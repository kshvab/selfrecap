#!/usr/bin/env tsx
/**
 * recap — everything a session runs for /remember. The server knows where the
 * session and its recap bodies live (config.yaml), so the session passes its
 * voice name. No curl anywhere: requests go out from Node, so Cyrillic and
 * other non-ASCII text arrive intact.
 *
 * Usage:
 *   npx tsx scripts/recap.ts <voice> --plan                        context, headroom, stack, next recap, body path, restart
 *   npx tsx scripts/recap.ts <voice> --find "<phrase>"             search the session; names the cut for a user match
 *   npx tsx scripts/recap.ts <voice> --around <line> [--span N]    read the records around a line (default ±30)
 *   npx tsx scripts/recap.ts <voice> --at <ISO time>               the last record before a moment
 *   npx tsx scripts/recap.ts <voice>                               dry-run the body at the plan's body path
 *   npx tsx scripts/recap.ts <voice> --go                          execute for real
 *   npx tsx scripts/recap.ts <voice> <body-file> [--go]            explicit body file (the 1.0 form, still works)
 *
 * Flags:
 *   --go              execute (default is a dry run)
 *   --force           allow the cut to delete a recap record outside the leading stack
 *   --json            print the server's full response instead of the checklist
 *   --before <ISO>    with --find: only matches before this time (default: the plan's, now minus 5 minutes)
 *   --server <url>    server URL (default http://127.0.0.1:9090)
 *
 * `--find -` reads the phrase from stdin.
 *
 * Auth: the POST routes (/find-cut-point, /surgery) require the X-Recap-Token
 * header. This script reads the token the server generated at
 * ~/.selfrecap/token and sends it.
 *
 * Exit codes: 0 done (or already done), 1 refused or invalid input,
 * 2 server unreachable or erroring.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_SENTINEL } from "../src/config.js";
import { decodeBodyText, parseSentinel, sentinelParseError, sentinelRe } from "../src/lib/recaps.js";

/** A recap applied this recently is taken to be the surgery just run. */
const RECENT_MINUTES = 120;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--server", "--find", "--around", "--span", "--at", "--before"]);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i]!)) {
    i++;
    continue;
  }
  if (!args[i]!.startsWith("-")) positional.push(args[i]!);
}
const serverBase = (flag("--server") ?? "http://127.0.0.1:9090").replace(/\/+$/, "");
const voice = positional[0];
const explicitBody = positional[1];
const go = args.includes("--go");
const force = args.includes("--force");
const asJson = args.includes("--json");

if (!voice || args.includes("--help") || args.includes("-h")) {
  console.error("Usage:");
  console.error("  npx tsx scripts/recap.ts <voice> --plan                        context, headroom, stack, next recap, body path, restart");
  console.error('  npx tsx scripts/recap.ts <voice> --find "<phrase>"             search the session; names the cut for a user match');
  console.error("  npx tsx scripts/recap.ts <voice> --around <line> [--span N]    read the records around a line (default ±30)");
  console.error("  npx tsx scripts/recap.ts <voice> --at <ISO time>               the last record before a moment");
  console.error("  npx tsx scripts/recap.ts <voice> [--go] [--force]              dry-run (or execute) the body at the plan's body path");
  console.error("  npx tsx scripts/recap.ts <voice> <body-file> [--go]            same, with an explicit body file");
  console.error("");
  console.error("Flags: --json (full server response), --before <ISO> (with --find), --server <url>");
  process.exit(1);
}

async function request(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; text: string; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    console.error(`Request failed: ${e.message}`);
    console.error(`Is the server running at ${serverBase}?`);
    process.exit(2);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON; the caller reports it.
  }
  return { status: res.status, ok: res.ok, text, data };
}

function authToken(): string {
  const tokenPath = path.join(os.homedir(), ".selfrecap", "token");
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    console.error(`Auth token not found at ${tokenPath}.`);
    console.error("Start the selfrecap server at least once so it can generate the token, then retry.");
    process.exit(2);
  }
}

const post = (route: string, body: unknown) =>
  request(`${serverBase}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Recap-Token": authToken() },
    body: JSON.stringify(body),
  });

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
}

/** The restart command, or words that cannot be mistaken for one. */
function restartLine(command: string | null | undefined, sessionId: string | undefined): string {
  return (
    command ??
    `claude --resume ${sessionId ?? "<session-id>"}  (no restart command in config.yaml for ${voice}: run it in the session's own folder, on its own account)`
  );
}

