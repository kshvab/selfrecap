/**
 * Surgery — cut a session at a chosen record, inject a recap in its place,
 * and swap the result in without losing what the live session writes
 * meanwhile.
 *
 * Layout after surgery:
 *
 *   [leading region]  header records + the earlier recaps, bytes untouched
 *   [new recap]       parentUuid → the last earlier recap (or null)
 *   [survivors]       records after the cut, bytes untouched except re-parented ones
 *   [carried tail]    lines Claude Code appended while surgery ran
 *
 * Checked before anything is written (a dry run reports the same):
 *   - the body carries a recap sentinel (config.sentinel_name) that parses
 *     (the last one in the body counts), and for a voice its id is the next
 *     one in that voice's recap stack;
 *   - the cut is after the leading region and deletes no other recap
 *     (unless force_overwrite_recap);
 *   - every survivor whose parent was cut now points at the new recap, and the
 *     chain from the conversation's last record reaches the new recap. Before
 *     1.1 only the next LINE was re-parented; when that line was metadata
 *     (last-prompt, file-history-snapshot) the resumed session never reached
 *     its recaps;
 *   - the cut separates no tool_use from a surviving tool_result;
 *   - the file is not a frozen ancestor behind a broken continuation link.
 *
 * The swap, while the session keeps writing (self-surgery: the Bash call
 * running this belongs to the file being cut):
 *   - Claude Code appends by path in bursts about every 100 ms and holds no
 *     handle in between. It takes no lock and drops a batch whose write fails,
 *     so we take no lock either.
 *   - The file is read once. The backup is written from exactly those bytes,
 *     fsynced and read back.
 *   - Then the file is checked in rounds. Complete lines appended since the
 *     read are carried into the new file and the round starts over; a
 *     half-written line is waited out. The rename happens only in a round
 *     that saw nothing new, right after checking that every byte surgery read
 *     is still there. A file that shrank or changed before the read point
 *     stops the surgery.
 *   - The live file only ever changes by rename. Windows refuses a rename while
 *     any process has the file open (EPERM), so the rename is retried, the
 *     rounds continuing meanwhile. On failure the tmp is removed and the live
 *     file is left exactly as it was. It is never "restored" from the older
 *     backup: that would erase whatever the session had written since.
 *   - The last gap, between the final size check and the rename, is closed
 *     with a side hard link to the live file: after the rename it still
 *     reaches the old file, so any line that landed there in that instant is
 *     recovered and appended to the new file.
 *
 * Surgery is synchronous from the first read to the rename, so two surgeries
 * in this process can never interleave.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getRecordText, readSessionBytes, type JsonlRecord, type SessionBytes } from "./jsonl.js";
import {
  GENERATED_USER_TEXT,
  formatRecapId,
  isRecapRecord,
  nextRecapNumber,
  parseSentinel,
  scanRecapStack,
} from "./recaps.js";
import { backupPathFor, rotateVoiceBackups, writeVerifiedBackup } from "./backups.js";
import { readRange, sleepSync, writeDurable } from "./fsutil.js";

/** Test seams. Never set in production. */
export interface SurgeryHooks {
  /** After the live file has been read, before anything else. */
  afterRead?: () => void;
  /** At the start of each swap round (1-based), before the file is re-checked. */
  beforeCheck?: (round: number) => void;
  /** Right before each rename attempt (1-based). */
  beforeRename?: (attempt: number) => void;
}

export interface SurgeryRequest {
  /** The live session file (already resolved through continuations). */
  file_path: string;
  cut_through_uuid: string;
  recap_content: string;
  /** Config key of the voice, when the file was resolved through config. */
  voice?: string;
  backup_dir: string;
  /** Configured recap sentinel marker name (config.sentinel_name). */
  sentinel_name: string;
  /**
   * When false (the default), filesystem paths in the diagnostics and messages
   * are cut to their base names, so a misconfigured clone cannot leak the
   * home directory layout. See config.expose_paths.
   */
  expose_paths?: boolean;
  /** Skip mutation, return diagnostics only. */
  dry_run?: boolean;
  /** Allow the cut range to contain a recap record outside the leading stack. */
  force_overwrite_recap?: boolean;
  /** Set when the voice's continuation chain names a successor whose file is gone. */
  broken_link?: string;
  hooks?: SurgeryHooks;
}

