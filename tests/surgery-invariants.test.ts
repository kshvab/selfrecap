/**
 * Invariant tests — the credibility core. After surgery the resulting file must
 * preserve the chain, never dangle into the cut range, keep tool pairs balanced,
 * and preserve leading recaps.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import { performSurgery } from "../src/lib/surgery.js";
import { loadJsonl } from "../src/lib/jsonl.js";
import { isRecapRecord } from "../src/lib/recaps.js";
import {
  FIXTURE_PATH,
  SENTINEL,
  fixtureRecords,
  makeWorkspace,
  type TempWorkspace,
} from "./helpers.js";

const RECAP_BODY =
  "New recap body for this cycle.\n\n```json\n" +
  JSON.stringify({ sentinel: SENTINEL, voice: "tester", id: "recap-002", version: 1 }) +
  "\n```\n";

// Cut at sess-uuid-10: a clean end_turn assistant after the recap and after two
// complete tool pairs (so no pair is split by the cut).
const CUT_UUID = "sess-uuid-10";

let ws: TempWorkspace[] = [];
afterEach(() => {
  for (const w of ws) w.cleanup();
  ws = [];
});

function newWorkspace(): TempWorkspace {
  const w = makeWorkspace();
  ws.push(w);
  return w;
}

describe("surgery invariants (dry run)", () => {
  it("reports a valid plan without mutating the file", async () => {
    const w = newWorkspace();
    const before = fs.readFileSync(w.filePath, "utf8");
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(true);
    // No mutation in dry run.
    expect(fs.readFileSync(w.filePath, "utf8")).toBe(before);
    expect(fs.existsSync(w.backupDir)).toBe(false);
  });
});

describe("surgery invariants (real)", () => {
  it("parentUuid chain is unbroken from new recap to last surviving record", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    // Walk the chain: each record's parentUuid must equal the previous uuid.
    // Index 0 is the preserved leading recap (parentUuid null).
    expect(out[0]?.parentUuid).toBe(null);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.parentUuid).toBe(out[i - 1]?.uuid);
    }
  });

  it("no surviving record points at a uuid that was in the cut range", async () => {
    const w = newWorkspace();
    // Cut range (after the leading recap) is sess-uuid-01..sess-uuid-10 inclusive.
    const cutRangeUuids = new Set(
      fixtureRecords()
        .slice(1, 11)
        .map((r) => r.uuid)
        .filter((u): u is string => typeof u === "string"),
    );
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    for (const r of out) {
      if (r.parentUuid) {
        expect(cutRangeUuids.has(r.parentUuid)).toBe(false);
      }
    }
  });

  it("tool_use ids match tool_result ids (zero orphans) for a non-splitting cut", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.pair_balance).not.toBeNull();
    expect(res.diagnostics.pair_balance?.orphans).toBe(0);

    // Independently confirm the id sets are equal in the written file.
    const out = loadJsonl(w.filePath);
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const r of out) {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "tool_use" && b.id) useIds.add(b.id);
          if (b?.type === "tool_result" && b.tool_use_id) resultIds.add(b.tool_use_id);
        }
      }
    }
    expect([...useIds].sort()).toEqual([...resultIds].sort());
  });

  it("preserves N leading recaps and inserts one more (N -> N+1)", async () => {
    const w = newWorkspace();
    // Fixture has exactly 1 leading recap.
    const leadingBefore = 1;
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.leading_recaps_preserved).toBe(leadingBefore);

    const out = loadJsonl(w.filePath);
    // Count consecutive leading recaps in the output, using the same detection
    // the library uses (getRecordText, not raw JSON which escapes the quotes).
    let count = 0;
    for (const r of out) {
      if (!r.uuid) continue;
      if (isRecapRecord(r, SENTINEL)) count++;
      else break;
    }
    expect(count).toBe(leadingBefore + 1);
  });

  it("new_recap_position equals leading_recaps_preserved", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.new_recap_position).toBe(res.diagnostics.leading_recaps_preserved);

    // And the new recap really sits at that index in the output.
    const out = loadJsonl(w.filePath);
    const pos = res.diagnostics.new_recap_position!;
    expect(out[pos]?.uuid).toBe(res.diagnostics.new_recap_uuid);
  });

  it("writes a backup of the original before mutating", async () => {
    const w = newWorkspace();
    const originalText = fs.readFileSync(FIXTURE_PATH, "utf8");
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(w.backupDir)).toBe(true);
    const backups = fs.readdirSync(w.backupDir);
    expect(backups.length).toBe(1);
    // The backup is the pre-surgery content (== the fixture we copied in).
    const backupText = fs.readFileSync(`${w.backupDir}/${backups[0]}`, "utf8");
    expect(backupText).toBe(originalText);
  });
});
