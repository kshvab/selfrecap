/**
 * Cut-point finder algorithms.
 *
 * Three methods supported:
 *   - marker_phrase   — exact substring match in record text
 *   - timestamp       — last record before given ISO timestamp
 *   - anchor_offset   — find anchor phrase, then offset N records
 *
 * All methods support `excludeRecap` to skip recap injection messages
 * (identified by the universal MIRROR-RECAP sentinel).
 */

import {
  loadJsonl,
  getRecordText,
  isRecapMessage,
  recordSummary,
  buildContextWindow,
  type JsonlRecord,
  type RecordSummary,
  type ContextWindow,
} from "./jsonl.js";

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
  excludeRecap = true,
): Match[] {
  if (!phrase || phrase.length < 3) return [];
  const records = loadJsonl(filePath);
  const matches: Match[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (excludeRecap && isRecapMessage(r)) continue;
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
  excludeRecap = true,
): Match[] {
  const cutoff = new Date(beforeIso).getTime();
  if (isNaN(cutoff)) return [];
  const records = loadJsonl(filePath);

  let lastIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (excludeRecap && isRecapMessage(r)) continue;
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
  excludeRecap = true,
): Match[] {
  const anchors = findMarkerPhrase(filePath, anchorPhrase, excludeRecap);
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

export function findCutPoint(filePath: string, spec: FindSpec): FindResult {
  const excludeRecap = spec.exclude_recap !== false;
  let matches: Match[] = [];

  switch (spec.method) {
    case "marker_phrase":
      matches = findMarkerPhrase(filePath, spec.phrase || "", excludeRecap);
      break;
    case "timestamp":
      matches = findTimestampBefore(filePath, spec.before || "", excludeRecap);
      break;
    case "anchor_offset":
      matches = findAnchorOffset(
        filePath,
        spec.anchor_phrase || "",
        spec.offset || 0,
        spec.direction || "after",
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
