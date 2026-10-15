/**
 * Live Claude Code sessions, across every account on the machine.
 * WINDOWS ONLY as written: see "Liveness" below.
 *
 * Each account (a CLAUDE_CONFIG_DIR, `~/.claude` by default) keeps its own
 * registry:
 *
 *   <account>/sessions/<pid>.json                        who is running, under which name, at which pipe
 *   <account>/sessions/<pid>.<sha256(pipe)>.key          the token a sender presents
 *
 * A machine can run several accounts (config `accounts`), so every lookup
 * walks all of them. Assuming one account breaks exactly when another is
 * needed: its live sessions vanish without an error.
 *
 * These files are Claude Code internals, not a documented interface; they
 * are what Claude Code's cross-session messaging uses (v2.1.224+, native
 * Windows v2.1.234+). If their shape changes, sessions read as not live and
 * nothing is nudged or restarted.
 *
 * Liveness is the pipe, not the row. A row outlives a killed process, and its
 * `updatedAt` is not a heartbeat (it is only rewritten when the status
 * changes). The pipe named in the row (`\\.\pipe\LOCAL\cc-msg-<random>`)
 * exists exactly as long as the process: its name is fresh randomness on every
 * start, so a reused PID cannot fake it. One directory listing answers for
 * every session at once.
 *
 * On macOS and Linux Claude Code uses a Unix socket instead of a named pipe,
 * so listPipes() returns null there ("unknown"). To adapt: make listPipes and
 * pipeExists check the socket path in `messagingSocketPath` instead.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { expandHome } from "../config.js";

export interface LiveSession {
  /** The account folder (CLAUDE_CONFIG_DIR) whose registry holds the row. */
  account: string;
  pid: number;
  sessionId: string;
  name: string | null;
  cwd: string | null;
  kind: string | null;
  /** busy | idle | waiting | shell, as Claude Code last wrote it. */
  status: string | null;
  /** Why a `waiting` session waits, e.g. "dialog open". */
  waitingFor: string | null;
  statusUpdatedAt: number | null;
  startedAt: number | null;
  pipe: string | null;
  /** The row file itself. */
  file: string;
  /** Its pipe exists: the process is alive. */
  alive: boolean;
}

/** The configured accounts (default `~/.claude`) plus any other given, each once. */
export function knownAccounts(configured: string[] = ["~/.claude"], extra: string[] = []): string[] {
  const all = [...configured.map(expandHome), ...extra];
  const seen = new Map<string, string>();
  for (const a of all) {
    const key = path.resolve(a).toLowerCase();
    if (!seen.has(key)) seen.set(key, path.resolve(a));
  }
  return [...seen.values()];
}

/**
 * The account a session file belongs to: <account>/projects/<folder>/<id>.jsonl.
 * Null when the path does not have that shape.
 */
export function accountOfSessionFile(sessionPath: string): string | null {
  const projects = path.dirname(path.dirname(path.resolve(sessionPath)));
  if (path.basename(projects).toLowerCase() !== "projects") return null;
  return path.dirname(projects);
}

/** The default account: the one plain `claude` uses when CLAUDE_CONFIG_DIR is unset. */
export function isDefaultAccount(account: string): boolean {
  return path.resolve(account).toLowerCase() === path.join(os.homedir(), ".claude").toLowerCase();
}

