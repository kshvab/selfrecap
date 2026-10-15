/**
 * Concurrency + safety tests for the file-mutation core.
 *
 *   - two surgeries on the same file never interleave (surgery is synchronous
 *     from read to rename), so neither update is lost
 *   - lines appended to the file mid-surgery are carried into the result,
 *     never clobbered
 *   - carrier fields are COPIED from the session's records (not hardcoded defaults)
 *   - fail-loud when a required carrier field is absent from every record
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import { performSurgery } from "../src/lib/surgery.js";
import { loadJsonl } from "../src/lib/jsonl.js";
import { isRecapRecord } from "../src/lib/recaps.js";
import {
  SENTINEL,
  makeWorkspace,
  workspaceFromText,
  type TempWorkspace,
} from "./helpers.js";

const RECAP_BODY = (id: string) =>
  `Recap body ${id}.\n\n` +
  "```json\n" +
  JSON.stringify({ sentinel: SENTINEL, voice: "tester", id, version: 1 }) +
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

describe("same-file surgeries", () => {
  it("two surgeries fired together on the same file both land (no lost update)", async () => {
    const w = track(makeWorkspace());

    // Fire two real surgeries together on the SAME file. The first cuts
    // through sess-uuid-10; the second cuts through sess-uuid-20 (still present
    // after the first cut, since survivors start at sess-uuid-11). Surgery is
    // synchronous from its read to its rename, so the second reads the file
    // the first wrote — and BOTH succeed. Were they to interleave, one write
    // would clobber the other and only one recap would survive.
    const [a, b] = await Promise.all([
      performSurgery({
        file_path: w.filePath,
        cut_through_uuid: "sess-uuid-10",
        recap_content: RECAP_BODY("recap-A"),
        backup_dir: w.backupDir,
        sentinel_name: SENTINEL,
      }),
      performSurgery({
        file_path: w.filePath,
        cut_through_uuid: "sess-uuid-20",
        recap_content: RECAP_BODY("recap-B"),
        backup_dir: w.backupDir,
        sentinel_name: SENTINEL,
      }),
    ]);

    // Both surgeries completed successfully (serialized, not raced).
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.diagnostics.new_recap_uuid).not.toBeNull();
    expect(b.diagnostics.new_recap_uuid).not.toBeNull();

    // Both injected recap UUIDs survive in the final on-disk file. A lost-update
    // race would drop one of them.
    const out = loadJsonl(w.filePath);
    const uuids = new Set(out.map((r) => r.uuid));
    expect(uuids.has(a.diagnostics.new_recap_uuid!)).toBe(true);
    expect(uuids.has(b.diagnostics.new_recap_uuid!)).toBe(true);

    // Two backups were written (one per serialized surgery).
    expect(fs.readdirSync(w.backupDir).length).toBe(2);

    // Final file's leading recaps: original 1 + two injected = 3.
    let leading = 0;
    for (const r of out) {
      if (!r.uuid) continue;
      if (isRecapRecord(r, SENTINEL)) leading++;
      else break;
    }
    expect(leading).toBe(3);
  });

  it("surgeries on DIFFERENT files do not affect each other", async () => {
    const w1 = track(makeWorkspace());
    const w2 = track(makeWorkspace());
    const [a, b] = await Promise.all([
      performSurgery({
        file_path: w1.filePath,
        cut_through_uuid: "sess-uuid-10",
        recap_content: RECAP_BODY("recap-X"),
        backup_dir: w1.backupDir,
        sentinel_name: SENTINEL,
      }),
      performSurgery({
        file_path: w2.filePath,
        cut_through_uuid: "sess-uuid-10",
        recap_content: RECAP_BODY("recap-Y"),
        backup_dir: w2.backupDir,
        sentinel_name: SENTINEL,
      }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});

describe("a writer appending mid-surgery", () => {
  it("has its lines carried into the result, never clobbered", async () => {
    const w = track(makeWorkspace());
    const appended =
      JSON.stringify({ uuid: "late-1", parentUuid: "sess-uuid-29", type: "user", message: { role: "user", content: "late line" } }) + "\n";

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "sess-uuid-10",
      recap_content: RECAP_BODY("recap-mt"),
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      // Simulate Claude Code appending to the live session after surgery read
      // the file but before it swaps the result in.
      hooks: { beforeCheck: (round) => void (round === 1 && fs.appendFileSync(w.filePath, appended)) },
    });

    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.carried_tail_lines).toBe(1);
    expect(fs.readFileSync(w.filePath, "utf8").endsWith(appended)).toBe(true);
  });
});

describe("carrier fields", () => {
  // A session with DISTINCTIVE carrier values that differ from the old hardcoded
  // defaults ("acceptEdits", "external", "cli", "2.1.92", "HEAD"). The new recap
  // must inherit THESE, proving copy-from-sample rather than hardcoding.
  const DISTINCT = {
    permissionMode: "plan",
    userType: "internal",
    entrypoint: "sdk",
    cwd: "/srv/distinct/workdir",
    sessionId: "99999999-aaaa-bbbb-cccc-000000000000",
    version: "9.9.9-distinct",
    gitBranch: "feature/distinct-branch",
  };

  function sessionWith(carrier: Partial<typeof DISTINCT>): string {
    const lines = [
      JSON.stringify({
        uuid: "c0",
        parentUuid: null,
        type: "user",
        ...carrier,
        message: { role: "user", content: `{"sentinel":"${SENTINEL}","id":"recap-001"} leading recap` },
      }),
      JSON.stringify({
        uuid: "c1",
        parentUuid: "c0",
        type: "user",
        ...carrier,
        message: { role: "user", content: "do the thing" },
      }),
      JSON.stringify({
        uuid: "c2",
        parentUuid: "c1",
        type: "assistant",
        ...carrier,
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      }),
    ];
    return lines.join("\n") + "\n";
  }

  it("copies distinctive carrier values from a sample record into the new recap", async () => {
    const w = track(workspaceFromText(sessionWith(DISTINCT)));
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "c2",
      recap_content: RECAP_BODY("recap-002"),
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    const injected = out.find((r) => r.uuid === res.diagnostics.new_recap_uuid);
    expect(injected).toBeDefined();
    // Every carrier field on the injected recap matches the session's distinctive
    // values, NOT the old hardcoded defaults.
    expect(injected!.permissionMode).toBe(DISTINCT.permissionMode);
    expect(injected!.userType).toBe(DISTINCT.userType);
    expect(injected!.entrypoint).toBe(DISTINCT.entrypoint);
    expect(injected!.cwd).toBe(DISTINCT.cwd);
    expect(injected!.sessionId).toBe(DISTINCT.sessionId);
    expect(injected!.version).toBe(DISTINCT.version);
    expect(injected!.gitBranch).toBe(DISTINCT.gitBranch);
  });

  it("fails loud when a required carrier field is absent from every record", async () => {
    // Drop `version` from all records — no sample carries it.
    const { version, ...withoutVersion } = DISTINCT;
    const w = track(workspaceFromText(sessionWith(withoutVersion)));
    const before = fs.readFileSync(w.filePath, "utf8");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "c2",
      recap_content: RECAP_BODY("recap-002"),
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("carrier_field_missing");
    expect(res.reason).toContain("version");
    // No mutation: the missing field is caught during planning, before any write.
    expect(fs.readFileSync(w.filePath, "utf8")).toBe(before);
    expect(fs.existsSync(w.backupDir)).toBe(false);
  });

  it("leaves an optional carrier field out rather than inventing it", async () => {
    const { gitBranch, permissionMode, ...withoutOptional } = DISTINCT;
    const w = track(workspaceFromText(sessionWith(withoutOptional)));
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "c2",
      recap_content: RECAP_BODY("recap-002"),
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok, res.reason).toBe(true);
    const injected = loadJsonl(w.filePath).find((r) => r.uuid === res.diagnostics.new_recap_uuid)!;
    expect("gitBranch" in injected).toBe(false);
    expect("permissionMode" in injected).toBe(false);
    expect(injected.version).toBe(DISTINCT.version);
  });
});
