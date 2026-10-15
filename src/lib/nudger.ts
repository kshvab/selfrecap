/**
 * The context nudge. WINDOWS ONLY, off by default (`nudge.enabled`).
 *
 * A colour on a dashboard is not an alert: it works only while someone
 * looks. This one has an addressee and an action. When a live session passes
 * `nudge.at` percent, it gets a message: find a seam, run /remember, then
 * restart.
 *
 * Only a session can call SendMessage, so the message travels by courier: a
 * one-shot `claude -p` on a cheap model (`nudge.model`), in the session's own
 * account, told to send a fixed text verbatim. The model writes nothing. A
 * nudge is recorded when the courier exits cleanly, and `nudge_failed` (not
 * ok) when it does not. Each courier is a `claude -p` run billed to that
 * account like any other.
 *
 * Needs Claude Code with cross-session messaging (SendMessage between
 * sessions: v2.1.224+, native Windows v2.1.234+) and a `name` on every
 * session it should reach (`claude --name`, the `name` the voice answers to).
 * Liveness comes from Claude Code's session registry and its Windows named
 * pipes (see sessions.ts): on macOS and Linux it reads nothing as live, so
 * the nudger does not start there.
 *
 * Three messages, by the session's situation:
 *   nudge     past the line: recap and restart
 *   overdue   a recap is applied but the old process is still running long
 *             after, or its restart failed: restart now, do not recap again
 *   ceiling   past 95% (or no room for a body): do NOT recap; stop and wait for
 *             the operator. Sent once per crossing, then silence: every nudge
 *             wakes the session and costs it a turn it cannot spare.
 *
 * Who is not nudged:
 *  - a voice that is not live (no registry row with a live pipe), or answers twice;
 *  - a voice whose running session is not the one config.yaml leads to (id drift);
 *  - a voice whose reading predates its process (just resumed: the number is the old process's);
 *  - a voice whose recap landed in the last OVERDUE_AFTER_MS (its restart is on the way);
 *  - a voice whose next recap body was written in the last hour (mid-recap);
 *  - a voice nudged within `cooldown_minutes`, or with a courier still running.
 *
 * State is in memory. A server restart forgets it; the worst case is one extra
 * message.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AppConfig } from "../config.js";
import { resolveLiveSession } from "./continuation.js";
import { voiceRefs } from "./lifecycle.js";
import { readLifecycleState, recordLifecycle } from "./lifecycle-log.js";
import { readContextSize } from "./monitor.js";
import { buildRecapPlan } from "./recap-plan.js";
import { claudeBin, claudeEnv, liveByName } from "./sessions.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const MID_RECAP_MS = 60 * 60_000;
/** A recap applied this long ago with the old process still running: the restart did not happen. */
export const OVERDUE_AFTER_MS = 20 * 60_000;
/** Past this the skill says: do not recap. */
export const CEILING_PERCENT = 95;
const COURIER_TIMEOUT_MS = 120_000;

const FROM = "From the selfrecap server (the /remember skill describes this):";

export function nudgeText(percent: number, at: number, cooldownMinutes: number): string {
  return [
    `${FROM} you are at ${percent.toFixed(1)}% of your context window (the nudge line is ${at}%).`,
    `At the next clean seam in your work: pause, run /remember, and when --go has succeeded restart as its last step says`,
    `(\`selfrecap restart\` if your plan has a restart command, otherwise the operator restarts you), then report and end your turn.`,
    `If you are already on it, ignore this. I look again in ${cooldownMinutes} min.`,
  ].join(" ");
}

export function overdueText(percent: number, recapId: string | null, why: string): string {
  return [
    `${FROM} your recap${recapId ? ` ${recapId}` : ""} is applied, but this session was not restarted (${why}), so you are still running on the old context at ${percent.toFixed(1)}%.`,
    `Do not recap again. Run \`selfrecap restart\` (or, without a restart command, ask the operator to restart you), send one line, and end your turn.`,
  ].join(" ");
}

export function ceilingText(percent: number): string {
  return [
    `${FROM} you are at ${percent.toFixed(1)}%, past the ${CEILING_PERCENT}% line where a recap cannot be written cleanly.`,
    `Do not run /remember. Reply with one line and end your turn; the operator takes it from here. You will not be nudged again until you are back under the line.`,
  ].join(" ");
}

export type NudgeKind = "nudge" | "overdue" | "ceiling";

export interface NudgeDecision {
  voice: string;
  action: NudgeKind | "skip";
  reason: string;
  percent?: number;
  recap_id?: string | null;
}

export interface NudgerMemory {
  /** Last message time per voice. */
  last: Map<string, number>;
  /** Voices already told they are past the ceiling, until they drop below the line. */
  ceilingTold: Set<string>;
  /** Voices with a courier still running. */
  inFlight: Set<string>;
}

