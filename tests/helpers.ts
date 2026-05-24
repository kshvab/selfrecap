/**
 * Shared test helpers: locate the fixture, copy it into an isolated temp dir
 * per test so we NEVER mutate the committed fixture, and build a minimal
 * AppConfig pointed at a temp allowed_root.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { loadJsonl, type JsonlRecord } from "../src/lib/jsonl.js";
import type { AppConfig } from "../src/config.js";

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
    server: { port: 9090, host: "127.0.0.1" },
    voices: {},
    allowed_roots: [allowedRootDir],
    expose_paths: false,
    sentinel_name: SENTINEL,
    backup_dir: path.join(allowedRootDir, "backups"),
    ...overrides,
  };
}

/** Serialize records back to JSONL text (matching surgery's format). */
export function toJsonl(records: JsonlRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
