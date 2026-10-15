/**
 * Surgery on synthetic sessions shaped like real ones: header records, a
 * recap stack, metadata lines at turn boundaries, tool calls. Covers the
 * re-parenting by chain, the checks against the voice's recap stack, and the
 * swap under a live session (appends carried over, rewrites stopped, the
 * rename retried while another handle holds the file).
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { performSurgery, type SurgeryRequest } from "../src/lib/surgery.js";
import { SENTINEL, Session, chainFromLeaf, lines, recapText, records, tmpDir, type Rec } from "./helpers.js";

/** Two headers, two recaps, then a conversation with a metadata line at the turn boundary. */
function alice() {
  const s = new Session();
  s.meta("mode", { mode: "normal" });
  s.meta("permission-mode", { permissionMode: "bypassPermissions" });
  const r1 = s.recap("alice", "alice-recap-001");
  const r2 = s.recap("alice", "alice-recap-002");
  const u1 = s.user("first task");
  const a1 = s.assistant("done with the first task");
  const t1 = s.system("turn_duration");
  s.meta("last-prompt", { lastPrompt: "first task" });
  const u2 = s.user("new arc starts here");
  const a2 = s.assistant("on it");
  const u3 = s.user("more");
  const a3 = s.assistant("more done");
  return { s, r1, r2, u1, a1, t1, u2, a2, u3, a3 };
}

function run(file: string, dir: string, over: Partial<SurgeryRequest> & { cut: string; id?: string }) {
  const { cut, id, ...rest } = over;
  return performSurgery({
    file_path: file,
    cut_through_uuid: cut,
    recap_content: recapText("alice", id ?? "alice-recap-003", cut),
    voice: "alice",
    backup_dir: path.join(dir, "backups"),
    sentinel_name: SENTINEL,
    expose_paths: true,
    ...rest,
  });
}

function backupsOf(dir: string, voice = "alice"): string[] {
  const d = path.join(dir, "backups", voice);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}

function noTmp(file: string) {
  const left = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".surgery.tmp"));
  expect(left, "no tmp file left behind").toEqual([]);
}