export interface ChainBreak {
  reason: "missing_parent" | "root_without_recap" | "cycle";
  /** The record where the walk stopped (line index in the resulting file). */
  line_idx: number | null;
  uuid: string;
  missing_parent: string | null;
}

export interface SurgeryDiagnostics {
  file_path: string;
  backup_path: string | null;
  total_lines_before: number;
  total_lines_after: number | null;
  cut_through_line_idx: number | null;
  /** The record the cut goes through: `type[/subtype]` and the start of its text. */
  cut_through_record: { type: string; preview: string } | null;
  lines_cut: number | null;
  new_recap_uuid: string | null;
  /** The body carries a recap sentinel that parses. */
  sentinel_invariant_passed: boolean;
  recap_id: string | null;
  /** For a voice: the id the next recap must carry. */
  expected_recap_id: string | null;
  cut_range_has_existing_recap: boolean;
  leading_recaps_preserved: number;
  new_recap_position: number | null;
  /** Survivors whose parent was cut, now pointing at the new recap. */
  repointed_records: number;
  chain_reaches_recap: boolean | null;
  chain_break: ChainBreak | null;
  /** tool_use ids the cut removes while their tool_result survives. */
  cut_orphaned_tool_results: string[];
  file_size_before_bytes: number;
  file_size_after_bytes: number | null;
  /** Lines appended by the live session during surgery and carried into the new file. */
  carried_tail_lines: number | null;
  rename_attempts: number | null;
  backups_compressed: string[];
  pair_balance: {
    tool_use: number;
    tool_result: number;
    orphans: number;
    // True when every orphan is a tool_use in the last conversation record and
    // that record is an assistant message: the session's own in-flight Bash
    // call when Claude Code flushed it before surgery read the file. Its
    // tool_result lands after the swap. Descriptive only.
    tail_orphan_only: boolean;
  } | null;
  /** Every reason this surgery would be refused; `reason` is the first. */
  problems: string[];
}

export interface SurgeryResult {
  ok: boolean;
  dry_run: boolean;
  reason?: string;
  diagnostics: SurgeryDiagnostics;
  warnings: string[];
}

const SWAP_BUDGET_MS = 3000;
const HALF_LINE_WAIT_MS = 120;
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
const NL = Buffer.from("\n");
const CRNL = Buffer.from("\r\n");

/**
 * Fields the new recap record copies from the session's own records, so it
 * looks native to this Claude Code build and session. Copied, never
 * invented: a hardcoded "2.1.x" or permission mode is wrong for some session.
 * A REQUIRED field absent from every record refuses the surgery; an optional
 * one is left out. `sessionId` falls back to the file name, which is the
 * session id by construction.
 */
const REQUIRED_CARRIERS = ["userType", "entrypoint", "cwd", "version"] as const;
const OPTIONAL_CARRIERS = ["permissionMode", "gitBranch"] as const;

/**
 * Run surgery (or a dry run). Returns full diagnostics whatever the outcome.
 * When ok is false the live file has not been changed.
 */
