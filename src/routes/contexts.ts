/**
 * GET /contexts — every configured voice in one call, for dashboards.
 *
 * Per voice: the context reading from the LIVE file (continuations
 * followed), the recap stack, the headroom left for a recap, whether the
 * reading is stale, whether the session is running (Windows only), and the
 * last nudge/restart event. Per-voice errors are isolated: one failed voice
 * doesn't break the response for the others.
 *
 * With `usage.enabled`, also `account_usage`: the plan-usage bars per Claude
 * account (see src/lib/account-usage.ts).
 */

import path from "path";
import type { FastifyInstance } from "fastify";
import fs from "fs";
import { readContextSize, type ContextReading } from "../lib/monitor.js";
import { resolveLiveSession } from "../lib/continuation.js";
import { loadJsonl } from "../lib/jsonl.js";
import { scanRecapStack } from "../lib/recaps.js";
import { headroomFor, type RecapPlan } from "../lib/recap-plan.js";
import { isUnderAllowedRoots, type AppConfig } from "../config.js";
import { readLifecycleState, type LifecycleState } from "../lib/lifecycle-log.js";
import { accountUsage } from "../lib/account-usage.js";
import { voiceRefs } from "../lib/lifecycle.js";
import { accountOfSessionFile, knownAccounts, listPipes, liveByName } from "../lib/sessions.js";

type VoiceContextEntry = {
  exists: boolean;
  error?: string;
  /** Session from config.yaml — the anchor. A base name unless expose_paths. */
  configured_path?: string;
  /** File actually read, after following `continued-in` markers. */
  resolved_path?: string;
  /** Continuations followed. > 0 means the config anchor is a frozen ancestor. */
  continuation_hops?: number;
  /** Successor named by a marker whose file is gone — this reading is stale. */
  broken_link?: string;
  /** Room left before the ceiling, and the recap body budget it leaves. */
  headroom?: RecapPlan["headroom"];
  /** The recap stack at the head of the live session. */
  recaps?: { count: number; last_id: string | null; last_applied_at: string | null };
  /**
   * The reading does not describe the context the session will run on: it
   * comes from a file behind a broken continuation link, or the last recap
   * landed after the running process started (or after the last reading),
   * so the process still holds the pre-surgery context until its restart.
   */
  stale_reading?: boolean;
  stale_reason?: string;
  /**
   * Live sessions answering to this voice's name on its account. Null when
   * liveness cannot be checked (not Windows; see src/lib/sessions.ts).
   */
  live?: Array<{ pid: number; session_id: string; status: string | null; started_at: string | null }> | null;
  /** The last nudge/restart event, or null. Not-ok events want a human. */
  lifecycle?: LifecycleState | null;
} & Partial<Omit<ContextReading, "voice" | "file">>;

export function registerContexts(app: FastifyInstance, config: AppConfig) {
  const show = (p: string) => (config.expose_paths ? p : path.basename(p));
  const usageAccounts = knownAccounts(
    config.accounts,
    Object.values(config.voices).flatMap((v) => accountOfSessionFile(v.session) ?? []),
  );
  const refs = new Map(voiceRefs(config).map((r) => [r.key, r]));

  app.get("/contexts", async () => {
    const snapshot_at = new Date().toISOString();
    const lifecycle = readLifecycleState();
    const canCheckLive = process.platform === "win32" && listPipes() !== null;

    const results = Object.entries(config.voices).map(([name, v]): [string, VoiceContextEntry] => {
      const ref = refs.get(name)!;
      const live =
        canCheckLive && ref.account
          ? liveByName(ref.name, [ref.account]).map((r) => ({
              pid: r.pid,
              session_id: r.sessionId,
              status: r.status,
              started_at: r.startedAt === null ? null : new Date(r.startedAt).toISOString(),
            }))
          : null;
      const base = { configured_path: show(v.session), live, lifecycle: lifecycle[name] ?? null };
      if (!fs.existsSync(v.session)) return [name, { exists: false, error: "file_not_found", ...base }];
      // The configured path is an anchor; a continued session lives in a
      // newer file. Follow the chain or the reading is frozen at the moment
      // of the continuation.
      const session = resolveLiveSession(v.session);
      if (!isUnderAllowedRoots(config, path.resolve(session.resolved_path)).ok) {
        return [name, { exists: false, error: "outside_allowed_roots", ...base }];
      }
      try {
        const records = loadJsonl(session.resolved_path);
        const reading = readContextSize(session.resolved_path, name, records);
        if (!reading) return [name, { exists: false, error: "file_not_found", ...base }];
        const { voice: _voice, file: _file, ...metrics } = reading;
        const stack = scanRecapStack(records, config.sentinel_name);
        const last = stack.recaps[stack.recaps.length - 1];
        let stale_reason: string | undefined;
        if (session.broken_link) {
          stale_reason = `continued into ${session.broken_link}, whose file is gone: this is the last readable file`;
        } else if (last?.applied_at) {
          const applied = Date.parse(last.applied_at);
          const started = live?.length === 1 && live[0]!.started_at ? Date.parse(live[0]!.started_at) : null;
          if (started !== null && applied > started) {
            stale_reason = `${last.id ?? "the last recap"} was applied after the running session started: it holds the old context until it restarts`;
          } else if (reading.last_usage_ts && applied > Date.parse(reading.last_usage_ts)) {
            stale_reason = `taken before ${last.id ?? "the last recap"} was applied; it updates after the restart`;
          }
        }
        return [
          name,
          {
            exists: true,
            ...base,
            resolved_path: show(session.resolved_path),
            continuation_hops: session.continuation_hops,
            ...(session.broken_link ? { broken_link: session.broken_link } : {}),
            ...metrics,
            headroom: headroomFor(reading.tokens_total),
            recaps: { count: stack.recaps.length, last_id: last?.id ?? null, last_applied_at: last?.applied_at ?? null },
            stale_reading: stale_reason !== undefined,
            ...(stale_reason ? { stale_reason } : {}),
          },
        ];
      } catch (e: any) {
        const why = !config.expose_paths && typeof e?.path === "string" ? `${e.code ?? "error"} (${e.syscall ?? "fs"})` : e.message;
        return [name, { exists: false, error: `read_failed: ${why}`, ...base }];
      }
    });

    return {
      snapshot_at,
      voice_count: results.length,
      ...(config.usage.enabled
        ? { account_usage: await accountUsage(usageAccounts, { warn: (m) => app.log.warn(m) }) }
        : {}),
      voices: Object.fromEntries(results),
    };
  });
}
