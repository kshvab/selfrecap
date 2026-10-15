/**
 * The HTTP surface added in 1.1, driven through Fastify's inject():
 * the recap plan, records around a line, /contexts with its recap stack,
 * headroom and stale-reading flag, and /surgery's restart command.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { buildApp } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { Session, configFor, recapText, tmpDir } from "./helpers.js";

const HOST = { host: "127.0.0.1:9090" };

function setup(opts: { recaps?: string[]; expose?: boolean } = {}) {
  const dir = tmpDir();
  const projects = path.join(dir, "account", "projects", "-proj");
  fs.mkdirSync(projects, { recursive: true });
  const s = new Session();
  for (const id of opts.recaps ?? []) s.recap("alice", id);
  s.user("first task");
  const a1 = s.assistantWithUsage("done", 300_000);
  s.system("turn_duration");
  s.user("next arc");
  s.assistantWithUsage("on it", 420_000);
  const session = s.write(projects);
  const recaps = path.join(dir, "recaps");
  fs.mkdirSync(recaps);
  const config = configFor(dir, {
    voices: { alice: { session, recaps, restart: "cd /proj; claude --resume {session_id} --name Alice" } },
    expose_paths: opts.expose ?? false,
  });
  const { app, authToken } = buildApp(config);
  return { dir, s, a1, session, recaps, config, app, authToken };
}

describe("routes", () => {
  it("/health reports the version and config problems", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/health", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", version: VERSION, voices_registered: 1, config_problems: 0 });
  });

  it("/voices/:voice/recap-plan answers the plan, and 404 for an unknown voice", async () => {
    const { app, s } = setup({ recaps: ["alice-recap-001"] });
    const res = await app.inject({ method: "GET", url: "/voices/Alice/recap-plan", headers: HOST });
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.next.id).toBe("alice-recap-002");
    expect(plan.sentinel_name).toBe("RECAP-CYCLE");
    expect(plan.restart_command).toBe(`cd /proj; claude --resume ${s.sessionId} --name Alice`);
    expect(plan.session.live_path).toBe(`${s.sessionId}.jsonl`);
    expect(plan.headroom.tokens_to_ceiling).toBe(970_000 - 420_000);
    const missing = await app.inject({ method: "GET", url: "/voices/nobody/recap-plan", headers: HOST });
    expect(missing.statusCode).toBe(404);
  });

  it("/voices/:voice/records reads around a line and hides the file path unless expose_paths", async () => {
    const hidden = setup();
    const r1 = (await hidden.app.inject({ method: "GET", url: "/voices/alice/records?around=2&span=1", headers: HOST })).json();
    expect(r1.records.map((x: any) => x.line_index)).toEqual([1, 2, 3]);
    expect("file" in r1).toBe(false);
    const shown = setup({ expose: true });
    const r2 = (await shown.app.inject({ method: "GET", url: "/voices/alice/records?around=2&span=1", headers: HOST })).json();
    expect(r2.file).toBe(shown.session);
    const bad = await hidden.app.inject({ method: "GET", url: "/voices/alice/records", headers: HOST });
    expect(bad.statusCode).toBe(400);
  });

  it("/contexts: reading, recap stack, headroom; no usage bars unless opted in; no absolute paths", async () => {
    const { app, s } = setup({ recaps: ["alice-recap-001"] });
    const res = await app.inject({ method: "GET", url: "/contexts", headers: HOST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect("account_usage" in body).toBe(false);
    const v = body.voices.alice;
    expect(v.exists).toBe(true);
    expect(v.tokens_total).toBe(420_000);
    expect(v.recaps).toMatchObject({ count: 1, last_id: "alice-recap-001" });
    expect(v.headroom.tokens_to_ceiling).toBe(550_000);
    expect(v.stale_reading).toBe(false);
    expect(v.resolved_path).toBe(`${s.sessionId}.jsonl`);
    expect(JSON.stringify(body)).not.toContain(path.sep === "\\" ? "\\\\" : "/account/");
  });

  it("/contexts flags a reading taken before the last recap landed", async () => {
    const { app, session, s } = setup();
    // Inject a recap at the head stamped after the last usage reading.
    const lines = fs.readFileSync(session, "utf8").split("\n");
    const recap = {
      parentUuid: null, isSidechain: false, type: "user", uuid: "55555555-5555-4555-8555-555555555555",
      timestamp: "2099-01-01T00:00:00.000Z", sessionId: s.sessionId,
      message: { role: "user", content: recapText("alice", "alice-recap-001", "x") },
    };
    fs.writeFileSync(session, [JSON.stringify(recap), ...lines].join("\n"));
    const v = (await app.inject({ method: "GET", url: "/contexts", headers: HOST })).json().voices.alice;
    expect(v.stale_reading).toBe(true);
    expect(v.stale_reason).toMatch(/alice-recap-001/);
  });

  it("/context/:voice reports continuation info", async () => {
    const { app } = setup();
    const v = (await app.inject({ method: "GET", url: "/context/alice", headers: HOST })).json();
    expect(v.continuation_hops).toBe(0);
    expect(v.tokens_total).toBe(420_000);
    expect("file" in v).toBe(false);
  });

  it("POST /surgery for a voice: a refusal is 400 with the reason; a dry run carries the restart command", async () => {
    const { app, authToken, a1, s } = setup();
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/surgery",
        headers: { ...HOST, "x-recap-token": authToken, "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
    const wrongId = await post({ voice: "alice", cut_through_uuid: a1.uuid, recap_content: recapText("alice", "alice-recap-007", a1.uuid), dry_run: true });
    expect(wrongId.statusCode).toBe(400);
    expect(wrongId.json().reason).toMatch(/^sentinel_id_mismatch/);
    const ok = await post({ voice: "alice", cut_through_uuid: a1.uuid, recap_content: recapText("alice", "alice-recap-001", a1.uuid), dry_run: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, dry_run: true, voice: "alice", live_session_id: s.sessionId });
    expect(ok.json().restart_command).toContain(`--resume ${s.sessionId}`);
    const unknown = await post({ voice: "nobody", cut_through_uuid: a1.uuid, recap_content: recapText("x", "x", a1.uuid), dry_run: true });
    expect(unknown.statusCode).toBe(404);
  });

  it("/lifecycle answers without starting anything", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/lifecycle", headers: HOST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supported).toBe(process.platform === "win32");
    expect(body.voices.alice.name).toBe("Alice");
  });
});
