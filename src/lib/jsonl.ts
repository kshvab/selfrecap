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
 * Load a JSONL file and parse each line, for read-only callers (monitor,
 * finder, planner). A line that fails to parse becomes an empty `{}`
 * placeholder so indices stay aligned with file lines. Never write these
 * records back: surgery reads with readSessionBytes and keeps raw bytes.
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

/** One complete line of a session file: its exact bytes and, if it parses, the record. */
export interface SessionLine {
  raw: Buffer;
  rec: JsonlRecord | null;
}

export interface SessionBytes {
  /** Every byte read, including a trailing line Claude Code may still be writing. */
  buf: Buffer;
  /** Bytes up to and including the last newline: the complete lines. */
  completeLength: number;
  lines: SessionLine[];
}

/**
 * Read a session file for surgery: one read, complete lines only, bytes kept
 * exactly. A line that does not parse keeps its bytes and gets `rec: null`;
 * a trailing partial line is left out of `lines` (it is still being written).
 */
export function readSessionBytes(filePath: string): SessionBytes {
  const buf = fs.readFileSync(filePath);
  const completeLength = buf.lastIndexOf(0x0a) + 1;
  const lines: SessionLine[] = [];
  let start = 0;
  while (start < completeLength) {
    const nl = buf.indexOf(0x0a, start);
    const raw = buf.subarray(start, nl);
    lines.push({ raw, rec: parseLine(raw) });
    start = nl + 1;
  }
  return { buf, completeLength, lines };
}

function parseLine(raw: Buffer): JsonlRecord | null {
  if (raw.length === 0) return null;
  let text = raw.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonlRecord) : null;
  } catch {
    return null;
  }
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
 * Build a compact summary of a record for response payloads.
 * Used in cut-point matches and surrounding context windows.
 */
export interface RecordSummary {
  line_index: number;
  uuid: string | null;
  parent_uuid: string | null;
  timestamp: string | null;
  type: string | null;
  /** For system records: turn_duration, stop_hook_summary, away_summary, ... */
  subtype: string | null;
  /** A user record carrying tool output rather than a typed message. */
  is_tool_result: boolean;
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
    subtype: o.subtype ?? null,
    is_tool_result: Array.isArray(o.message?.content) && o.message!.content.some((b: any) => b?.type === "tool_result"),
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
