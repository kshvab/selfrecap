/**
 * Config loader. Reads `config.yaml` from the working directory by default,
 * or the file named by the `RECAP_CONFIG` env var. Read once at startup:
 * after editing, run `npm run check-config`, then restart the server.
 *
 * A voice entry says where everything of that session lives:
 *
 *   voices:
 *     my-session:
 *       session: "~/.claude/projects/<project-dir>/<session-id>.jsonl"
 *       recaps:  "~/selfrecap/my-session"      # optional; defaults to home
 *       home:    "~/selfrecap/my-session"      # optional; memories live in <home>/memories
 *       restart: 'cd ~/projects/my-app; claude --resume {session_id} --name MySession'
 *       name:    MySession                     # optional; defaults to the key, capitalized
 *
 * - `session` is the session JSONL. It is an ANCHOR: see resolveSafePath.
 *   `path` is accepted as its 1.0 name. The session id is the file name.
 * - `recaps` is where recap bodies are written (`recap-NNN.body.txt`).
 * - `restart` is the command that resumes the session after surgery;
 *   `{session_id}` is filled with the LIVE session id, which after a
 *   continuation is not the anchor's.
 * - `name` is the name the session answers to (`claude --name`, SendMessage).
 *
 * Voice names are case-insensitive. Entries are checked one at a time: a broken
 * entry is reported (startup log, /health, /voices, check-config) and left out,
 * and the other voices keep working.
 *
 * Every path a request resolves — through a voice or a direct file_path — is
 * validated against `allowed_roots` (see resolveSafePath), so neither a voice
 * entry nor a direct file_path can point the server at a file outside them.
 */

import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveLiveSession, type ResolvedSession } from "./lib/continuation.js";

export interface VoiceConfig {
  /** Session JSONL anchor (`path` in 1.0 configs). */
  session: string;
  home?: string;
  recaps?: string;
  restart?: string;
  /** The name the session answers to (SendMessage, --name). Defaults to the key, capitalized. */
  name?: string;
}

/** The context nudge: a live session past `at` percent is told to recap and restart. Windows only. */
export interface NudgeConfig {
  enabled: boolean;
  /** Percent of the 1M window that triggers a nudge. */
  at: number;
  /** How often the server looks. */
  every_minutes: number;
  /** Least time between two nudges to the same voice. */
  cooldown_minutes: number;
  /** The courier model. It only carries a fixed text; it writes nothing. */
  model: string;
}

/** Plan-usage bars per Claude account (reads each account's login token). Off by default. */
export interface UsageConfig {
  enabled: boolean;
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
  /**
   * Claude Code account folders (each a CLAUDE_CONFIG_DIR) to look in for
   * live sessions and plan usage. Accounts the voices' sessions live in are
   * added on top.
   */
  accounts: string[];
  nudge: NudgeConfig;
  usage: UsageConfig;
  /** File the config was read from, or null when running on defaults. */
  config_path: string | null;
  /** Everything wrong with the file, one line each. Empty when clean. */
  problems: string[];
}

export const NUDGE_DEFAULTS: NudgeConfig = {
  enabled: false,
  at: 83,
  every_minutes: 5,
  cooldown_minutes: 10,
  model: "haiku",
};

export const DEFAULT_SENTINEL = "RECAP-CYCLE";

export const DEFAULTS: AppConfig = {
  server: { port: 9090, host: "127.0.0.1" },
  voices: {},
  allowed_roots: ["~/.claude/projects/"],
  expose_paths: false,
  sentinel_name: DEFAULT_SENTINEL,
  backup_dir: "./backups",
  accounts: ["~/.claude"],
  nudge: NUDGE_DEFAULTS,
  usage: { enabled: false },
  config_path: null,
  problems: [],
};

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const VoiceEntrySchema = z
  .object({
    session: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    home: z.string().min(1).optional(),
    recaps: z.string().min(1).optional(),
    restart: z.string().min(1).optional(),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a plain name (letters, digits, - and _)").optional(),
  })
  .passthrough();

const VOICE_KEYS = new Set(["session", "path", "home", "recaps", "restart", "name"]);
const TOP_KEYS = new Set([
  "server",
  "voices",
  "allowed_roots",
  "expose_paths",
  "sentinel_name",
  "backup_dir",
  "accounts",
  "nudge",
  "usage",
]);

