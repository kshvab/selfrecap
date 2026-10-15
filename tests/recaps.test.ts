/**
 * The one definition of "a recap": sentinel parsing, recap records, the recap
 * stack at the head of a session, and the next recap number.
 */

import { describe, it, expect } from "vitest";
import {
  decodeBodyText,
  isRecapRecord,
  nextRecapNumber,
  parseSentinel,
  recapNumber,
  scanRecapStack,
  sentinelParseError,
} from "../src/lib/recaps.js";
import { SENTINEL, Session, recapText } from "./helpers.js";

const S = SENTINEL;

describe("parseSentinel", () => {
  it("takes the LAST sentinel: a quoted predecessor earlier in the body is ignored", () => {
    const body = [
      "Hey alice. Operator here.",
      `Last time the sentinel was {"sentinel":"${S}","voice":"alice","id":"alice-recap-015","cut_through_uuid":"old"}.`,
      recapText("alice", "alice-recap-016", "new"),
    ].join("\n");
    const s = parseSentinel(body, S);
    expect(s?.id).toBe("alice-recap-016");
    expect(s?.cut_through_uuid).toBe("new");
  });

  it("reads pretty-printed, extra-spaced and nested sentinels", () => {
    expect(parseSentinel(`x {\n  "sentinel"  :   "${S}",\n  "id": "a-recap-001"\n} y`, S)?.id).toBe("a-recap-001");
    expect(parseSentinel(`{"meta":{"k":{"deep":1}},"sentinel":"${S}","id":"a-recap-002","cut_through_uuid":"u"}`, S)?.id).toBe("a-recap-002");
    expect(parseSentinel(`text with {braces} and "quotes" {"sentinel":"${S}","id":"a-recap-003"}`, S)?.id).toBe("a-recap-003");
    expect(parseSentinel(`{"sentinel":"${S}","note":"has } and { inside","id":"a-recap-004"}`, S)?.id).toBe("a-recap-004");
  });

  it("returns null without a parseable sentinel of the configured name", () => {
    expect(parseSentinel("no sentinel here", S)).toBeNull();
    expect(parseSentinel(`{"sentinel":"${S}", broken`, S)).toBeNull();
    expect(parseSentinel('{"sentinel":"OTHER"}', S)).toBeNull();
    // A custom sentinel name is honoured, and the default does not match it.
    expect(parseSentinel('{"sentinel":"MY-MARK","id":"x-recap-001"}', "MY-MARK")?.id).toBe("x-recap-001");
    expect(parseSentinel('{"sentinel":"MY-MARK","id":"x-recap-001"}', S)).toBeNull();
    // Regex metacharacters in a name are literal.
    expect(parseSentinel('{"sentinel":"A.B","id":"x"}', "A.B")?.id).toBe("x");
    expect(parseSentinel('{"sentinel":"AxB","id":"x"}', "A.B")).toBeNull();
  });

  it("a broken final sentinel never falls back to a quoted predecessor, and the error says why", () => {
    const body = [
      `Quoting the last one: {"sentinel":"${S}","id":"alice-recap-015","cut_through_uuid":"old"}`,
      "",
      "```json",
      "{",
      `  "sentinel": "${S}",`,
      '  "id": "alice-recap-016",',
      '  "mode": "B",',
      "}",
      "```",
    ].join("\n");
    expect(parseSentinel(body, S)).toBeNull();
    expect(sentinelParseError(body, S)).toBeTruthy();
    expect(sentinelParseError(`{"sentinel":"${S}","id":"x-recap-001"}`, S)).toBeNull();
    expect(sentinelParseError("no sentinel at all", S)).toBeNull();
  });
});

describe("decodeBodyText", () => {
  it("handles a UTF-8 BOM and UTF-16 bodies (PowerShell 5.1 redirection)", () => {
    const text = `Hey. Ärger – ок {"sentinel":"${S}","id":"x-recap-001"}`;
    expect(decodeBodyText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]))).toBe(text);
    expect(decodeBodyText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))).toBe(text);
    const be = Buffer.from(text, "utf16le");
    be.swap16();
    expect(decodeBodyText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(text);
    expect(decodeBodyText(Buffer.from(text, "utf8"))).toBe(text);
    expect(decodeBodyText(Buffer.from("a\r\nb"))).toBe("a\nb");
  });
});

