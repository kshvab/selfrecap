/**
 * GET /lifecycle — per voice: is it live (and how many sessions answer to it),
 * its last nudge/restart event, and what the nudger would do right now.
 * Read-only: computing the nudge decision sends nothing.
 *
 * Liveness and the nudge decision need Windows (see src/lib/sessions.ts);
 * elsewhere `supported` is false and only the recorded events are returned.
 */

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { voiceRefs } from "../lib/lifecycle.js";
import { readLifecycleState } from "../lib/lifecycle-log.js";
import { decideNudges, liveMemory } from "../lib/nudger.js";
import { liveByName } from "../lib/sessions.js";

export function registerLifecycle(app: FastifyInstance, config: AppConfig) {
  app.get("/lifecycle", async () => {
    const supported = process.platform === "win32";
    const state = readLifecycleState();
    const decisions = new Map(supported ? decideNudges(config, liveMemory).map((d) => [d.voice, d]) : []);
    return {
      supported,
      nudge: config.nudge,
      voices: Object.fromEntries(
        voiceRefs(config).map((s) => {
          const rows = supported && s.account ? liveByName(s.name, [s.account]) : [];
          const d = decisions.get(s.key);
          return [
            s.key,
            {
              name: s.name,
              live: supported ? rows.map((r) => ({ pid: r.pid, session_id: r.sessionId, status: r.status, waiting_for: r.waitingFor })) : null,
              lifecycle: state[s.key] ?? null,
              nudge: d ? { action: d.action, reason: d.reason } : null,
            },
          ];
        }),
      ),
    };
  });
}
