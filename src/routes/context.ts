/**
 * GET /context/:voice
 * GET /context?path=<absolute-jsonl-path>
 *
 * Returns the current context size for a JSONL session file using the
 * formula derived from CC's /context implementation. AI does not see this
 * output — it's for monitoring and dashboards.
 */

import type { FastifyInstance } from "fastify";
import { readContextSize } from "../lib/monitor.js";
import type { AppConfig } from "../config.js";
import { resolvePath } from "../config.js";

export function registerContext(app: FastifyInstance, config: AppConfig) {
  app.get<{ Params: { voice: string } }>("/context/:voice", async (request, reply) => {
    const { voice } = request.params;
    let resolved: { path: string; voice?: string };
    try {
      resolved = resolvePath(config, voice, undefined);
    } catch (e: any) {
      return reply.status(404).send({ error: "voice_not_found", message: e.message });
    }
    const reading = readContextSize(resolved.path, voice);
    if (!reading) {
      return reply.status(404).send({ error: "file_not_found", path: resolved.path });
    }
    return reply.send(reading);
  });

  app.get<{ Querystring: { path?: string } }>("/context", async (request, reply) => {
    const filePath = request.query.path;
    if (!filePath) {
      return reply.status(400).send({ error: "missing_path", message: "Pass ?path=<absolute-jsonl-path> or use /context/:voice" });
    }
    const reading = readContextSize(filePath);
    if (!reading) {
      return reply.status(404).send({ error: "file_not_found", path: filePath });
    }
    return reply.send(reading);
  });
}
