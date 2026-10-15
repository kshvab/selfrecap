/**
 * GET /voices/:voice/recap-plan
 *
 * Read-only. Everything a session needs for /remember in one call: the live
 * session, the recap stack, the next recap number and body path, the sentinel
 * values to copy, the headroom left for the body, a before_timestamp for
 * find-cut-point, and the restart command. `npx tsx scripts/recap.ts <voice>
 * --plan` prints it.
 */

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { UnknownVoiceError } from "../config.js";
import { buildRecapPlan } from "../lib/recap-plan.js";

export function registerRecapPlan(app: FastifyInstance, config: AppConfig) {
  app.get<{ Params: { voice: string } }>("/voices/:voice/recap-plan", async (request, reply) => {
    try {
      return reply.send(buildRecapPlan(config, request.params.voice));
    } catch (e: any) {
      if (e instanceof UnknownVoiceError) {
        return reply.status(404).send({ error: "voice_not_found", message: e.message });
      }
      return reply.status(500).send({ error: "plan_failed", message: e.message });
    }
  });
}
