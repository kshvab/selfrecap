/**
 * Security tests — two layers:
 *  (a) resolveSafePath path guard (suffix gate, allowed_roots, symlink escape).
 *  (b) HTTP onRequest hook via fastify .inject(): token, Origin, Host gates.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { resolveSafePath } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { configFor, makeWorkspace, type TempWorkspace } from "./helpers.js";

// ─── (a) resolveSafePath ──────────────────────────────────────────────────────

describe("resolveSafePath", () => {
  let ws: TempWorkspace;
  beforeAll(() => {
    ws = makeWorkspace();
  });
  afterAll(() => ws.cleanup());

  it("accepts a .jsonl path under allowed_roots and returns the resolved path", () => {
    const cfg = configFor(ws.dir);
    const out = resolveSafePath(cfg, undefined, ws.filePath);
    expect(out.path).toBe(path.resolve(ws.filePath));
  });

  it("rejects a path outside allowed_roots", () => {
    const cfg = configFor(ws.dir);
    // A clearly out-of-root absolute path (still .jsonl so we hit the root gate).
    const outside = path.join(os.tmpdir(), "definitely-not-allowed", "passwd.jsonl");
    expect(() => resolveSafePath(cfg, undefined, outside)).toThrow(/allowed_roots/i);
  });

  it("rejects a traversal path that escapes the allowed root", () => {
    const cfg = configFor(ws.dir);
    const traversal = path.join(ws.dir, "..", "..", "etc", "passwd.jsonl");
    expect(() => resolveSafePath(cfg, undefined, traversal)).toThrow(/allowed_roots/i);
  });

  it("rejects a path not ending in .jsonl", () => {
    const cfg = configFor(ws.dir);
    const notJsonl = path.join(ws.dir, "session.txt");
    expect(() => resolveSafePath(cfg, undefined, notJsonl)).toThrow(/non-\.jsonl|\.jsonl/i);
  });

  it("rejects a symlink whose target sits outside allowed_roots (skipped if unprivileged)", () => {
    const cfg = configFor(ws.dir);
    // Target file lives OUTSIDE the allowed root.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "recap-outside-"));
    const realOutside = fs.realpathSync(outsideDir);
    const target = path.join(realOutside, "secret.jsonl");
    fs.writeFileSync(target, "secret\n");
    // The symlink itself lives INSIDE the allowed root but points outside it.
    const link = path.join(ws.dir, "escape.jsonl");
    let created = false;
    try {
      fs.symlinkSync(target, link, "file");
      created = true;
    } catch {
      // Windows without Developer Mode / admin; skip gracefully.
      created = false;
    }
    try {
      if (!created) {
        expect(true).toBe(true); // skipped: symlink creation needs privileges
        return;
      }
      // realpathSync resolves the link to its outside target -> must throw.
      expect(() => resolveSafePath(cfg, undefined, link)).toThrow(/allowed_roots/i);
    } finally {
      try { fs.rmSync(realOutside, { recursive: true, force: true }); } catch { /* */ }
      try { if (created) fs.rmSync(link, { force: true }); } catch { /* */ }
    }
  });
});

// ─── (b) HTTP layer via .inject() ──────────────────────────────────────────────

describe("HTTP security hook (inject)", () => {
  let ws: TempWorkspace;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    ws = makeWorkspace();
    const built = buildApp(configFor(ws.dir));
    app = built.app;
    token = built.authToken;
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    ws.cleanup();
  });

  const LOOPBACK = { host: "localhost" };

  it("POST /surgery with no X-Recap-Token -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/surgery",
      headers: { ...LOOPBACK },
      payload: {
        file_path: ws.filePath,
        cut_through_uuid: "nonexistent-uuid",
        recap_content: "x".repeat(60),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("any request carrying an Origin header -> 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { ...LOOPBACK, origin: "https://evil.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden_origin");
  });

  it("non-loopback Host header -> 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "evil.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden_host");
  });

  it("GET /health with loopback host and no Origin -> 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { ...LOOPBACK },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("POST /surgery WITH a valid token passes the auth gate (dry_run)", async () => {
    const recap =
      "Recap body.\n\n```json\n" +
      JSON.stringify({ sentinel: "RECAP-CYCLE", id: "recap-009", version: 1 }) +
      "\n```\n";
    const res = await app.inject({
      method: "POST",
      url: "/surgery",
      headers: { ...LOOPBACK, "x-recap-token": token },
      payload: {
        file_path: ws.filePath,
        cut_through_uuid: "sess-uuid-10",
        recap_content: recap,
        dry_run: true,
      },
    });
    // Auth passed -> 200 with a successful dry-run plan (not 401/403).
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().dry_run).toBe(true);
  });
});