const NudgeSchema = z
  .object({
    enabled: z.boolean().optional(),
    at: z.number().min(1).max(99).optional(),
    every_minutes: z.number().min(1).optional(),
    cooldown_minutes: z.number().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

const UsageSchema = z.object({ enabled: z.boolean().optional() }).strict();

function parseNudge(raw: unknown, problems: string[]): NudgeConfig {
  if (raw === undefined || raw === null) return { ...NUDGE_DEFAULTS };
  const parsed = NudgeSchema.safeParse(raw);
  if (!parsed.success) {
    // A broken block must not switch the nudger ON (a mistyped `enabled: "false"`
    // would). Defaults otherwise, but enabled only if it says so plainly.
    const issue = parsed.error.issues[0];
    const enabled = typeof raw === "object" && (raw as Record<string, unknown>).enabled === true;
    problems.push(`nudge: ${issue ? `${issue.path.join(".") || "entry"} ${issue.message}` : "invalid"}; defaults used, nudger ${enabled ? "on" : "OFF"}`);
    return { ...NUDGE_DEFAULTS, enabled };
  }
  return { ...NUDGE_DEFAULTS, ...parsed.data };
}

function parseUsage(raw: unknown, problems: string[]): UsageConfig {
  if (raw === undefined || raw === null) return { enabled: false };
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) {
    // Same rule as the nudger: a broken block never opts in to reading credentials.
    const enabled = typeof raw === "object" && (raw as Record<string, unknown>).enabled === true;
    problems.push(`usage: ${parsed.error.issues[0]?.message ?? "invalid"}; usage bars ${enabled ? "on" : "OFF"}`);
    return { enabled };
  }
  return { enabled: parsed.data.enabled ?? false };
}

function parseVoices(raw: unknown, problems: string[]): Record<string, VoiceConfig> {
  const voices: Record<string, VoiceConfig> = {};
  if (raw === undefined || raw === null) return voices;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("voices: must be a mapping of voice name to entry");
    return voices;
  }
  for (const [rawName, entry] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.toLowerCase();
    if (voices[name]) {
      problems.push(`voices.${rawName}: same name as another entry (names are case-insensitive), skipped`);
      continue;
    }
    const parsed = VoiceEntrySchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(`voices.${rawName}: ${issue ? `${issue.path.join(".") || "entry"} ${issue.message}` : "invalid entry"}, skipped`);
      continue;
    }
    const e = parsed.data;
    const unknown = Object.keys(e).filter((k) => !VOICE_KEYS.has(k));
    if (unknown.length > 0) problems.push(`voices.${rawName}: unknown key(s) ${unknown.join(", ")}, ignored`);
    if (e.session && e.path && e.session !== e.path) {
      problems.push(`voices.${rawName}: both session and path are set and differ; using session`);
    }
    const session = e.session ?? e.path;
    if (!session) {
      problems.push(`voices.${rawName}: no session (the session JSONL path), skipped`);
      continue;
    }
    voices[name] = {
      session: expandHome(session),
      ...(e.home ? { home: expandHome(e.home) } : {}),
      ...(e.recaps ? { recaps: expandHome(e.recaps) } : {}),
      ...(e.restart ? { restart: e.restart } : {}),
      ...(e.name ? { name: e.name } : {}),
    };
  }
  return voices;
}

function stringList(raw: unknown, key: string, problems: string[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.length === 0)) {
    problems.push(`${key}: must be a list of paths; default used`);
    return null;
  }
  return raw as string[];
}