export function performSurgery(req: SurgeryRequest): SurgeryResult {
  const dryRun = !!req.dry_run;
  const sentinelName = req.sentinel_name;
  const show = (p: string) => (req.expose_paths ? p : path.basename(p));
  const warnings: string[] = [];
  const diag: SurgeryDiagnostics = {
    file_path: show(req.file_path),
    backup_path: null,
    total_lines_before: 0,
    total_lines_after: null,
    cut_through_line_idx: null,
    cut_through_record: null,
    lines_cut: null,
    new_recap_uuid: null,
    sentinel_invariant_passed: false,
    recap_id: null,
    expected_recap_id: null,
    cut_range_has_existing_recap: false,
    leading_recaps_preserved: 0,
    new_recap_position: null,
    repointed_records: 0,
    chain_reaches_recap: null,
    chain_break: null,
    cut_orphaned_tool_results: [],
    file_size_before_bytes: 0,
    file_size_after_bytes: null,
    carried_tail_lines: null,
    rename_attempts: null,
    backups_compressed: [],
    pair_balance: null,
    problems: [],
  };
  const fail = (reason: string): SurgeryResult => {
    if (!diag.problems.includes(reason)) diag.problems.unshift(reason);
    return { ok: false, dry_run: dryRun, reason, diagnostics: diag, warnings };
  };

  if (req.broken_link) {
    return fail(
      `continuation_broken: this session was continued into ${req.broken_link}, whose file is gone, so ` +
        `${path.basename(req.file_path)} is a frozen ancestor the running session never reads. ` +
        `Point the voice's session in config.yaml at the live file.`,
    );
  }
  if (!fs.existsSync(req.file_path)) return fail("file_not_found");

  // ─── Read once ─────────────────────────────────────────────────────────────

  const bytes = readSessionBytes(req.file_path);
  req.hooks?.afterRead?.();
  const lines = bytes.lines;
  const recs = lines.map((l) => l.rec);
  diag.file_size_before_bytes = bytes.buf.length;
  diag.total_lines_before = lines.length;

  const sentinel = parseSentinel(req.recap_content, sentinelName);
  diag.sentinel_invariant_passed = !!sentinel;
  diag.recap_id = typeof sentinel?.id === "string" ? sentinel.id : null;
  // Checked first: a body run as the wrong voice otherwise surfaces as an
  // unhelpful "cut_through_uuid not found" in the other voice's file.
  if (req.voice && typeof sentinel?.voice === "string" && sentinel.voice.toLowerCase() !== req.voice) {
    return fail(
      `sentinel_voice_mismatch: this body is signed "${sentinel.voice}", but this is ${req.voice}'s session. ` +
        `Run it as ${sentinel.voice.toLowerCase()}, or fix the sentinel.`,
    );
  }

  const stack = scanRecapStack(recs, sentinelName);
  const lastRecap = stack.recaps[stack.recaps.length - 1];
  diag.leading_recaps_preserved = stack.recaps.length;
  let idsNumbered = true;
  if (req.voice) {
    const next = nextRecapNumber(stack);
    idsNumbered = next.basis === "ids";
    diag.expected_recap_id = formatRecapId(req.voice, next.number);
    if (!idsNumbered) warnings.push("some recap ids in the stack carry no number; the expected id is a count");
  }

  // ─── Cut point ─────────────────────────────────────────────────────────────

  const recapId = diag.recap_id?.toLowerCase() ?? null;
  const cutIdx = recs.findIndex((r) => r?.uuid === req.cut_through_uuid);
  if (cutIdx === -1) {
    const applied = recapId ? stack.recaps.find((r) => r.id?.toLowerCase() === recapId) : undefined;
    if (applied && applied.cut_through_uuid && applied.cut_through_uuid !== req.cut_through_uuid) {
      return fail(
        `sentinel_id_taken: ${diag.recap_id} is already in the recap stack (line ${applied.index}) with a different cut point, ` +
          `and this body's cut point is not in the file: it looks like an earlier recap's sentinel reused. ` +
          `End the body with your own${diag.expected_recap_id ? `: "id": "${diag.expected_recap_id}"` : ""}.`,
      );
    }
    if (applied) {
      return fail(
        `already_applied: ${diag.recap_id} is already in the recap stack (line ${applied.index}) and its cut point ` +
          `is gone from the file. This surgery has run; there is nothing to do.`,
      );
    }
    return fail(`cut_through_uuid not found: ${req.cut_through_uuid} is not a record in ${path.basename(req.file_path)}.`);
  }
  diag.cut_through_line_idx = cutIdx;
  const cutRec = recs[cutIdx]!;
  diag.cut_through_record = {
    type: `${cutRec.type ?? "?"}${cutRec.subtype ? `/${cutRec.subtype}` : ""}`,
    preview: getRecordText(cutRec).replace(/\s+/g, " ").trim().slice(0, 80),
  };
  if (cutIdx < stack.end) {
    return fail(
      `cut_inside_recap_stack: the cut point (line ${cutIdx}) is one of the leading recaps (lines 0..${stack.end - 1}). ` +
        `Choose a record after ${lastRecap?.id ?? "the last recap"}.`,
    );
  }
  diag.lines_cut = cutIdx - stack.end + 1;
  diag.new_recap_position = stack.end;

  // ─── Body checks ───────────────────────────────────────────────────────────

  const problems = diag.problems;
  if (!sentinel) {
    problems.push(
      `no_sentinel: the body has no ${sentinelName} sentinel that parses as JSON. End it with ` +
        `{"sentinel":"${sentinelName}","voice":"<voice>","id":"<voice>-recap-NNN","version":1,"cut_through_uuid":"<uuid>", ...}`,
    );
  } else {
    if (typeof sentinel.cut_through_uuid === "string" && sentinel.cut_through_uuid !== req.cut_through_uuid) {
      problems.push(
        `sentinel_cut_mismatch: the sentinel says cut_through_uuid ${sentinel.cut_through_uuid}, the request says ${req.cut_through_uuid}.`,
      );
    }
    if (!recapId) {
      warnings.push(
        `the sentinel has no id; add "id": "${diag.expected_recap_id ?? "<voice>-recap-NNN"}" so later cycles can number from it`,
      );
    } else if (req.voice && idsNumbered && recapId !== diag.expected_recap_id) {
      const have = lastRecap ? `${stack.recaps.length} recap(s), the last ${lastRecap.id ?? "(no id)"}` : "no recaps yet";
      problems.push(
        `sentinel_id_mismatch: the sentinel says ${diag.recap_id}, but ${req.voice}'s session has ${have}, ` +
          `so this recap is ${diag.expected_recap_id}. Fix the id (and predecessor_recap) in the body.`,
      );
    }
  }

  // A recap record outside the leading stack would be destroyed by the cut.
  let strayRecap = -1;
  let strayId: string | null = null;
  for (let i = stack.end; i <= cutIdx; i++) {
    const r = recs[i];
    if (!isRecapRecord(r, sentinelName)) continue;
    const s = parseSentinel(r!.message!.content as string, sentinelName);
    strayRecap = i;
    strayId = typeof s?.id === "string" ? s.id : null;
    break;
  }
  diag.cut_range_has_existing_recap = strayRecap >= 0;
  if (strayRecap >= 0 && !req.force_overwrite_recap) {
    const stray = recs[strayRecap]!;
    const opening = getRecordText(stray).replace(/\s+/g, " ").trim().slice(0, 60);
    problems.push(
      `cut_range_contains_recap: line ${strayRecap} (${stray.timestamp ?? "no time"}, "${opening}") is a user message carrying ` +
        `a recap sentinel (${strayId ?? "no id"}) outside the leading stack, and this cut would delete it. If it is a pasted ` +
        `copy rather than an injected recap, force_overwrite_recap (--force) is safe; otherwise choose a later cut. ` +
        `Tell the operator either way.`,
    );
  }

  // Cutting through the boundary message itself drops the message that opens
  // the new arc: it ends up in neither the recap nor the kept text. Only when
  // an assistant reply to it survives — an interrupt line has no reply.
  if (isHumanMessage(cutRec, sentinelName)) {
    if (replySurvives(recs, cutIdx)) {
      problems.push(
        `cut_is_user_message: line ${cutIdx} is a user message ("${diag.cut_through_record.preview.slice(0, 50)}") whose reply survives, ` +
          `so the cut would drop the message that opens your new arc. Cut through its parent instead: ${cutRec.parentUuid ?? "(none)"}.`,
      );
    }
  }

  // ─── Build the result ──────────────────────────────────────────────────────

  const carrier = carrierFields(recs, sentinelName);
  if (carrier.missing) {
    problems.push(
      `carrier_field_missing: no record in the session carries the "${carrier.missing}" field, so the injected recap cannot ` +
        `copy it. Refusing rather than inventing a value that would be wrong for this session.`,
    );
  }

  const newUuid = crypto.randomUUID();
  diag.new_recap_uuid = newUuid;
  const newRecord: JsonlRecord = {
    parentUuid: lastRecap?.uuid ?? null,
    isSidechain: false,
    promptId: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: req.recap_content },
    uuid: newUuid,
    timestamp: new Date().toISOString(),
    ...carrier.fields,
    sessionId: carrier.sessionId ?? path.basename(req.file_path, ".jsonl"),
  };

  const cutUuids = new Set<string>();
  for (let i = stack.end; i <= cutIdx; i++) {
    const u = recs[i]?.uuid;
    if (u) cutUuids.add(u);
  }

  // Lines surgery writes itself end the way the file's lines end, so a CRLF
  // file never comes out with a \r\n / \n mix. (Claude Code writes LF; a CRLF
  // file comes from an editor or git autocrlf.)
  const endsCR = (raw: Buffer) => raw.length > 0 && raw[raw.length - 1] === 0x0d;
  const fileCRLF = lines.length > 0 && endsCR(lines[0]!.raw);
  const parts: Buffer[] = [];
  const finalRecs: (JsonlRecord | null)[] = [];
  for (let i = 0; i < stack.end; i++) {
    parts.push(lines[i]!.raw, NL);
    finalRecs.push(recs[i] ?? null);
  }
  parts.push(Buffer.from(JSON.stringify(newRecord)), fileCRLF ? CRNL : NL);
  finalRecs.push(newRecord);
  for (let i = cutIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const r = line.rec;
    if (r && typeof r.parentUuid === "string" && cutUuids.has(r.parentUuid)) {
      const fixed: JsonlRecord = { ...r, parentUuid: newUuid };
      parts.push(Buffer.from(JSON.stringify(fixed)), endsCR(line.raw) ? CRNL : NL);
      finalRecs.push(fixed);
      diag.repointed_records++;
    } else {
      parts.push(line.raw, NL);
      finalRecs.push(r);
    }
  }
  const newContent = Buffer.concat(parts);
  diag.total_lines_after = finalRecs.length;
  diag.file_size_after_bytes = newContent.length;

  const chain = walkChain(finalRecs, newUuid);
  diag.chain_reaches_recap = chain.reaches;
  diag.chain_break = chain.break;
  if (!chain.reaches && chain.break) {
    const b = chain.break;
    problems.push(
      b.reason === "missing_parent"
        ? `chain_broken: walking back from the last message, record ${b.uuid} points at ${b.missing_parent}, which is not in the file, ` +
            `so the resumed session would never reach the recap. The break is not caused by this cut; it needs a look before any surgery.`
        : b.reason === "cycle"
          ? `chain_broken: the parentUuid chain loops at ${b.uuid}; the resumed session would never reach the recap.`
          : `chain_broken: walking back from the last message ends at ${b.uuid} without passing the recap, so the resumed session would not load it.`,
    );
  }

  diag.cut_orphaned_tool_results = orphanedByCut(recs, stack.end, cutIdx);
  if (diag.cut_orphaned_tool_results.length > 0) {
    problems.push(
      `cut_splits_tool_call: the cut removes the tool_use of ${diag.cut_orphaned_tool_results.length} tool_result(s) that survive ` +
        `(first: ${diag.cut_orphaned_tool_results[0]}). Cut at the end of a turn: the assistant end_turn record, or the system record after it.`,
    );
  }
  diag.pair_balance = pairBalance(finalRecs);

  if (problems.length > 0) return fail(problems[0]!);
  if (dryRun) return { ok: true, dry_run: true, diagnostics: diag, warnings };

  // ─── Execute: verified backup → tmp → checked swap ─────────────────────────

  const sessionId = path.basename(req.file_path, ".jsonl");
  const backupPath = backupPathFor(req.backup_dir, req.voice, sessionId, new Date());
  try {
    writeVerifiedBackup(backupPath, bytes.buf.subarray(0, bytes.completeLength));
  } catch (e: any) {
    return fail(`backup_failed: ${e.message}. Nothing was changed.`);
  }
  diag.backup_path = show(backupPath);

  const tmpPath = `${req.file_path}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.surgery.tmp`;
  const swap = swapIn(req.file_path, tmpPath, newContent, bytes, req.hooks, show);
  diag.rename_attempts = swap.renameAttempts;
  if (!swap.renamed) {
    return fail(`not_applied: ${swap.error}. The live file was not changed. A verified copy of it is at ${show(backupPath)}.`);
  }
  warnings.push(...swap.notes);

  // Everything the session wrote during surgery, in order: lines carried
  // before the rename, then lines recovered from the instant before it.
  const tail = Buffer.concat([swap.carried, swap.late]);
  const carriedLines = countNewlines(tail);
  diag.carried_tail_lines = carriedLines;
  diag.total_lines_after = finalRecs.length + carriedLines;
  diag.file_size_after_bytes = newContent.length + tail.length;
  if (tail.length > 0) {
    try {
      writeDurable(backupPath, tail, "a");
    } catch (e: any) {
      warnings.push(`the backup lacks the ${carriedLines} line(s) carried over during the swap: ${e.message}`);
    }
  }
  if (req.voice) {
    // After the swap: rotation trouble is a warning, never a failed surgery.
    try {
      const rotation = rotateVoiceBackups(path.dirname(backupPath));
      diag.backups_compressed = rotation.compressed;
      for (const err of rotation.errors) warnings.push(`backup rotation: ${err}`);
    } catch (e: any) {
      warnings.push(`backup rotation: ${e.message}`);
    }
  }

  return { ok: true, dry_run: false, diagnostics: diag, warnings };
}

