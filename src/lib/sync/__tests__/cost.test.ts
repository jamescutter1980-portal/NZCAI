import { describe, expect, it } from "vitest";
import { estimateCost } from "../cost";
import type { MeterReading } from "@/lib/integrations/n3rgy";

const r = (start: string, value: number): MeterReading => ({
  mpxn: "1", utility: "electricity", direction: "import", intervalStart: start, intervalEnd: start, value, unit: "kWh",
  provenance: { source: "n3rgy", dataset: "d", retrievedAt: "t", territory: "GB", licence: "consent_based", attribution: "a", basis: "measured" },
});

describe("estimateCost", () => {
  it("prices matched intervals, counts unpriced ones and applies the standing charge per day", () => {
    const readings = [r("2026-09-01T00:00:00.000Z", 2), r("2026-09-01T00:30:00.000Z", 1), r("2026-09-02T00:00:00.000Z", 1)];
    const prices = [
      { mpxn: "1", utility: "electricity" as const, intervalStart: "2026-09-01T00:00:00.000Z", pencePerKwh: 25, retrievedAt: "t" },
      { mpxn: "1", utility: "electricity" as const, intervalStart: "2026-09-02T00:00:00.000Z", pencePerKwh: 10, retrievedAt: "t" },
    ];
    const charges = [
      { mpxn: "1", utility: "electricity" as const, startDate: "2026-01-01", pencePerDay: 40, retrievedAt: "t" },
      { mpxn: "1", utility: "electricity" as const, startDate: "2026-09-02", pencePerDay: 60, retrievedAt: "t" },
    ];
    expect(estimateCost(readings, prices, charges)).toEqual({
      unitCostGbp: 0.6, standingCostGbp: 1.0, totalGbp: 1.6, unpricedIntervals: 1, days: 2,
    });
  });
});
