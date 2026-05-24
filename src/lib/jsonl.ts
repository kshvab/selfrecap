/**
 * JSONL utilities — shared logic for reading Claude Code session files.
 *
 * Each line is a JSON object representing a record in the conversation:
 *  - user / assistant / system / file-history-snapshot / attachment / etc.
 *
 * These helpers traverse the various content shapes (string, content array
 * with text/tool_use/tool_result/thinking blocks) to extract searchable text.
 */

import fs from "fs";

export interface JsonlRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: {
    role?: string;
    content?: any;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
    stop_reason?: string;
  };
  content?: string;
  [key: string]: any;
}

/**
 * Load a JSONL file and parse each line. Lines that fail to parse are skipped
 * silently (the file may be mid-write or contain partial records).
 */
export function loadJsonl(filePath: string): JsonlRecord[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    try {
      return JSON.parse(line) as JsonlRecord;
    } catch {
      return {} as JsonlRecord;
    }
  });
}

/**
 * Load file as raw lines (string array) — useful when callers need both
 * the parsed objects and the original line strings.
 */
export function loadJsonlLines(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n");
}

/**
 * Extract ALL searchable text from a record. No truncation.
 * Traverses: message.content (string OR array), tool_use.input (full JSON),
 * tool_result.content (string OR array of blocks), thinking blocks, system content.
 */
export function getRecordText(o: JsonlRecord): string {
  let s = "";

  // System records may have direct content
  if (typeof o.content === "string") s += o.content + " ";

  const c = o.message?.content;
  if (typeof c === "string") {
    s += c + " ";
  } else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === "text" && typeof b.text === "string") {
        s += b.text + " ";
      } else if (b.type === "tool_use") {
        s += "[tool:" + (b.name || "") + "] ";
        if (b.input) s += JSON.stringify(b.input) + " ";
      } else if (b.type === "tool_result") {
        if (typeof b.content === "string") {
          s += b.content + " ";
        } else if (Array.isArray(b.content)) {
          for (const sub of b.content) {
            if (sub && sub.type === "text" && typeof sub.text === "string") s += sub.text + " ";
            else if (typeof sub === "string") s += sub + " ";
            else if (sub) s += JSON.stringify(sub) + " ";
          }
        }
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        s += b.thinking + " ";
      }
    }
  }

  return s;
}

/**
 * Detect recap injection messages. All recaps contain the JSON sentinel
 * `"sentinel":"<NAME>"` (with or without space after colon) in their content.
 * The marker name is configurable (config.sentinel_name) and threaded in by
 * callers so existing recaps authored with a different marker still match.
 *
 * exclude_recap=true callers use this to skip recap messages during search,
 * preventing recap content from polluting cut-point lookups.
 */
export function isRecapMessage(o: JsonlRecord, sentinelName: string): boolean {
  const text = getRecordText(o);
  return text.includes(`"sentinel":"${sentinelName}"`) ||
         text.includes(`"sentinel": "${sentinelName}"`);
}

/**
 * Build a compact summary of a record for response payloads.
 * Used in cut-point matches and surrounding context windows.
 */
export interface RecordSummary {
  line_index: number;
  uuid: string | null;
  parent_uuid: string | null;
  timestamp: string | null;
  type: string | null;
  role: string | null;
  content_preview: string;
  /**
   * True if this record can be used as a cut point in surgery (has a uuid).
   * False for records like fakechat channel envelopes that lack uuid in JSONL —
   * AI should not pick these as cut_through_uuid targets.
   */
  selectable: boolean;
  /** When `selectable: false`, why the record cannot be a cut point. */
  unselectable_reason?: string;
}

export function recordSummary(
  o: JsonlRecord,
  lineIdx: number,
  previewChars = 200,
): RecordSummary {
  const text = getRecordText(o);
  const hasUuid = typeof o.uuid === "string" && o.uuid.length > 0;
  return {
    line_index: lineIdx,
    uuid: hasUuid ? o.uuid! : null,
    parent_uuid: o.parentUuid ?? null,
    timestamp: o.timestamp ?? null,
    type: o.type ?? null,
    role: o.message?.role ?? null,
    content_preview: text.slice(0, previewChars).replace(/\n/g, " ").trim(),
    selectable: hasUuid,
    ...(hasUuid ? {} : { unselectable_reason: "missing_uuid" }),
  };
}

/**
 * Build the `context_before` and `context_after` window around a target line
 * for inclusion in match responses. Helps the AI verify the correct location
 * by seeing the surrounding conversational flow.
 */
export interface ContextWindow {
  before: RecordSummary[];
  after: RecordSummary[];
}

export function buildContextWindow(
  records: JsonlRecord[],
  idx: number,
  span = 2,
): ContextWindow {
  const before: RecordSummary[] = [];
  const after: RecordSummary[] = [];
  for (let i = Math.max(0, idx - span); i < idx; i++) {
    const r = records[i];
    if (r) before.push(recordSummary(r, i));
  }
  for (let i = idx + 1; i <= Math.min(records.length - 1, idx + span); i++) {
    const r = records[i];
    if (r) after.push(recordSummary(r, i));
  }
  return { before, after };
}
