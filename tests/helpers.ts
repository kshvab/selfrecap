/**
 * Shared test helpers: locate the fixture, copy it into an isolated temp dir
 * per test so we NEVER mutate the committed fixture, build a minimal
 * AppConfig pointed at a temp allowed_root, and build synthetic Claude Code
 * sessions with the record shapes found in real files — uuid-less header and
 * metadata lines, system records in the parentUuid chain, tool calls, and
 * recap records at the head.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { loadJsonl, type JsonlRecord } from "../src/lib/jsonl.js";
import { DEFAULTS, type AppConfig } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = path.join(here, "fixtures", "sample.jsonl");
export const SENTINEL = "RECAP-CYCLE";

/** Read the committed fixture's records (read-only). */
export function fixtureRecords(): JsonlRecord[] {
  return loadJsonl(FIXTURE_PATH);
}

/** Raw fixture text (read-only). */
export function fixtureText(): string {
  return fs.readFileSync(FIXTURE_PATH, "utf8");
}

export interface TempWorkspace {
  dir: string;
  /** A .jsonl path inside `dir` that the security guard will accept (dir is the allowed_root). */
  filePath: string;
  backupDir: string;
  cleanup(): void;
}

/**
 * Create a fresh temp dir and copy the given content (default: the fixture)
 * into `<dir>/session.jsonl`. The temp dir doubles as the allowed_root so
 * resolveSafePath accepts the file.
 */
export function makeWorkspace(content?: string): TempWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recap-test-"));
  // Resolve symlinks (macOS /var -> /private/var) so realpath comparisons hold.
  const realDir = fs.realpathSync(dir);
  const filePath = path.join(realDir, "session.jsonl");
  fs.writeFileSync(filePath, content ?? fixtureText());
  const backupDir = path.join(realDir, "backups");
  return {
    dir: realDir,
    filePath,
    backupDir,
    cleanup() {
      try {
        fs.rmSync(realDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Write arbitrary text to a fresh temp .jsonl and return its workspace. */
export function workspaceFromText(text: string): TempWorkspace {
  return makeWorkspace(text);
}

/** Build a config whose allowed_root is the given dir. */
export function configFor(allowedRootDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULTS,
    server: { port: 9090, host: "127.0.0.1" },
    voices: {},
    allowed_roots: [allowedRootDir],
    expose_paths: false,
    sentinel_name: SENTINEL,
    backup_dir: path.join(allowedRootDir, "backups"),
    problems: [],
    ...overrides,
  };
}

/** Serialize records back to JSONL text (matching surgery's format). */
export function toJsonl(records: JsonlRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// ─── Synthetic sessions ─────────────────────────────────────────────────────

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

/** A temp folder (symlinks resolved), removed when the test process exits. */
export function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "selfrecap-test-")));
  created.push(dir);
  return dir;
}

export type Rec = Record<string, any>;

let clock = Date.parse("2026-01-01T10:00:00.000Z");
const ts = () => new Date((clock += 1000)).toISOString();

/** A recap body as the skill writes it: operator wrapper, prose, sentinel block last. */
export function recapText(voice: string, id: string, cut: string, extra: Record<string, unknown> = {}): string {
  const sentinel = { sentinel: SENTINEL, voice, id, version: 1, cut_through_uuid: cut, ...extra };
  return [
    `Hey ${voice}. Operator here. This is what happened in the period before the cut, told back to you.`,
    "",
    "Decisions, open loops, relationships.",
    "",
    "```json",
    JSON.stringify(sentinel, null, 2),
    "```",
    "",
  ].join("\n");
}

export class Session {
  readonly sessionId = crypto.randomUUID();
  readonly recs: Rec[] = [];
  /** uuid of the chain's current tip. */
  tip: string | null = null;
  private lastRecap: string | null = null;

  private base(type: string): Rec {
    return {
      parentUuid: this.tip,
      isSidechain: false,
      type,
      uuid: crypto.randomUUID(),
      timestamp: ts(),
      cwd: "/home/user/project",
      sessionId: this.sessionId,
      version: "2.1.280",
      userType: "external",
      entrypoint: "cli",
      gitBranch: "main",
    };
  }

  private chain(r: Rec): Rec {
    this.recs.push(r);
    this.tip = r.uuid;
    return r;
  }

  /** uuid-less record (mode, permission-mode, last-prompt, custom-title, file-history-snapshot, queue-operation). */
  meta(type: string, extra: Rec = {}): Rec {
    const r = { type, ...extra, sessionId: this.sessionId };
    this.recs.push(r);
    return r;
  }

  recap(voice: string, id: string): Rec {
    const r: Rec = {
      ...this.base("user"),
      parentUuid: this.lastRecap,
      message: { role: "user", content: recapText(voice, id, crypto.randomUUID()) },
    };
    this.recs.push(r);
    this.lastRecap = r.uuid;
    this.tip = r.uuid;
    return r;
  }

  user(text: string): Rec {
    return this.chain({ ...this.base("user"), message: { role: "user", content: text } });
  }

  assistant(text: string): Rec {
    return this.chain({
      ...this.base("assistant"),
      message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    });
  }

  /** An assistant reply carrying a usage block, as the context monitor reads it. */
  assistantWithUsage(text: string, tokens: number): Rec {
    return this.chain({
      ...this.base("assistant"),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 50 },
      },
    });
  }

  toolUse(id: string, command = "ls"): Rec {
    return this.chain({
      ...this.base("assistant"),
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }], stop_reason: "tool_use" },
    });
  }

  toolResult(id: string, text: string): Rec {
    return this.chain({
      ...this.base("user"),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    });
  }

  system(subtype: string): Rec {
    return this.chain({ ...this.base("system"), subtype, content: "" });
  }

  /** A chained record that is not written to the file yet, for simulating appends. */
  next(kind: "user" | "assistant", text: string): Rec {
    return kind === "user" ? this.user(text) : this.assistant(text);
  }

  text(recs: Rec[] = this.recs): string {
    return recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  }

  write(dir: string): string {
    const file = path.join(dir, `${this.sessionId}.jsonl`);
    fs.writeFileSync(file, this.text());
    return file;
  }
}

export function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

export function records(file: string): Rec[] {
  return lines(file).map((l) => JSON.parse(l));
}

/** Walk parentUuid back from the last conversation record; returns the uuids passed. */
export function chainFromLeaf(recs: Rec[]): string[] {
  const byUuid = new Map(recs.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  let leaf: Rec | undefined;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!;
    if (r.uuid && !r.isSidechain && (r.type === "user" || r.type === "assistant")) {
      leaf = r;
      break;
    }
  }
  const walked: string[] = [];
  let cur = leaf;
  while (cur) {
    walked.push(cur.uuid);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return walked;
}
