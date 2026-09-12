import { describe, expect, it } from "vitest";
import { dailyTotals, normaliseConsumption, readingsToCsv } from "../normalise";
import fixture from "./fixtures/consumption-electricity.json";

const result = { chunks: [fixture, fixture], partial: false, retrievedAt: "2026-09-09T12:00:00.000Z" };
const q = { mpxn: "1234567890123", utility: "electricity" as const };

describe("normaliseConsumption", () => {
  it("treats timestamps as interval ends, de-duplicates overlapping chunks and attaches provenance", () => {
    const readings = normaliseConsumption(q, result, { consentRef: "consent-1" });
    expect(readings).toHaveLength(4);
    expect(readings[0]).toMatchObject({
      intervalStart: "2026-09-01T00:00:00.000Z",
      intervalEnd: "2026-09-01T00:30:00.000Z",
      value: 0.125,
      unit: "kWh",
      direction: "import",
    });
    expect(readings[2].status).toBe("E");
    expect(readings[0].provenance).toMatchObject({
      source: "n3rgy",
      basis: "measured",
      licence: "consent_based",
      territory: "GB",
      consentRef: "consent-1",
      retrievedAt: "2026-09-09T12:00:00.000Z",
    });
  });

  it("can treat timestamps as interval starts when configured", () => {
    const readings = normaliseConsumption(q, result, { timestampIsIntervalEnd: false });
    expect(readings[0].intervalStart).toBe("2026-09-01T00:30:00.000Z");
  });
});

describe("dailyTotals", () => {
  it("sums by UTC day of interval start", () => {
    const totals = dailyTotals(normaliseConsumption(q, result));
    // 00:30, 01:00, 01:30 on 1 Sep and 00:00 on 2 Sep are interval ends,
    // so all four intervals start on 1 September.
    expect(totals).toEqual([{ date: "2026-09-01", value: 0.574, unit: "kWh", intervals: 4 }]);
  });
});

describe("readingsToCsv", () => {
  it("writes a header and one row per reading", () => {
    const csv = readingsToCsv(normaliseConsumption(q, result));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^mpxn,utility,direction,interval_start/);
    expect(lines).toHaveLength(5);
  });
});
