/**
 * Small synchronous file helpers shared by surgery and backups.
 *
 * Surgery runs synchronously inside one request so that two surgeries in this
 * process can never interleave. These helpers keep it that way: durable writes
 * (fsync before close), exact range reads, and a blocking sleep for the short
 * waits the swap loop needs.
 */

import fs from "fs";
import crypto from "crypto";

/** Write `data` to `filePath` and fsync it before closing. `flag` is an fs open flag ("w", "wx", "a"). */
export function writeDurable(filePath: string, data: Buffer, flag: "w" | "wx" | "a"): void {
  const fd = fs.openSync(filePath, flag);
  try {
    let off = 0;
    while (off < data.length) {
      off += fs.writeSync(fd, data, off, data.length - off);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read bytes [from, to) of a file. Returns fewer bytes only if the file is shorter. */
export function readRange(filePath: string, from: number, to: number): Buffer {
  const length = Math.max(0, to - from);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block the thread for `ms` milliseconds. Used only for the swap loop's short waits. */
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}
