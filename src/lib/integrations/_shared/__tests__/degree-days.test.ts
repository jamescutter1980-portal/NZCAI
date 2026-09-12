import { describe, expect, it } from "vitest";
import { coolingDegreeDays, dailyDegreeDays, degreeDayTotals, heatingDegreeDays, meanFromMaxMin } from "../degree-days";

describe("degree-days", () => {
  it("uses UK bases by default", () => {
    expect(heatingDegreeDays(10)).toBeCloseTo(5.5);
    expect(heatingDegreeDays(20)).toBe(0);
    expect(coolingDegreeDays(25)).toBe(3);
    expect(coolingDegreeDays(15)).toBe(0);
  });

  it("accepts a custom base", () => {
    expect(heatingDegreeDays(10, 18)).toBe(8);
    expect(coolingDegreeDays(25, 18)).toBe(7);
  });

  it("totals a series and counts missing days", () => {
    const t = degreeDayTotals([5, 15.5, null, 25, undefined, Number.NaN]);
    expect(t.hdd).toBeCloseTo(10.5);
    expect(t.cdd).toBe(3);
    expect(t.days).toBe(3);
    expect(t.missing).toBe(3);
    expect(t.meanTemperature).toBeCloseTo((5 + 15.5 + 25) / 3);
    expect(t.hddBase).toBe(15.5);
    expect(t.cddBase).toBe(22);
  });

  it("returns null mean for an empty series", () => {
    expect(degreeDayTotals([])).toMatchObject({ hdd: 0, cdd: 0, days: 0, meanTemperature: null });
  });

  it("maps per-day values and preserves gaps", () => {
    expect(dailyDegreeDays([10, null], { hddBase: 18, cddBase: 24 })).toEqual([
      { hdd: 8, cdd: 0 },
      { hdd: null, cdd: null },
    ]);
  });

  it("derives a mean from max and min", () => {
    expect(meanFromMaxMin(20, 10)).toBe(15);
    expect(meanFromMaxMin(20, null)).toBeNull();
  });
});