/** The running nudger's memory; /lifecycle reads it so its answer matches what the next tick will do. */
export const liveMemory: NudgerMemory = newMemory();

export function newMemory(): NudgerMemory {
  return { last: new Map(), ceilingTold: new Set(), inFlight: new Set() };
}

/** What would happen to each voice now, and why. Pure reads: no sending, and `mem` is only read. */
export function decideNudges(config: AppConfig, mem: NudgerMemory, now = Date.now()): NudgeDecision[] {
  const out: NudgeDecision[] = [];
  const skip = (voice: string, reason: string, percent?: number) => out.push({ voice, action: "skip", reason, ...(percent !== undefined ? { percent } : {}) });
  const { at, cooldown_minutes } = config.nudge;
  const state = readLifecycleState(now);
  for (const ref of voiceRefs(config)) {
    if (!ref.account) {
      skip(ref.key, "account unknown");
      continue;
    }
    const rows = liveByName(ref.name, [ref.account]);
    if (rows.length === 0) {
      skip(ref.key, "not live");
      continue;
    }
    if (rows.length > 1) {
      skip(ref.key, `${rows.length} live sessions answer to ${ref.name}: the name does not resolve`);
      continue;
    }
    const row = rows[0]!;
    const resolved = resolveLiveSession(ref.entry.session);
    if (path.basename(resolved.resolved_path, ".jsonl") !== row.sessionId) {
      skip(ref.key, `id drift: running ${row.sessionId}, config leads to ${path.basename(resolved.resolved_path, ".jsonl")}`);
      continue;
    }
    let percent: number;
    let lastUsage: string | null;
    try {
      const reading = readContextSize(resolved.resolved_path, ref.key);
      if (!reading) {
        skip(ref.key, "no reading");
        continue;
      }
      percent = reading.percent_of_1m;
      lastUsage = reading.last_usage_ts;
    } catch (e: any) {
      skip(ref.key, `read failed: ${e?.message ?? e}`);
      continue;
    }
    if (percent < at) {
      skip(ref.key, "below the line", percent);
      continue;
    }
    if (lastUsage && row.startedAt && Date.parse(lastUsage) < row.startedAt) {
      skip(ref.key, "reading predates this process (just resumed)", percent);
      continue;
    }
    if (mem.inFlight.has(ref.key)) {
      skip(ref.key, "a courier is still on its way", percent);
      continue;
    }
    const last = mem.last.get(ref.key);
    if (last !== undefined && now - last < cooldown_minutes * 60_000) {
      skip(ref.key, "cooling down", percent);
      continue;
    }

    let plan: ReturnType<typeof buildRecapPlan>;
    try {
      plan = buildRecapPlan(config, ref.key);
    } catch (e: any) {
      skip(ref.key, `no recap plan: ${e?.message ?? e}`, percent);
      continue;
    }
    const top = plan.stack.at(-1);
    const applied = top?.applied_at ? Date.parse(top.applied_at) : null;
    if (applied !== null && row.startedAt && applied > row.startedAt) {
      // Surgery done in this process: the number stays high until the restart.
      const st = state[ref.key];
      const failedSince = st && !st.ok && Date.parse(st.at) > applied ? `${st.event}: ${st.detail}` : null;
      if (!failedSince && now - applied < OVERDUE_AFTER_MS) {
        skip(ref.key, "recap applied, restart on its way", percent);
        continue;
      }
      out.push({ voice: ref.key, action: "overdue", reason: failedSince ?? `recap applied ${Math.round((now - applied) / 60_000)} min ago`, percent, recap_id: top?.id ?? null });
      continue;
    }
    const noRoom = plan.headroom !== null && plan.headroom.body_budget_chars <= 0;
    if (percent >= CEILING_PERCENT || noRoom) {
      if (mem.ceilingTold.has(ref.key)) {
        skip(ref.key, "past the ceiling; already told, waiting for the operator", percent);
        continue;
      }
      out.push({ voice: ref.key, action: "ceiling", reason: noRoom ? "no room left for a recap body" : `${percent}% >= ${CEILING_PERCENT}%`, percent });
      continue;
    }
    if (plan.next.body_exists && plan.next.body_path) {
      try {
        if (now - fs.statSync(plan.next.body_path).mtimeMs < MID_RECAP_MS) {
          skip(ref.key, "mid-recap: next body written in the last hour", percent);
          continue;
        }
      } catch {
        // Unreadable: nudge anyway.
      }
    }
    out.push({ voice: ref.key, action: "nudge", reason: `${percent}% >= ${at}%`, percent });
  }
  return out;
}