describe("surgery: cut, chain, stack", () => {
  it("cuts after the stack, keeps header and recap bytes, and chains the new recap", () => {
    const dir = tmpDir();
    const { s, r2, t1, u2 } = alice();
    const file = s.write(dir);
    const before = lines(file);

    const res = run(file, dir, { cut: t1.uuid });
    expect(res.ok, res.reason).toBe(true);
    const d = res.diagnostics;
    expect(d.leading_recaps_preserved).toBe(2);
    expect(d.new_recap_position).toBe(4);
    expect(d.recap_id).toBe("alice-recap-003");
    expect(d.chain_reaches_recap).toBe(true);
    expect(d.repointed_records).toBe(1);

    const after = lines(file);
    expect(after.slice(0, 4), "headers and earlier recaps are byte-identical").toEqual(before.slice(0, 4));
    const recs = records(file);
    const recap = recs[4]!;
    expect(recap.uuid).toBe(d.new_recap_uuid);
    expect(recap.parentUuid).toBe(r2.uuid);
    expect(typeof recap.message.content).toBe("string");
    expect(recap.sessionId).toBe(s.sessionId);
    // last-prompt (uuid-less) survives unchanged; u2 now hangs off the recap.
    expect(after[5]).toBe(before[7]);
    expect(recs.find((r) => r.uuid === u2.uuid)!.parentUuid).toBe(d.new_recap_uuid);
    expect(chainFromLeaf(recs)).toContain(d.new_recap_uuid!);
    // Records after the re-parented one are byte-identical.
    expect(after.slice(7)).toEqual(before.slice(9));

    const backups = backupsOf(dir);
    expect(backups.length).toBe(1);
    expect(backups[0]!).toMatch(new RegExp(`^alice-${s.sessionId}-pre-surgery-.*\\.jsonl$`));
    expect(fs.readFileSync(path.join(dir, "backups", "alice", backups[0]!), "utf8")).toBe(before.join("\n") + "\n");
    expect(path.isAbsolute(d.backup_path!)).toBe(true);
    noTmp(file);
  });

  it("seam regression: a metadata line right after the cut no longer strands the conversation", () => {
    // Before 1.1 the repair edited the next LINE (here: last-prompt) and left
    // u2 pointing at the cut record, so a resumed session never reached its recaps.
    const dir = tmpDir();
    const s = new Session();
    s.recap("alice", "alice-recap-001");
    s.user("u1");
    const a1 = s.assistant("a1");
    s.meta("last-prompt", { lastPrompt: "u1" });
    s.meta("file-history-snapshot", { messageId: "m1" });
    const u2 = s.user("u2");
    s.assistant("a2");
    const file = s.write(dir);

    const res = run(file, dir, { cut: a1.uuid, id: "alice-recap-002" });
    expect(res.ok, res.reason).toBe(true);
    const recs = records(file);
    expect(recs.find((r) => r.uuid === u2.uuid)!.parentUuid).toBe(res.diagnostics.new_recap_uuid);
    const walked = chainFromLeaf(recs);
    expect(walked).toContain(res.diagnostics.new_recap_uuid!);
    expect(recs.find((r) => r.uuid === walked[walked.length - 1])!.message.content).toContain("alice-recap-001");
  });

  it("refuses a cut that separates a tool_use from its surviving tool_result, and changes nothing", () => {
    const dir = tmpDir();
    const s = new Session();
    s.user("run it");
    const use = s.toolUse("toolu_1");
    s.toolResult("toolu_1", "ok");
    s.assistant("ran it");
    const file = s.write(dir);
    const before = fs.readFileSync(file);

    const res = run(file, dir, { cut: use.uuid, id: "alice-recap-001" });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^cut_splits_tool_call/);
    expect(res.diagnostics.cut_orphaned_tool_results).toEqual(["toolu_1"]);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(backupsOf(dir)).toEqual([]);
  });

  it("refuses when the chain is already broken past the cut", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    s.recs[s.recs.length - 1]!.parentUuid = "00000000-0000-4000-8000-000000000000";
    const file = s.write(dir);

    const res = run(file, dir, { cut: a1.uuid });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^chain_broken/);
    expect(res.diagnostics.chain_reaches_recap).toBe(false);
    expect(res.diagnostics.chain_break?.reason).toBe("missing_parent");
  });

  it("checks the sentinel against the voice's stack", () => {
    const dir = tmpDir();
    const { s, a1, r2 } = alice();
    const file = s.write(dir);

    const wrongNumber = run(file, dir, { cut: a1.uuid, id: "alice-recap-001" });
    expect(wrongNumber.ok).toBe(false);
    expect(wrongNumber.reason!).toMatch(/^sentinel_id_mismatch.*alice-recap-003/);

    const wrongVoice = run(file, dir, { cut: a1.uuid, recap_content: recapText("bob", "alice-recap-003", a1.uuid), dry_run: true });
    expect(wrongVoice.ok).toBe(false);
    expect(wrongVoice.reason!).toMatch(/^sentinel_voice_mismatch/);

    // A genuine repeat: the same id and the same cut point as the applied recap.
    const r2Cut = JSON.parse(/\{[\s\S]*\}/.exec(r2.message.content)![0]).cut_through_uuid;
    const repeat = run(file, dir, { cut: r2Cut, id: "alice-recap-002" });
    expect(repeat.ok).toBe(false);
    expect(repeat.reason!).toMatch(/^already_applied/);
    // An earlier recap's sentinel reused in a new body: same id, a cut point that is gone.
    const reused = run(file, dir, { cut: "11111111-1111-4111-8111-111111111111", id: "alice-recap-002" });
    expect(reused.ok).toBe(false);
    expect(reused.reason!).toMatch(/^sentinel_id_taken: .*"id": "alice-recap-003"/);
  });

  it("a record that only quotes the sentinel is not a recap; a stray real recap needs --force", () => {
    const dir = tmpDir();
    const s = new Session();
    s.user("read the old body");
    s.toolUse("toolu_r");
    s.toolResult("toolu_r", recapText("alice", "alice-recap-009", "x"));
    const a = s.assistant("read it");
    s.user("go on");
    s.assistant("ok");
    let file = s.write(dir);

    const quoted = run(file, dir, { cut: a.uuid, id: "alice-recap-001", dry_run: true });
    expect(quoted.ok, quoted.reason).toBe(true);
    expect(quoted.diagnostics.cut_range_has_existing_recap).toBe(false);

    const s2 = new Session();
    s2.user("start");
    s2.assistant("ok");
    s2.user(recapText("alice", "alice-recap-007", "y"));
    const a2 = s2.assistant("noted");
    s2.user("next");
    s2.assistant("ok");
    file = s2.write(dir);
    const refused = run(file, dir, { cut: a2.uuid, id: "alice-recap-001", dry_run: true });
    expect(refused.ok).toBe(false);
    expect(refused.reason!).toMatch(/^cut_range_contains_recap/);
    expect(refused.diagnostics.cut_range_has_existing_recap).toBe(true);
    const forced = run(file, dir, { cut: a2.uuid, id: "alice-recap-001", dry_run: true, force_overwrite_recap: true });
    expect(forced.ok, forced.reason).toBe(true);
  });

  it("any recap pasted into the conversation is protected, whoever signed it", () => {
    const dir = tmpDir();
    const s = new Session();
    s.user("start");
    s.user(recapText("bob", "bob-recap-003", "x"));
    const a = s.assistant("noted");
    s.user("next");
    s.assistant("ok");
    const file = s.write(dir);
    const res = run(file, dir, { cut: a.uuid, id: "alice-recap-001", dry_run: true });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(
      /^cut_range_contains_recap: line 1 \(.+, "Hey bob\. Operator here\..*"\) is a user message carrying a recap sentinel \(bob-recap-003\)/,
    );
  });

  it("another voice's recap at the head is part of the stack: it is kept, never cut", () => {
    const dir = tmpDir();
    const s = new Session();
    const theirs = s.recap("bob", "bob-recap-004");
    s.user("hello");
    const a = s.assistant("hi");
    s.user("more");
    s.assistant("ok");
    const file = s.write(dir);
    // Numbered from the whole stack: the last there is 004, so this is 005.
    const res = run(file, dir, { cut: a.uuid, id: "alice-recap-005" });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.leading_recaps_preserved).toBe(1);
    expect(records(file)[0]!.uuid).toBe(theirs.uuid);
  });

  it("a cut inside the recap stack is refused without pointing at --force", () => {
    const dir = tmpDir();
    const { s, r1 } = alice();
    const file = s.write(dir);
    const res = run(file, dir, { cut: r1.uuid });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^cut_inside_recap_stack/);
    expect(res.reason!).not.toMatch(/force/i);
  });

  it("refuses a frozen ancestor behind a broken continuation link", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const before = fs.readFileSync(file);
    const res = run(file, dir, { cut: a1.uuid, broken_link: "22222222-2222-4222-8222-222222222222" });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^continuation_broken/);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("dry run writes nothing", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const before = fs.readFileSync(file);
    const res = run(file, dir, { cut: a1.uuid, dry_run: true });
    expect(res.ok, res.reason).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
    noTmp(file);
  });

  it("keeps an unparseable line byte for byte instead of writing {}", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const text = fs.readFileSync(file, "utf8").split("\n");
    text.splice(text.length - 2, 0, "this line is not JSON {");
    fs.writeFileSync(file, text.join("\n"));

    const res = run(file, dir, { cut: a1.uuid });
    expect(res.ok, res.reason).toBe(true);
    const after = lines(file);
    expect(after).toContain("this line is not JSON {");
    expect(after).not.toContain("{}");
  });

  it("the new record takes its metadata from the latest conversation record, not from the recaps", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    s.recs.forEach((r: Rec) => {
      if (r.type === "user" && typeof r.message?.content === "string" && r.message.content.includes(SENTINEL)) {
        r.version = "2.0.1";
        r.permissionMode = "acceptEdits";
      }
    });
    const file = s.write(dir);
    const res = run(file, dir, { cut: a1.uuid });
    expect(res.ok, res.reason).toBe(true);
    const recap = records(file).find((r) => r.uuid === res.diagnostics.new_recap_uuid)!;
    expect(recap.version).toBe("2.1.280");
    expect("permissionMode" in recap).toBe(false);
  });

  it("refuses a cut through the boundary message whose reply survives; its parent is the right cut", () => {
    const dir = tmpDir();
    const { s, t1, u2 } = alice();
    const file = s.write(dir);
    const onMessage = run(file, dir, { cut: u2.uuid, dry_run: true });
    expect(onMessage.ok).toBe(false);
    expect(onMessage.reason!).toMatch(/^cut_is_user_message/);
    expect(onMessage.reason!, "names the parent to cut through instead").toContain(t1.uuid);
    const onParent = run(file, dir, { cut: u2.parentUuid, dry_run: true });
    expect(onParent.ok, onParent.reason).toBe(true);
    expect(onParent.diagnostics.cut_through_record).toEqual({ type: "system/turn_duration", preview: "" });
  });

  it("a user message with no assistant reply (an interrupt line) is a valid cut", () => {
    const dir = tmpDir();
    const s = new Session();
    s.user("do the thing");
    s.assistant("starting");
    const interrupt = s.user("[Request interrupted by user]");
    s.user("new arc: something else");
    s.assistant("on it");
    const file = s.write(dir);
    const res = run(file, dir, { cut: interrupt.uuid, id: "alice-recap-001", dry_run: true });
    expect(res.ok, res.reason).toBe(true);
  });

  it("the boundary-message refusal sees a reply that hangs off an attachment, as in real files", () => {
    const dir = tmpDir();
    const s = new Session();
    s.user("old arc");
    s.assistant("done");
    s.system("turn_duration");
    const boundary = s.user("new arc starts here");
    const attachment = { ...s.system("x"), type: "attachment", subtype: undefined };
    s.recs[s.recs.length - 1] = attachment;
    s.assistant("on it");
    const file = s.write(dir);
    const res = run(file, dir, { cut: boundary.uuid, id: "alice-recap-001", dry_run: true });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^cut_is_user_message/);
  });

  it("ids compare case-insensitively; the wrong voice is caught before the cut lookup", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const upper = run(file, dir, { cut: a1.uuid, id: "Alice-Recap-003", dry_run: true });
    expect(upper.ok, upper.reason).toBe(true);
    const otherVoice = run(file, dir, {
      cut: "33333333-3333-4333-8333-333333333333",
      recap_content: recapText("bob", "bob-recap-007", "33333333-3333-4333-8333-333333333333"),
      dry_run: true,
    });
    expect(otherVoice.reason!).toMatch(/^sentinel_voice_mismatch: this body is signed "bob"/);
  });

  it("other refusals: sentinel cut mismatch, missing file, and a backup that cannot be written", () => {
    const dir = tmpDir();
    const { s, a1, t1 } = alice();
    const file = s.write(dir);
    const before = fs.readFileSync(file);

    const cutMismatch = run(file, dir, { cut: a1.uuid, recap_content: recapText("alice", "alice-recap-003", t1.uuid), dry_run: true });
    expect(cutMismatch.reason!).toMatch(/^sentinel_cut_mismatch/);

    const missing = run(path.join(dir, "nope.jsonl"), dir, { cut: a1.uuid });
    expect(missing.reason).toBe("file_not_found");

    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "a file where the backup folder should be");
    const noBackup = run(file, dir, { cut: a1.uuid, backup_dir: blocker });
    expect(noBackup.ok).toBe(false);
    expect(noBackup.reason!).toMatch(/^backup_failed: .*Nothing was changed\.$/);
    expect(fs.readFileSync(file)).toEqual(before);
    noTmp(file);
  });

  it("a sentinel without an id still applies, with a warning naming the id to use", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const res = run(file, dir, {
      cut: a1.uuid,
      recap_content: `Hey alice. Operator here. A body whose sentinel forgot its id entirely.\n{"sentinel":"${SENTINEL}","voice":"alice","cut_through_uuid":"${a1.uuid}"}`,
      dry_run: true,
    });
    expect(res.ok, res.reason).toBe(true);
    expect(res.warnings.some((w) => w.includes('"id": "alice-recap-003"'))).toBe(true);
  });

  it("without expose_paths, diagnostics carry base names only", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const res = run(file, dir, { cut: a1.uuid, expose_paths: false });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.file_path).toBe(path.basename(file));
    expect(path.isAbsolute(res.diagnostics.backup_path!)).toBe(false);
  });
});