/**
 * The carrier fields for the new recap, each from the most recent
 * conversation record that has it (the latest record is the most faithful
 * template: a session's version and permission mode change over its life).
 */
function carrierFields(
  recs: ReadonlyArray<JsonlRecord | null>,
  sentinelName: string,
): { fields: Record<string, unknown>; sessionId: string | null; missing: string | null } {
  const conversation: JsonlRecord[] = [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (isConversation(r) && !isRecapRecord(r, sentinelName)) conversation.push(r);
  }
  // A required field may come from any record as a last resort (still newest
  // first); an optional one only from the conversation, never from an old
  // recap that carries the state of a session long gone.
  const anyRecord = [...conversation];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r && !conversation.includes(r)) anyRecord.push(r);
  }
  const pick = (key: string, from: JsonlRecord[]): unknown => {
    for (const s of from) {
      const v = s[key];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  };
  const fields: Record<string, unknown> = {};
  let missing: string | null = null;
  for (const key of REQUIRED_CARRIERS) {
    const v = pick(key, anyRecord);
    if (v === undefined) missing ??= key;
    else fields[key] = v;
  }
  for (const key of OPTIONAL_CARRIERS) {
    const v = pick(key, conversation);
    if (v !== undefined) fields[key] = v;
  }
  const sid = pick("sessionId", anyRecord);
  return { fields, sessionId: typeof sid === "string" && sid ? sid : null, missing };
}

