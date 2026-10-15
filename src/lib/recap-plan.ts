/**
 * Recap plan — everything a session at its context wall needs for /remember,
 * worked out from config and the live session so the session juggles no paths
 * and counts no files: where the session lives now, the recap stack, the next
 * recap number and body path, the sentinel values, and the restart command.
 *
 * The next number comes from the session's recap stack, not from the folder:
 * the stack is what surgery keeps and what the voice has in context. The
 * folder is checked against it and disagreements come back as warnings.
 */

import fs from "fs";
import path from "path";
import { displayNameOf, getVoice, isUnderAllowedRoots, recapsDirOf, restartCommandFor, type AppConfig } from "../config.js";
import { resolveLiveSession } from "./continuation.js";
import { loadJsonl } from "./jsonl.js";
import { readContextSize } from "./monitor.js";
import { decodeBodyText, formatRecapId, nextRecapNumber, recapBodyFileName, scanRecapStack } from "./recaps.js";

export interface RecapPlan {
  voice: string;
  /** The name the session answers to. */
  name: string;
  /** The sentinel name bodies must carry (config.sentinel_name). */
  sentinel_name: string;
  home: string | null;
  recaps_dir: string | null;
  memories_dir: string | null;
  /** Paths are base names unless config.expose_paths is on. */
  session: {
    configured_path: string;
    live_path: string;
    live_session_id: string;
    exists: boolean;
    continuation_hops: number;
    continuation_chain?: string[];
    broken_link?: string;
  };
  context: { tokens_total: number; percent_of_1m: number; last_usage_ts: string | null } | null;
  /**
   * How much room is left before the old session crosses the ceiling, and how
   * long the body can be. The window between --go and the restart is where
   * cycles have died: this is the number to write to.
   */
  headroom: {
    ceiling_percent: number;
    tokens_to_ceiling: number;
    reserve_tokens: number;
    body_budget_chars: number;
    tight: boolean;
  } | null;
  /** The recap stack at the head of the live session, oldest first. */
  stack: Array<{
    line_idx: number;
    id: string | null;
    period_covered: string | null;
    cut_through_uuid: string | null;
    applied_at: string | null;
  }>;
  next: {
    number: number;
    id: string;
    predecessor_id: string | null;
    /** Where to write the body. Null when no recaps folder is configured. */
    body_path: string | null;
    /** A body for this number is already written (not yet applied). */
    body_exists: boolean;
    /**
     * Length of that body in characters — what the headroom budget counts.
     * Not bytes: `wc -c` counts bytes, and Cyrillic takes two per character,
     * so a Ukrainian body looks twice its size to it.
     */
    body_chars: number | null;
  };
  /** Recap numbers found as recap-NNN.body.txt in the recaps folder. */
  bodies_on_disk: number[];
  /** Now minus five minutes: find-cut-point's filter against matching this very conversation. */
  suggested_before_timestamp: string;
  restart_command: string | null;
  warnings: string[];
}

const BODY_RE = /^recap-(\d{3,})\.body\.txt$/;

/** The context window percent_of_1m assumes. */
const WINDOW_TOKENS = 1_000_000;
/** The line the old session must not cross before its restart: past it, cycles have died. */
const CEILING = 0.97;
/**
 * Tokens kept for everything the voice does after reading the plan, apart
 * from writing the body: the searches and seam reads, the dry run, --go and
 * the report, plus its own reasoning in between.
 *
 * Measured: a typical cycle's tool output is ~12k tokens and the /remember
 * text ~12k (usually not yet in the plan's reading). A real cycle with an
 * easy seam (one search, one seam read, no backtracking) cost ~24k for the
 * whole protocol. So ~24k is the solid part and the other 16k is the variance
 * term for hard seams, where reasoning over several candidates is what grows.
 */
export const RESERVE_TOKENS = 40_000;
/** Characters per token for recap prose, counted low so the budget errs small (Cyrillic, for one, tokenizes densely). */
const CHARS_PER_TOKEN = 2.5;
/** Below this body budget the plan says TIGHT. */
const TIGHT_CHARS = 40_000;

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Paths go out with forward slashes. On Windows, Claude Code runs commands
 * through Git Bash, where an unquoted backslash path silently turns into a
 * junk file name.
 */
function slash(p: string): string;
function slash(p: string | null): string | null;
function slash(p: string | null): string | null {
  return p === null ? null : p.replace(/\\/g, "/");
}

/** Room left before the ceiling, and the body budget that leaves after the reserve. */
export function headroomFor(tokensTotal: number): NonNullable<RecapPlan["headroom"]> {
  const toCeiling = Math.max(0, Math.floor(WINDOW_TOKENS * CEILING) - tokensTotal);
  const budget = Math.max(0, Math.floor((toCeiling - RESERVE_TOKENS) * CHARS_PER_TOKEN));
  return {
    ceiling_percent: CEILING * 100,
    tokens_to_ceiling: toCeiling,
    reserve_tokens: RESERVE_TOKENS,
    body_budget_chars: budget,
    tight: budget < TIGHT_CHARS,
  };
}

