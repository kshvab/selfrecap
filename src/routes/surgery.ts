/**
 * POST /surgery
 *
 * Cut + inject + parentUuid repair. The Phase 2 endpoint.
 *
 * AI provides:
 *   - voice OR file_path
 *   - cut_through_uuid (from /find-cut-point)
 *   - recap_content (the user-facing message body, must contain the configured sentinel)
 *   - dry_run (boolean) — recommended on first call
 *
 * Server enforces safety invariants before any mutation. See lib/surgery.ts.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { performSurgery } from "../lib/surgery.js";
import type { AppConfig } from "../config.js";
import { resolvePath } from "../config.js";

const RequestSchema = z
  .object({
    voice: z.string().optional(),
    file_path: z.string().optional(),
    cut_through_uuid: z.string().min(8),
    // Cap recap body at 1MB so an oversized payload is rejected with a clean 400
    // before any file work. (Fastify's bodyLimit guards the whole request too.)
    recap_content: z.string().min(50).max(1_048_576),
    dry_run: z.boolean().optional(),
    force_overwrite_recap: z.boolean().optional(),
  })
  .refine((d) => d.voice || d.file_path, {
    message: "Must provide `voice` or `file_path`",
  });

export function registerSurgery(app: FastifyInstance, config: AppConfig) {
  app.post("/surgery", async (request, reply) => {
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

    const result = await performSurgery({
      file_path: resolved.path,
      cut_through_uuid: body.cut_through_uuid,
      recap_content: body.recap_content,
      voice: resolved.voice,
      backup_dir: config.backup_dir,
      sentinel_name: config.sentinel_name,
      expose_paths: config.expose_paths,
      dry_run: body.dry_run,
      force_overwrite_recap: body.force_overwrite_recap,
    });

    // A write_failed (or any post-write/validation failure) is a server-side
    // failure, not a bad request — surface those as 500. Plan-level rejections
    // (bad uuid, sentinel missing, etc.) remain 400 (caller can fix the input).
    const serverSideFailure =
      !result.ok &&
      (result.reason?.startsWith("write_failed") ||
        result.reason?.startsWith("backup_failed") ||
        result.reason?.startsWith("post_write_validation_failed") ||
        result.reason?.startsWith("concurrent_modification"));
    const status = result.ok ? 200 : serverSideFailure ? 500 : 400;

    return reply.status(status).send({
      ...result,
      voice: resolved.voice,
    });
  });
}