// ─── Swap ────────────────────────────────────────────────────────────────────

class SwapAbort extends Error {}

interface SwapOutcome {
  renamed: boolean;
  renameAttempts: number;
  /** Complete lines the session appended during surgery, carried into the new file before the rename. */
  carried: Buffer;
  /** Lines that reached the old file in the instant before the rename, recovered through the side link and appended after it. */
  late: Buffer;
  /** Anything about that recovery the caller should report. */
  notes: string[];
  error?: string;
}

/**
 * Put `content` in place of the live file, carrying over complete lines the
 * live session appended since `read`. The live file is touched only by the
 * rename (and, after it, by appending lines recovered from the instant before
 * it); on any failure before the rename the tmp is removed and the live file
 * is as it was.
 */
function swapIn(
  livePath: string,
  tmpPath: string,
  content: Buffer,
  read: SessionBytes,
  hooks: SurgeryHooks | undefined,
  show: (p: string) => string,
): SwapOutcome {
  const carried: Buffer[] = [];
  let carriedUpTo = read.completeLength;
  let renameAttempts = 0;
  const prefix = read.buf.subarray(0, read.completeLength);
  const sidePath = `${tmpPath}.side`;
  let side = false;
  let stall = "the live file kept changing";
  try {
    writeDurable(tmpPath, content, "wx");
    // A second name for the live file. After the rename it still reaches the
    // old file, so a line Claude Code appended in the instant between the
    // last check and the rename is recovered instead of lost. (A handle opened
    // through the live name still blocks the rename, as before.)
    try {
      fs.linkSync(livePath, sidePath);
      side = true;
    } catch {
      // No hard links on this volume: that instant stays unguarded.
    }
    const deadline = Date.now() + SWAP_BUDGET_MS;
    for (let round = 1; ; round++) {
      if (Date.now() > deadline) throw new SwapAbort(`${stall} for 3 s; retry in a moment`);
      hooks?.beforeCheck?.(round);
      const size = fs.statSync(livePath).size;
      if (size < carriedUpTo) {
        throw new SwapAbort(
          size < read.completeLength
            ? `the live file shrank from ${read.completeLength} to ${size} bytes during surgery, so something rewrote it`
            : "the live file lost lines surgery had already carried over, so something rewrote it",
        );
      }
      if (size > carriedUpTo) {
        // New lines since the last look: carry the complete ones, then look
        // again. The rename only happens in a round that saw nothing new.
        const delta = readRange(livePath, carriedUpTo, size);
        const nl = delta.lastIndexOf(0x0a);
        if (nl >= 0) {
          const chunk = Buffer.from(delta.subarray(0, nl + 1));
          writeDurable(tmpPath, chunk, "a");
          carried.push(chunk);
          carriedUpTo += chunk.length;
        }
        if (carriedUpTo < size) {
          stall =
            "the session file ends in a line that stayed incomplete (if the session is not running, open and close it once: " +
            "Claude Code seals a torn last line)";
          sleepSync(HALF_LINE_WAIT_MS);
        }
        continue;
      }
      // A quiet round. Everything surgery read and carried must still be
      // there, byte for byte — a rewrite that kept the size would otherwise
      // slip through — and nothing may have arrived while that was checked.
      const expected = carried.length > 0 ? Buffer.concat([prefix, ...carried]) : prefix;
      if (!readRange(livePath, 0, carriedUpTo).equals(expected)) {
        throw new SwapAbort("the live file changed before the point surgery had read and carried, so something rewrote it");
      }
      if (fs.statSync(livePath).size !== carriedUpTo) continue;
      renameAttempts++;
      hooks?.beforeRename?.(renameAttempts);
      try {
        fs.renameSync(tmpPath, livePath);
      } catch (e: any) {
        if (!RETRYABLE.has(e.code)) throw e;
        stall = `another process kept the live file open (${e.code})`;
        sleepSync(Math.min(50 * renameAttempts, 250));
        continue;
      }
      return finishSwap(livePath, side ? sidePath : null, carriedUpTo, Buffer.concat(carried), renameAttempts, show);
    }
  } catch (e: any) {
    for (const p of [tmpPath, sidePath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // May not exist.
      }
    }
    const error = e instanceof SwapAbort ? e.message : `${e.code ?? "error"}: ${e.message}`;
    return { renamed: false, renameAttempts, carried: Buffer.concat(carried), late: Buffer.alloc(0), notes: [], error };
  }
}