export function loadConfig(configPath = process.env.RECAP_CONFIG || path.resolve(process.cwd(), "config.yaml")): AppConfig {
  if (!fs.existsSync(configPath)) {
    console.warn(`[config] No config file at ${configPath}. Using defaults.`);
    console.warn(`[config] Copy config.example.yaml to config.yaml to register voices.`);
    return { ...DEFAULTS, problems: [] };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw) as Record<string, any> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Config file at ${configPath} did not parse as object`);
  }

  const problems: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!TOP_KEYS.has(key)) problems.push(`${key}: unknown top-level key, ignored`);
  }
  const roots = stringList(parsed.allowed_roots, "allowed_roots", problems);
  const accounts = stringList(parsed.accounts, "accounts", problems);
  return {
    server: {
      port: parsed.server?.port ?? DEFAULTS.server.port,
      host: parsed.server?.host ?? DEFAULTS.server.host,
    },
    voices: parseVoices(parsed.voices, problems),
    allowed_roots: roots && roots.length > 0 ? roots : DEFAULTS.allowed_roots,
    expose_paths: parsed.expose_paths ?? DEFAULTS.expose_paths,
    sentinel_name: parsed.sentinel_name ?? DEFAULTS.sentinel_name,
    backup_dir: parsed.backup_dir ?? DEFAULTS.backup_dir,
    accounts: accounts ?? DEFAULTS.accounts,
    nudge: parseNudge(parsed.nudge, problems),
    usage: parseUsage(parsed.usage, problems),
    config_path: configPath,
    problems,
  };
}

/** A config problem that removes a voice (or all of them), rather than just being ignored. */
export function isFatalProblem(problem: string): boolean {
  return problem.endsWith("skipped") || problem.startsWith("voices: must be");
}

export class UnknownVoiceError extends Error {}

/** A configured voice by name (case-insensitive). Throws UnknownVoiceError. */
export function getVoice(config: AppConfig, name: string): { name: string; entry: VoiceConfig } {
  const key = name.toLowerCase();
  const entry = config.voices[key];
  if (!entry) {
    throw new UnknownVoiceError(`Unknown voice: ${name}. Known: ${Object.keys(config.voices).join(", ") || "(none)"}`);
  }
  return { name: key, entry };
}

/** The name a voice answers to: `name` from config, else the key capitalized (my-session → My-session). */
export function displayNameOf(key: string, entry: VoiceConfig): string {
  return entry.name ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Where a voice's recap bodies live: `recaps`, else `home`. */
export function recapsDirOf(entry: VoiceConfig): string | null {
  return entry.recaps ?? entry.home ?? null;
}

/** The voice's restart command with `{session_id}` filled in, or null without a template. */
export function restartCommandFor(entry: VoiceConfig | undefined, liveSessionId: string): string | null {
  return entry?.restart ? entry.restart.split("{session_id}").join(liveSessionId) : null;
}

/**
 * Check a restart template against its session path
 * (<account>/projects/<project-dir>/<id>.jsonl). The project folder is the
 * working directory with every non-alphanumeric character turned into `-`,
 * so the `cd` target must map onto it: `claude --resume` looks sessions up by
 * folder. A session on an account other than the default `~/.claude` needs
 * that account selected (CLAUDE_CONFIG_DIR, or a launcher that sets it) when
 * the command is run by hand; `selfrecap restart` selects it itself.
 */
export function checkRestart(session: string, restart: string | undefined): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!restart) {
    errors.push("no restart command: set restart in config.yaml, or --go cannot tell the operator how to resume this voice");
    return { errors, warnings };
  }
  if (!restart.includes("{session_id}")) errors.push("restart has no {session_id} placeholder");
  // Resume by explicit id only. A resume by name, or --continue, can open
  // another session or fork this one under a new id.
  else if (!/(--resume|-r)\s+\{session_id\}(\s|$)/.test(restart)) {
    errors.push("restart must resume by id: `--resume {session_id}`");
  }
  // Only as arguments to claude: `bash -c` or `pwsh -c` around it are fine.
  if (/\bclaude\b[^;&|\n]*\s(--continue|-c)(\s|$)/.test(restart)) {
    errors.push("restart must not use --continue: it opens the latest session in the folder, not this one");
  }
  if (/--fork-session/.test(restart)) errors.push("restart must not use --fork-session: it gives the session a new id");
  if (process.platform === "win32") {
    // `selfrecap restart` runs the template in Windows PowerShell 5.1, which
    // has no && or || and whose cd (Set-Location) has no /d. A template it
    // cannot run would leave the session closed and not resumed.
    if (/&&|\|\|/.test(restart)) errors.push("restart uses && or ||, which Windows PowerShell 5.1 cannot run: separate the commands with ;");
    if (/\bcd\s+\/d\b/i.test(restart)) errors.push("restart uses cd /d (cmd syntax); in PowerShell write cd <folder>");
  }
  if (!/(^|\s)(--name|-n)\s+\S/.test(restart)) {
    warnings.push("restart has no --name: the name then rides only on transcript records, which surgery can cut");
  }
  const projectDir = path.dirname(path.resolve(session));
  const projects = path.dirname(projectDir);
  if (path.basename(projects) !== "projects") {
    warnings.push("the session is not under <account>/projects/<folder>/; restart not checked");
    return { errors, warnings };
  }
  const account = path.dirname(projects);
  const isDefault = path.resolve(account).toLowerCase() === path.join(os.homedir(), ".claude").toLowerCase();
  if (isDefault) {
    if (/CLAUDE_CONFIG_DIR/i.test(restart)) {
      errors.push("the session is on the default ~/.claude account, but restart sets CLAUDE_CONFIG_DIR to another");
    }
  } else if (!/CLAUDE_CONFIG_DIR/i.test(restart) && !restart.toLowerCase().includes(path.basename(account).replace(/^\./, "").toLowerCase())) {
    warnings.push(
      `the session is on the ${path.basename(account)} account: run by hand, restart must select it ` +
        `(CLAUDE_CONFIG_DIR or your launcher for it); selfrecap restart selects it itself`,
    );
  }
  const cd = /\bcd\s+(?:\/d\s+)?(["']?)([^;&|"'\n]+)\1/i.exec(restart);
  const folder = path.basename(projectDir);
  if (!cd) {
    warnings.push(`restart does not cd into the session's folder (${folder})`);
  } else {
    const target = expandHome(cd[2]!.trim());
    if (target.replace(/[^A-Za-z0-9]/g, "-").toLowerCase() !== folder.toLowerCase()) {
      errors.push(`restart cds into ${cd[2]!.trim()}, but the session belongs to the folder ${folder}`);
    }
  }
  return { errors, warnings };
}

