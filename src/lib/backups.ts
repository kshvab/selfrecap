/**
 * Pre-surgery backups: where they go, how they are written, how old ones are
 * kept small.
 *
 * Layout, per voice:
 *   <backup_dir>/<voice>/<voice>-<session-id>-pre-surgery-<ts>.jsonl
 * Surgery on an explicit file_path (no voice) keeps the flat layout:
 *   <backup_dir>/<session-id>-pre-surgery-<ts>.jsonl
 *
 * Every backup is the only verbatim copy of the period its surgery cut, so
 * nothing here deletes content. Rotation gzips a voice's backups beyond the
 * newest KEEP_RAW and removes a raw file only after its compressed copy has
 * been read back and matched byte for byte. Restore an old one with gunzip.
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { sha256, writeDurable } from "./fsutil.js";

/** Raw (uncompressed) backups kept per voice; older ones are gzipped. */
export const KEEP_RAW = 3;

/** Absolute path for a new backup: under backups/<voice>/ for a voice, flat otherwise. */
export function backupPathFor(backupDir: string, voice: string | undefined, sessionId: string, when: Date): string {
  const ts = when.toISOString().replace(/[:.]/g, "-");
  const root = path.resolve(backupDir);
  return voice
    ? path.join(root, voice, `${voice}-${sessionId}-pre-surgery-${ts}.jsonl`)
    : path.join(root, `${sessionId}-pre-surgery-${ts}.jsonl`);
}

/**
 * Write a new backup and prove it: fsync, read it back, compare size and
 * sha256. Never overwrites an existing file. On any failure the partial file
 * is removed and the error is thrown.
 */
export function writeVerifiedBackup(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // "wx": never overwrite. From the moment the file exists, any failure —
  // a short write, a failed fsync, a mismatch on read-back — removes it, so
  // a partial file can never pass for a backup.
  const fd = fs.openSync(filePath, "wx");
  try {
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const back = fs.readFileSync(filePath);
    if (back.length !== bytes.length || !sha256(back).equals(sha256(bytes))) {
      throw new Error(`verification failed: wrote ${bytes.length} bytes, read back ${back.length}`);
    }
  } catch (e) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort.
    }
    throw e;
  }
}

/** Timestamp embedded in a backup name (`...-2026-09-22T01-08-16-344Z.jsonl`), in ms. */
function stampOf(name: string): number | null {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : t;
}

function compressVerified(filePath: string): void {
  const target = `${filePath}.gz`;
  if (fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists`);
  const raw = fs.readFileSync(filePath);
  const gz = zlib.gzipSync(raw);
  if (!sha256(zlib.gunzipSync(gz)).equals(sha256(raw))) throw new Error("gzip round-trip mismatch");
  const tmp = `${target}.tmp`;
  writeDurable(tmp, gz, "w");
  fs.renameSync(tmp, target);
  const back = zlib.gunzipSync(fs.readFileSync(target));
  if (!sha256(back).equals(sha256(raw))) {
    fs.unlinkSync(target);
    throw new Error("compressed copy did not read back");
  }
  fs.unlinkSync(filePath);
}

export interface RotationResult {
  compressed: string[];
  errors: string[];
}

/**
 * Keep the newest `keep` raw backups in one voice's folder and gzip the rest.
 * Only `*.jsonl` files in that folder are considered; nothing is deleted
 * without a verified compressed copy, and errors leave the raw file in place.
 */
export function rotateVoiceBackups(voiceDir: string, keep = KEEP_RAW): RotationResult {
  const result: RotationResult = { compressed: [], errors: [] };
  if (!fs.existsSync(voiceDir)) return result;
  const dated = fs
    .readdirSync(voiceDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: stampOf(f) ?? fs.statSync(path.join(voiceDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of dated.slice(keep)) {
    try {
      compressVerified(path.join(voiceDir, f));
      result.compressed.push(f);
    } catch (e: any) {
      result.errors.push(`${f}: ${e.message}`);
    }
  }
  return result;
}