describe("surgery: backups", () => {
  it("rotation gzips the voice's older backups beyond the newest three, and touches nothing else", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const aliceDir = path.join(dir, "backups", "alice");
    const bobDir = path.join(dir, "backups", "bob");
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.mkdirSync(bobDir, { recursive: true });
    const old = ["01", "02", "03", "04"].map((m) => `alice-${s.sessionId}-pre-surgery-2026-${m}-01T00-00-00-000Z.jsonl`);
    old.forEach((f, i) => fs.writeFileSync(path.join(aliceDir, f), `backup ${i}\n`));
    fs.writeFileSync(path.join(bobDir, "bob-x-pre-surgery-2026-01-01T00-00-00-000Z.jsonl"), "bob\n");
    fs.writeFileSync(path.join(dir, "backups", "flat-pre-surgery-2026-01-01T00-00-00-000Z.jsonl"), "flat\n");

    const res = run(file, dir, { cut: a1.uuid });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.backups_compressed.sort()).toEqual([old[0], old[1]].sort());
    const now = fs.readdirSync(aliceDir).sort();
    expect(now.filter((f) => f.endsWith(".jsonl")).length).toBe(3);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(aliceDir, `${old[0]}.gz`))).toString()).toBe("backup 0\n");
    expect(fs.readdirSync(bobDir)).toEqual(["bob-x-pre-surgery-2026-01-01T00-00-00-000Z.jsonl"]);
    expect(fs.existsSync(path.join(dir, "backups", "flat-pre-surgery-2026-01-01T00-00-00-000Z.jsonl"))).toBe(true);
  });

  it("a backup that fails partway is removed, never left looking like a backup", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const before = fs.readFileSync(file);
    const realFsync = fs.fsyncSync;
    let calls = 0;
    (fs as any).fsyncSync = (fd: number) => {
      if (++calls === 1) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      return realFsync(fd);
    };
    let res: ReturnType<typeof performSurgery>;
    try {
      res = run(file, dir, { cut: a1.uuid });
    } finally {
      (fs as any).fsyncSync = realFsync;
    }
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^backup_failed: no space left on device\. Nothing was changed\.$/);
    expect(backupsOf(dir), "no partial backup left behind").toEqual([]);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

