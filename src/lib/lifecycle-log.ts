/**
 * What happened to each voice's nudges and restarts, kept where the operator
 * can see it later.
 *
 *   logs/lifecycle.log          one line per event, append-only: the trail
 *   logs/lifecycle-state.json   the last event per voice: the signal
 *
 * The log is for whoever goes looking (`selfrecap log`). The state is what
 * /contexts returns as `lifecycle`, so a dashboard shows "restart failed"
 * instead of silence — an absent failure must never read as a success, so
 * successes are recorded too, with their time.
 *
 * Written by `selfrecap restart` (a separate process) and by the server's
 * nudger. Every write is a small whole-file replace; the last writer wins,
 * which is right for "the last event", with one exception: a routine event
 * (a nudge) never replaces a failure in the state. The failure stays the
 * signal until something that settles it (a resume, a restart) comes along.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** logs/ at the repo root, whichever process (server, `selfrecap restart` from any cwd) writes. */
export const LOG_DIR = process.env.RECAP_LOG_DIR ?? fileURLToPath(new URL("../../logs/", import.meta.url));
const LOG_FILE = () => path.join(LOG_DIR, "lifecycle.log");
const STATE_FILE = () => path.join(LOG_DIR, "lifecycle-state.json");

/**
 * Events. `ok` says whether it is good news; a dashboard flags the rest.
 *   nudged            the nudger's courier delivered the recap-and-restart message
 *   nudge_failed      the courier did not deliver it
 *   restart_overdue   a recap was applied, but the old process is still running long after
 *   over_ceiling      past 95%: too tight to recap cleanly; needs the operator (trim first)
 *   restart_scheduled the session ran `selfrecap restart`; waiting for it to go idle
 *   resumed           the session is back: expected id, expected name, live, not stuck
 *   resume_failed     the resume did not come up, came up stuck, or its helper died
 *   aborted           nothing was killed or resumed (never idle, closed by someone else, a lock, a check)
 *   id_drift          the running id is not the one config.yaml leads to
 */
export type LifecycleEvent =
  | "nudged"
  | "nudge_failed"
  | "restart_overdue"
  | "over_ceiling"
  | "restart_scheduled"
  | "resumed"
  | "resume_failed"
  | "aborted"
  | "id_drift";

const GOOD: ReadonlySet<LifecycleEvent> = new Set(["nudged", "restart_scheduled", "resumed"]);
/** Good news that says nothing about whether an earlier failure was fixed. */
const ROUTINE: ReadonlySet<LifecycleEvent> = new Set(["nudged"]);

/** A scheduled restart with no outcome after this long means its helper died: idle wait (20 min) + resume check (3 min) + slack. */
export const SCHEDULED_STALE_MS = 25 * 60_000;

export interface LifecycleState {
  event: LifecycleEvent;
  ok: boolean;
  at: string;
  session_id?: string;
  detail: string;
}

/** The state as recorded, with one inference: a restart scheduled long ago with no outcome is a failure. */
export function readLifecycleState(now = Date.now()): Record<string, LifecycleState> {
  let raw: Record<string, LifecycleState>;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (!raw || typeof raw !== "object") return {};
  } catch {
    return {};
  }
  for (const [voice, s] of Object.entries(raw)) {
    if (s?.event === "restart_scheduled" && now - Date.parse(s.at) > SCHEDULED_STALE_MS) {
      raw[voice] = { ...s, ok: false, detail: `${s.detail}; no outcome recorded after ${SCHEDULED_STALE_MS / 60_000} min: the restart helper died or never ran` };
    }
  }
  return raw;
}

/** Log an event and make it the voice's current state. Never throws: a log failure must not stop a restart. */
export function recordLifecycle(voice: string, event: LifecycleEvent, detail: string, sessionId?: string): LifecycleState {
  const key = voice.toLowerCase();
  const state: LifecycleState = {
    event,
    ok: GOOD.has(event),
    at: new Date().toISOString(),
    ...(sessionId ? { session_id: sessionId } : {}),
    detail,
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE(), `${state.at} ${key.padEnd(12)} ${event.padEnd(17)} ${sessionId ?? "-"} ${detail.replace(/\s+/g, " ")}\n`);
    const all = readLifecycleState();
    if (ROUTINE.has(event) && all[key] && !all[key]!.ok) return state; // keep the failure as the signal
    all[key] = state;
    writeState(all);
  } catch (e: any) {
    console.error(`[lifecycle] could not record ${event} for ${voice}: ${e?.message ?? e}`);
  }
  return state;
}

function writeState(all: Record<string, LifecycleState>): void {
  const tmp = `${STATE_FILE()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  // A reader holding the file open makes the rename fail on Windows (EPERM) for an instant: retry briefly.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, STATE_FILE());
      return;
    } catch (e) {
      if (i >= 20) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // brief spin: this runs in short-lived restart helpers and between server ticks
      }
    }
  }
}

/** The last `n` lines of the log. */
export function tailLifecycleLog(n: number): string[] {
  try {
    return fs.readFileSync(LOG_FILE(), "utf8").split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