/** The recap plan for one voice (case-insensitive name). Throws UnknownVoiceError. */
export function buildRecapPlan(config: AppConfig, voiceName: string, now = new Date()): RecapPlan {
  const { name, entry } = getVoice(config, voiceName);
  const warnings: string[] = [];

  const resolved = resolveLiveSession(entry.session);
  const livePath = resolved.resolved_path;
  const liveId = path.basename(livePath, ".jsonl");
  const inRoots = isUnderAllowedRoots(config, path.resolve(livePath)).ok;
  if (!inRoots) warnings.push("the session file is outside allowed_roots: it is not read, and surgery would refuse it");
  const exists = inRoots && fs.existsSync(livePath);
  if (inRoots && !exists) warnings.push(`session file not found: ${config.expose_paths ? livePath : path.basename(livePath)}`);
  if (resolved.broken_link) {
    warnings.push(
      `continuation chain broken: the session was continued into ${resolved.broken_link}, whose file is gone. ` +
        `Surgery is refused until config.yaml points at the live file.`,
    );
  }

  const records = exists ? loadJsonl(livePath) : [];
  const stack = scanRecapStack(records, config.sentinel_name);
  const next = nextRecapNumber(stack);
  if (next.basis === "count") warnings.push("some recap ids in the stack carry no number; the next number is a count");
  const lastRecap = stack.recaps[stack.recaps.length - 1];
  const reading = exists ? readContextSize(livePath, name) : null;

  const recapsDir = recapsDirOf(entry);
  let bodies: number[] = [];
  let bodyPath: string | null = null;
  let bodyExists = false;
  let bodyChars: number | null = null;
  if (!recapsDir) {
    warnings.push(`no recaps folder configured for ${name}: set recaps (or home) in config.yaml`);
  } else if (!fs.existsSync(recapsDir)) {
    warnings.push(`recaps folder does not exist: ${recapsDir}`);
  } else {
    bodies = fs
      .readdirSync(recapsDir)
      .map((f) => BODY_RE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1]!, 10))
      .sort((a, b) => a - b);
    bodyPath = path.join(recapsDir, recapBodyFileName(next.number));
    bodyExists = fs.existsSync(bodyPath);
    if (bodyExists) bodyChars = decodeBodyText(fs.readFileSync(bodyPath)).length;
    const beyond = bodies.filter((n) => n > next.number);
    if (beyond.length > 0) {
      warnings.push(
        `the recaps folder has recap-${beyond.map(pad).join(", recap-")} beyond the next number ${pad(next.number)}; ` +
          `the session's stack decides the number`,
      );
    }
    if (stack.recaps.length > 0 && bodies.length === 0) {
      warnings.push(`the session carries ${stack.recaps.length} recap(s) but ${recapsDir} holds no recap bodies: is recaps the right folder?`);
    }
  }
  if (!entry.restart) warnings.push(`no restart command configured for ${name}: set restart in config.yaml so --go can print it`);

  const show = (p: string) => (config.expose_paths ? slash(p) : path.basename(p));
  return {
    voice: name,
    name: displayNameOf(name, entry),
    sentinel_name: config.sentinel_name,
    home: slash(entry.home ?? null),
    recaps_dir: slash(recapsDir),
    memories_dir: entry.home ? slash(path.join(entry.home, "memories")) : null,
    session: {
      configured_path: show(resolved.configured_path),
      live_path: show(livePath),
      live_session_id: liveId,
      exists,
      continuation_hops: resolved.continuation_hops,
      ...(resolved.continuation_chain ? { continuation_chain: resolved.continuation_chain } : {}),
      ...(resolved.broken_link ? { broken_link: resolved.broken_link } : {}),
    },
    context: reading
      ? { tokens_total: reading.tokens_total, percent_of_1m: reading.percent_of_1m, last_usage_ts: reading.last_usage_ts }
      : null,
    headroom: reading ? headroomFor(reading.tokens_total) : null,
    stack: stack.recaps.map((r) => ({
      line_idx: r.index,
      id: r.id,
      period_covered: r.period_covered,
      cut_through_uuid: r.cut_through_uuid,
      applied_at: r.applied_at,
    })),
    next: {
      number: next.number,
      id: formatRecapId(name, next.number),
      predecessor_id: lastRecap?.id ?? null,
      body_path: slash(bodyPath),
      body_exists: bodyExists,
      body_chars: bodyChars,
    },
    bodies_on_disk: bodies,
    suggested_before_timestamp: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    restart_command: restartCommandFor(entry, liveId),
    warnings,
  };
}
