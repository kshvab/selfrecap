/**
 * Config loader. Reads `config.yaml` from the working directory by default,
 * or from `RECAP_CONFIG` env var if set.
 *
 * Voice mapping is convenience only — clients can always pass file_path directly
 * to bypass voice resolution. BUT every resolved path is then validated against
 * `allowed_roots` (see resolveSafePath) so neither a voice entry nor a direct
 * file_path can point the server at a file outside the permitted roots.
 */

import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";

export interface VoiceConfig {
  path: string;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  server: ServerConfig;
  voices: Record<string, VoiceConfig>;
  allowed_roots: string[];
  expose_paths: boolean;
  sentinel_name: string;
  backup_dir: string;
}

const DEFAULTS: AppConfig = {
  server: { port: 9090, host: "127.0.0.1" },
  voices: {},
  allowed_roots: ["~/.claude/projects/"],
  expose_paths: false,
  sentinel_name: "RECAP-CYCLE",
  backup_dir: "./backups",
};

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.RECAP_CONFIG || path.resolve(process.cwd(), "config.yaml");

  if (!fs.existsSync(configPath)) {
    console.warn(`[config] No config file at ${configPath}. Using defaults.`);
    console.warn(`[config] Copy config.example.yaml to config.yaml to register voices.`);
    return DEFAULTS;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw) as Partial<AppConfig> | null;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config file at ${configPath} did not parse as object`);
  }

  return {
    server: {
      port: parsed.server?.port ?? DEFAULTS.server.port,
      host: parsed.server?.host ?? DEFAULTS.server.host,
    },
    voices: parsed.voices ?? {},
    allowed_roots:
      parsed.allowed_roots && parsed.allowed_roots.length > 0
        ? parsed.allowed_roots
        : DEFAULTS.allowed_roots,
    expose_paths: parsed.expose_paths ?? DEFAULTS.expose_paths,
    sentinel_name: parsed.sentinel_name ?? DEFAULTS.sentinel_name,
    backup_dir: parsed.backup_dir ?? DEFAULTS.backup_dir,
  };
}

/**
 * Resolve a request's target path AND validate it against allowed_roots.
 *
 * Accepts either `voice` (mapped via config) or `file_path` (used directly).
 * After resolution:
 *   1. The path must end in `.jsonl` (we only operate on session transcripts).
 *   2. The path, with symlinks resolved to their real location, must sit inside
 *      one of `allowed_roots`. This is the guard that stops `/surgery` from
 *      being tricked into rewriting `~/.ssh/authorized_keys`, a file outside
 *      the projects dir, or a symlink that escapes the allowed root.
 *
 * Throws on any violation. Callers should surface the message as a 400.
 */
export function resolveSafePath(
  config: AppConfig,
  voice?: string,
  filePath?: string,
): { path: string; voice?: string } {
  let candidate: string;
  let voiceName: string | undefined;

  if (filePath) {
    candidate = filePath;
  } else if (voice) {
    const v = config.voices[voice];
    if (!v) {
      throw new Error(
        `Unknown voice: ${voice}. Known: ${Object.keys(config.voices).join(", ") || "(none)"}`,
      );
    }
    candidate = v.path;
    voiceName = voice;
  } else {
    throw new Error("Must provide either `voice` or `file_path`");
  }

  // 1. Suffix gate — we only ever touch JSONL transcripts.
  if (!candidate.toLowerCase().endsWith(".jsonl")) {
    throw new Error(
      "Refusing non-.jsonl path. This server only operates on session transcript files.",
    );
  }

  const expanded = path.resolve(expandHome(candidate));

  // 2. Allowed-roots gate. Resolve symlinks where the file exists so a symlink
  //    cannot point inside an allowed root while its target sits outside it.
  //    For a not-yet-existing file we fall back to the lexically-resolved path.
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    real = expanded;
  }

  const roots = config.allowed_roots.map((r) => path.resolve(expandHome(r)));
  const inRoot = roots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return real === root || real.startsWith(rootWithSep);
  });

  if (!inRoot) {
    throw new Error(
      `Path is outside allowed_roots. Resolved "${real}" is not under any of: ${roots.join(", ")}. ` +
        `Adjust allowed_roots in config.yaml if your sessions live elsewhere.`,
    );
  }

  return { path: expanded, voice: voiceName };
}

/**
 * Backwards-compatible alias. Prefer resolveSafePath everywhere — the unchecked
 * resolver is gone on purpose so no route can accidentally skip the guard.
 */
export const resolvePath = resolveSafePath;
