/**
 * Byte-preservation tests — the data-loss backstop.
 *
 * Surgery rewrites a transcript by cutting old records, injecting ONE recap,
 * and repointing the first survivor's parentUuid. Every OTHER survivor must
 * come back byte-for-byte from the original file. Before the fix, survivors
 * were re-serialized from their parsed form, so:
 *   - an unparseable line (parses to `{}`) was written back as `{}` (data loss);
 *   - even valid lines could drift (key order / unicode escaping).
 * These tests lock both failure modes shut, plus the fail-loud guard for an
 * unparseable FIRST survivor (whose chain can't be safely repaired).
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import crypto from "crypto";
import { performSurgery } from "../src/lib/surgery.js";
import { loadJsonl } from "../src/lib/jsonl.js";
import { SENTINEL, makeWorkspace, type TempWorkspace } from "./helpers.js";

const RECAP_BODY =
  "New recap body for this cycle.\n\n```json\n" +
  JSON.stringify({ sentinel: SENTINEL, voice: "tester", id: "recap-002", version: 1 }) +
  "\n```\n";

let ws: TempWorkspace[] = [];
afterEach(() => {
  for (const w of ws) w.cleanup();
  ws = [];
});

function newWorkspace(content: string): TempWorkspace {
  const w = makeWorkspace(content);
  ws.push(w);
  return w;
}

/**
 * Build a minimal, well-formed record line carrying the carrier fields surgery
 * needs (sessionId, version, cwd, userType, entrypoint, permissionMode, gitBranch).
 */
function recordLine(opts: {
  uuid: string;
  parentUuid: string | null;
  type: "user" | "assistant";
  content: any;
}): string {
  return JSON.stringify({
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    timestamp: "2026-05-07T20:00:00.000Z",
    isSidechain: false,
    sessionId: "11111111-1111-1111-1111-111111111111",
    cwd: "/home/user/project",
    version: "2.1.92",
    gitBranch: "main",
    userType: "external",
    entrypoint: "cli",
    permissionMode: "acceptEdits",
    type: opts.type,
    message: { role: opts.type, content: opts.content },
  });
}

