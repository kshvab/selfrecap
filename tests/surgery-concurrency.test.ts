/**
 * Concurrency + safety tests for the file-mutation core.
 *
 * Covers the P1-A hardening:
 *   - per-path mutex serializes concurrent surgeries on the same file (no lost-update)
 *   - mtime re-check aborts when the file changes on disk mid-surgery
 *   - carrier fields are COPIED from a sample record (not hardcoded defaults)
 *   - fail-loud when a required carrier field is absent from every record
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import { performSurgery } from "../src/lib/surgery.js";
import { loadJsonl, isRecapMessage } from "../src/lib/jsonl.js";
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

describe("per-path mutex", () => {
  it("serializes two concurrent surgeries on the same file (both complete, no lost-update)", async () => {
    const w = track(makeWorkspace());

    // Fire two real surgeries concurrently on the SAME file. The first cuts
    // through sess-uuid-10; the second cuts through sess-uuid-20 (still present
    // after the first cut, since survivors start at sess-uuid-11). With the
    // mutex, the second runs only after the first commits and reloads fresh
    // state — so BOTH succeed. Without serialization, one write would clobber
    // the other (lost update) and only one recap would survive.
    //
    // A real yield point is forced inside each critical section (the awaited
    // beforeWrite hook) so that, absent the mutex, both surgeries would load the
    // ORIGINAL file, both pause, then both write — losing one update. The mutex
    // must prevent the second from even loading until the first releases.
    const [a, b] = await Promise.all([
      performSurgery({
        file_path: w.filePath,
        cut_through_uuid: "sess-uuid-10",
        recap_content: RECAP_BODY("recap-A"),
        backup_dir: w.backupDir,
        sentinel_name: SENTINEL,
        __beforeWriteHook: () => new Promise((res) => setTimeout(res, 25)),
      }),
      performSurgery({
        file_path: w.filePath,
        cut_through_uuid: "sess-uuid-20",
        recap_content: RECAP_BODY("recap-B"),
        backup_dir: w.backupDir,
        sentinel_name: SENTINEL,
        __beforeWriteHook: () => new Promise((res) => setTimeout(res, 25)),
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
      if (isRecapMessage(r, SENTINEL)) leading++;
      else break;
    }
    expect(leading).toBe(3);
  });

  it("surgeries on DIFFERENT files run without serializing into each other", async () => {
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

describe("mtime re-check", () => {
  it("aborts with concurrent_modification if the file changes on disk mid-surgery", async () => {
    const w = track(makeWorkspace());
    const before = fs.readFileSync(w.filePath, "utf8");

    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: "sess-uuid-10",
      recap_content: RECAP_BODY("recap-mt"),
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      // Simulate an external writer (e.g. CC appending to the live session)
      // touching the file after surgery loaded it but before it writes. The
      // mtime guard must detect the change and refuse to clobber it.
      __beforeWriteHook: () => {
        const future = new Date(Date.now() + 60_000);
        fs.appendFileSync(w.filePath, "");
        fs.utimesSync(w.filePath, future, future);
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("concurrent_modification");
    // The original content (plus the external writer's no-op append) is intact;
    // surgery did NOT overwrite it.
    expect(fs.readFileSync(w.filePath, "utf8")).toBe(before);
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
    // Drop `gitBranch` from all records — no sample carries it.
    const { gitBranch, ...withoutBranch } = DISTINCT;
    const w = track(workspaceFromText(sessionWith(withoutBranch)));
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
    expect(res.reason).toContain("gitBranch");
    // No mutation: the missing field is caught during planning, before any write.
    expect(fs.readFileSync(w.filePath, "utf8")).toBe(before);
    expect(fs.existsSync(w.backupDir)).toBe(false);
  });
});