function alreadyDone(id: string, minutes: number | null, restart: string, canSelfRestart: boolean): never {
  console.log("─── ALREADY DONE ───");
  console.log(`${id} is in your session${minutes !== null ? ` (applied ${minutes} minute(s) ago)` : ""}. Nothing to run, nothing to write.`);
  if (canSelfRestart) {
    console.log("Restart to load it: run `selfrecap restart` (Step 8), then send your report and stop.");
    console.log("If that is not available, the operator closes this terminal and runs, in a new one:");
  } else {
    console.log("Restart to load it: the operator closes this terminal and runs, in a new one:");
  }
  console.log(`     ${restart}`);
  process.exit(0);
}

const n = (x: number) => x.toLocaleString("en-US");
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** How a record reads in a list: "user", "user (tool result)", "system/turn_duration", ... */
function kind(r: any): string {
  if (r.type === "user" && r.is_tool_result) return "user (tool result)";
  return `${r.type ?? "?"}${r.subtype ? `/${r.subtype}` : ""}`;
}

function time(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 19).replace("T", " ") : "                   ";
}

// ─── Plan ──────────────────────────────────────────────────────────────────

async function getPlan(required: boolean): Promise<any> {
  const res = await request(`${serverBase}/voices/${encodeURIComponent(voice!)}/recap-plan`);
  if (res.ok) return res.data;
  if (res.data?.error === "voice_not_found") fail(res.data.message);
  if (required) {
    console.error(`Could not get the recap plan (HTTP ${res.status}): ${res.text}`);
    if (res.status === 404) console.error("The server is older than this script (no recap-plan route): tell the operator.");
    process.exit(2);
  }
  return null; // An older server has no plan route; with an explicit body file we carry on without it.
}

function printPlan(plan: any): void {
  const s = plan.session;
  const ctx = plan.context;
  const stack: any[] = plan.stack ?? [];
  const last = stack[stack.length - 1];
  console.log(`─── Recap plan: ${plan.voice} ───`);
  let context = "(no reading)";
  if (ctx) {
    context = `${ctx.percent_of_1m}% (${n(ctx.tokens_total)} tokens), last usage ${ctx.last_usage_ts ?? "none"}`;
    const lastAt = Date.parse(last?.applied_at ?? "");
    const usageAt = Date.parse(ctx.last_usage_ts ?? "");
    if (!Number.isNaN(lastAt) && !Number.isNaN(usageAt) && lastAt > usageAt) {
      context += "  (taken before your last surgery; it updates after the restart)";
    }
  }
  console.log(`Context        ${context}`);
  const h = plan.headroom;
  if (h) {
    const verdict =
      h.body_budget_chars <= 0
        ? "NO ROOM: do not write a recap now; tell the operator (trim-only first)"
        : `write the body in under ~${n(h.body_budget_chars)} characters (characters, not bytes: \`wc -c\` counts Cyrillic twice)` +
          `${h.tight ? ". TIGHT: write short, dry-run, --go, restart, report, stop" : ""}`;
    console.log(`Headroom       ${n(h.tokens_to_ceiling)} tokens to ${h.ceiling_percent}%, ${n(h.reserve_tokens)} kept for the rest of the protocol: ${verdict}`);
  }
  console.log(
    `Session        ${s.live_session_id}${s.continuation_hops > 0 ? `  (continued ${s.continuation_hops}x from the configured anchor)` : ""}`,
  );
  console.log(`               ${s.live_path}${s.exists ? "" : "  (FILE NOT FOUND)"}`);
  if (stack.length === 0) {
    console.log("Recap stack    none yet: this is your first recap");
  } else {
    const range = stack.length === 1 ? `1 recap: ${last.id ?? "?"}` : `${stack.length} recaps: ${stack[0].id ?? "?"} .. ${last.id ?? "?"}`;
    console.log(`Recap stack    ${range}`);
    console.log(`               last: ${last.id ?? "?"}${last.period_covered ? `, period ${last.period_covered}` : ""}`);
    console.log("               (they are the first messages of your context; no need to re-read them from disk)");
  }
  console.log(`Next recap     ${plan.next.id}`);
  if (plan.next.body_path) {
    const written =
      plan.next.body_chars != null
        ? `(already written: ${n(plan.next.body_chars)} characters${h ? ` of the ~${n(h.body_budget_chars)} budget` : ""}; surgery will use it)`
        : "(not written yet)";
    console.log(`Body file      ${plan.next.body_path}  ${plan.next.body_exists ? written : "(not written yet)"}`);
  } else {
    console.log("Body file      (no recaps folder configured: pass a body path)");
  }
  const sentinelFields = [`"sentinel": "${plan.sentinel_name ?? DEFAULT_SENTINEL}"`, `"voice": "${plan.voice}"`, `"id": "${plan.next.id}"`];
  if (plan.next.predecessor_id) sentinelFields.push(`"predecessor_recap": "${plan.next.predecessor_id}"`);
  console.log(`Sentinel       ${sentinelFields.join(", ")}`);
  if (plan.memories_dir) console.log(`Memories       ${plan.memories_dir}`);
  console.log(`Search cutoff  ${plan.suggested_before_timestamp}  (now minus 5 minutes; --find uses it)`);
  console.log(`Restart        ${restartLine(plan.restart_command, s.live_session_id)}`);
  if (plan.restart_command) console.log("               (selfrecap restart runs exactly this, on Windows; see Step 8)");
  for (const w of plan.warnings ?? []) console.log(`Warning        ${w}`);
}

