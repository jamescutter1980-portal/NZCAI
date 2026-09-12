import { describe, expect, it } from "vitest";
import { chunkRange, fromN3rgyTimestamp, rangeDays, toN3rgyDateString } from "../dates";

describe("toN3rgyDateString", () => {
  it("formats UTC as YYYYMMDDHHmm", () => {
    expect(toN3rgyDateString(new Date("2026-09-01T07:05:00Z"))).toBe("202609010705");
  });
});

describe("fromN3rgyTimestamp", () => {
  it("parses compact, dashed and date-only forms to ISO UTC", () => {
    expect(fromN3rgyTimestamp("202609010030")).toBe("2026-09-01T00:30:00.000Z");
    expect(fromN3rgyTimestamp("2026-09-01 00:30")).toBe("2026-09-01T00:30:00.000Z");
    expect(fromN3rgyTimestamp("2026-09-01T00:30:00")).toBe("2026-09-01T00:30:00.000Z");
    expect(fromN3rgyTimestamp("20260901")).toBe("2026-09-01T00:00:00.000Z");
    expect(fromN3rgyTimestamp("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
  });
  it("passes unknown forms through unchanged", () => {
    expect(fromN3rgyTimestamp("yesterday")).toBe("yesterday");
  });
});

describe("chunkRange", () => {
  const d = (s: string) => new Date(s);

  it("returns a single chunk at or under the limit", () => {
    const range = { start: d("2026-06-01T00:00Z"), end: d("2026-08-29T23:59Z") };
    expect(rangeDays(range)).toBe(90);
    expect(chunkRange(range)).toEqual([range]);
  });

  it("splits ranges over 90 days without overlap or gaps", () => {
    const start = d("2026-01-01T00:00Z");
    const end = d("2026-09-01T00:00Z");
    const chunks = chunkRange({ start, end });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].start).toEqual(start);
    expect(chunks[chunks.length - 1].end).toEqual(end);
    for (const c of chunks) expect(rangeDays(c)).toBeLessThanOrEqual(91);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start.getTime() - chunks[i - 1].end.getTime()).toBe(60_000);
    }
  });

  it("rejects an inverted range", () => {
    expect(() => chunkRange({ start: d("2026-02-01"), end: d("2026-01-01") })).toThrow(RangeError);
  });
});
