/**
 * POST /surgery
 *
 * Cut + inject + parentUuid repair, swapped in safely under a live session.
 *
 * AI provides:
 *   - voice OR file_path
 *   - cut_through_uuid (from /find-cut-point)
 *   - recap_content (the body; must end with the configured recap sentinel,
 *     whose id, for a voice, is the next in its recap stack — see
 *     /voices/:voice/recap-plan)
 *   - dry_run (boolean) — recommended on first call
 *   - force_overwrite_recap — only to delete a recap record outside the leading stack
 *
 * The response adds live_session_id and, for a voice with a restart
 * template, the exact restart_command. Refusals (the caller can fix the
 * input) come back as 400 with ok:false, a reason, and the full diagnostics;
 * a swap that could not be done because the file kept changing is 409 (the
 * live file is unchanged; retry); a backup that could not be written is 500.
 * See lib/surgery.ts for what is checked and how the swap works.
 */

import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { performSurgery } from "../lib/surgery.js";
import type { AppConfig } from "../config.js";
import { UnknownVoiceError, resolvePath, restartCommandFor } from "../config.js";

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

    let resolved: ReturnType<typeof resolvePath>;
    try {
      resolved = resolvePath(config, body.voice, body.file_path);
    } catch (e: any) {
      const status = e instanceof UnknownVoiceError ? 404 : 400;
      return reply.status(status).send({ error: status === 404 ? "voice_not_found" : "path_resolution_failed", message: e.message });
    }

    let result: ReturnType<typeof performSurgery>;
    try {
      result = performSurgery({
        file_path: resolved.path,
        cut_through_uuid: body.cut_through_uuid,
        recap_content: body.recap_content,
        voice: resolved.voice,
        backup_dir: config.backup_dir,
        sentinel_name: config.sentinel_name,
        expose_paths: config.expose_paths,
        dry_run: body.dry_run,
        force_overwrite_recap: body.force_overwrite_recap,
        broken_link: resolved.session?.broken_link,
      });
    } catch (e: any) {
      // performSurgery reports its own refusals; a throw is unexpected, and the
      // swap may or may not have happened. Say so rather than guess.
      return reply.status(500).send({
        error: "surgery_failed",
        message: `${e.message}. Surgery stopped unexpectedly: check the session with recap.ts --plan before retrying.`,
      });
    }

    const reason = result.reason ?? "";
    const status = result.ok ? 200 : reason.startsWith("backup_failed") ? 500 : reason.startsWith("not_applied") ? 409 : 400;
    const liveSessionId = path.basename(resolved.path, ".jsonl");
    return reply.status(status).send({
      ...result,
      voice: resolved.voice,
      live_session_id: liveSessionId,
      restart_command: resolved.voice ? restartCommandFor(config.voices[resolved.voice], liveSessionId) : null,
    });
  });
}