if (args.includes("--plan")) {
  printPlan(await getPlan(true));
  process.exit(0);
}

// ─── Reading the session: --find, --around, --at ───────────────────────────

function printRows(records: any[], mark?: number): void {
  const lineOf = new Map<string, number>();
  for (const r of records) if (r.uuid) lineOf.set(r.uuid, r.line_index);
  for (const r of records) {
    const parent = r.parent_uuid ? (lineOf.has(r.parent_uuid) ? `← ${lineOf.get(r.parent_uuid)}` : `← ${r.parent_uuid.slice(0, 8)}…`) : "";
    const prefix = r.line_index === mark ? ">" : " ";
    console.log(
      `${prefix}${String(r.line_index).padStart(5)}  ${kind(r).padEnd(26)} ${(r.uuid ?? "(no uuid)").padEnd(36)} ${parent.padEnd(12)} ${time(r.timestamp)}  ${oneLine(r.content_preview ?? "", 70)}`,
    );
  }
}

const findArg = flag("--find");
if (findArg !== undefined) {
  const phrase = findArg === "-" ? fs.readFileSync(0, "utf8").trim() : findArg;
  if (!phrase || phrase.length < 3) fail("--find needs a phrase of at least 3 characters (6+ distinctive words from one line work best).");
  const plan = await getPlan(false);
  const before = flag("--before") ?? plan?.suggested_before_timestamp;
  const res = await post("/find-cut-point", {
    voice,
    method: "marker_phrase",
    phrase,
    exclude_recap: true,
    limit: 20,
    ...(before ? { before_timestamp: before } : {}),
  });
  if (!res.ok) fail(`Search failed (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const r = res.data;
  console.log(`─── ${r.total_matches} match(es) for "${oneLine(phrase, 60)}"${before ? ` before ${before}` : ""}${r.truncated ? `, first ${r.returned_count} shown` : ""} ───`);
  printRows(r.matches);
  const typed = r.matches.filter((m: any) => m.type === "user" && m.selectable && !m.is_tool_result);
  if (r.total_matches === 0) {
    console.log("No match. Usually the phrase crosses a line break, or its punctuation differs (— vs -, ’ vs '). Try 4–6 words from within one line.");
  } else if (typed.length === 1) {
    const m = typed[0];
    console.log(`Boundary: the user message at line ${m.line_index}. Cut through its parent: ${m.parent_uuid ?? "(none: it is the first record)"}`);
    console.log(`Read the seam first: npx tsx scripts/recap.ts ${voice} --around ${m.line_index}`);
  } else if (typed.length > 1) {
    console.log(`${typed.length} user messages match; pick the one that opens your new arc and cut through its parent (← line above).`);
  } else {
    console.log("None of the matches is a message someone typed (tool output, your own text, or a queued copy). Search words from the user message itself.");
  }
  if (r.matches.some((m: any) => m.type === "queue-operation")) console.log("(queue-operation lines are queued copies of a message: ignore them.)");
  process.exit(0);
}

const aroundArg = flag("--around");
if (aroundArg !== undefined) {
  const line = Number(aroundArg);
  if (!Number.isInteger(line) || line < 0) fail("--around needs a line number (from --find or --at).");
  const span = flag("--span") ?? "30";
  const res = await request(`${serverBase}/voices/${encodeURIComponent(voice!)}/records?around=${line}&span=${encodeURIComponent(span)}`);
  if (!res.ok) fail(`Could not read the records (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const r = res.data;
  console.log(`─── lines ${r.from}..${r.to} of ${r.total_lines} (← = parent line) ───`);
  printRows(r.records, line);
  process.exit(0);
}

const atArg = flag("--at");
if (atArg !== undefined) {
  if (Number.isNaN(Date.parse(atArg))) fail(`--at needs an ISO time, e.g. 2026-09-22T09:30:00Z (UTC). Got: ${atArg}`);
  const res = await post("/find-cut-point", { voice, method: "timestamp", before: atArg, exclude_recap: true });
  if (!res.ok) fail(`Search failed (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const m = res.data.matches?.[0];
  if (!m) fail(`Nothing before ${atArg}.`);
  console.log(`─── the last record before ${atArg} ───`);
  printRows([...m.context_before, m, ...m.context_after], m.line_index);
  console.log(`Read further around it: npx tsx scripts/recap.ts ${voice} --around ${m.line_index}`);
  process.exit(0);
}

// ─── Body ──────────────────────────────────────────────────────────────────

const plan = await getPlan(!explicitBody);
const sentinelName: string = plan?.sentinel_name ?? DEFAULT_SENTINEL;
const canSelfRestart = process.platform === "win32" && !!plan?.restart_command;
const bodyPath: string | null = explicitBody ?? plan?.next?.body_path ?? null;
if (!bodyPath) fail(`No body file: ${voice} has no recaps folder in config.yaml. Pass the body path explicitly.`);
if (!fs.existsSync(bodyPath)) {
  const last = plan?.stack?.[plan.stack.length - 1];
  const minutes = minutesSince(last?.applied_at);
  if (!explicitBody && last?.id && minutes !== null && minutes <= RECENT_MINUTES) {
    alreadyDone(last.id, minutes, restartLine(plan.restart_command, plan.session?.live_session_id), canSelfRestart);
  }
  console.error(`Body file not found: ${bodyPath}`);
  if (!explicitBody) console.error(`Write ${plan?.next?.id ?? "the recap"} there first, with your Write tool (see --plan).`);
  process.exit(1);
}
if (explicitBody && plan?.next?.body_path && path.resolve(explicitBody) !== path.resolve(plan.next.body_path)) {
  console.log(`Note: the plan's body path for ${plan.next.id} is ${plan.next.body_path}`);
}

const body = decodeBodyText(fs.readFileSync(bodyPath));
const sentinel = parseSentinel(body, sentinelName);
if (!sentinel) {
  console.error("─── Body validation failed ───");
  if (sentinelRe(sentinelName).test(body)) {
    console.error(`The sentinel block at the end of the body is not valid JSON: ${sentinelParseError(body, sentinelName)}.`);
    console.error("Usually a trailing comma after the last field, or a quote left open.");
  } else {
    console.error(`The body has no ${sentinelName} sentinel. End it with a fenced JSON block, like:`);
    console.error(
      `{"sentinel":"${sentinelName}","voice":"${plan?.voice ?? voice}","id":"${plan?.next?.id ?? "<voice>-recap-NNN"}","version":1,"cut_through_uuid":"<uuid>"}`,
    );
  }
  process.exit(1);
}
const cutThroughUuid = sentinel.cut_through_uuid;
if (!cutThroughUuid || typeof cutThroughUuid !== "string") fail("The sentinel has no `cut_through_uuid`. Add it: it is the surgery handoff key.");

// Checks against the plan, before anything is sent.
if (plan) {
  const signed = typeof sentinel.voice === "string" ? sentinel.voice.toLowerCase() : null;
  if (signed && signed !== plan.voice) fail(`This body is ${sentinel.voice}'s (its sentinel says so); you ran it as ${plan.voice}.`);
  const id = typeof sentinel.id === "string" ? sentinel.id.toLowerCase() : null;
  const stack: any[] = plan.stack ?? [];
  const applied = id ? stack.find((r) => typeof r.id === "string" && r.id.toLowerCase() === id) : undefined;
  if (applied) {
    const minutes = minutesSince(applied.applied_at);
    const sameCut = !applied.cut_through_uuid || applied.cut_through_uuid === cutThroughUuid;
    if (sameCut && applied === stack[stack.length - 1] && minutes !== null && minutes <= RECENT_MINUTES) {
      alreadyDone(applied.id, minutes, restartLine(plan.restart_command, plan.session?.live_session_id), canSelfRestart);
    }
    fail(
      `The last sentinel in this body is ${applied.id}, a recap already in your session${applied.applied_at ? ` (applied ${applied.applied_at})` : ""}. ` +
        `End the body with your own sentinel: "id": "${plan.next.id}".`,
    );
  }
}

// ─── Surgery ───────────────────────────────────────────────────────────────

console.log(`─── Recap surgery: ${voice}, ${go ? "EXECUTE" : "dry-run"}${force ? ", force_overwrite" : ""} ───`);
console.log(`Body     ${bodyPath} (${n(body.length)} characters, sentinel ${sentinel.id ?? "(no id)"})`);
console.log(`Cut      ${cutThroughUuid}`);

const res = await post("/surgery", {
  voice,
  cut_through_uuid: cutThroughUuid,
  recap_content: body,
  dry_run: !go,
  ...(force ? { force_overwrite_recap: true } : {}),
});
if (!res.data) fail(`Server returned non-JSON (HTTP ${res.status}):\n${res.text}`, 2);
// A response with `ok: false` and a reason is a refusal: its state is known
// (nothing changed). Anything else that is not ok leaves it unknown.
if (!res.ok && (typeof res.data.ok !== "boolean" || typeof res.data.reason !== "string")) {
  console.error(`─── SERVER ERROR (HTTP ${res.status}) ───`);
  console.error(res.data.message ?? res.text);
  fail("It is not known whether the surgery happened. Run --plan and check the recap stack before retrying.", 2);
}
const result = res.data;
if (!res.ok && typeof result.reason === "string" && result.reason.startsWith("already_applied")) {
  alreadyDone(result.diagnostics?.recap_id ?? String(sentinel.id), null, restartLine(result.restart_command, result.live_session_id), canSelfRestart);
}

const d = result.diagnostics ?? {};
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  // The fields the skill's checklist reads, by their JSON names.
  const pb = d.pair_balance;
  const rows: Array<[string, unknown]> = [
    ["ok", result.ok],
    ["recap_id", `${d.recap_id} (expected ${d.expected_recap_id ?? "n/a"})`],
    ["cut_through_line_idx", `${d.cut_through_line_idx}${d.cut_through_record ? ` — ${d.cut_through_record.type}${d.cut_through_record.preview ? `: "${oneLine(d.cut_through_record.preview, 60)}"` : ""}` : ""}`],
    ["lines_cut", `${d.lines_cut} of ${d.total_lines_before} (total_lines_after ${d.total_lines_after})`],
    ["leading_recaps_preserved", d.leading_recaps_preserved],
    ["new_recap_position", d.new_recap_position],
    ["repointed_records", d.repointed_records],
    ["chain_reaches_recap", d.chain_reaches_recap],
    ["cut_orphaned_tool_results", (d.cut_orphaned_tool_results ?? []).length],
    ["pair_balance", pb ? `orphans ${pb.orphans}, tail_orphan_only ${pb.tail_orphan_only}` : "n/a"],
    ["cut_range_has_existing_recap", d.cut_range_has_existing_recap],
  ];
  if (!result.dry_run) {
    rows.push(["backup_path", d.backup_path], ["carried_tail_lines", d.carried_tail_lines], ["rename_attempts", d.rename_attempts]);
  }
  for (const [k, v] of rows) console.log(`  ${k.padEnd(29)}${v}`);
}
for (const w of result.warnings ?? []) console.log(`Warning: ${w}`);

if (!res.ok || result.ok === false) {
  console.error("─── FAILED ───");
  if (result.reason) console.error(`Reason: ${result.reason}`);
  for (const p of (d.problems ?? []).filter((p: string) => p !== result.reason)) console.error(`Also:   ${p}`);
  fail(go ? "The live file was not changed: a refused surgery never touches it." : "Nothing was written.");
}

if (result.dry_run) {
  console.log("─── DRY-RUN OK ─── Diagnostics look right? Re-run with --go to execute.");
} else {
  const mb = (x: number) => (x / 1_000_000).toFixed(1);
  const cutPct = d.total_lines_before ? Math.round((100 * d.lines_cut) / d.total_lines_before) : 0;
  console.log("─── SURGERY EXECUTED ───");
  console.log(
    `Report   Was ${plan?.context ? `${plan.context.percent_of_1m}% / ` : ""}${n(d.total_lines_before)} lines / ${mb(d.file_size_before_bytes)} MB. ` +
      `Now ${n(d.total_lines_after)} lines / ${mb(d.file_size_after_bytes)} MB (cut ${cutPct}% of lines).`,
  );
  console.log("Your running session is still the pre-surgery one: every turn from here costs context in the OLD session.");
  if (canSelfRestart) {
    console.log("Now run `selfrecap restart` (Step 8): it closes this session when your turn ends and resumes it by id in a");
    console.log("new console, with a welcome-back prompt. Then send your report and stop. If that is not available, the");
    console.log("operator closes this terminal and runs, in a new one:");
  } else {
    console.log("Now send your report and stop. The operator closes this terminal and runs, in a new one:");
  }
  console.log(`     ${restartLine(result.restart_command, result.live_session_id)}`);
}
