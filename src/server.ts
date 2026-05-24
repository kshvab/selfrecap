/**
 * recap-server — HTTP API for Claude Code session continuity.
 *
 * Phase 1 endpoints:
 *   POST /find-cut-point   — locate a record in JSONL by AI-supplied spec
 *   GET  /context/:voice   — read current context size for a registered voice
 *   GET  /context?path=... — read current context size for any JSONL path
 *   GET  /health           — liveness check
 *   GET  /voices           — list configured voices
 *
 * Run:
 *   npx tsx src/server.ts
 *
 * Config:
 *   ./config.yaml (or RECAP_CONFIG env var to override path)
 */

import Fastify from "fastify";
import fs from "fs";
import { loadConfig } from "./config.js";
import { registerFindCutPoint } from "./routes/find-cut-point.js";
import { registerContext } from "./routes/context.js";
import { registerContexts } from "./routes/contexts.js";
import { registerSurgery } from "./routes/surgery.js";

interface VoiceInfo {
  path: string;
  exists: boolean;
  file_size_bytes: number | null;
  last_modified: string | null;
}

function inspectVoice(path: string): VoiceInfo {
  if (!fs.existsSync(path)) {
    return { path, exists: false, file_size_bytes: null, last_modified: null };
  }
  const stat = fs.statSync(path);
  return {
    path,
    exists: true,
    file_size_bytes: stat.size,
    last_modified: stat.mtime.toISOString(),
  };
}

async function main() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

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
    version: "0.2.0",
    voices_registered: Object.keys(config.voices).length,
    voices_missing_file: missing.length,
  }));

  app.get("/voices", async () => ({
    voices: Object.fromEntries(
      Object.entries(config.voices).map(([name, v]) => [name, inspectVoice(v.path)]),
    ),
  }));

  registerFindCutPoint(app, config);
  registerContext(app, config);
  registerContexts(app, config);
  registerSurgery(app, config);

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`recap-server listening on http://${config.server.host}:${config.server.port}`);
    app.log.info(`Configured voices: ${Object.keys(config.voices).join(", ") || "(none)"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
