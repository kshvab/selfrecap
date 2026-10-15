/**
 * Config loading, restart-template checks, the recap plan, headroom, and the
 * records-around reader.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { checkRestart, getVoice, isFatalProblem, loadConfig, resolvePath, restartCommandFor } from "../src/config.js";
import { RESERVE_TOKENS, buildRecapPlan, headroomFor } from "../src/lib/recap-plan.js";
import { recordsAround } from "../src/lib/finder.js";
import { Session, configFor, tmpDir } from "./helpers.js";

const slash = (p: string) => p.replace(/\\/g, "/");

function writeConfig(dir: string, yaml: string): string {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml);
  return file;
}

describe("loadConfig", () => {
  it("1.0 `path` entries still load; names are case-insensitive; problems are reported, not fatal", () => {
    const dir = tmpDir();
    const cfg = loadConfig(
      writeConfig(
        dir,
        [
          "voices:",
          "  Alice:",
          '    path: "/sessions/alice.jsonl"',
          "  bob:",
          '    session: "/sessions/bob.jsonl"',
          '    home: "/voices/bob"',
          '    recap: "typo"',
          "  ghost:",
          '    home: "/nowhere"',
          "  BOB:",
          '    session: "/sessions/other.jsonl"',
          "extra: 1",
        ].join("\n"),
      ),
    );
    expect(Object.keys(cfg.voices).sort()).toEqual(["alice", "bob"]);
    expect(cfg.voices.alice!.session).toBe("/sessions/alice.jsonl");
    expect(getVoice(cfg, "ALICE").name).toBe("alice");
    expect(cfg.problems.some((p) => p.startsWith("voices.bob: unknown key(s) recap"))).toBe(true);
    expect(cfg.problems.some((p) => p.startsWith("voices.ghost: no session") && p.endsWith("skipped"))).toBe(true);
    expect(cfg.problems.some((p) => p.startsWith("voices.BOB: same name"))).toBe(true);
    expect(cfg.problems.some((p) => p.startsWith("extra: unknown top-level key"))).toBe(true);
  });

  it("keeps the 1.0 keys and defaults; nudger and usage bars are off unless asked for", () => {
    const dir = tmpDir();
    const cfg = loadConfig(writeConfig(dir, ["voices: {}", "sentinel_name: OLD-MARK", "expose_paths: true", "allowed_roots: ['/x/']"].join("\n")));
    expect(cfg.sentinel_name).toBe("OLD-MARK");
    expect(cfg.expose_paths).toBe(true);
    expect(cfg.allowed_roots).toEqual(["/x/"]);
    expect(cfg.nudge.enabled).toBe(false);
    expect(cfg.usage.enabled).toBe(false);
    expect(cfg.accounts).toEqual(["~/.claude"]);
    expect(cfg.problems).toEqual([]);
  });

  it("expands ~ in voice paths", () => {
    const dir = tmpDir();
    const cfg = loadConfig(writeConfig(dir, 'voices:\n  a:\n    session: "~/s/a.jsonl"\n    recaps: "~/r"\n'));
    expect(cfg.voices.a!.session).toBe(path.join(os.homedir(), "s/a.jsonl"));
    expect(cfg.voices.a!.recaps).toBe(path.join(os.homedir(), "r"));
  });

  it("a broken usage block never opts in to reading credentials", () => {
    const dir = tmpDir();
    const cfg = loadConfig(writeConfig(dir, 'voices: {}\nusage:\n  enabled: "yes"\n'));
    expect(cfg.usage.enabled).toBe(false);
    expect(cfg.problems.some((p) => p.startsWith("usage:"))).toBe(true);
  });

  it("isFatalProblem: skipped entries and a broken voices block are fatal, ignored keys are not", () => {
    expect(isFatalProblem("voices.ghost: no session (the session JSONL path), skipped")).toBe(true);
    expect(isFatalProblem("voices: must be a mapping of voice name to entry")).toBe(true);
    expect(isFatalProblem("voices.bob: unknown key(s) recap, ignored")).toBe(false);
  });
});

describe("restart templates", () => {
  // A working directory and the project folder Claude Code derives from it.
  const cwd = path.resolve("/work/my-app");
  const folder = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const defaultSession = path.join(os.homedir(), ".claude", "projects", folder, "11111111-1111-4111-8111-111111111111.jsonl");
  const otherSession = path.join(os.homedir(), ".claude-alt", "projects", folder, "11111111-1111-4111-8111-111111111111.jsonl");
  const template = `cd ${cwd}; claude --resume {session_id} --name Alice`;

  it("restartCommandFor fills {session_id}", () => {
    expect(restartCommandFor({ session: "x", restart: "claude --resume {session_id} --flag" }, "abc")).toBe("claude --resume abc --flag");
    expect(restartCommandFor({ session: "x" }, "abc")).toBeNull();
  });

  it("the cd must map onto the session's folder; another account must be selected", () => {
    expect(checkRestart(defaultSession, template)).toEqual({ errors: [], warnings: [] });
    expect(checkRestart(defaultSession, template.replace("my-app", "other-app")).errors[0]!).toMatch(new RegExp(`belongs to the folder ${folder}`));
    expect(checkRestart(defaultSession, `$env:CLAUDE_CONFIG_DIR='x'; ${template}`).errors[0]!).toMatch(/default ~\/\.claude account/);
    expect(checkRestart(otherSession, template).warnings.some((w) => /\.claude-alt account/.test(w))).toBe(true);
    expect(checkRestart(otherSession, `$env:CLAUDE_CONFIG_DIR='x'; ${template}`).warnings).toEqual([]);
    expect(checkRestart(defaultSession, undefined).errors[0]!).toMatch(/^no restart command/);
    expect(checkRestart(defaultSession, template.replace("{session_id}", "abc")).errors[0]!).toMatch(/no \{session_id\}/);
    expect(checkRestart(defaultSession, "claude --resume {session_id} --name Alice").warnings.some((w) => /does not cd/.test(w))).toBe(true);
  });

  it("-c belongs to claude only: a shell's -c around the command is fine", () => {
    expect(checkRestart(defaultSession, `bash -c 'cd ${cwd}; claude --resume {session_id} --name Alice'`).errors).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("on Windows, refuses what Windows PowerShell cannot run: && and cd /d", () => {
    expect(checkRestart(defaultSession, `cd ${cwd} && claude --resume {session_id} --name Alice`).errors.some((e) => /&&/.test(e))).toBe(true);
    expect(checkRestart(defaultSession, `cd /d ${cwd}; claude --resume {session_id} --name Alice`).errors.some((e) => /cd \/d/.test(e))).toBe(true);
  });

  it("resume by explicit id only, never by name or --continue; --name is expected", () => {
    const errs = (t: string) => checkRestart(defaultSession, `cd ${cwd}; claude ${t}`).errors;
    expect(errs("--resume {session_id} --name Alice")).toEqual([]);
    expect(errs("-r {session_id} -n Alice")).toEqual([]);
    expect(errs("--resume Alice --name Alice --session-id {session_id}")[0]!).toMatch(/resume by id/);
    expect(errs("--continue --name Alice --resume {session_id}").some((e) => /--continue/.test(e))).toBe(true);
    expect(errs("-c --resume {session_id} --name Alice").some((e) => /--continue/.test(e))).toBe(true);
    expect(errs("--resume {session_id} --fork-session --name Alice").some((e) => /fork/.test(e))).toBe(true);
    expect(checkRestart(defaultSession, `cd ${cwd}; claude --resume {session_id}`).warnings.some((w) => /no --name/.test(w))).toBe(true);
  });
});

describe("resolvePath", () => {
  it("maps a voice name case-insensitively and refuses voice and file_path together", () => {
    const dir = tmpDir();
    const cfg = configFor(dir, { voices: { alice: { session: path.join(dir, "alice.jsonl") } } });
    expect(resolvePath(cfg, "Alice").voice).toBe("alice");
    expect(() => resolvePath(cfg, "alice", path.join(dir, "other.jsonl"))).toThrow(/not both/);
  });

  it("follows a continuation, and the live file must still be inside allowed_roots", () => {
    const dir = tmpDir();
    const anchor = new Session();
    anchor.user("hi");
    const anchorFile = anchor.write(dir);
    const live = new Session();
    live.user("continued");
    const liveFile = live.write(dir);
    fs.appendFileSync(anchorFile, JSON.stringify({ type: "continued-in", sessionId: anchor.sessionId, continuedInSessionId: live.sessionId }) + "\n");
    const cfg = configFor(dir, { voices: { alice: { session: anchorFile } } });
    const r = resolvePath(cfg, "alice");
    expect(r.path).toBe(liveFile);
    expect(r.session?.continuation_hops).toBe(1);
    const outside = configFor(tmpDir(), { voices: { alice: { session: anchorFile } } });
    expect(() => resolvePath(outside, "alice")).toThrow(/outside allowed_roots/);
  });
});

function voiceSetup(recapIds: string[]) {
  const dir = tmpDir();
  const projects = path.join(dir, "account", "projects", "-proj");
  fs.mkdirSync(projects, { recursive: true });
  const s = new Session();
  s.meta("mode");
  for (const id of recapIds) s.recap("alice", id);
  s.user("hi");
  s.assistant("hello");
  const session = s.write(projects);
  const home = path.join(dir, "Alice");
  fs.mkdirSync(home);
  const cfg = configFor(dir, {
    voices: { alice: { session, home, restart: "cd /proj; claude --resume {session_id} --name Alice" } },
    expose_paths: true,
  });
  return { dir, s, session, home, cfg, projects };
}

describe("recap plan", () => {
  it("next number from the session's stack, body path in the recaps folder, restart filled", () => {
    const { s, home, cfg } = voiceSetup(["alice-recap-001", "alice-recap-002"]);
    fs.writeFileSync(path.join(home, "recap-001.body.txt"), "x");
    fs.writeFileSync(path.join(home, "recap-002.body.txt"), "x");

    const plan = buildRecapPlan(cfg, "Alice", new Date("2026-01-22T20:00:00.000Z"));
    expect(plan.voice).toBe("alice");
    expect(plan.name).toBe("Alice");
    expect(plan.sentinel_name).toBe(cfg.sentinel_name);
    expect(plan.next.number).toBe(3);
    expect(plan.next.id).toBe("alice-recap-003");
    expect(plan.next.predecessor_id).toBe("alice-recap-002");
    expect(plan.next.body_path, "paths go out with forward slashes").toBe(slash(path.join(home, "recap-003.body.txt")));
    expect(plan.next.body_path!).not.toContain("\\");
    expect(plan.next.body_exists).toBe(false);
    expect(plan.bodies_on_disk).toEqual([1, 2]);
    expect(plan.memories_dir).toBe(slash(path.join(home, "memories")));
    expect(plan.suggested_before_timestamp).toBe("2026-01-22T19:55:00.000Z");
    expect(plan.restart_command).toBe(`cd /proj; claude --resume ${s.sessionId} --name Alice`);
    expect(plan.warnings).toEqual([]);

    fs.writeFileSync(path.join(home, "recap-003.body.txt"), "draft");
    fs.writeFileSync(path.join(home, "recap-005.body.txt"), "stray");
    const again = buildRecapPlan(cfg, "alice");
    expect(again.next.body_exists).toBe(true);
    expect(again.warnings.some((w) => w.includes("recap-005 beyond the next number 003"))).toBe(true);
  });

  it("first recap, and a stack whose folder holds no bodies is flagged", () => {
    const empty = voiceSetup([]);
    const first = buildRecapPlan(empty.cfg, "alice");
    expect(first.next.id).toBe("alice-recap-001");
    expect(first.next.predecessor_id).toBeNull();

    const wrongFolder = voiceSetup(["alice-recap-001"]);
    const plan = buildRecapPlan(wrongFolder.cfg, "alice");
    expect(plan.warnings.some((w) => w.includes("is recaps the right folder?"))).toBe(true);
  });

  it("follows a continuation: the restart command carries the LIVE session id", () => {
    const { cfg, session, projects } = voiceSetup(["alice-recap-001"]);
    const successor = new Session();
    successor.recap("alice", "alice-recap-001");
    successor.user("continued");
    const live = successor.write(projects);
    fs.appendFileSync(session, JSON.stringify({ type: "continued-in", sessionId: "old", continuedInSessionId: successor.sessionId }) + "\n");
    const plan = buildRecapPlan(cfg, "alice");
    expect(plan.session.live_path).toBe(slash(live));
    expect(plan.session.continuation_hops).toBe(1);
    expect(plan.restart_command!).toContain(`--resume ${successor.sessionId}`);

    fs.unlinkSync(live);
    const broken = buildRecapPlan(cfg, "alice");
    expect(broken.warnings.some((w) => w.startsWith("continuation chain broken"))).toBe(true);
  });

  it("without expose_paths the session paths are base names; the body path stays usable", () => {
    const { cfg, session, home } = voiceSetup([]);
    const plan = buildRecapPlan({ ...cfg, expose_paths: false }, "alice");
    expect(plan.session.live_path).toBe(path.basename(session));
    expect(plan.next.body_path).toBe(slash(path.join(home, "recap-001.body.txt")));
  });

  it("warns about a missing session, a missing recaps folder and a missing restart command", () => {
    const dir = tmpDir();
    const cfg = configFor(dir, {
      voices: { ghost: { session: path.join(dir, "projects", "x", "11111111-1111-4111-8111-111111111111.jsonl"), recaps: path.join(dir, "nope") } },
    });
    const plan = buildRecapPlan(cfg, "ghost");
    expect(plan.warnings.some((w) => w.startsWith("session file not found"))).toBe(true);
    expect(plan.warnings.some((w) => w.startsWith("recaps folder does not exist"))).toBe(true);
    expect(plan.warnings.some((w) => w.startsWith("no restart command"))).toBe(true);
    expect(plan.next.id).toBe("ghost-recap-001");
    expect(plan.next.body_path).toBeNull();
    expect(plan.restart_command).toBeNull();
  });

  it("a session outside allowed_roots is not read", () => {
    const { cfg } = voiceSetup(["alice-recap-001"]);
    const plan = buildRecapPlan({ ...cfg, allowed_roots: [tmpDir()] }, "alice");
    expect(plan.session.exists).toBe(false);
    expect(plan.stack).toEqual([]);
    expect(plan.warnings.some((w) => w.startsWith("the session file is outside allowed_roots"))).toBe(true);
  });

  it("counts a written body in characters, not bytes (Cyrillic is two bytes each)", () => {
    const { home, cfg } = voiceSetup(["alice-recap-001"]);
    fs.writeFileSync(path.join(home, "recap-001.body.txt"), "x");
    const body = "Γεια σου, Αλίκη. Привет. ".repeat(10);
    fs.writeFileSync(path.join(home, "recap-002.body.txt"), body);
    const plan = buildRecapPlan(cfg, "alice");
    expect(plan.next.body_exists).toBe(true);
    expect(plan.next.body_chars).toBe(body.length);
    expect(Buffer.byteLength(body), "the same body is far longer in bytes").toBeGreaterThan(1.5 * body.length);
    const none = voiceSetup([]);
    expect(buildRecapPlan(none.cfg, "alice").next.body_chars).toBeNull();
  });
});

describe("headroom", () => {
  it("tokens to 97%, minus the reserve, as a character budget counted low", () => {
    const roomy = headroomFor(700_000);
    expect(roomy.ceiling_percent).toBe(97);
    expect(roomy.tokens_to_ceiling).toBe(270_000);
    expect(roomy.body_budget_chars).toBe(Math.floor((270_000 - RESERVE_TOKENS) * 2.5));
    expect(roomy.tight).toBe(false);
    const tight = headroomFor(970_000 - RESERVE_TOKENS - 10_000);
    expect(tight.body_budget_chars).toBe(25_000);
    expect(tight.tight).toBe(true);
    expect(headroomFor(960_000).body_budget_chars).toBe(0);
    expect(headroomFor(990_000).tokens_to_ceiling).toBe(0);
  });
});

describe("recordsAround", () => {
  it("the lines around a line, clamped to the file, summarized with subtype and tool-result flag", () => {
    const dir = tmpDir();
    const s = new Session();
    s.meta("mode");
    s.user("hello");
    s.toolUse("toolu_x");
    s.toolResult("toolu_x", "output");
    s.system("turn_duration");
    s.user("next arc");
    const file = s.write(dir);
    const r = recordsAround(file, 4, 2);
    expect(r.total_lines).toBe(6);
    expect([r.from, r.to]).toEqual([2, 5]);
    expect(r.records.map((x) => [x.line_index, x.type, x.subtype, x.is_tool_result])).toEqual([
      [2, "assistant", null, false],
      [3, "user", null, true],
      [4, "system", "turn_duration", false],
      [5, "user", null, false],
    ]);
    expect(recordsAround(file, 0, 1).from).toBe(0);
  });
});
