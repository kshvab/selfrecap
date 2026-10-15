#!/usr/bin/env tsx
/**
 * install-skill — install skills/remember/SKILL.md as the /remember skill of
 * every Claude Code account that runs a configured voice, plus every account
 * in config `accounts` (default ~/.claude): <account>/skills/remember/SKILL.md.
 * A voice's account is read off its session path
 * (<account>/projects/<project>/<session-id>.jsonl).
 *
 * The repo copy is the source of truth. Installed copies are never edited by
 * hand; change skills/remember/SKILL.md, then run this.
 *
 * The skill drives the server (`recap.ts --plan` needs 1.1.0), so this refuses
 * to install while the running server is older: update and restart it first.
 *
 *   npm run install-skill                 (or: npx tsx scripts/install-skill.ts [--dry-run])
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";
import { accountOfSessionFile, knownAccounts } from "../src/lib/sessions.js";

const REQUIRED_SERVER = "1.1.0";

// `npm run install-skill --dry-run` hands the flag to npm, not to us: honour npm's copy too.
const dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true";
const source = fileURLToPath(new URL("../skills/remember/SKILL.md", import.meta.url));
const skill = fs.readFileSync(source);
const hash = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 12);

function atLeast(version: string | null, wanted: string): boolean {
  if (!version) return false;
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = wanted.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const config = loadConfig();

const health = `http://${config.server.host}:${config.server.port}/health`;
let serverVersion: string | null = null;
try {
  serverVersion = ((await (await fetch(health, { signal: AbortSignal.timeout(3000) })).json()) as { version?: string }).version ?? null;
} catch {
  // Unreachable: reported below.
}
if (!atLeast(serverVersion, REQUIRED_SERVER)) {
  const msg = `The server at ${health} reports ${serverVersion ?? "nothing (not reachable)"}; this skill needs ${REQUIRED_SERVER} or later.`;
  if (!dryRun) {
    console.error(`${msg} Start (or update and restart) the selfrecap server first.`);
    process.exit(1);
  }
  console.log(`Note: ${msg} A real install would refuse.`);
}

const voicesOf = new Map<string, string[]>();
for (const [name, v] of Object.entries(config.voices)) {
  const account = accountOfSessionFile(v.session);
  if (!account) {
    console.log(`skip ${name}: session is not under <account>/projects/ (${path.basename(v.session)})`);
    continue;
  }
  const key = path.resolve(account);
  voicesOf.set(key, [...(voicesOf.get(key) ?? []), name]);
}
const accounts = knownAccounts(config.accounts, [...voicesOf.keys()]);

console.log(`Skill: ${source} (sha256 ${hash(skill)})`);
for (const account of accounts) {
  if (!fs.existsSync(account)) {
    console.log(`skip ${account}: no such Claude Code account folder`);
    continue;
  }
  const target = path.join(account, "skills", "remember", "SKILL.md");
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const voices = voicesOf.get(path.resolve(account)) ?? [];
  const label = `${target}${voices.length ? `  [${voices.join(", ")}]` : ""}`;
  if (current && current.equals(skill)) {
    console.log(`up to date  ${label}`);
    continue;
  }
  if (dryRun) {
    console.log(`would install  ${label}  (${current ? `replacing ${hash(current)}` : "new"})`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`installed  ${label}  (${current ? `was ${hash(current)}` : "new"})`);
}
