/**
 * Surgery — cut + inject + parentUuid repair.
 *
 * The Phase 2 operation: take a file, a cut_through_uuid, and a recap message
 * body. Produce a trimmed file with the recap injected at position 0 as a
 * user message, parentUuid chain repaired so the conversation flows from
 * recap → first surviving record → onward.
 *
 * SAFETY INVARIANTS (enforced before any file mutation):
 *
 *   1. cut_through_uuid must exist as a record uuid in the file.
 *   2. recap_content must contain the configured recap sentinel JSON.
 *   3. No record in the cut range may contain the recap sentinel
 *      (would destroy a prior recap) unless force_overwrite_recap=true.
 *   4. Backup must be written before any mutation.
 *   5. Result must pass schema validation (basic shape) — else rollback.
 *
 * dry_run=true short-circuits the actual mutation, returning diagnostics
 * about what WOULD happen. Use this for iteration and validation testing.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { loadJsonl, getRecordText, type JsonlRecord } from "./jsonl.js";

// ─── Per-path in-process mutex ────────────────────────────────────────────────
//
// Two concurrent surgeries on the SAME resolved file would each read the file,
// mutate in memory, and write back — a classic lost-update race (the second
// write clobbers the first). We serialize per resolved path with a promise
// chain: each call appends itself to the tail of its path's chain and awaits the
// previous one. Surgeries on DIFFERENT paths share no chain and still run
// concurrently. The chain entry is cleaned up once it becomes the tail again so
// the map doesn't grow unbounded.
const pathLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
  // Wait for whatever is already queued on this path (resolved Promise if idle).
  const prev = pathLocks.get(resolvedPath) ?? Promise.resolve();
  // Our turn: a promise that resolves only when we call release().
  let release!: () => void;
  const turn = new Promise<void>((res) => {
    release = res;
  });
  // The new tail for this path is "after prev finishes, then after our turn".
  // Publish it BEFORE awaiting so any later caller chains behind US, not prev.
  const tail = prev.then(() => turn);
  pathLocks.set(resolvedPath, tail);
  await prev; // serialize: don't touch the file until the prior surgery is done
  try {
    return await fn();
  } finally {
    release();
    // Bound the map: if no later caller has replaced the tail, drop the entry.
    if (pathLocks.get(resolvedPath) === tail) {
      pathLocks.delete(resolvedPath);
    }
  }
}

export interface SurgeryRequest {
  file_path: string;
  cut_through_uuid: string;
  recap_content: string;
  voice?: string;
  backup_dir: string;
  /** Configured recap sentinel marker name (config.sentinel_name). */
  sentinel_name: string;
  /**
   * When false, filesystem paths (file_path, backup_path) are stripped from the
   * returned diagnostics so a public/misconfigured clone can't leak the home
   * directory layout. Defaults to false (safe). See config.expose_paths.
   */
  expose_paths?: boolean;
  /** Skip mutation, return diagnostics only. */
  dry_run?: boolean;
  /** Allow cut range to include records with the recap sentinel. Default false. */
  force_overwrite_recap?: boolean;
  /**
   * TEST-ONLY seam. Invoked after the in-memory plan is built and AFTER the
   * load-time mtime is captured, but immediately BEFORE the mtime re-check and
   * write. Lets tests deterministically simulate an external writer touching the
   * file mid-surgery (the race the mtime guard defends against), which is
   * otherwise impossible to interleave in a synchronous code path. Never set in
   * production code paths — the HTTP route does not expose it. May be async so
   * tests can force a yield point between load and write.
   */
  __beforeWriteHook?: () => void | Promise<void>;
}

export interface SurgeryResult {
  ok: boolean;
  dry_run: boolean;
  reason?: string;
  diagnostics: {
    file_path: string;
    backup_path: string | null;
    total_lines_before: number;
    total_lines_after: number | null;
    cut_through_line_idx: number | null;
    lines_cut: number | null;
    new_recap_uuid: string | null;
    sentinel_invariant_passed: boolean;
    cut_range_has_existing_recap: boolean;
    leading_recaps_preserved: number;
    new_recap_position: number | null;
    file_size_before_bytes: number;
    file_size_after_bytes: number | null;
    pair_balance: {
      tool_use: number;
      tool_result: number;
      orphans: number;
      // Descriptive flag: true when the only orphan is a single tool_use in the
      // very last assistant record of the resulting file. Signature of a "self-loop"
      // surgery — voice running surgery from inside its own session, where the
      // bash tool_use that fired the script is in-flight and its tool_result will
      // land after surgery completes (CC appends to file post-bash-return). When
      // true AND the caller knows they are running self-loop, the orphan is
      // expected and benign. When false OR caller is external, orphan is real.
      tail_orphan_only: boolean;
    } | null;
  };
}