describe("surgery byte-preservation (survivors)", () => {
  it("preserves an unparseable SURVIVOR line byte-for-byte (does NOT turn it into {})", async () => {
    // Cut through u02. Survivors are u03 (first), then a MALFORMED line, then u05.
    const malformed = '{"uuid":"u04","parentUuid":"u03","broken';
    const lines = [
      recordLine({ uuid: "u00", parentUuid: null, type: "user", content: "first message" }),
      recordLine({ uuid: "u01", parentUuid: "u00", type: "assistant", content: "reply" }),
      recordLine({ uuid: "u02", parentUuid: "u01", type: "user", content: "cut here" }),
      recordLine({ uuid: "u03", parentUuid: "u02", type: "assistant", content: "first survivor" }),
      malformed,
      recordLine({ uuid: "u05", parentUuid: "u04", type: "assistant", content: "last survivor" }),
    ];
    const w = newWorkspace(lines.join("\n") + "\n");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u02",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    // The exact malformed line must survive verbatim — NOT be rewritten as "{}".
    const out = fs.readFileSync(w.filePath, "utf8");
    const outLines = out.replace(/\n$/, "").split("\n");
    expect(outLines).toContain(malformed);
    expect(out).not.toContain('\n{}\n');
  });

  it("preserves a valid survivor byte-for-byte (unusual key order + unicode, no drift)", async () => {
    // A survivor line with deliberately unusual key order and a unicode char.
    // Written by hand (not via JSON.stringify of our canonical shape) so any
    // re-serialization would reorder keys / re-escape the unicode and the
    // byte-for-byte assertion would fail.
    const quirky =
      '{"type":"assistant","uuid":"u04","message":{"content":"caf\\u00e9 \\u2014 r\\u00e9sum\\u00e9","role":"assistant"},"parentUuid":"u03","timestamp":"2026-05-07T20:04:00.000Z","sessionId":"11111111-1111-1111-1111-111111111111","version":"2.1.92","cwd":"/home/user/project","userType":"external","entrypoint":"cli","permissionMode":"acceptEdits","gitBranch":"main","isSidechain":false}';
    const lines = [
      recordLine({ uuid: "u00", parentUuid: null, type: "user", content: "first message" }),
      recordLine({ uuid: "u01", parentUuid: "u00", type: "assistant", content: "reply" }),
      recordLine({ uuid: "u02", parentUuid: "u01", type: "user", content: "cut here" }),
      recordLine({ uuid: "u03", parentUuid: "u02", type: "assistant", content: "first survivor" }),
      quirky,
      recordLine({ uuid: "u05", parentUuid: "u04", type: "user", content: "last survivor" }),
    ];
    const w = newWorkspace(lines.join("\n") + "\n");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u02",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const outLines = fs.readFileSync(w.filePath, "utf8").replace(/\n$/, "").split("\n");
    // The quirky survivor line must appear EXACTLY as authored.
    expect(outLines).toContain(quirky);
  });

  it("fails loud (first_survivor_unparseable) and does NOT mutate the file", async () => {
    // The FIRST survivor (index cutIdx+1) is malformed: we cannot repoint its
    // parentUuid safely, so surgery must refuse and leave the file untouched.
    const malformedFirst = '{"uuid":"u03","parentUuid":"u02","broken';
    const lines = [
      recordLine({ uuid: "u00", parentUuid: null, type: "user", content: "first message" }),
      recordLine({ uuid: "u01", parentUuid: "u00", type: "assistant", content: "reply" }),
      recordLine({ uuid: "u02", parentUuid: "u01", type: "user", content: "cut here" }),
      malformedFirst,
      recordLine({ uuid: "u04", parentUuid: "u03", type: "assistant", content: "survivor" }),
    ];
    const w = newWorkspace(lines.join("\n") + "\n");

    const beforeHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(w.filePath))
      .digest("hex");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u02",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("first_survivor_unparseable");

    // File is byte-identical (no mutation, no partial write).
    const afterHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(w.filePath))
      .digest("hex");
    expect(afterHash).toBe(beforeHash);
  });

  it("keeps the recap -> first-survivor -> rest chain intact after a raw-preserving write", async () => {
    const lines = [
      recordLine({ uuid: "u00", parentUuid: null, type: "user", content: "first message" }),
      recordLine({ uuid: "u01", parentUuid: "u00", type: "assistant", content: "reply" }),
      recordLine({ uuid: "u02", parentUuid: "u01", type: "user", content: "cut here" }),
      recordLine({ uuid: "u03", parentUuid: "u02", type: "assistant", content: "first survivor" }),
      recordLine({ uuid: "u04", parentUuid: "u03", type: "user", content: "second survivor" }),
    ];
    const w = newWorkspace(lines.join("\n") + "\n");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u02",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    // No leading recaps in this transcript, so index 0 is the NEW recap.
    expect(out[0]?.uuid).toBe(res.diagnostics.new_recap_uuid);
    expect(out[0]?.parentUuid).toBe(null);
    // The first survivor (formerly u03) now parents the new recap.
    expect(out[1]?.uuid).toBe("u03");
    expect(out[1]?.parentUuid).toBe(res.diagnostics.new_recap_uuid);
    // Full chain unbroken.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.parentUuid).toBe(out[i - 1]?.uuid);
    }
  });

  it("CRLF input produces a consistent CRLF file — no mixed \\r\\n / \\n endings", async () => {
    // Before the eol-detection fix, verbatim survivors kept their \r\n while the
    // re-serialized recap + first survivor were joined with bare \n, producing a
    // mixed-ending file. Real CC transcripts are LF-only, but a stranger's editor
    // or git autocrlf could hand the tool a CRLF transcript; the output must stay
    // single-ending either way.
    const lines = [
      recordLine({ uuid: "u00", parentUuid: null, type: "user", content: "first message" }),
      recordLine({ uuid: "u01", parentUuid: "u00", type: "assistant", content: "reply" }),
      recordLine({ uuid: "u02", parentUuid: "u01", type: "user", content: "cut here" }),
      recordLine({ uuid: "u03", parentUuid: "u02", type: "assistant", content: "first survivor" }),
      recordLine({ uuid: "u04", parentUuid: "u03", type: "user", content: "second survivor" }),
    ];
    const w = newWorkspace(lines.join("\r\n") + "\r\n");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u02",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = fs.readFileSync(w.filePath, "utf8");
    const totalLF = (out.match(/\n/g) || []).length;
    const crlf = (out.match(/\r\n/g) || []).length;
    // Every newline is part of a \r\n pair — no bare \n, no mix.
    expect(crlf).toBeGreaterThan(0);
    expect(crlf).toBe(totalLF);
    // Records still parse and the chain is intact.
    expect(loadJsonl(w.filePath).length).toBe(res.diagnostics.total_lines_after);
  });
});
