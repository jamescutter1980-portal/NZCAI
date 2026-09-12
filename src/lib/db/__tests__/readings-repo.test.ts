import { describe, expect, it } from "vitest";
import { openDatabase } from "../sqlite";
import { ReadingsRepository } from "../readings-repo";
import type { MeterReading } from "@/lib/integrations/n3rgy";

const reading = (start: string, value: number): MeterReading => ({
  mpxn: "1234567890123",
  utility: "electricity",
  direction: "import",
  intervalStart: start,
  intervalEnd: new Date(new Date(start).getTime() + 1_800_000).toISOString(),
  value,
  unit: "kWh",
  provenance: {
    source: "n3rgy", dataset: "electricity/consumption/halfhour", retrievedAt: "2026-09-09T00:00:00.000Z",
    territory: "GB", licence: "consent_based", attribution: "x", basis: "measured", consentRef: "c1",
  },
});

describe("ReadingsRepository", () => {
  it("migrates, upserts idempotently and reads back with provenance", () => {
    const db = openDatabase(":memory:");
    const repo = new ReadingsRepository(db);
    const key = { mpxn: "1234567890123", utility: "electricity" as const, direction: "import" as const };
    expect(repo.latestIntervalStart(key)).toBeUndefined();
    expect(repo.upsertReadings([reading("2026-09-01T00:00:00.000Z", 0.1), reading("2026-09-01T00:30:00.000Z", 0.2)])).toBe(2);
    repo.upsertReadings([reading("2026-09-01T00:30:00.000Z", 0.25)]);
    expect(repo.countReadings(key)).toBe(2);
    expect(repo.latestIntervalStart(key)).toBe("2026-09-01T00:30:00.000Z");
    const rows = repo.listReadings(key, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    expect(rows[1].value).toBe(0.25);
    expect(rows[0].provenance).toMatchObject({ source: "n3rgy", basis: "measured", consentRef: "c1", licence: "consent_based" });
    expect(repo.listMeters()).toEqual([{ ...key, first: "2026-09-01T00:00:00.000Z", last: "2026-09-01T00:30:00.000Z", count: 2 }]);
  });

  it("stores tariffs", () => {
    const repo = new ReadingsRepository(openDatabase(":memory:"));
    const k = { mpxn: "1", utility: "gas" as const };
    repo.upsertTariffPrices([{ ...k, intervalStart: "2026-09-01T00:00:00.000Z", pencePerKwh: 6.1, retrievedAt: "t" }]);
    repo.upsertTariffPrices([{ ...k, intervalStart: "2026-09-01T00:00:00.000Z", pencePerKwh: 6.2, retrievedAt: "t" }]);
    repo.upsertStandingCharges([{ ...k, startDate: "2026-04-01", pencePerDay: 29.6, retrievedAt: "t" }]);
    expect(repo.listTariffPrices(k, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z")[0].pencePerKwh).toBe(6.2);
    expect(repo.listStandingCharges(k)[0].pencePerDay).toBe(29.6);
  });

  it("migrations are recorded once", () => {
    const db = openDatabase(":memory:");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});
