import { describe, expect, it } from "vitest";
import { findGaps, summariseGaps } from "../gaps";

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 1, h, m)).toISOString();

describe("findGaps", () => {
  it("returns nothing when every interval is present", () => {
    expect(findGaps([t(0), t(0, 30), t(1)], t(0), t(1, 30))).toEqual([]);
  });
  it("finds internal and trailing gaps with counts", () => {
    const gaps = findGaps([t(0), t(2)], t(0), t(3));
    expect(gaps).toEqual([
      { from: t(0, 30), to: t(2), missingIntervals: 3 },
      { from: t(2, 30), to: t(3), missingIntervals: 1 },
    ]);
    expect(summariseGaps(gaps)).toEqual({ count: 2, missingIntervals: 4 });
  });
});
