/**
 * Context size monitor.
 *
 * Reverse-engineered from CC's /context implementation:
 *   1. Scan JSONL backward from last line
 *   2. Skip records with isSidechain: true (subagents — separate context)
 *   3. Find most recent assistant message with `usage` object
 *   4. Total context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Cache-read tokens count toward context window even though they're cheap to bill.
 * Output tokens are not part of the input context window.
 */

import fs from "fs";
import { loadJsonl } from "./jsonl.js";

export interface ContextReading {
  voice?: string;
  file: string;
  tokens_total: number;
  percent_of_1m: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  file_size_bytes: number;
  line_count: number;
  last_usage_ts: string | null;
  last_usage_line_idx: number;
}

export function readContextSize(filePath: string, voice?: string): ContextReading | null {
  if (!fs.existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  const records = loadJsonl(filePath);

  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r) continue;
    if (r.isSidechain === true) continue;
    if (r.type !== "assistant") continue;
    const usage = r.message?.usage;
    if (!usage) continue;

    const input = usage.input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const output = usage.output_tokens || 0;
    const total = input + cacheRead + cacheCreation;

    return {
      voice,
      file: filePath,
      tokens_total: total,
      percent_of_1m: Number(((total / 1_000_000) * 100).toFixed(2)),
      input_tokens: input,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      output_tokens: output,
      file_size_bytes: stats.size,
      line_count: records.length,
      last_usage_ts: r.timestamp ?? null,
      last_usage_line_idx: i,
    };
  }

  // No usage entry yet — file empty or only system records
  return {
    voice,
    file: filePath,
    tokens_total: 0,
    percent_of_1m: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    output_tokens: 0,
    file_size_bytes: stats.size,
    line_count: records.length,
    last_usage_ts: null,
    last_usage_line_idx: -1,
  };
}