describe("surgery: the swap under a live session", () => {
  it("carries lines the live session appends during the swap", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const original = fs.readFileSync(file, "utf8");
    const late1 = s.next("user", "typed while surgery ran");
    const late2 = s.next("assistant", "answered while surgery ran");
    const appended = s.text([late1, late2]);

    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: { beforeCheck: (round) => void (round === 1 && fs.appendFileSync(file, appended)) },
    });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.carried_tail_lines).toBe(2);
    const after = fs.readFileSync(file, "utf8");
    expect(after.endsWith(appended), "appended lines are at the end of the new file").toBe(true);
    expect(chainFromLeaf(records(file))).toContain(res.diagnostics.new_recap_uuid!);
    const backup = fs.readFileSync(res.diagnostics.backup_path!, "utf8");
    expect(backup, "backup = the file as it was at the swap").toBe(original + appended);
  });

  it("waits out a half-written last line instead of dropping or mangling it", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const late = JSON.stringify(s.next("assistant", "a line Claude Code is still writing"));
    fs.appendFileSync(file, late.slice(0, 40));

    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: { beforeCheck: (round) => void (round === 2 && fs.appendFileSync(file, late.slice(40) + "\n")) },
    });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.carried_tail_lines).toBe(1);
    expect(res.diagnostics.rename_attempts).toBe(1);
    const after = lines(file);
    expect(after[after.length - 1]).toBe(late);
    expect(after).not.toContain("{}");
  });

  it("a round that sees new lines carries them and looks again before renaming", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const batches = [s.text([s.next("user", "first burst")]), s.text([s.next("assistant", "second burst")])];
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: { beforeCheck: (round) => void (round <= 2 && fs.appendFileSync(file, batches[round - 1]!)) },
    });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.carried_tail_lines).toBe(2);
    expect(fs.readFileSync(file, "utf8").endsWith(batches.join(""))).toBe(true);
  });

  it("stops, and changes nothing, if the file shrinks during surgery", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    let truncated: Buffer | null = null;
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: {
        beforeCheck: () => {
          const b = fs.readFileSync(file);
          truncated = b.subarray(0, Math.floor(b.length / 2));
          fs.writeFileSync(file, truncated);
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^not_applied: the live file shrank/);
    expect(fs.readFileSync(file)).toEqual(truncated);
    expect(fs.existsSync(res.diagnostics.backup_path!), "the verified copy stays").toBe(true);
    noTmp(file);
  });

  it("stops if bytes before the read point change (a rewrite, not an append)", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: {
        beforeCheck: (round) => {
          if (round !== 1) return;
          const text = fs.readFileSync(file, "utf8");
          fs.writeFileSync(file, text.replace("more done", "MORE DONE") + '{"type":"x"}\n');
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^not_applied: the live file changed/);
    noTmp(file);
  });

  it("stops on a same-size rewrite far before the read point (not just the last few KiB)", () => {
    const dir = tmpDir();
    const s = new Session();
    s.recap("alice", "alice-recap-001");
    s.user("EARLY MARKER message that will be rewritten in place");
    const early = s.assistant("x".repeat(20000));
    for (let i = 0; i < 20; i++) {
      s.user(`later message ${i} ${"y".repeat(500)}`);
      s.assistant(`later reply ${i} ${"z".repeat(500)}`);
    }
    const file = s.write(dir);
    expect(fs.statSync(file).size).toBeGreaterThan(40000);
    const res = run(file, dir, {
      cut: early.uuid,
      id: "alice-recap-002",
      hooks: {
        beforeCheck: (round) => {
          if (round === 1) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("EARLY MARKER", "early marker"));
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^not_applied: the live file changed/);
    expect(fs.readFileSync(file, "utf8"), "the rewritten file was left as it was").toContain("early marker");
    noTmp(file);
  });

  it("carried lines that vanish from the live file (a record deleted mid-swap) stop the surgery", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const original = fs.readFileSync(file, "utf8");
    const A = s.text([s.next("user", "record A, deleted a moment later")]);
    const B = s.text([s.next("assistant", "record B")]);
    const D = s.text([s.next("user", "record D, appended after the deletion")]);
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: {
        beforeCheck: (round) => {
          if (round === 1) fs.appendFileSync(file, A + B);
          if (round === 2) fs.writeFileSync(file, original + B + D);
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^not_applied: the live file (lost lines|changed)/);
    expect(fs.readFileSync(file, "utf8"), "the live file is left as Claude Code wrote it").toBe(original + B + D);
    noTmp(file);
  });

  it("a line that reaches the old file in the instant before the rename is recovered through the side link", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    const original = fs.readFileSync(file, "utf8");
    const late = s.text([s.next("user", "written between the last check and the rename")]);
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: { beforeRename: (attempt) => void (attempt === 1 && fs.appendFileSync(file, late)) },
    });
    expect(res.ok, res.reason).toBe(true);
    expect(res.diagnostics.carried_tail_lines).toBe(1);
    expect(fs.readFileSync(file, "utf8").endsWith(late), "the late line is in the new file").toBe(true);
    expect(fs.readFileSync(res.diagnostics.backup_path!, "utf8"), "and in the backup").toBe(original + late);
    expect(chainFromLeaf(records(file))).toContain(res.diagnostics.new_recap_uuid!);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".side") || f.endsWith(".tmp")), "no side link or tmp left").toEqual([]);
  });

  it("retries the rename while another handle holds the file (EPERM on Windows)", () => {
    const dir = tmpDir();
    const { s, a1 } = alice();
    const file = s.write(dir);
    let fd: number | null = null;
    const res = run(file, dir, {
      cut: a1.uuid,
      hooks: {
        beforeRename: (attempt) => {
          if (attempt === 1) fd = fs.openSync(file, "r");
        },
        beforeCheck: (round) => {
          if (round === 2 && fd !== null) {
            fs.closeSync(fd);
            fd = null;
          }
        },
      },
    });
    if (fd !== null) fs.closeSync(fd);
    expect(res.ok, res.reason).toBe(true);
    if (process.platform === "win32") expect(res.diagnostics.rename_attempts).toBe(2);
    expect(chainFromLeaf(records(file))).toContain(res.diagnostics.new_recap_uuid!);
    noTmp(file);
  });

  it.skipIf(process.platform !== "win32")(
    "when the rename never succeeds, the live file keeps everything it had: no restore from the older backup",
    () => {
      const dir = tmpDir();
      const { s, a1 } = alice();
      const file = s.write(dir);
      const late = s.text([s.next("user", "written after the backup")]);
      let fd: number | null = null;
      const res = run(file, dir, {
        cut: a1.uuid,
        hooks: {
          beforeCheck: (round) => {
            if (round === 1) fs.appendFileSync(file, late);
          },
          beforeRename: (attempt) => {
            if (attempt === 1) fd = fs.openSync(file, "r");
          },
        },
      });
      if (fd !== null) fs.closeSync(fd);
      expect(res.ok).toBe(false);
      expect(res.reason!).toMatch(/^not_applied: another process kept the live file open/);
      expect(fs.readFileSync(file, "utf8").endsWith(late), "the line written after the backup is still there").toBe(true);
      noTmp(file);
    },
  );
});