function hasRecapSentinel(text: string, sentinelName: string): boolean {
  return (
    text.includes(`"sentinel":"${sentinelName}"`) ||
    text.includes(`"sentinel": "${sentinelName}"`)
  );
}

function recordHasRecapSentinel(r: JsonlRecord, sentinelName: string): boolean {
  return hasRecapSentinel(getRecordText(r), sentinelName);
}

/**
 * Carrier fields the new recap record copies from the existing session so the
 * injected message looks native to this CC build/session rather than carrying
 * the original author's hardcoded values. Copying (vs. hardcoding) is what keeps
 * the recap valid across plan-mode sessions, different CC versions, branches,
 * etc. — a hardcoded "acceptEdits"/"2.1.92" would be wrong on those sessions.
 */
const CARRIER_FIELDS = [
  "permissionMode",
  "userType",
  "entrypoint",
  "cwd",
  "sessionId",
  "version",
  "gitBranch",
] as const;
type CarrierField = (typeof CARRIER_FIELDS)[number];

/**
 * Pull each carrier field from the first sample record that actually has it.
 * `cwd` is allowed to be empty-string (some sessions legitimately have ""),
 * so we treat "present as a string" — including "" — as found; only undefined/
 * null counts as missing. If a field is absent from EVERY sample record we
 * FAIL LOUD: returning a hardcoded substitute here is what silently corrupted
 * plan-mode / different-CC-version sessions before.
 */
function collectCarrierFields(
  samples: JsonlRecord[],
): { ok: true; fields: Record<CarrierField, unknown> } | { ok: false; missing: CarrierField } {
  const fields = {} as Record<CarrierField, unknown>;
  for (const key of CARRIER_FIELDS) {
    let found = false;
    for (const s of samples) {
      const v = (s as Record<string, unknown>)[key];
      if (v !== undefined && v !== null) {
        fields[key] = v;
        found = true;
        break;
      }
    }
    if (!found) {
      return { ok: false, missing: key };
    }
  }
  return { ok: true, fields };
}

type PairBalance = {
  tool_use: number;
  tool_result: number;
  orphans: number;
  tail_orphan_only: boolean;
};

/**
 * Compute tool_use/tool_result pairing over a record array, plus the self-loop
 * tail-orphan signature. Shared between the in-memory plan and the post-write
 * re-validation so both measure pairing the exact same way.
 */
function computePairBalance(recs: JsonlRecord[]): PairBalance {
  let toolUseCount = 0;
  let toolResultCount = 0;
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of recs) {
    const c = r.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "tool_use" && b.id) {
          toolUseCount++;
          useIds.add(b.id);
        }
        if (b?.type === "tool_result" && b.tool_use_id) {
          toolResultCount++;
          resultIds.add(b.tool_use_id);
        }
      }
    }
  }
  const orphanUses = [...useIds].filter((id) => !resultIds.has(id));
  const orphanResults = [...resultIds].filter((id) => !useIds.has(id));

  // Detect self-loop tail orphan signature.
  // True iff: exactly one orphan, it's a tool_use (not tool_result), and the
  // orphan tool_use lives in a tool_use block within the very LAST record of
  // recs AND that record is an assistant message.
  // This is the structural fingerprint of "voice ran surgery on its own session
  // while a bash tool_use was in-flight" — tool_result is expected to land
  // post-surgery via CC's append-to-file when bash returns.
  let tailOrphanOnly = false;
  if (orphanUses.length === 1 && orphanResults.length === 0 && recs.length > 0) {
    const lastRecord = recs[recs.length - 1];
    if (lastRecord && lastRecord.type === "assistant") {
      const c = lastRecord.message?.content;
      if (Array.isArray(c)) {
        tailOrphanOnly = c.some(
          (b: any) => b?.type === "tool_use" && b.id === orphanUses[0],
        );
      }
    }
  }

  return {
    tool_use: toolUseCount,
    tool_result: toolResultCount,
    orphans: orphanUses.length + orphanResults.length,
    tail_orphan_only: tailOrphanOnly,
  };
}

