/**
 * POST /find-cut-point
 *
 * AI describes a target point in their JSONL session. Server returns matches
 * with uuid (the deterministic handoff key) plus surrounding context for
 * AI to verify the correct location.
 *
 * Step 1 of the recap protocol. After AI confirms the right uuid, step 2
 * (surgery — cut + inject + repair) takes that uuid as input.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findCutPoint, type FindMethod } from "../lib/finder.js";
import type { AppConfig } from "../config.js";
import { resolvePath } from "../config.js";

const RequestSchema = z.object({
  voice: z.string().optional(),
  file_path: z.string().optional(),
  method: z.enum(["marker_phrase", "timestamp", "anchor_offset"]),
  phrase: z.string().optional(),
  before: z.string().optional(),
  anchor_phrase: z.string().optional(),
  offset: z.number().int().optional(),
  direction: z.enum(["before", "after"]).optional(),
  exclude_recap: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  before_timestamp: z.string().optional(),
}).refine(
  (data) => data.voice || data.file_path,
  { message: "Must provide `voice` or `file_path`" },
);

export function registerFindCutPoint(app: FastifyInstance, config: AppConfig) {
  app.post("/find-cut-point", async (request, reply) => {
    const parse = RequestSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({
        error: "invalid_request",
        details: parse.error.format(),
      });
    }
    const body = parse.data;

    let resolved: { path: string; voice?: string };
    try {
      resolved = resolvePath(config, body.voice, body.file_path);
    } catch (e: any) {
      return reply.status(400).send({ error: "path_resolution_failed", message: e.message });
    }

    try {
      const result = findCutPoint(resolved.path, {
        method: body.method as FindMethod,
        phrase: body.phrase,
        before: body.before,
        anchor_phrase: body.anchor_phrase,
        offset: body.offset,
        direction: body.direction,
        exclude_recap: body.exclude_recap,
        limit: body.limit,
        before_timestamp: body.before_timestamp,
      }, config.sentinel_name);
      // Strip the absolute file path from the response unless expose_paths is on.
      const { file, ...rest } = result;
      const payload = config.expose_paths ? result : rest;
      return reply.send({ ...payload, voice: resolved.voice });
    } catch (e: any) {
      return reply.status(500).send({ error: "find_failed", message: e.message });
    }
  });
}
