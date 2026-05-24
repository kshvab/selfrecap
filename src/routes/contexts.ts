/**
 * GET /contexts — aggregated context readings for all configured voices.
 *
 * Single-call snapshot for dashboards. Reads all voice files in parallel.
 * Per-voice errors (missing file, parse failure) are isolated — one failed
 * voice doesn't break the response for others.
 */

import type { FastifyInstance } from "fastify";
import fs from "fs";
import { readContextSize } from "../lib/monitor.js";
import type { AppConfig } from "../config.js";

interface VoiceContextEntry {
  exists: boolean;
  error?: string;
  tokens_total?: number;
  percent_of_1m?: number;
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  output_tokens?: number;
  file_size_bytes?: number;
  line_count?: number;
  last_usage_ts?: string | null;
  last_usage_line_idx?: number;
}

export function registerContexts(app: FastifyInstance, config: AppConfig) {
  app.get("/contexts", async () => {
    const snapshot_at = new Date().toISOString();
    const voiceEntries = Object.entries(config.voices);

    const results = await Promise.all(
      voiceEntries.map(async ([name, v]): Promise<[string, VoiceContextEntry]> => {
        if (!fs.existsSync(v.path)) {
          return [name, { exists: false, error: "file_not_found" }];
        }
        try {
          const reading = readContextSize(v.path, name);
          if (!reading) {
            return [name, { exists: false, error: "no_usage_entries" }];
          }
          return [
            name,
            {
              exists: true,
              tokens_total: reading.tokens_total,
              percent_of_1m: reading.percent_of_1m,
              input_tokens: reading.input_tokens,
              cache_read_tokens: reading.cache_read_tokens,
              cache_creation_tokens: reading.cache_creation_tokens,
              output_tokens: reading.output_tokens,
              file_size_bytes: reading.file_size_bytes,
              line_count: reading.line_count,
              last_usage_ts: reading.last_usage_ts,
              last_usage_line_idx: reading.last_usage_line_idx,
            },
          ];
        } catch (e: any) {
          return [name, { exists: false, error: `read_failed: ${e.message}` }];
        }
      }),
    );

    return {
      snapshot_at,
      voice_count: results.length,
      voices: Object.fromEntries(results),
    };
  });
}