/**
 * Run surgery (or dry-run). Returns full diagnostics regardless of outcome.
 * On failure, ok=false and reason is set; no mutation has occurred.
 *
 * Async because real writes serialize per resolved path through an in-process
 * mutex: load → mutate → mtime re-check → write → re-validate must run as one
 * atomic unit per file, or two concurrent surgeries would lose-update. The
 * resolved path is the lock key, so surgeries on different files stay parallel.
 */
export async function performSurgery(req: SurgeryRequest): Promise<SurgeryResult> {
  // The lock key must be the canonical path so two requests naming the same file
  // differently still serialize. (Caller already passes an absolute resolved path.)
  return withPathLock(path.resolve(req.file_path), () => runSurgery(req));
}

/** The actual surgery body. Always invoked under the per-path lock for the file. */
async function runSurgery(req: SurgeryRequest): Promise<SurgeryResult> {
  const sentinelName = req.sentinel_name;
  // When expose_paths is false, surface only the basename so diagnostics never
  // leak the absolute home-directory layout. Internal logic always uses
  // req.file_path / the real backup path regardless of this flag.
  const exposePaths = !!req.expose_paths;
  const baseDiag = {
    file_path: exposePaths ? req.file_path : path.basename(req.file_path),
    backup_path: null as string | null,
    total_lines_before: 0,
    total_lines_after: null as number | null,
    cut_through_line_idx: null as number | null,
    lines_cut: null as number | null,
    new_recap_uuid: null as string | null,
    sentinel_invariant_passed: false,
    cut_range_has_existing_recap: false,
    leading_recaps_preserved: 0,
    new_recap_position: null as number | null,
    file_size_before_bytes: 0,
    file_size_after_bytes: null as number | null,
    pair_balance: null as { tool_use: number; tool_result: number; orphans: number; tail_orphan_only: boolean } | null,
  };

  // ─── Validate file exists ──────────────────────────────────────────────────

  if (!fs.existsSync(req.file_path)) {
    return { ok: false, dry_run: !!req.dry_run, reason: "file_not_found", diagnostics: baseDiag };
  }
  const statsBefore = fs.statSync(req.file_path);
  baseDiag.file_size_before_bytes = statsBefore.size;
  // Capture mtime at load so we can detect an EXTERNAL modification (e.g. CC
  // appending to a live session) that happens between our read and our write,
  // and abort rather than clobber it. Re-checked just before the rename.
  const mtimeAtLoad = statsBefore.mtimeMs;

  // ─── Load + locate cut point ───────────────────────────────────────────────

  const records = loadJsonl(req.file_path);
  baseDiag.total_lines_before = records.length;

  let cutIdx = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.uuid === req.cut_through_uuid) {
      cutIdx = i;
      break;
    }
  }
  if (cutIdx === -1) {
    return {
      ok: false,
      dry_run: !!req.dry_run,
      reason: `cut_through_uuid not found: ${req.cut_through_uuid}`,
      diagnostics: baseDiag,
    };
  }
  baseDiag.cut_through_line_idx = cutIdx;
  baseDiag.lines_cut = cutIdx + 1;

  // ─── Validate recap_content contains sentinel ──────────────────────────────

  if (!hasRecapSentinel(req.recap_content, sentinelName)) {
    return {
      ok: false,
      dry_run: !!req.dry_run,
      reason: `recap_content must contain ${sentinelName} sentinel JSON. Add a fenced code block: {"sentinel":"${sentinelName}","voice":"<name>","id":"<recap-id>","version":1,...}`,
      diagnostics: baseDiag,
    };
  }
  baseDiag.sentinel_invariant_passed = true;

  // ─── Detect leading recap records (consecutive recaps from position 0) ────
  //
  // Multi-recap layering: if the file already starts with one or more recap
  // injections from prior cycles, preserve them. The new recap is inserted
  // AFTER them, and the cut excludes them. This is what enables recap-002,
  // recap-003 etc. to compound on top of recap-001 instead of destroying it.

  let leadingRecapsEnd = 0;
  while (leadingRecapsEnd < records.length && recordHasRecapSentinel(records[leadingRecapsEnd]!, sentinelName)) {
    leadingRecapsEnd++;
  }
  baseDiag.leading_recaps_preserved = leadingRecapsEnd;

  // ─── Validate cut range relative to leading recaps ────────────────────────

  // (a) cut_through_uuid must be AFTER all leading recaps
  if (cutIdx < leadingRecapsEnd) {
    return {
      ok: false,
      dry_run: !!req.dry_run,
      reason: `cut_through_uuid is at or within the existing leading recap(s) at positions 0..${leadingRecapsEnd - 1}. Choose a cut_through_uuid AFTER the last existing recap, or set force_overwrite_recap:true to deliberately overwrite.`,
      diagnostics: baseDiag,
    };
  }

  // (b) check for non-leading recap in cut range (unusual; default-safe reject)
  let nonLeadingRecapInRange = false;
  for (let i = leadingRecapsEnd; i <= cutIdx; i++) {
    const r = records[i];
    if (r && recordHasRecapSentinel(r, sentinelName)) {
      nonLeadingRecapInRange = true;
      break;
    }
  }
  baseDiag.cut_range_has_existing_recap = nonLeadingRecapInRange;

  if (nonLeadingRecapInRange && !req.force_overwrite_recap) {
    return {
      ok: false,
      dry_run: !!req.dry_run,
      reason: "cut_range_contains_non_leading_recap. Unusual — recap mid-conversation rather than at start. Default-safe: refuse. Set force_overwrite_recap:true if intentional.",
      diagnostics: baseDiag,
    };
  }

  // Update lines_cut: actual cut excludes preserved leading recaps
  baseDiag.lines_cut = cutIdx - leadingRecapsEnd + 1;

  // ─── Build new recap user message ──────────────────────────────────────────

  const newUuid = crypto.randomUUID();
  const cutRecord = records[cutIdx]!;

  // Carrier fields are copied from real records in THIS file, not hardcoded.
  // Prefer user records (the new recap is itself a user message, so a user
  // record is the most faithful template), then the cut record, then any record
  // — gathering several samples so a field missing from one is filled by another.
  const carrierSamples: JsonlRecord[] = [];
  for (const r of records) if (r && r.type === "user") carrierSamples.push(r);
  carrierSamples.push(cutRecord);
  for (const r of records) if (r) carrierSamples.push(r);
  const carrier = collectCarrierFields(carrierSamples);
  if (!carrier.ok) {
    // FAIL LOUD: no sample record carries this field. Substituting a default
    // here is exactly the silent-corruption bug we're fixing.
    return {
      ok: false,
      dry_run: !!req.dry_run,
      reason: `carrier_field_missing: no record in the session carries the "${carrier.missing}" field, so the injected recap cannot inherit it safely. Refusing rather than substituting a hardcoded value (which would be wrong for this session/CC build).`,
      diagnostics: baseDiag,
    };
  }

  // parentUuid for the new recap:
  //   - If there are leading recaps, point at the last leading recap's uuid (chains the new recap onto the existing recap stack)
  //   - Otherwise null (new recap is the first record)
  const lastPreservedRecapUuid =
    leadingRecapsEnd > 0 ? records[leadingRecapsEnd - 1]?.uuid ?? null : null;

  const newRecord: JsonlRecord = {
    parentUuid: lastPreservedRecapUuid,
    isSidechain: false,
    promptId: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: req.recap_content },
    uuid: newUuid,
    timestamp: new Date().toISOString(),
    // Carrier fields copied from sample records above (fail-loud if absent).
    ...carrier.fields,
  };
  baseDiag.new_recap_uuid = newUuid;
  baseDiag.new_recap_position = leadingRecapsEnd;

  // ─── Build resulting record array ──────────────────────────────────────────
  //
  // Layout: [preserved leading recaps] + [new recap] + [survivors]
  // Cut excludes leading recaps (records 0..leadingRecapsEnd-1) and survives
  // records cutIdx+1..end. The cut range is leadingRecapsEnd..cutIdx inclusive.

  const preservedRecaps = records.slice(0, leadingRecapsEnd);
  const survivors = records.slice(cutIdx + 1);
  if (survivors.length > 0 && survivors[0]) {
    survivors[0].parentUuid = newUuid;
  }
  const finalRecords = [...preservedRecaps, newRecord, ...survivors];
  baseDiag.total_lines_after = finalRecords.length;

  // ─── Pair-balance check ────────────────────────────────────────────────────

  const plannedBalance = computePairBalance(finalRecords);
  baseDiag.pair_balance = plannedBalance;

  // ─── Estimate post-mutation file size ──────────────────────────────────────

  const finalContent = finalRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
  baseDiag.file_size_after_bytes = Buffer.byteLength(finalContent);

  if (req.dry_run) {
    return { ok: true, dry_run: true, diagnostics: baseDiag };
  }

  // ─── Real execution: backup → atomic write ─────────────────────────────────

  if (!fs.existsSync(req.backup_dir)) {
    fs.mkdirSync(req.backup_dir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(req.file_path, ".jsonl");
  const backupPath = path.join(
    req.backup_dir,
    `${baseName}-pre-surgery-${ts}.jsonl`,
  );

  try {
    fs.copyFileSync(req.file_path, backupPath);
  } catch (e: any) {
    return {
      ok: false,
      dry_run: false,
      reason: `backup_failed: ${e.message}`,
      diagnostics: baseDiag,
    };
  }
  baseDiag.backup_path = exposePaths ? backupPath : path.basename(backupPath);

  // TEST-ONLY: simulate an external writer touching the file mid-surgery.
  // Awaited so it can introduce a real yield point between load and write — the
  // exact interleaving window the per-path mutex must close.
  if (req.__beforeWriteHook) await req.__beforeWriteHook();

  // mtime re-check: if the file changed on disk between our load and now, some
  // other writer (e.g. CC appending to a live session) touched it. Our in-memory
  // plan is stale; writing would silently destroy their append. Abort instead.
  // The in-process mutex prevents OUR concurrent surgeries from racing; this
  // guards against writers we don't control.
  try {
    const mtimeNow = fs.statSync(req.file_path).mtimeMs;
    if (mtimeNow !== mtimeAtLoad) {
      return {
        ok: false,
        dry_run: false,
        reason: `concurrent_modification: the file changed on disk after it was loaded (mtime ${mtimeAtLoad} -> ${mtimeNow}). Aborting to avoid clobbering the external change. No mutation performed.`,
        diagnostics: baseDiag,
      };
    }
  } catch (e: any) {
    return {
      ok: false,
      dry_run: false,
      reason: `concurrent_modification: could not re-stat the file before writing (${e.message}). Aborting.`,
      diagnostics: baseDiag,
    };
  }

  // Atomic write: write to a UNIQUE temp, then rename over the original.
  // The pid+UUID suffix avoids colliding with a stale .tmp left by a prior crash
  // or with any other writer using a fixed .tmp name.
  const tempPath = `${req.file_path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, finalContent);
    fs.renameSync(tempPath, req.file_path);
  } catch (e: any) {
    // Restore from backup on failure
    try { fs.copyFileSync(backupPath, req.file_path); } catch {}
    if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch {}
    return {
      ok: false,
      dry_run: false,
      reason: `write_failed: ${e.message}. File restored from backup.`,
      diagnostics: baseDiag,
    };
  }

  // Post-write re-validation: read the file back FROM DISK and recompute the
  // pair balance. The in-memory plan said how many orphans we expect; if the
  // on-disk content disagrees (e.g. a serialization/encoding/truncation issue
  // corrupted a record), restore from backup and fail. This catches disk-level
  // corruption that the in-memory check can't see.
  try {
    const onDisk = loadJsonl(req.file_path);
    const diskBalance = computePairBalance(onDisk);
    const lineMismatch = onDisk.length !== finalRecords.length;
    const orphanMismatch = diskBalance.orphans !== plannedBalance.orphans;
    if (lineMismatch || orphanMismatch) {
      // Roll back: the written file does not match the validated plan.
      try { fs.copyFileSync(backupPath, req.file_path); } catch {}
      return {
        ok: false,
        dry_run: false,
        reason: `post_write_validation_failed: on-disk content diverged from the validated plan (` +
          `lines ${finalRecords.length} -> ${onDisk.length}, orphans ${plannedBalance.orphans} -> ${diskBalance.orphans}). ` +
          `File restored from backup.`,
        diagnostics: baseDiag,
      };
    }
  } catch (e: any) {
    // Could not read the file back to validate — restore and fail.
    try { fs.copyFileSync(backupPath, req.file_path); } catch {}
    return {
      ok: false,
      dry_run: false,
      reason: `post_write_validation_failed: could not re-read the file after writing (${e.message}). File restored from backup.`,
      diagnostics: baseDiag,
    };
  }

  return { ok: true, dry_run: false, diagnostics: baseDiag };
}