/**
 * After the rename: take any complete lines that reached the old file after
 * the last check (they are past `carriedUpTo` in it, reached through the side
 * link), append them to the new live file, and drop the side link. Never
 * throws — the swap has happened; problems become notes and the old file is
 * kept for inspection.
 */
function finishSwap(
  livePath: string,
  sidePath: string | null,
  carriedUpTo: number,
  carried: Buffer,
  renameAttempts: number,
  show: (p: string) => string,
): SwapOutcome {
  const notes: string[] = [];
  let late = Buffer.alloc(0);
  if (sidePath) {
    let keep = false;
    try {
      const size = fs.statSync(sidePath).size;
      if (size > carriedUpTo) {
        const tail = readRange(sidePath, carriedUpTo, size);
        const end = tail.lastIndexOf(0x0a) + 1;
        if (end > 0) {
          const lines = Buffer.from(tail.subarray(0, end));
          writeDurable(livePath, lines, "a");
          late = lines;
        }
        if (end < tail.length) {
          keep = true;
          notes.push(`a partial line reached the old file during the rename; the old file is kept at ${show(sidePath)}`);
        }
      } else if (size < carriedUpTo) {
        keep = true;
        notes.push(`the old file changed during the rename in a way that could not be carried over; it is kept at ${show(sidePath)}`);
      }
    } catch (e: any) {
      keep = true;
      notes.push(`lines written during the rename could not be recovered (${e.message}); the old file is kept at ${show(sidePath)}`);
    }
    if (!keep) {
      try {
        fs.unlinkSync(sidePath);
      } catch {
        // Best effort.
      }
    }
  }
  return { renamed: true, renameAttempts, carried, late, notes };
}

