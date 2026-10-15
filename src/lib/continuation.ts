/**
 * Session continuation resolver.
 *
 * A voice's JSONL is not a stable file. When a session is continued (CC's
 * `--continue` / auto-continue on restart), CC freezes the current file and
 * starts a NEW file under a new session id, appending a marker to the old one:
 *
 *   {"type":"continued-in","sessionId":"<old>","continuedInSessionId":"<new>"}
 *
 * The old file stops growing. Anything still pointing at it reports the
 * context the session had at the moment it was continued — not its live
 * state. A dashboard can read 28% for days while the live session sits at 67%.
 *
 * This resolver walks that chain forward from the configured anchor to the
 * live file. It is deliberately conservative: it only follows a hop when the
 * successor is a well-formed session id AND its file exists on disk, so a
 * TTL-deleted successor degrades to "read the last file we still have" rather
 * than to file_not_found.
 */

import fs from "fs";
import path from "path";

/** Guard against a malformed / cyclic chain running away. */
const MAX_HOPS = 25;

/**
 * Bytes read from the end of a file when looking for the marker. The
 * continuation records CC appends (cost-state, bridge-session, continued-in,
 * last-prompt) are a few hundred bytes each and always land at the tail, so
 * this is generous — and it keeps chain resolution off the hot path of
 * reading multi-megabyte session files in full.
 */
const TAIL_BYTES = 256 * 1024;

const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

export interface ResolvedSession {
  /** Path as written in config.yaml. */
  configured_path: string;
  /** Live file after following the chain. Equals configured_path when no hop. */
  resolved_path: string;
  /** Number of continuations followed. 0 means the anchor is already live. */
  continuation_hops: number;
  /** Session ids traversed, anchor first. Only present when hops > 0. */
  continuation_chain?: string[];
  /**
   * Set when the chain stops at a successor we cannot read — the marker names
   * a session id whose file is gone (TTL wipe). resolved_path is then the last
   * readable file and its reading is stale by definition.
   */
  broken_link?: string;
}

/** Read the last TAIL_BYTES of a file as whole lines (partial head dropped). */
function readTailLines(filePath: string): string[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, length, start);
    const lines = buf.toString("utf8").split("\n");
    // When we started mid-file the first fragment is a partial line — drop it.
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The session this file was continued into, or null if it is still live.
 * Scans from the end — the marker is appended last.
 */
export function findContinuedInSessionId(filePath: string): string | null {
  const lines = readTailLines(filePath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"continued-in"')) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; continuedInSessionId?: string };
      if (rec.type !== "continued-in") continue;
      const next = rec.continuedInSessionId;
      if (typeof next === "string" && SESSION_ID_RE.test(next)) return next;
    } catch {
      // Partial or corrupt line — keep scanning.
    }
  }
  return null;
}

/**
 * Follow the continuation chain from `configuredPath` to the live session file.
 *
 * Successors live beside their ancestor (same project directory, `<id>.jsonl`),
 * which is how CC lays sessions out.
 */
export function resolveLiveSession(configuredPath: string): ResolvedSession {
  const result: ResolvedSession = {
    configured_path: configuredPath,
    resolved_path: configuredPath,
    continuation_hops: 0,
  };

  if (!fs.existsSync(configuredPath)) return result;

  const dir = path.dirname(configuredPath);
  const chain = [path.basename(configuredPath, ".jsonl")];
  const seen = new Set(chain);
  let current = configuredPath;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const nextId = findContinuedInSessionId(current);
    if (!nextId) break;

    if (seen.has(nextId)) {
      // Cycle — refuse to loop, report where we stopped.
      result.broken_link = nextId;
      break;
    }

    const nextPath = path.join(dir, `${nextId}.jsonl`);
    if (!fs.existsSync(nextPath)) {
      // Marker points at a file that is gone (TTL wipe). Stay on the last
      // readable file rather than resolving to nothing.
      result.broken_link = nextId;
      break;
    }

    seen.add(nextId);
    chain.push(nextId);
    current = nextPath;
    result.resolved_path = nextPath;
    result.continuation_hops = hop + 1;
  }

  if (result.continuation_hops > 0 || result.broken_link) {
    result.continuation_chain = chain;
  }
  return result;
}