describe("isRecapRecord", () => {
  it("only a user record with string content carrying the sentinel", () => {
    const body = recapText("alice", "alice-recap-001", "c");
    expect(isRecapRecord({ type: "user", message: { role: "user", content: body } }, S)).toBe(true);
    expect(
      isRecapRecord({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: body }] } }, S),
    ).toBe(false);
    expect(isRecapRecord({ type: "assistant", message: { role: "assistant", content: body } }, S)).toBe(false);
    expect(isRecapRecord({ type: "queue-operation", content: body } as any, S)).toBe(false);
    expect(isRecapRecord(null, S)).toBe(false);
  });

  it("not recaps: a task notification quoting a sentinel, a sentinel-shaped regex, a meta note", () => {
    const real = recapText("alice", "alice-recap-001", "c");
    const user = (content: string, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
    expect(isRecapRecord(user(real), S)).toBe(true);
    expect(isRecapRecord(user(`<task-notification>\nsubagent says: ${real}</task-notification>`), S)).toBe(false);
    expect(isRecapRecord(user(`grep for /"sentinel"\\s*:\\s*"${S}"/ in the logs`), S)).toBe(false);
    expect(isRecapRecord(user(real, { isMeta: true }), S)).toBe(false);
  });

  it("a recap written without an id (a 1.0 body) is still a recap, so it stays protected", () => {
    const user = (content: string) => ({ type: "user", message: { role: "user", content } });
    expect(isRecapRecord(user(`Hey. {"sentinel":"${S}","voice":"alice","cut_through_uuid":"c"}`), S)).toBe(true);
  });

  it("a 1.0 recap whose sentinel block does not parse is still a recap at the head of the stack", () => {
    const s = new Session();
    const old = s.user(`Hey. Recap.
{"sentinel":"${S}","id":"alice-recap-001",}`);
    s.user("hello");
    const stack = scanRecapStack(s.recs, S);
    expect(stack.recaps.map((r) => [r.uuid, r.id])).toEqual([[old.uuid, null]]);
    expect(stack.end).toBe(1);
  });
});

describe("the recap stack", () => {
  it("skips header records, stops at the first conversation record", () => {
    const s = new Session();
    s.meta("mode");
    s.meta("file-history-snapshot");
    s.recap("alice", "alice-recap-001");
    s.meta("custom-title");
    s.recap("alice", "alice-recap-002");
    s.user("hello");
    s.user(recapText("alice", "alice-recap-099", "x")); // a recap-shaped record later is not part of the stack
    const stack = scanRecapStack(s.recs, S);
    expect(stack.recaps.map((r) => [r.index, r.id, r.number])).toEqual([
      [2, "alice-recap-001", 1],
      [4, "alice-recap-002", 2],
    ]);
    expect(stack.end).toBe(5);
    expect(nextRecapNumber(stack).number).toBe(3);
  });

  it("every recap at the head counts, whoever signed it: none may be cut", () => {
    const s = new Session();
    s.recap("alice", "alice-recap-001");
    s.recap("bob", "bob-recap-004");
    s.user("hello");
    const stack = scanRecapStack(s.recs, S);
    expect(stack.recaps.map((r) => [r.id, r.voice])).toEqual([
      ["alice-recap-001", "alice"],
      ["bob-recap-004", "bob"],
    ]);
    expect(stack.end).toBe(2);
  });

  it("nextRecapNumber: first recap, numbered ids, and ids without numbers", () => {
    expect(nextRecapNumber({ recaps: [], end: 0 })).toEqual({ number: 1, basis: "ids" });
    const r = (id: string | null) => ({
      index: 0, uuid: "u", id, number: recapNumber(id), voice: null, period_covered: null, cut_through_uuid: null, applied_at: null,
    });
    expect(nextRecapNumber({ recaps: [r("alice-recap-001"), r("alice-recap-015")], end: 2 })).toEqual({ number: 16, basis: "ids" });
    expect(nextRecapNumber({ recaps: [r("alice-recap-001"), r("legacy")], end: 2 })).toEqual({ number: 3, basis: "count" });
    expect(nextRecapNumber({ recaps: [r("alice-recap-001"), r(null)], end: 2 })).toEqual({ number: 3, basis: "count" });
  });
});
