/**
 * Cut-point finder algorithms.
 *
 * Three methods supported:
 *   - marker_phrase   — exact substring match in record text
 *   - timestamp       — last record before given ISO timestamp
 *   - anchor_offset   — find anchor phrase, then offset N records
 *
 * All methods support `excludeRecap` to skip injected recap records (see
 * isRecapRecord in recaps.ts; the sentinel name is config.sentinel_name).
 */

import {
  loadJsonl,
  getRecordText,
  recordSummary,
  buildContextWindow,
  type JsonlRecord,
  type RecordSummary,
  type ContextWindow,
} from "./jsonl.js";
import { isRecapRecord } from "./recaps.js";

export interface Match extends RecordSummary {
  context_before: RecordSummary[];
  context_after: RecordSummary[];
}

function buildMatch(records: JsonlRecord[], idx: number): Match {
  const r = records[idx];
  if (!r) throw new Error(`Record at index ${idx} not found`);
  const summary = recordSummary(r, idx);
  const window = buildContextWindow(records, idx);
  return {
    ...summary,
    context_before: window.before,
    context_after: window.after,
  };
}

export function findMarkerPhrase(
  filePath: string,
  phrase: string,
  sentinelName: string,
  excludeRecap = true,
): Match[] {
  if (!phrase || phrase.length < 3) return [];
  const records = loadJsonl(filePath);
  const matches: Match[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (excludeRecap && isRecapRecord(r, sentinelName)) continue;
    const text = getRecordText(r);
    if (text.includes(phrase)) {
      matches.push(buildMatch(records, i));
    }
  }
  return matches;
}

export function findTimestampBefore(
  filePath: string,
  beforeIso: string,
  sentinelName: string,
  excludeRecap = true,
): Match[] {
  const cutoff = new Date(beforeIso).getTime();
  if (isNaN(cutoff)) return [];
  const records = loadJsonl(filePath);

  let lastIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (excludeRecap && isRecapRecord(r, sentinelName)) continue;
    if (!r.timestamp) continue;
    const t = new Date(r.timestamp).getTime();
    if (isNaN(t)) continue;
    if (t < cutoff) lastIdx = i;
    else break;
  }
  if (lastIdx < 0) return [];
  return [buildMatch(records, lastIdx)];
}

export function findAnchorOffset(
  filePath: string,
  anchorPhrase: string,
  offset: number,
  direction: "before" | "after",
  sentinelName: string,
  excludeRecap = true,
): Match[] {
  const anchors = findMarkerPhrase(filePath, anchorPhrase, sentinelName, excludeRecap);
  if (anchors.length === 0) return [];
  const records = loadJsonl(filePath);
  const sign = direction === "before" ? -1 : 1;
  const results: Match[] = [];
  for (const a of anchors) {
    const targetIdx = a.line_index + sign * offset;
    if (targetIdx < 0 || targetIdx >= records.length) continue;
    results.push(buildMatch(records, targetIdx));
  }
  return results;
}

export type FindMethod = "marker_phrase" | "timestamp" | "anchor_offset";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export interface FindSpec {
  method: FindMethod;
  phrase?: string;
  before?: string;
  anchor_phrase?: string;
  offset?: number;
  direction?: "before" | "after";
  exclude_recap?: boolean;
  /** Cap on returned matches. Default 50, max 500. `total_matches` always reports the full count. */
  limit?: number;
  /**
   * Filter out matches with timestamp >= this ISO timestamp.
   * Useful for excluding self-contamination from current session activity.
   * Example: `before_timestamp: "2026-05-07T22:58:00Z"` to find pre-test data only.
   */
  before_timestamp?: string;
}

export interface FindResult {
  method: FindMethod;
  spec: FindSpec;
  exclude_recap: boolean;
  /** Total matches found in file (before limit applied). */
  total_matches: number;
  /** Number of matches returned in `matches` array (after limit). */
  returned_count: number;
  /** Limit applied to truncate matches. */
  limit: number;
  /** True if total_matches > returned_count — caller should refine query. */
  truncated: boolean;
  matches: Match[];
  file: string;
  total_lines: number;
}

export function findCutPoint(filePath: string, spec: FindSpec, sentinelName: string): FindResult {
  const excludeRecap = spec.exclude_recap !== false;
  let matches: Match[] = [];

  switch (spec.method) {
    case "marker_phrase":
      matches = findMarkerPhrase(filePath, spec.phrase || "", sentinelName, excludeRecap);
      break;
    case "timestamp":
      matches = findTimestampBefore(filePath, spec.before || "", sentinelName, excludeRecap);
      break;
    case "anchor_offset":
      matches = findAnchorOffset(
        filePath,
        spec.anchor_phrase || "",
        spec.offset || 0,
        spec.direction || "after",
        sentinelName,
        excludeRecap,
      );
      break;
    default:
      throw new Error(`Unknown method: ${(spec as any).method}`);
  }

  // Optional self-contamination filter: drop matches at or after the given timestamp.
  if (spec.before_timestamp) {
    const cutoff = new Date(spec.before_timestamp).getTime();
    if (!isNaN(cutoff)) {
      matches = matches.filter((m) => {
        if (!m.timestamp) return true; // keep records without timestamps (rare)
        const t = new Date(m.timestamp).getTime();
        return isNaN(t) ? true : t < cutoff;
      });
    }
  }

  const limit = Math.min(Math.max(spec.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const totalMatches = matches.length;
  const truncated = totalMatches > limit;
  const returned = truncated ? matches.slice(0, limit) : matches;

  const records = loadJsonl(filePath);
  return {
    method: spec.method,
    spec,
    exclude_recap: excludeRecap,
    total_matches: totalMatches,
    returned_count: returned.length,
    limit,
    truncated,
    matches: returned,
    file: filePath,
    total_lines: records.length,
  };
}

export const AROUND_DEFAULT_SPAN = 30;
export const AROUND_MAX_SPAN = 200;

export interface RecordsAround {
  file: string;
  total_lines: number;
  /** First and last line index returned (inclusive). */
  from: number;
  to: number;
  records: RecordSummary[];
}

/**
 * The records from `line - span` to `line + span`, summarized — for reading a
 * seam in context. A cut is found this way far more often than by phrase
 * alone: search the line, then read around it.
 */
export function recordsAround(filePath: string, line: number, span = AROUND_DEFAULT_SPAN): RecordsAround {
  const records = loadJsonl(filePath);
  const s = Math.min(Math.max(span, 1), AROUND_MAX_SPAN);
  const from = Math.max(0, line - s);
  const to = Math.min(records.length - 1, line + s);
  const out: RecordSummary[] = [];
  for (let i = from; i <= to; i++) out.push(recordSummary(records[i]!, i, 160));
  return { file: filePath, total_lines: records.length, from, to, records: out };
}
