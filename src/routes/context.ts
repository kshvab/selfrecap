/**
 * GET /context/:voice
 * GET /context?path=<absolute-jsonl-path>
 *
 * Returns the current context size for a JSONL session file using the
 * formula derived from CC's /context implementation. For a voice, the
 * reading is taken from the LIVE file (continuations followed), and the
 * continuation chain is reported so a caller can tell a live reading from one
 * taken off a frozen ancestor.
 */

import path from "path";
import type { FastifyInstance } from "fastify";
import { readContextSize } from "../lib/monitor.js";
import type { AppConfig } from "../config.js";
import { UnknownVoiceError, resolvePath } from "../config.js";

export function registerContext(app: FastifyInstance, config: AppConfig) {
  // Absolute paths only when expose_paths is on; base names otherwise.
  const show = (p: string) => (config.expose_paths ? p : path.basename(p));

  app.get<{ Params: { voice: string } }>("/context/:voice", async (request, reply) => {
    const { voice } = request.params;
    let resolved: ReturnType<typeof resolvePath>;
    try {
      resolved = resolvePath(config, voice, undefined);
    } catch (e: any) {
      const status = e instanceof UnknownVoiceError ? 404 : 400;
      return reply.status(status).send({ error: status === 404 ? "voice_not_found" : "path_resolution_failed", message: e.message });
    }
    const reading = readContextSize(resolved.path, resolved.voice);
    if (!reading) {
      return reply.status(404).send({ error: "file_not_found" });
    }
    const { file, ...rest } = reading;
    return reply.send({
      ...(config.expose_paths ? reading : rest),
      configured_path: show(resolved.session?.configured_path ?? resolved.path),
      resolved_path: show(resolved.path),
      continuation_hops: resolved.session?.continuation_hops ?? 0,
      ...(resolved.session?.continuation_chain ? { continuation_chain: resolved.session.continuation_chain } : {}),
      ...(resolved.session?.broken_link ? { broken_link: resolved.session.broken_link } : {}),
    });
  });

  app.get<{ Querystring: { path?: string } }>("/context", async (request, reply) => {
    const filePath = request.query.path;
    if (!filePath) {
      return reply.status(400).send({ error: "missing_path", message: "Pass ?path=<absolute-jsonl-path> or use /context/:voice" });
    }
    // Validate the caller-supplied path against allowed_roots (same guard as
    // every other route) so an arbitrary path can't be read off disk.
    let resolved: { path: string; voice?: string };
    try {
      resolved = resolvePath(config, undefined, filePath);
    } catch (e: any) {
      return reply.status(400).send({ error: "path_resolution_failed", message: e.message });
    }
    const reading = readContextSize(resolved.path);
    if (!reading) {
      return reply.status(404).send({ error: "file_not_found" });
    }
    const { file, ...rest } = reading;
    return reply.send(config.expose_paths ? reading : rest);
  });
}