/**
 * Send one message by courier; resolves with whether the courier exited cleanly in time.
 * `as` names the courier, and the name is what the reader sees.
 */
export function deliver(config: AppConfig, name: string, account: string, text: string, as = "Nudge"): Promise<{ ok: boolean; detail: string }> {
  const args = [
    "-p",
    `Use SendMessage to send this to "${name}", verbatim and with no commentary:\n${text}`,
    "--name",
    `${as}-${name}`,
    "--model",
    config.nudge.model,
    "--allowedTools",
    "SendMessage",
    // Off Remote Control: a mirrored one-shot lingers in the cloud peer list.
    "--settings",
    JSON.stringify({ remoteControlAtStartup: false, disableRemoteControl: true }),
  ];
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    let out = "";
    const bin = claudeBin();
    if (!bin) {
      finish(false, "courier could not start: no claude executable found (the nudger needs claude.exe, or claude on PATH)");
      return;
    }
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, args, { cwd: REPO, env: claudeEnv(account), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (e: any) {
      finish(false, `courier could not start: ${e?.message ?? e}`);
      return;
    }
    p.stdout!.on("data", (d) => (out = (out + d).slice(-400)));
    p.stderr!.on("data", (d) => (out = (out + d).slice(-400)));
    timer = setTimeout(() => {
      p.kill();
      finish(false, `courier timed out after ${COURIER_TIMEOUT_MS / 1000} s`);
    }, COURIER_TIMEOUT_MS);
    p.on("error", (e) => finish(false, `courier could not start: ${e.message}`));
    p.on("exit", (code) => finish(code === 0, code === 0 ? "delivered" : `courier exited ${code}: ${out.replace(/\s+/g, " ").trim().slice(-200)}`));
  });
}

export function startNudger(config: AppConfig, log: { info: (m: string) => void; warn: (m: string) => void }): () => void {
  if (!config.nudge.enabled) {
    log.info("[nudge] off (nudge.enabled in config.yaml)");
    return () => {};
  }
  if (process.platform !== "win32") {
    log.warn("[nudge] enabled in config.yaml, but the nudger is Windows-only (it checks liveness through Windows named pipes); not started");
    return () => {};
  }
  const mem = liveMemory;
  const tick = () => {
    let decisions: NudgeDecision[];
    try {
      decisions = decideNudges(config, mem);
    } catch (e: any) {
      log.warn(`[nudge] tick failed: ${e?.message ?? e}`);
      return;
    }
    for (const d of decisions) {
      if (d.action === "skip") {
        if (d.reason === "below the line") mem.ceilingTold.delete(d.voice); // back under: a new crossing starts fresh
        continue;
      }
      const ref = voiceRefs(config).find((s) => s.key === d.voice)!;
      const text =
        d.action === "nudge"
          ? nudgeText(d.percent!, config.nudge.at, config.nudge.cooldown_minutes)
          : d.action === "overdue"
            ? overdueText(d.percent!, d.recap_id ?? null, d.reason)
            : ceilingText(d.percent!);
      mem.inFlight.add(d.voice);
      mem.last.set(d.voice, Date.now());
      if (d.action === "ceiling") mem.ceilingTold.add(d.voice);
      void deliver(config, ref.name, ref.account!, text).then((r) => {
        mem.inFlight.delete(d.voice);
        const what = d.action === "nudge" ? `at ${d.percent}% (line ${config.nudge.at}%)` : `${d.action}: ${d.reason}`;
        if (!r.ok) {
          mem.last.delete(d.voice); // try again next tick
          mem.ceilingTold.delete(d.voice);
          recordLifecycle(d.voice, "nudge_failed", `${what}; ${r.detail}`);
          log.warn(`[nudge] ${ref.name}: ${d.action} not delivered: ${r.detail}`);
          return;
        }
        // Overdue and ceiling are failures a human should see, even though the message went out.
        recordLifecycle(d.voice, d.action === "nudge" ? "nudged" : d.action === "overdue" ? "restart_overdue" : "over_ceiling", what);
        log.info(`[nudge] ${ref.name}: ${d.action} delivered (${what})`);
      }).catch((e) => {
        // deliver() resolves on every failure it knows; this is the last guard
        // against an unhandled rejection taking the server down.
        mem.inFlight.delete(d.voice);
        mem.last.delete(d.voice);
        log.warn(`[nudge] ${ref.name}: ${d.action} failed: ${e?.message ?? e}`);
      });
    }
  };
  const timer = setInterval(tick, config.nudge.every_minutes * 60_000);
  timer.unref();
  log.info(`[nudge] every ${config.nudge.every_minutes} min at ${config.nudge.at}%, cooldown ${config.nudge.cooldown_minutes} min, courier ${config.nudge.model}`);
  return () => clearInterval(timer);
}