/** True when `p` (after symlink resolution where it exists) sits under one of `allowed_roots`. */
export function isUnderAllowedRoots(config: AppConfig, p: string): { ok: boolean; real: string; roots: string[] } {
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    real = p;
  }
  const roots = config.allowed_roots.map((r) => {
    const abs = path.resolve(expandHome(r));
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  });
  const ok = roots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return real === root || real.startsWith(rootWithSep);
  });
  return { ok, real, roots };
}

function assertSafe(config: AppConfig, candidate: string): string {
  // 1. Suffix gate — we only ever touch JSONL transcripts.
  if (!candidate.toLowerCase().endsWith(".jsonl")) {
    throw new Error("Refusing non-.jsonl path. This server only operates on session transcript files.");
  }
  const expanded = path.resolve(expandHome(candidate));
  // 2. Allowed-roots gate. Symlinks are resolved where the file exists, so a
  //    symlink cannot point inside an allowed root while its target sits
  //    outside it. A not-yet-existing file is checked lexically.
  const check = isUnderAllowedRoots(config, expanded);
  if (!check.ok) {
    throw new Error(
      `Path is outside allowed_roots. Resolved "${check.real}" is not under any of: ${check.roots.join(", ")}. ` +
        `Adjust allowed_roots in config.yaml if your sessions live elsewhere.`,
    );
  }
  return expanded;
}

/**
 * Resolve a request's target path AND validate it against allowed_roots.
 *
 * Accepts either `voice` (mapped via config) or `file_path` (used directly),
 * not both. A voice's configured session is an ANCHOR, not a guarantee: when
 * a session is continued, Claude Code freezes that file and starts a new one,
 * and the anchor then reports the context as of the continuation, frozen
 * forever. So voice lookups follow the `continued-in` chain to the live file —
 * for reads and for surgery alike, since operating on a frozen ancestor would
 * edit a file the running session never reads. An explicit `file_path` is
 * taken literally and never followed.
 *
 * Either way the final path must end in `.jsonl` and sit inside one of
 * `allowed_roots` — the guard that stops `/surgery` from being tricked into
 * rewriting a file outside the projects dir, or through a symlink that
 * escapes it. Throws on any violation (UnknownVoiceError for an unknown voice);
 * callers surface the message as a 4xx.
 */
export function resolveSafePath(
  config: AppConfig,
  voice?: string,
  filePath?: string,
): { path: string; voice?: string; session?: ResolvedSession } {
  if (filePath && voice) throw new Error("Pass either `voice` or `file_path`, not both.");
  if (filePath) return { path: assertSafe(config, filePath) };
  if (voice) {
    const v = getVoice(config, voice);
    const session = resolveLiveSession(v.entry.session);
    return { path: assertSafe(config, session.resolved_path), voice: v.name, session };
  }
  throw new Error("Must provide either `voice` or `file_path`");
}

/**
 * Backwards-compatible alias. Prefer resolveSafePath everywhere — there is no
 * unchecked resolver, on purpose, so no route can accidentally skip the guard.
 */
export const resolvePath = resolveSafePath;
