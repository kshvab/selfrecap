/**
 * Finder tests — marker_phrase (with recap exclusion), timestamp, anchor_offset
 * (both directions), and the before_timestamp self-contamination filter.
 */

import { describe, it, expect } from "vitest";
import {
  findMarkerPhrase,
  findTimestampBefore,
  findAnchorOffset,
  findCutPoint,
} from "../src/lib/finder.js";
import { FIXTURE_PATH, SENTINEL } from "./helpers.js";

describe("findMarkerPhrase", () => {
  it("finds the unique marker phrase at its record", () => {
    const matches = findMarkerPhrase(FIXTURE_PATH, "THE_MARKER_PHRASE", SENTINEL);
    expect(matches.length).toBe(1);
    expect(matches[0]?.line_index).toBe(6);
    expect(matches[0]?.uuid).toBe("sess-uuid-06");
  });

  it("exclude_recap=true skips the leading recap even if the phrase is inside it", () => {
    // The leading recap (sess-uuid-00) contains the literal string 'cut_through_uuid'.
    const withRecap = findMarkerPhrase(FIXTURE_PATH, "cut_through_uuid", SENTINEL, false);
    const withoutRecap = findMarkerPhrase(FIXTURE_PATH, "cut_through_uuid", SENTINEL, true);
    // With exclusion off, the recap record matches; with it on, the recap is skipped.
    expect(withRecap.some((m) => m.line_index === 0)).toBe(true);
    expect(withoutRecap.some((m) => m.line_index === 0)).toBe(false);
  });
});

describe("findTimestampBefore", () => {
  it("returns the latest record strictly before the cutoff", () => {
    // Records are 1 minute apart starting 2026-05-07T20:00:00Z (idx 0).
    // uuid-05 is at 20:05:00. A cutoff of 20:05:30 -> last before is idx 5.
    const matches = findTimestampBefore(FIXTURE_PATH, "2026-05-07T20:05:30.000Z", SENTINEL);
    expect(matches.length).toBe(1);
    expect(matches[0]?.line_index).toBe(5);
    expect(matches[0]?.uuid).toBe("sess-uuid-05");
  });

  it("returns nothing when the cutoff predates all records", () => {
    const matches = findTimestampBefore(FIXTURE_PATH, "2020-01-01T00:00:00.000Z", SENTINEL);
    expect(matches.length).toBe(0);
  });
});

describe("findAnchorOffset", () => {
  it("offset 'after' moves forward from the anchor", () => {
    // Anchor SECOND_MARKER is at idx 20; +2 after -> idx 22.
    const matches = findAnchorOffset(FIXTURE_PATH, "SECOND_MARKER", 2, "after", SENTINEL);
    expect(matches.length).toBe(1);
    expect(matches[0]?.line_index).toBe(22);
    expect(matches[0]?.uuid).toBe("sess-uuid-22");
  });

  it("offset 'before' moves backward from the anchor", () => {
    // Anchor SECOND_MARKER at idx 20; -3 before -> idx 17.
    const matches = findAnchorOffset(FIXTURE_PATH, "SECOND_MARKER", 3, "before", SENTINEL);
    expect(matches.length).toBe(1);
    expect(matches[0]?.line_index).toBe(17);
    expect(matches[0]?.uuid).toBe("sess-uuid-17");
  });
});

describe("before_timestamp filter (via findCutPoint)", () => {
  it("excludes matches at or after the given timestamp", () => {
    // 'File written' appears in tool_result records uuid-15 (20:15) and uuid-19 (20:19).
    const all = findCutPoint(
      FIXTURE_PATH,
      { method: "marker_phrase", phrase: "File written" },
      SENTINEL,
    );
    expect(all.total_matches).toBe(2);

    // Filter to strictly before 20:19:00 -> only uuid-15 survives.
    const filtered = findCutPoint(
      FIXTURE_PATH,
      { method: "marker_phrase", phrase: "File written", before_timestamp: "2026-05-07T20:19:00.000Z" },
      SENTINEL,
    );
    expect(filtered.total_matches).toBe(1);
    expect(filtered.matches[0]?.uuid).toBe("sess-uuid-15");
  });
});