// ─── Checks on the resulting records ─────────────────────────────────────────

function isConversation(r: JsonlRecord | null | undefined): r is JsonlRecord {
  return !!r && typeof r.uuid === "string" && r.isSidechain !== true && (r.type === "user" || r.type === "assistant");
}

/** A message a person typed: a user record that is not a tool result, a meta note, a recap or generated text. */
function isHumanMessage(r: JsonlRecord | null | undefined, sentinelName: string): boolean {
  if (!r || r.type !== "user" || r.isMeta === true || isRecapRecord(r, sentinelName)) return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return false;
  if (typeof c !== "string" && !Array.isArray(c)) return false;
  return !GENERATED_USER_TEXT.test(getRecordText(r).trimStart());
}

/**
 * Whether an assistant reply to the record at `idx` survives the cut: any
 * descendant after it that is an assistant record. The reply often hangs off
 * an attachment rather than the message itself, and messages sent together
 * chain one after another before the single reply to all of them.
 */
function replySurvives(recs: ReadonlyArray<JsonlRecord | null>, idx: number): boolean {
  const children = new Map<string, JsonlRecord[]>();
  for (let i = idx + 1; i < recs.length; i++) {
    const r = recs[i];
    if (!r || typeof r.parentUuid !== "string") continue;
    const list = children.get(r.parentUuid);
    if (list) list.push(r);
    else children.set(r.parentUuid, [r]);
  }
  const start = recs[idx]?.uuid;
  if (!start) return false;
  const queue = [start];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child.type === "assistant") return true;
      if (!child.uuid || seen.has(child.uuid)) continue;
      seen.add(child.uuid);
      queue.push(child.uuid);
    }
  }
  return false;
}