/** Same account folder, whatever the slashes and case. */
export function sameAccount(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Names of the pipes that exist right now, lower-cased; null when the listing
 * itself failed. Node lists the pipe namespace only as `//./pipe/`: the
 * backslash form fails with ENOENT.
 *
 * Null is "unknown", never "none": read as an empty set it would make every
 * session look dead, and a dead-looking live session gets its row deleted and
 * a second copy resumed on top of it. Unknown counts as alive everywhere.
 */
export function listPipes(): Set<string> | null {
  try {
    return new Set(fs.readdirSync("//./pipe/").map((p) => p.toLowerCase()));
  } catch {
    return null;
  }
}

/** Is this pipe there? Unknown (listing failed) answers true: assume alive. */
export function pipeExists(pipe: string | null, pipes: Set<string> | null = listPipes()): boolean {
  if (pipes === null) return true;
  return pipe !== null && pipes.has(pipeKey(pipe));
}

/** Does a process with this PID exist? (Any process: the PID may have been reused.) */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** `\\.\pipe\LOCAL\cc-msg-x` → `local\cc-msg-x`, the form listPipes returns. */
export function pipeKey(pipe: string): string {
  return pipe.replace(/^[\\/]{2}[.?][\\/]pipe[\\/]/i, "").replace(/\//g, "\\").toLowerCase();
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Every row in one account's registry, alive or not. Half-written rows are skipped. */
export function readRegistry(account: string, pipes: Set<string> | null = listPipes()): LiveSession[] {
  const dir = path.join(account, "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const rows: LiveSession[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const pid = num(raw?.pid);
    const sessionId = str(raw?.sessionId);
    if (pid === null || !sessionId) continue;
    const pipe = str(raw.messagingSocketPath);
    rows.push({
      account,
      pid,
      sessionId,
      name: str(raw.name),
      cwd: str(raw.cwd),
      kind: str(raw.kind),
      status: str(raw.status),
      waitingFor: str(raw.waitingFor),
      statusUpdatedAt: num(raw.statusUpdatedAt),
      startedAt: num(raw.startedAt),
      pipe,
      file,
      alive: pipeExists(pipe, pipes),
    });
  }
  return rows;
}

/** Live sessions in every known account. */
export function liveSessions(accounts: string[] = knownAccounts()): LiveSession[] {
  const pipes = listPipes();
  return accounts.flatMap((a) => readRegistry(a, pipes)).filter((r) => r.alive);
}

/** Live sessions answering to a name (case-insensitive, as the resolver treats it). */
export function liveByName(name: string, accounts?: string[]): LiveSession[] {
  const n = name.toLowerCase();
  return liveSessions(accounts).filter((r) => r.name?.toLowerCase() === n);
}

/** Live sessions running a session id, in any account. */
export function liveBySessionId(sessionId: string, accounts?: string[]): LiveSession[] {
  return liveSessions(accounts).filter((r) => r.sessionId === sessionId);
}

/**
 * Remove a dead session's registry row and key. A killed process leaves both
 * behind; Claude Code itself skips them, but anything that greps the folder
 * for a name would read a ghost. Refuses while the pipe is still there.
 */
export function removeDeadRow(row: LiveSession, pipes: Set<string> | null = listPipes()): string[] {
  // Only a pipe we can see is gone: an unreadable listing removes nothing.
  if (pipes === null || !row.pipe || pipes.has(pipeKey(row.pipe))) return [];
  // Re-read the row first: a new process may have taken the PID, and then the
  // row and the key beside it are its own. Nothing is removed unless the row
  // on disk is still this session's, at this session's pipe.
  try {
    const now = JSON.parse(fs.readFileSync(row.file, "utf8"));
    if (now?.sessionId !== row.sessionId || now?.messagingSocketPath !== row.pipe) return [];
  } catch {
    return [];
  }
  const dir = path.dirname(row.file);
  const removed: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const f of files) {
    if (f === `${row.pid}.json` || (f.startsWith(`${row.pid}.`) && f.endsWith(".key"))) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed.push(f);
      } catch {
        // Already gone.
      }
    }
  }
  return removed;
}

let binCache: string | null | undefined;

/**
 * The Claude Code executable. Resolved, not left to PATH: a process
 * manager's PATH (pm2's is frozen when its daemon started) may lack
 * ~/.local/bin, and then a bare `claude` from the server fails with ENOENT.
 *
 * On Windows only a real `claude.exe` will do: an npm-installed `claude.cmd`
 * cannot be spawned without a shell (Node refuses .cmd files with EINVAL),
 * and the courier's prompt is not something to pass through cmd's quoting.
 * Null when none is found.
 */
export function claudeBin(): string | null {
  if (binCache !== undefined) return binCache;
  const win = process.platform === "win32";
  const exe = win ? "claude.exe" : "claude";
  const local = path.join(os.homedir(), ".local", "bin", exe);
  if (fs.existsSync(local)) return (binCache = local);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return (binCache = p);
  }
  return (binCache = win ? null : "claude");
}

/**
 * Environment for a Claude process on an account. Every inherited CLAUDE*
 * variable is dropped, not a list of known ones: a list always lags (a child
 * can inherit its parent's Remote Control session id). The default account
 * gets no CLAUDE_CONFIG_DIR at all: with it set, Claude Code reads a second
 * state file that has never completed onboarding and shows the first-run
 * wizard.
 */
export function claudeEnv(account: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // NO_COLOR too: Claude Code sets it in its own tool shells, and a session
  // started from one inherits it and comes up monochrome.
  for (const [k, v] of Object.entries(base)) if (!/^claude/i.test(k) && k.toUpperCase() !== "NO_COLOR") env[k] = v;
  if (!isDefaultAccount(account)) env.CLAUDE_CONFIG_DIR = account;
  return env;
}
