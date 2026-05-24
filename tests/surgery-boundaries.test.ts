/**
 * Boundary / failure tests — the cases where surgery must refuse cleanly,
 * leave the file untouched, or handle degenerate inputs without crashing.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import crypto from "crypto";
import { performSurgery } from "../src/lib/surgery.js";
import {
  SENTINEL,
  makeWorkspace,
  workspaceFromText,
  fixtureText,
  type TempWorkspace,
} from "./helpers.js";

const RECAP_BODY =
  "Recap body.\n\n```json\n" +
  JSON.stringify({ sentinel: SENTINEL, voice: "tester", id: "recap-002", version: 1 }) +
  "\n```\n";

let ws: TempWorkspace[] = [];
afterEach(() => {
  for (const w of ws) w.cleanup();
  ws = [];
});
function track(w: TempWorkspace): TempWorkspace {
  ws.push(w);
  return w;
}

function hash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("surgery boundaries", () => {
  it("cut_through_uuid not found -> ok:false, file untouched", () => {
    const w = track(makeWorkspace());
    const before = hash(w.filePath);
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "uuid-does-not-exist",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("cut_through_uuid not found");
    // No mutation, no backup dir.
    expect(hash(w.filePath)).toBe(before);
    expect(fs.existsSync(w.backupDir)).toBe(false);
  });

  it("cut_through_uuid inside leading recap range + force_overwrite_recap=false -> rejected", () => {
    // The fixture's leading recap is sess-uuid-00. Targeting it should be rejected.
    const w = track(makeWorkspace());
    const before = hash(w.filePath);
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "sess-uuid-00",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      force_overwrite_recap: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/leading recap/i);
    expect(hash(w.filePath)).toBe(before);
  });

  it("recap_content missing the sentinel -> rejected", () => {
    const w = track(makeWorkspace());
    const before = hash(w.filePath);
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "sess-uuid-10",
      recap_content: "Just a plain recap with no sentinel marker at all.",
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(SENTINEL);
    expect(res.diagnostics.sentinel_invariant_passed).toBe(false);
    expect(hash(w.filePath)).toBe(before);
  });

  it("empty file -> handled without crash (cut_through not found)", () => {
    const w = track(workspaceFromText(""));
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "sess-uuid-10",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.total_lines_before).toBe(0);
  });

  it("single-record file -> handled without crash", () => {
    const single = {
      uuid: "only-1",
      parentUuid: null,
      type: "assistant",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] },
    };
    const w = track(workspaceFromText(JSON.stringify(single) + "\n"));
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "only-1",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      dry_run: true,
    });
    // Cut consumes the only record; new recap becomes the single survivor.
    expect(res.ok).toBe(true);
    expect(res.diagnostics.total_lines_after).toBe(1);
  });

  it("all-records-are-recaps file -> cut inside leading recaps is rejected", () => {
    const recapLine = (i: number) =>
      JSON.stringify({
        uuid: `r-${i}`,
        parentUuid: i === 0 ? null : `r-${i - 1}`,
        type: "user",
        message: {
          role: "user",
          content: `recap ${i} {"sentinel":"${SENTINEL}","id":"recap-00${i}"}`,
        },
      });
    const text = [recapLine(0), recapLine(1), recapLine(2)].join("\n") + "\n";
    const w = track(workspaceFromText(text));
    const before = hash(w.filePath);
    // Every record is a leading recap; any cut target sits within them.
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "r-2",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/leading recap/i);
    expect(hash(w.filePath)).toBe(before);
  });

  it("tail_orphan_only: lone tool_use in the final assistant record -> flag true", () => {
    // Build: leading recap (0), a complete pair (1,2), then the cut target (3),
    // then a final assistant record holding a single unmatched tool_use (4).
    // After cutting through uuid-3, survivors = [record 4] -> last record is an
    // assistant with one orphan tool_use and no matching tool_result anywhere.
    const lines = [
      JSON.stringify({
        uuid: "u0",
        parentUuid: null,
        type: "user",
        message: { role: "user", content: `{"sentinel":"${SENTINEL}","id":"recap-001"} leading recap` },
      }),
      JSON.stringify({
        uuid: "u1",
        parentUuid: "u0",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tool_paired", name: "Bash", input: {} }] },
      }),
      JSON.stringify({
        uuid: "u2",
        parentUuid: "u1",
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_paired", content: "ok" }] },
      }),
      JSON.stringify({
        uuid: "u3",
        parentUuid: "u2",
        type: "assistant",
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "cut here" }] },
      }),
      JSON.stringify({
        uuid: "u4",
        parentUuid: "u3",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tool_inflight", name: "Bash", input: { command: "tsx scripts/surgery.ts" } }] },
      }),
    ];
    const w = track(workspaceFromText(lines.join("\n") + "\n"));
    const res = performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "u3",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    const pb = res.diagnostics.pair_balance;
    expect(pb).not.toBeNull();
    expect(pb?.orphans).toBe(1);
    expect(pb?.tail_orphan_only).toBe(true);
  });

  it("file_not_found -> ok:false without crash", () => {
    const w = track(makeWorkspace());
    const missing = w.filePath.replace("session.jsonl", "nope.jsonl");
    const res = performSurgery({
      file_path: missing,
      cut_through_uuid: "sess-uuid-10",
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("file_not_found");
  });

  it("baseline: the committed fixture is never mutated by these tests", () => {
    // Sanity guard — fixtureText reads the real fixture; just confirm it still
    // contains the original recap-001 sentinel and 30 lines.
    const text = fixtureText();
    // The recap JSON lives inside a record's string content, so its quotes are
    // escaped in the raw JSONL line.
    expect(text).toContain('\\"id\\":\\"recap-001\\"');
    expect(text.trim().split("\n").length).toBe(30);
  });
});