/**
 * Walk parentUuid back from the conversation's last record, the way Claude
 * Code rebuilds a session on resume. It must pass the new recap.
 */
function walkChain(recs: ReadonlyArray<JsonlRecord | null>, recapUuid: string): { reaches: boolean; break: ChainBreak | null } {
  const nodes = new Map<string, { parent: string | null; idx: number }>();
  recs.forEach((r, idx) => {
    if (r?.uuid) nodes.set(r.uuid, { parent: typeof r.parentUuid === "string" ? r.parentUuid : null, idx });
  });
  let leafIdx = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (isConversation(recs[i])) {
      leafIdx = i;
      break;
    }
  }
  if (leafIdx < 0) return { reaches: false, break: null };
  const seen = new Set<string>();
  let cur = recs[leafIdx]!.uuid!;
  for (;;) {
    if (cur === recapUuid) return { reaches: true, break: null };
    seen.add(cur);
    const node = nodes.get(cur)!;
    if (node.parent === null) {
      return { reaches: false, break: { reason: "root_without_recap", line_idx: node.idx, uuid: cur, missing_parent: null } };
    }
    if (seen.has(node.parent)) {
      return { reaches: false, break: { reason: "cycle", line_idx: node.idx, uuid: cur, missing_parent: null } };
    }
    if (!nodes.has(node.parent)) {
      return { reaches: false, break: { reason: "missing_parent", line_idx: node.idx, uuid: cur, missing_parent: node.parent } };
    }
    cur = node.parent;
  }
}

function contentBlocks(r: JsonlRecord | null | undefined): any[] {
  const c = r?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** tool_use ids in lines [from, cutIdx] whose tool_result survives after cutIdx. */
function orphanedByCut(recs: ReadonlyArray<JsonlRecord | null>, from: number, cutIdx: number): string[] {
  const cutUses = new Set<string>();
  for (let i = from; i <= cutIdx; i++) {
    for (const b of contentBlocks(recs[i])) if (b?.type === "tool_use" && b.id) cutUses.add(b.id);
  }
  const orphaned: string[] = [];
  for (let i = cutIdx + 1; i < recs.length; i++) {
    for (const b of contentBlocks(recs[i])) {
      if (b?.type === "tool_result" && b.tool_use_id && cutUses.has(b.tool_use_id)) orphaned.push(b.tool_use_id);
    }
  }
  return orphaned;
}

function pairBalance(recs: ReadonlyArray<JsonlRecord | null>): NonNullable<SurgeryDiagnostics["pair_balance"]> {
  let toolUse = 0;
  let toolResult = 0;
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of recs) {
    for (const b of contentBlocks(r)) {
      if (b?.type === "tool_use" && b.id) {
        toolUse++;
        useIds.add(b.id);
      }
      if (b?.type === "tool_result" && b.tool_use_id) {
        toolResult++;
        resultIds.add(b.tool_use_id);
      }
    }
  }
  const orphanUses = [...useIds].filter((id) => !resultIds.has(id));
  const orphanResults = [...resultIds].filter((id) => !useIds.has(id));
  let tailOrphanOnly = false;
  if (orphanUses.length > 0 && orphanResults.length === 0) {
    let leaf: JsonlRecord | null = null;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (isConversation(recs[i])) {
        leaf = recs[i]!;
        break;
      }
    }
    if (leaf?.type === "assistant") {
      const leafUses = new Set(contentBlocks(leaf).filter((b) => b?.type === "tool_use").map((b) => b.id));
      tailOrphanOnly = orphanUses.every((id) => leafUses.has(id));
    }
  }
  return {
    tool_use: toolUse,
    tool_result: toolResult,
    orphans: orphanUses.length + orphanResults.length,
    tail_orphan_only: tailOrphanOnly,
  };
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}
