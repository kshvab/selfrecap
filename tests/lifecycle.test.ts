/**
 * The pure parts of the nudger and `selfrecap restart`: pipe names, the
 * process-tree walk, the environment a resumed session gets, which voice a
 * live session is, the texts, the registry reader, and the usage parser.
 * (Liveness itself needs Windows; these run everywhere.)
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NUDGE_DEFAULTS, displayNameOf, loadConfig } from "../src/config.js";
import { isAncestor, voiceByName, voiceOfSession, welcomeText } from "../src/lib/lifecycle.js";
import { ceilingText, nudgeText, overdueText } from "../src/lib/nudger.js";
import { parseUsage } from "../src/lib/account-usage.js";
import {
  accountOfSessionFile,
  claudeEnv,
  isDefaultAccount,
  knownAccounts,
  pipeKey,
  readRegistry,
  removeDeadRow,
  type LiveSession,
} from "../src/lib/sessions.js";
import { configFor, tmpDir } from "./helpers.js";

const home = os.homedir();
const other = path.join(home, ".claude-alt");
const dflt = path.join(home, ".claude");

describe("sessions", () => {
  it("pipeKey: the registry's pipe path and the pipe listing meet on one form", () => {
    expect(pipeKey("\\\\.\\pipe\\LOCAL\\cc-msg-ABC")).toBe("local\\cc-msg-abc");
    expect(pipeKey("//./pipe/LOCAL/cc-msg-abc")).toBe("local\\cc-msg-abc");
    expect(pipeKey("LOCAL\\cc-msg-abc")).toBe("local\\cc-msg-abc");
  });

  it("claudeEnv: every CLAUDE* var dropped; the default account gets no CLAUDE_CONFIG_DIR", () => {
    const base = {
      PATH: "p",
      CLAUDECODE: "1",
      CLAUDE_PID: "5",
      CLAUDE_CODE_BRIDGE_SESSION_ID: "session_x",
      CLAUDE_CONFIG_DIR: other,
      claude_lowercase: "x",
      NO_COLOR: "1",
    };
    expect(claudeEnv(other, base)).toEqual({ PATH: "p", CLAUDE_CONFIG_DIR: other });
    expect(claudeEnv(dflt, base)).toEqual({ PATH: "p" });
    expect(isDefaultAccount(dflt) && !isDefaultAccount(other)).toBe(true);
  });

  it("accountOfSessionFile reads the account off <account>/projects/<folder>/<id>.jsonl", () => {
    expect(accountOfSessionFile(path.join(other, "projects", "-x", "abc.jsonl"))).toBe(other);
    expect(accountOfSessionFile(path.resolve("/somewhere/abc.jsonl"))).toBeNull();
  });

  it("knownAccounts: the configured ones (~ expanded) plus extras, each once", () => {
    expect(knownAccounts(["~/.claude"], [dflt, other])).toEqual([dflt, other]);
  });

  it("readRegistry / removeDeadRow: a dead row is found and removed with its key; a row rewritten by a new process is kept", () => {
    const account = tmpDir();
    const dir = path.join(account, "sessions");
    fs.mkdirSync(dir);
    const write = (pid: number, sessionId: string) =>
      fs.writeFileSync(
        path.join(dir, `${pid}.json`),
        JSON.stringify({ pid, sessionId, name: "Ghost", messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-nonexistent-test" }),
      );
    write(4242, "old");
    fs.writeFileSync(path.join(dir, "4242.abc.key"), "k");
    fs.writeFileSync(path.join(dir, "4242.json.tmp"), "junk"); // not a row
    const rows = readRegistry(account, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0]!.alive).toBe(false);
    expect(rows[0]!.name).toBe("Ghost");
    // A new process took the PID and rewrote the row: keep it.
    write(4242, "new");
    expect(removeDeadRow(rows[0]!, new Set())).toEqual([]);
    expect(fs.existsSync(path.join(dir, "4242.json"))).toBe(true);
    // The row is ours: both files go.
    write(4242, "old");
    expect(removeDeadRow(rows[0]!, new Set()).sort()).toEqual(["4242.abc.key", "4242.json"]);
    expect(fs.existsSync(path.join(dir, "4242.json.tmp"))).toBe(true);
  });

  it("an unreadable pipe listing removes nothing (unknown is never read as dead)", () => {
    const account = tmpDir();
    fs.mkdirSync(path.join(account, "sessions"));
    fs.writeFileSync(
      path.join(account, "sessions", "77.json"),
      JSON.stringify({ pid: 77, sessionId: "s", name: "X", messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-z" }),
    );
    const rows = readRegistry(account, null);
    expect(rows[0]!.alive).toBe(true);
    expect(removeDeadRow(rows[0]!, null)).toEqual([]);
  });
});

describe("the process tree", () => {
  it("isAncestor: yes when found, no on a complete chain, unknown when a parent already exited (Git Bash)", () => {
    // 10 <- 20 <- 30 <- 40, and 40's parent 0 (a root)
    const full = new Map([[10, 20], [20, 30], [30, 40], [40, 0]]);
    expect(isAncestor(30, 10, full)).toBe("yes");
    expect(isAncestor(99, 10, full)).toBe("no");
    // 30's parent 55 has exited: the walk cannot say
    const broken = new Map([[10, 20], [20, 30], [30, 55]]);
    expect(isAncestor(99, 10, broken)).toBe("unknown");
    expect(isAncestor(20, 10, broken)).toBe("yes");
    // a reused PID making a cycle ends as "no", not a hang
    expect(isAncestor(99, 10, new Map([[10, 20], [20, 10]]))).toBe("no");
  });
});

function row(name: string, account: string): LiveSession {
  return {
    account, pid: 1, sessionId: "s", name, cwd: null, kind: "interactive", status: "idle", waitingFor: null,
    statusUpdatedAt: null, startedAt: null, pipe: null, file: "f", alive: true,
  };
}

describe("voices and live sessions", () => {
  it("names come from `name` or the capitalized key; a session is a voice only on the voice's own account", () => {
    const cfg = configFor(tmpDir(), {
      voices: {
        alice: { session: path.join(other, "projects", "-dev", "a.jsonl") },
        tb: { session: path.join(dflt, "projects", "-x", "t.jsonl"), name: "Test-Bot" },
      },
    });
    expect(displayNameOf("alice", cfg.voices.alice!)).toBe("Alice");
    expect(voiceByName(cfg, "ALICE")?.key).toBe("alice");
    expect(voiceByName(cfg, "test-bot")?.key).toBe("tb");
    expect(voiceOfSession(cfg, row("Alice", other))?.key).toBe("alice");
    // Same name on another account is not the voice: different registry, different session.
    expect(voiceOfSession(cfg, row("Alice", dflt))).toBeNull();
    expect(voiceOfSession(cfg, row("Stranger", other))).toBeNull();
  });

  it("loadConfig: `nudge` merges over the defaults; a bad block falls back and is reported", () => {
    const dir = tmpDir();
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, 'voices:\n  alice:\n    session: "/s/a.jsonl"\n    name: Alice\nnudge:\n  enabled: true\n  at: 85\n');
    const cfg = loadConfig(file);
    expect(cfg.nudge).toEqual({ ...NUDGE_DEFAULTS, enabled: true, at: 85 });
    expect(cfg.voices.alice!.name).toBe("Alice");
    expect(cfg.problems).toEqual([]);
    fs.writeFileSync(file, 'voices:\n  alice:\n    session: "/s/a.jsonl"\nnudge:\n  at: 200\n  typo: 1\n');
    const bad = loadConfig(file);
    expect(bad.nudge).toEqual({ ...NUDGE_DEFAULTS, enabled: false }); // a broken block never switches it on
    expect(bad.problems.some((p) => p.startsWith("nudge:"))).toBe(true);
  });
});

describe("texts", () => {
  it("the welcome names a recap only when one landed, and survives a launcher's second parse", () => {
    const when = new Date(2026, 0, 23, 3, 7);
    const withRecap = welcomeText("alice-recap-002", when);
    expect(withRecap).toMatch(/03:07/);
    expect(withRecap).toMatch(/after alice-recap-002/);
    expect(withRecap).toMatch(/selfrecap restart/);
    expect(welcomeText(null, when)).toMatch(/no recap was applied/);
    // The id comes from a sentinel: anything that could break the quoting is dropped.
    expect(welcomeText(`x'; rm -rf /"`, when)).not.toMatch(/["';/]/);
    for (const t of [withRecap, welcomeText(null, when)]) {
      // cmd metacharacters and quotes would be re-parsed by a launcher .cmd; the PowerShell literal is single-quoted
      expect(t).not.toMatch(/["'%!^&|<>]/);
      expect(t).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("the nudge texts name selfrecap restart and the operator, nothing else", () => {
    const n = nudgeText(84.26, 83, 10);
    expect(n).toMatch(/84\.3%/);
    expect(n).toMatch(/\/remember/);
    expect(n).toMatch(/selfrecap restart/);
    expect(overdueText(90, "alice-recap-002", "recap applied 25 min ago")).toMatch(/Do not recap again/);
    expect(ceilingText(96)).toMatch(/Do not run \/remember/);
  });
});

describe("usage bars", () => {
  it("parseUsage: the bars from the limits list, with the per-model week; the old fields as a fallback", () => {
    const limits = {
      five_hour: { utilization: 12, resets_at: "2026-01-24T00:40:00Z" },
      limits: [
        { kind: "session", percent: 12, severity: "normal", resets_at: "2026-01-24T00:39:59Z", scope: null },
        { kind: "weekly_all", percent: 51, severity: "normal", resets_at: "2026-01-25T08:59:59Z", scope: null },
        { kind: "weekly_scoped", percent: 54, severity: "normal", resets_at: "2026-01-25T08:59:59Z", scope: { model: { id: null, display_name: "ModelX" }, surface: null } },
      ],
    };
    expect(parseUsage(limits).map((w) => [w.label, w.percent])).toEqual([
      ["Current session", 12],
      ["Current week (all models)", 51],
      ["Current week (ModelX)", 54],
    ]);
    expect(
      parseUsage({ five_hour: { utilization: 3, resets_at: null }, seven_day: { utilization: 40, resets_at: "x" } }).map((w) => [w.kind, w.percent]),
    ).toEqual([
      ["session", 3],
      ["weekly_all", 40],
    ]);
    expect(parseUsage({ something: "else" })).toEqual([]);
  });
});
