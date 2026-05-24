#!/usr/bin/env tsx
/**
 * recap — execute a recap surgery from a single body file.
 *
 * Maximum simplification for AI callers. AI authors ONE file (the recap body),
 * runs ONE command. Script extracts cut_through_uuid from the body's
 * sentinel JSON, POSTs to selfrecap, prints result.
 *
 * Default is dry-run. Add --go to execute for real.
 *
 * Usage:
 *   npx tsx scripts/recap.ts <voice> <body-file>             # dry-run
 *   npx tsx scripts/recap.ts <voice> <body-file> --go        # execute
 *   npx tsx scripts/recap.ts <voice> <body-file> --force     # override prior recap
 *   npx tsx scripts/recap.ts <voice> <body-file> --server <url>
 *
 * Body file requirements:
 *   - Plain text, native newlines, no escaping
 *   - Must contain a recap sentinel JSON block somewhere
 *   - Sentinel JSON must include `cut_through_uuid` field
 *
 * Example sentinel block to embed in body:
 *   {"sentinel":"RECAP-CYCLE","voice":"my-session","id":"my-session-recap-001","version":1,"cut_through_uuid":"00000000-0000-0000-0000-000000000000","period_covered":"2026-01-08_to_2026-01-15","generated":"2026-01-15","next_recap_should_skip_this":true}
 *
 * Auth: /surgery is a mutating route and requires the X-Recap-Token header.
 * This script reads the token the server generated at ~/.selfrecap/token.
 */

import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const voice = args[0];
const bodyPath = args[1];

if (!voice || !bodyPath || args.includes("--help") || args.includes("-h")) {
  console.error("Usage: npx tsx scripts/recap.ts <voice> <body-file> [flags]");
  console.error("");
  console.error("Flags:");
  console.error("  --go              Execute real surgery (default is dry-run)");
  console.error("  --force           Allow cut over prior recap (force_overwrite_recap)");
  console.error("  --server <url>    Override server URL (default http://127.0.0.1:9090)");
  console.error("");
  console.error("Body file must contain a recap sentinel JSON block with");
  console.error("`cut_through_uuid` field. Script extracts it automatically.");
  process.exit(1);
}

if (!fs.existsSync(bodyPath)) {
  console.error(`Body file not found: ${bodyPath}`);
  process.exit(1);
}

const go = args.includes("--go");
const force = args.includes("--force");
const serverIdx = args.indexOf("--server");
const serverBase = serverIdx >= 0 && args[serverIdx + 1]
  ? args[serverIdx + 1]!
  : "http://127.0.0.1:9090";

const body = fs.readFileSync(bodyPath, "utf8");

// ─── Extract sentinel JSON from body ───────────────────────────────────────
//
// The sentinel name is server-configurable (config.sentinel_name), so match any
// non-empty value here. The server validates that the body's sentinel matches
// its configured name; this script only needs to pull out cut_through_uuid.

const sentinelRegex = /\{[^{}]*"sentinel"\s*:\s*"[^"]+"[^{}]*\}/;
const sentinelMatch = body.match(sentinelRegex);

if (!sentinelMatch) {
  console.error("─── Body validation failed ───");
  console.error("Body file does not contain a recap sentinel JSON block.");
  console.error("");
  console.error("Add a sentinel block somewhere in the body, like this:");
  console.error('{"sentinel":"RECAP-CYCLE","voice":"<your-voice>","id":"<recap-id>","version":1,"cut_through_uuid":"<uuid>"}');
  console.error("");
  console.error("Server requires this for protection of recap from future trim cycles.");
  process.exit(1);
}

let sentinel: any;
try {
  sentinel = JSON.parse(sentinelMatch[0]);
} catch (e: any) {
  console.error(`Sentinel JSON parse failed: ${e.message}`);
  console.error(`Block: ${sentinelMatch[0]}`);
  process.exit(1);
}

const cutThroughUuid = sentinel.cut_through_uuid;
if (!cutThroughUuid || typeof cutThroughUuid !== "string") {
  console.error("Sentinel JSON missing `cut_through_uuid` field.");
  console.error("Add it to the sentinel block — it's the surgery handoff key.");
  process.exit(1);
}

// ─── Load auth token ────────────────────────────────────────────────────────
//
// The server writes a per-machine token to ~/.selfrecap/token on startup.
// /surgery is mutating, so it requires this token in the X-Recap-Token header.

const tokenPath = path.join(os.homedir(), ".selfrecap", "token");
let authToken = "";
try {
  authToken = fs.readFileSync(tokenPath, "utf8").trim();
} catch {
  console.error(`Auth token not found at ${tokenPath}.`);
  console.error("Start the selfrecap at least once so it can generate the token, then retry.");
  process.exit(2);
}

// ─── Build payload + POST ──────────────────────────────────────────────────

const payload = {
  voice,
  cut_through_uuid: cutThroughUuid,
  recap_content: body,
  dry_run: !go,
  ...(force ? { force_overwrite_recap: true } : {}),
};

console.log("─── Recap Surgery ───");
console.log(`Server:           ${serverBase}`);
console.log(`Voice:            ${voice}`);
console.log(`Body file:        ${bodyPath} (${body.length.toLocaleString()} chars)`);
console.log(`cut_through_uuid: ${cutThroughUuid}`);
console.log(`Sentinel id:      ${sentinel.id || "(unspecified)"}`);
console.log(`Mode:             ${go ? "EXECUTE (real mutation)" : "dry-run"}`);
console.log(`force_overwrite:  ${force}`);
console.log("");

let response: Response;
try {
  response = await fetch(`${serverBase}/surgery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Recap-Token": authToken,
    },
    body: JSON.stringify(payload),
  });
} catch (e: any) {
  console.error(`Request failed: ${e.message}`);
  console.error(`Is the server running at ${serverBase}?`);
  process.exit(2);
}

const text = await response.text();
let result: any;
try {
  result = JSON.parse(text);
} catch {
  console.error(`Server returned non-JSON (HTTP ${response.status}):`);
  console.error(text);
  process.exit(2);
}

console.log("─── Response ───");
console.log(`HTTP ${response.status}`);
console.log("");
console.log(JSON.stringify(result, null, 2));
console.log("");

if (!response.ok || result.ok === false) {
  console.error("─── FAILED ───");
  if (result.reason) console.error(`Reason: ${result.reason}`);
  process.exit(1);
}

if (result.dry_run) {
  console.log("─── DRY-RUN OK ───");
  console.log("Diagnostics look good? Re-run with --go to execute.");
} else {
  console.log("─── SURGERY EXECUTED ───");
  console.log(`Backup: ${result.diagnostics?.backup_path || "(check server logs)"}`);
  console.log("");
  console.log("⚠️  Surgery is on disk. The live session is still using its in-memory");
  console.log("    snapshot from before surgery and will continue to do so until restart.");
  console.log("");
  console.log("To make the trim take effect on the running session:");
  console.log("  1. Close the affected voice's terminal completely");
  console.log("  2. claude --resume <session-id>");
  console.log("");
  console.log("See docs/cache-mechanics.md for the two-layer cache explanation.");
}
