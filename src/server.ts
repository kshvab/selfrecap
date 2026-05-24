/**
 * selfrecap — HTTP API for Claude Code session continuity.
 *
 * Endpoints:
 *   GET  /health           — liveness check
 *   GET  /voices           — list configured voices
 *   GET  /context/:voice   — read current context size for a registered voice
 *   GET  /context?path=... — read current context size for any JSONL path
 *   GET  /contexts         — aggregated context sizes for all voices
 *   POST /find-cut-point   — locate a record in JSONL by AI-supplied spec
 *   POST /surgery          — cut + inject recap + repair chain (dry-run by default)
 *
 * Run:
 *   npx tsx src/server.ts
 *
 * Config:
 *   ./config.yaml (or RECAP_CONFIG env var to override path)
 *
 * Security (localhost-only by design):
 *   - Every request must have a loopback Host header and NO Origin header
 *     (browsers always send Origin; CLI/curl clients don't) — kills CSRF.
 *   - Mutating POST routes additionally require an X-Recap-Token header matching
 *     the token at ~/.selfrecap/token (generated on first start, mode 0600).
 *   - 2MB request bodyLimit; per-route Zod caps narrow it further.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { loadConfig, type AppConfig } from "./config.js";
import { registerFindCutPoint } from "./routes/find-cut-point.js";
import { registerContext } from "./routes/context.js";
import { registerContexts } from "./routes/contexts.js";
import { registerSurgery } from "./routes/surgery.js";

interface VoiceInfo {
  path?: string;
  exists: boolean;
  file_size_bytes: number | null;
  last_modified: string | null;
}

function inspectVoice(filePath: string, exposePaths: boolean): VoiceInfo {
  if (!fs.existsSync(filePath)) {
    return {
      ...(exposePaths ? { path: filePath } : {}),
      exists: false,
      file_size_bytes: null,
      last_modified: null,
    };
  }
  const stat = fs.statSync(filePath);
  return {
    // Only surface the absolute path when expose_paths is on — otherwise a
    // misconfigured public clone would leak the user's home directory layout.
    ...(exposePaths ? { path: filePath } : {}),
    exists: true,
    file_size_bytes: stat.size,
    last_modified: stat.mtime.toISOString(),
  };
}

/**
 * Ensure a per-machine auth token exists at ~/.selfrecap/token and return it.
 * The dir is created 0o700 and the file 0o600 (owner-only) on POSIX so other
 * local users can't read it. NOTE: on Windows/NTFS these POSIX mode bits are a
 * no-op (Node's mode flag doesn't map to ACLs), so the token is not OS-enforced
 * owner-only there — acceptable for a single-user loopback box. Token is 32
 * random bytes hex. The mutating POST routes require it in the X-Recap-Token header.
 */
function ensureAuthToken(): { token: string; tokenPath: string } {
  const dir = path.join(os.homedir(), ".selfrecap");
  const tokenPath = path.join(dir, "token");

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return { token: existing, tokenPath };
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return { token, tokenPath };
}

/**
 * Host header must resolve to loopback. A real CLI/curl client talking to
 * 127.0.0.1 sends a loopback Host; this rejects DNS-rebinding style attacks
 * where a browser is pointed at a hostname that resolves to localhost.
 */
function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  const allowed = new Set([
    "127.0.0.1",
    `127.0.0.1:${port}`,
    "localhost",
    `localhost:${port}`,
    "[::1]",
    `[::1]:${port}`,
    "::1",
    `::1:${port}`,
  ]);
  return allowed.has(host);
}

/**
 * Build the configured Fastify instance: security onRequest hook, auth token,
 * and all routes registered. Does NOT call listen() — the caller decides whether
 * to bind a port (main()) or drive it via .inject() (tests).
 *
 * Returns the app plus the resolved auth token / token path so tests can supply
 * a valid X-Recap-Token without re-reading the token file.
 *
 * `logger` defaults to false so tests stay quiet; main() turns it on.
 */
export interface BuiltApp {
  app: FastifyInstance;
  authToken: string;
  tokenPath: string;
}

export function buildApp(config: AppConfig, opts: { logger?: boolean } = {}): BuiltApp {
  // bodyLimit caps the request body at 2MB so an oversized POST can't exhaust
  // memory before route-level validation runs.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });

  // ─── Auth token ─────────────────────────────────────────────────────────────
  const { token: authToken, tokenPath } = ensureAuthToken();
  app.log.info(`[auth] Token loaded from ${tokenPath} (mutating POST routes require X-Recap-Token).`);

  // ─── Security preHandler ────────────────────────────────────────────────────
  //
  // Applies to every route:
  //   - Reject any request that carries an Origin header. A real CLI/curl client
  //     sends none; only browsers do. This is the primary CSRF/cross-site kill.
  //   - Require the Host header to be loopback (defends DNS-rebinding).
  //   - For mutating methods (POST), require the X-Recap-Token header to match.
  //     GETs stay token-free (read-only; Origin+Host already block browsers) so
  //     curl and local dashboards work without juggling the token.
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["origin"] !== undefined) {
      return reply.status(403).send({
        error: "forbidden_origin",
        message: "Requests carrying an Origin header are rejected (CSRF protection). Use a CLI/curl client.",
      });
    }

    const host = Array.isArray(request.headers["host"]) ? request.headers["host"][0] : request.headers["host"];
    if (!isLoopbackHost(host, config.server.port)) {
      return reply.status(403).send({
        error: "forbidden_host",
        message: "Host header must be loopback (127.0.0.1, localhost, or [::1]). This server is localhost-only.",
      });
    }

    if (request.method === "POST") {
      const provided = request.headers["x-recap-token"];
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!value || value !== authToken) {
        return reply.status(401).send({
          error: "unauthorized",
          message: `Mutating requests require a valid X-Recap-Token header. Token lives at ${tokenPath}.`,
        });
      }
    }
  });

  // Startup validation — warn for any registered voice whose file is missing.
  const missing: string[] = [];
  for (const [name, v] of Object.entries(config.voices)) {
    if (!fs.existsSync(v.path)) missing.push(`${name} (${v.path})`);
  }
  if (missing.length > 0) {
    app.log.warn(
      `[config] ${missing.length} voice(s) registered with missing files: ${missing.join("; ")}`
    );
    app.log.warn(`[config] /context/<voice> will return file_not_found until paths exist.`);
  }

  app.get("/health", async () => ({
    status: "ok",
    version: "1.0.0",
    voices_registered: Object.keys(config.voices).length,
    voices_missing_file: missing.length,
  }));

  app.get("/voices", async () => ({
    voices: Object.fromEntries(
      Object.entries(config.voices).map(([name, v]) => [name, inspectVoice(v.path, config.expose_paths)]),
    ),
  }));

  registerFindCutPoint(app, config);
  registerContext(app, config);
  registerContexts(app, config);
  registerSurgery(app, config);

  return { app, authToken, tokenPath };
}

async function main() {
  const config = loadConfig();
  const { app } = buildApp(config, { logger: true });

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`selfrecap listening on http://${config.server.host}:${config.server.port}`);
    app.log.info(`Configured voices: ${Object.keys(config.voices).join(", ") || "(none)"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests).
// Under tsx/node ESM, import.meta.url matches argv[1] when executed as the entry.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
