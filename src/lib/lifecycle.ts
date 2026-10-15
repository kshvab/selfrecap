/**
 * Mechanics for `selfrecap restart` and the nudger: which configured voice a
 * live session is, the process tree, launching outside it, and killing inside
 * it. WINDOWS ONLY: process creation goes through WMI and PowerShell, and the
 * kill through taskkill.
 *
 * Nothing here takes a target from outside: `selfrecap restart` works out
 * which session called it and acts on that session only. A session restarts
 * itself; nothing restarts someone else's.
 */

import { spawnSync } from "child_process";
import { displayNameOf, type AppConfig, type VoiceConfig } from "../config.js";
import { accountOfSessionFile, sameAccount, type LiveSession } from "./sessions.js";

/**
 * The first thing a resumed session reads. Without a prompt a resumed session
 * waits for a human, and at 3 a.m. there is none. ASCII only, no quotes and no
 * cmd metacharacters: a launcher .cmd on the way parses the arguments a
 * second time.
 */
export function welcomeText(recapId: string | null, when: Date = new Date()): string {
  const hhmm = when.toTimeString().slice(0, 5);
  // The id comes from a sentinel the session wrote: keep only what cannot break the quoting.
  recapId = recapId ? recapId.replace(/[^A-Za-z0-9_-]/g, "") || null : null;
  if (recapId) {
    return (
      `Welcome back. You restarted yourself at ${hhmm} with selfrecap restart, after ${recapId}. ` +
      `External signals say you are post-resume: that recap now stands where the period it covers used to be. ` +
      `Carry on from where you left off.`
    );
  }
  return `Welcome back. You restarted yourself at ${hhmm} with selfrecap restart; no recap was applied, so your context is as it was. Carry on from where you left off.`;
}

/** A configured voice, as the live registry sees it. */
export interface VoiceRef {
  /** Config key, lower-case (my-session). */
  key: string;
  /** The name it answers to (My-session, or `name` from config). */
  name: string;
  entry: VoiceConfig;
  /** Account folder, read off the session path. */
  account: string | null;
}

export function voiceRefs(config: AppConfig): VoiceRef[] {
  return Object.entries(config.voices).map(([key, entry]) => ({
    key,
    name: displayNameOf(key, entry),
    entry,
    account: accountOfSessionFile(entry.session),
  }));
}

/** The voice a name belongs to (the key or the display name, any case). */
export function voiceByName(config: AppConfig, name: string): VoiceRef | null {
  const n = name.toLowerCase();
  return voiceRefs(config).find((s) => s.key === n || s.name.toLowerCase() === n) ?? null;
}

/** The voice a live session is, when its name and account both match one. */
export function voiceOfSession(config: AppConfig, row: LiveSession): VoiceRef | null {
  if (!row.name) return null;
  const v = voiceByName(config, row.name);
  if (!v || !v.account || !sameAccount(v.account, row.account)) return null;
  return v;
}

/** pid → parent pid for every process, from one CIM query. */
export function processParents(): Map<number, number> {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
    { encoding: "utf8", windowsHide: true },
  );
  const map = new Map<number, number>();
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/**
 * Is `ancestor` above `pid` in the process tree?
 *
 *   "yes"      found on the way up
 *   "no"       the chain reached the top (a root, or a cycle from reused PIDs) without it
 *   "unknown"  the chain broke: a parent had already exited
 *
 * "unknown" is the normal answer from Claude Code's Bash tool: Git Bash's
 * intermediate processes exit as soon as they have started the next one, so
 * the walk from a script up to claude.exe dead-ends every time.
 */
export function isAncestor(ancestor: number, pid: number, parents: Map<number, number>): "yes" | "no" | "unknown" {
  const seen = new Set<number>();
  let cur = parents.get(pid);
  while (cur !== undefined && cur !== 0 && !seen.has(cur)) {
    if (cur === ancestor) return "yes";
    seen.add(cur);
    if (!parents.has(cur)) return "unknown";
    cur = parents.get(cur);
  }
  return "no";
}

/**
 * Start a process outside the caller's process tree and job, through WMI
 * (Win32_Process.Create). Its parent is the WMI host, so killing the caller's
 * tree cannot reach it, and it starts with the user's own environment: nothing
 * of the caller's session leaks in. It opens as a normal visible console
 * window. Returns the new PID, or throws.
 */
export function launchDetached(commandLine: string, cwd: string): number {
  const script = [
    "$a = @{ CommandLine = $env:SELFRECAP_CMDLINE; CurrentDirectory = $env:SELFRECAP_CWD }",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a",
    "\"$($r.ReturnValue) $($r.ProcessId)\"",
  ].join("; ");
  // The command line rides in the environment: nothing has to survive a round of quoting.
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SELFRECAP_CMDLINE: commandLine, SELFRECAP_CWD: cwd },
  });
  const m = /^(\d+)\s+(\d+)/m.exec(r.stdout ?? "");
  if (!m || m[1] !== "0") {
    throw new Error(`WMI could not start the process (return ${m?.[1] ?? "?"}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  }
  return Number(m[2]);
}

/** Kill a process and everything under it (MCP servers included). */
export function killTree(pid: number): { ok: boolean; output: string } {
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `check` returns a value (not undefined), or the time runs out (undefined). */
export async function waitFor<T>(check: () => T | undefined, timeoutMs: number, stepMs = 1000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(stepMs);
  }
}
