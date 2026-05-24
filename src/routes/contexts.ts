/**
 * GET /contexts — aggregated context readings for all configured voices.
 *
 * Single-call snapshot for dashboards. Reads all voice files in parallel.
 * Per-voice errors (missing file, parse failure) are isolated — one failed
 * voice doesn't break the response for others.
 */

import type { FastifyInstance } from "fastify";
import fs from "fs";
import { readContextSize, type ContextReading } from "../lib/monitor.js";
import type { AppConfig } from "../config.js";

// A per-voice entry is the shared ContextReading projection (minus `voice`,
// which is the map key, and `file`, which we never expose here) plus liveness
// fields. Derived from ContextReading so the field set can't drift out of sync.
type VoiceContextEntry = {
  exists: boolean;
  error?: string;
} & Partial<Omit<ContextReading, "voice" | "file">>;

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
          // Drop `voice` (the map key) and `file` (never exposed here); keep the
          // rest of the shared ContextReading projection verbatim.
          const { voice: _voice, file: _file, ...metrics } = reading;
          return [name, { exists: true, ...metrics }];
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
