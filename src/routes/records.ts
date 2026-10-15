/**
 * GET /voices/:voice/records?around=<line>&span=<n>
 *
 * Read-only. The records around a line of the voice's live session,
 * summarized (line, type/subtype, uuid, parent_uuid, time, preview), for
 * reading a seam before choosing the cut. The file path is left out unless
 * expose_paths is on. span defaults to 30, max 200.
 * `scripts/recap.ts <voice> --around <line>` prints it.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { UnknownVoiceError, resolvePath } from "../config.js";
import { AROUND_DEFAULT_SPAN, AROUND_MAX_SPAN, recordsAround } from "../lib/finder.js";

const QuerySchema = z.object({
  around: z.coerce.number().int().min(0),
  span: z.coerce.number().int().min(1).max(AROUND_MAX_SPAN).optional(),
});

export function registerRecords(app: FastifyInstance, config: AppConfig) {
  app.get<{ Params: { voice: string } }>("/voices/:voice/records", async (request, reply) => {
    const parse = QuerySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.status(400).send({ error: "invalid_request", details: parse.error.format() });
    }
    let resolved: ReturnType<typeof resolvePath>;
    try {
      resolved = resolvePath(config, request.params.voice, undefined);
    } catch (e: any) {
      const status = e instanceof UnknownVoiceError ? 404 : 400;
      return reply.status(status).send({ error: status === 404 ? "voice_not_found" : "path_resolution_failed", message: e.message });
    }
    try {
      const { file, ...rest } = recordsAround(resolved.path, parse.data.around, parse.data.span ?? AROUND_DEFAULT_SPAN);
      return reply.send({ ...(config.expose_paths ? { file } : {}), ...rest, voice: resolved.voice });
    } catch (e: any) {
      return reply.status(500).send({ error: "read_failed", message: e.message });
    }
  });
}
