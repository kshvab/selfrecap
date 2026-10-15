#!/usr/bin/env tsx
/**
 * check-config — validate config.yaml before restarting the server.
 *
 *   npm run check-config                  (or: npx tsx scripts/check-config.ts [config-path])
 *
 * Prints every voice the way the server will see it: the live session file,
 * the recap stack and next recap, the folders, the restart command. Exits 1
 * when something would stop a voice's surgery or its restart: a skipped entry,
 * a missing session file or folder, a session outside allowed_roots, a broken
 * continuation, or a restart command that does not match the session's folder.
 * Run it before restarting the server.
 */

import fs from "fs";
import { checkRestart, isFatalProblem, loadConfig } from "../src/config.js";
import { buildRecapPlan } from "../src/lib/recap-plan.js";

const arg = process.argv[2];
if (arg?.startsWith("-")) {
  console.log("Usage: npx tsx scripts/check-config.ts [config-path]   (default: RECAP_CONFIG, else ./config.yaml)");
  process.exit(arg === "--help" || arg === "-h" ? 0 : 1);
}
// Paths are printed in full here: this runs in the operator's own terminal.
const config = { ...loadConfig(arg), expose_paths: true };
let errors = 0;
const error = (msg: string) => {
  errors++;
  console.log(`  ERROR  ${msg}`);
};

console.log(`Config: ${config.config_path ?? "(no file: defaults)"}`);
if (!config.config_path) error(`no config file at ${arg ?? process.env.RECAP_CONFIG ?? "./config.yaml"}: the server would start with no voices`);
for (const p of config.problems) {
  if (isFatalProblem(p)) error(p);
  else console.log(`  warn   ${p}`);
}
if (config.config_path && Object.keys(config.voices).length === 0) error("no voices loaded: the server would monitor nothing");
console.log(`Sentinel: ${config.sentinel_name}`);
console.log(
  `Nudger: ${config.nudge.enabled ? `on at ${config.nudge.at}%${process.platform === "win32" ? "" : " (but it is Windows-only: it will not start here)"}` : "off"}`,
);
console.log(`Usage bars: ${config.usage.enabled ? "on (reads each account's login token)" : "off"}`);

for (const [name, entry] of Object.entries(config.voices)) {
  const plan = buildRecapPlan(config, name);
  const s = plan.session;
  console.log("");
  console.log(`${name}  (answers to ${plan.name})`);
  console.log(`  session   ${s.live_path}${s.continuation_hops > 0 ? `  (continued ${s.continuation_hops}x from ${s.configured_path})` : ""}`);
  if (plan.context) console.log(`  context   ${plan.context.percent_of_1m}%`);
  console.log(
    `  stack     ${plan.stack.length} recap(s)${plan.stack.length ? `, last ${plan.stack[plan.stack.length - 1]!.id ?? "(no id)"}` : ""}; next ${plan.next.id}`,
  );
  console.log(`  body      ${plan.next.body_path ?? "(none)"}${plan.next.body_exists ? "  (already written)" : ""}`);
  console.log(`  restart   ${plan.restart_command ?? "(none: the operator restarts by hand with claude --resume <id>)"}`);

  const outside = plan.warnings.some((w) => w.startsWith("the session file is outside"));
  if (!s.exists && !outside) error(`session file not found: ${s.live_path}`);
  if (s.broken_link) error(`continuation chain broken at ${s.broken_link}`);
  if (entry.home && !fs.existsSync(entry.home)) error(`home folder does not exist: ${entry.home}`);
  if (entry.restart) {
    const restart = checkRestart(entry.session, entry.restart);
    restart.errors.forEach(error);
    for (const w of restart.warnings) console.log(`  warn   ${w}`);
  }
  for (const w of plan.warnings) {
    if (w.startsWith("session file not found") || w.startsWith("continuation chain broken")) continue;
    if (w.startsWith("recaps folder does not exist") || w.startsWith("the session file is outside")) error(w);
    else console.log(`  warn   ${w}`);
  }
}

console.log("");
console.log(errors > 0 ? `${errors} error(s): fix them before restarting the server.` : "OK: safe to restart the server.");
process.exit(errors > 0 ? 1 : 0);
