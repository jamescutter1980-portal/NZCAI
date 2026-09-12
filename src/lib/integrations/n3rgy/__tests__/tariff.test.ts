import { describe, expect, it } from "vitest";
import { normaliseTariff } from "../tariff";

describe("normaliseTariff", () => {
  it("flattens prices to interval starts and standing charges to dates", () => {
    const raw = {
      resource: "/1/electricity/tariff/1",
      responseTimestamp: "x",
      start: "202609010000",
      end: "202609012359",
      values: [
        {
          standingCharges: [{ startDate: "2026-04-01", value: 45.2 }],
          prices: [
            { timestamp: "2026-09-01 00:30", value: 24.5 },
            { timestamp: "2026-09-01 01:00", value: 24.5 },
          ],
        },
      ],
    };
    const t = normaliseTariff({ chunks: [raw, raw], partial: false, retrievedAt: "r" });
    expect(t.prices).toEqual([
      { intervalStart: "2026-09-01T00:00:00.000Z", pencePerKwh: 24.5 },
      { intervalStart: "2026-09-01T00:30:00.000Z", pencePerKwh: 24.5 },
    ]);
    expect(t.standingCharges).toEqual([{ startDate: "2026-04-01", pencePerDay: 45.2 }]);
  });
});
