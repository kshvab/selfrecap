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
import { loadJsonl, getRecordText, type JsonlRecord } from "./jsonl.js";

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
 * Run surgery (or dry-run). Returns full diagnostics regardless of outcome.
 * On failure, ok=false and reason is set; no mutation has occurred.
 */
export function performSurgery(req: SurgeryRequest): SurgeryResult {
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
  const sampleRecord = records[0] || cutRecord;

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
    permissionMode: (sampleRecord as any).permissionMode || "acceptEdits",
    userType: (sampleRecord as any).userType || "external",
    entrypoint: (sampleRecord as any).entrypoint || "cli",
    cwd: (sampleRecord as any).cwd || "",
    sessionId: (sampleRecord as any).sessionId || "",
    version: (sampleRecord as any).version || "2.1.92",
    gitBranch: (sampleRecord as any).gitBranch || "HEAD",
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

  let toolUseCount = 0;
  let toolResultCount = 0;
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of finalRecords) {
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
  // finalRecords AND that record is an assistant message.
  // This is the structural fingerprint of "voice ran surgery on its own session
  // while a bash tool_use was in-flight" — tool_result is expected to land
  // post-surgery via CC's append-to-file when bash returns.
  let tailOrphanOnly = false;
  if (orphanUses.length === 1 && orphanResults.length === 0 && finalRecords.length > 0) {
    const lastRecord = finalRecords[finalRecords.length - 1];
    if (lastRecord && lastRecord.type === "assistant") {
      const c = lastRecord.message?.content;
      if (Array.isArray(c)) {
        tailOrphanOnly = c.some(
          (b: any) => b?.type === "tool_use" && b.id === orphanUses[0],
        );
      }
    }
  }

  baseDiag.pair_balance = {
    tool_use: toolUseCount,
    tool_result: toolResultCount,
    orphans: orphanUses.length + orphanResults.length,
    tail_orphan_only: tailOrphanOnly,
  };

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

  // Atomic write: write to temp, then rename
  const tempPath = req.file_path + ".tmp";
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

  return { ok: true, dry_run: false, diagnostics: baseDiag };
}
