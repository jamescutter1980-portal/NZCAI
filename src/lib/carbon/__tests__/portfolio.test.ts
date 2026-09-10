import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { AssetsRepository } from "@/lib/assets/repo";
import { testContext, routedFetch } from "@/lib/integrations/testing";
import { assetCarbonForPeriod, calendarYear, fiscalYear, portfolioReport } from "..";
import type { MeterReading } from "@/lib/integrations/n3rgy";

// Factor values here are synthetic (0.111 / 0.222 style) and only exercise the plumbing.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.100
3,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.010
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.200
`;
const AIB_CSV = `data_year,country_code,country,residual_mix_gco2_per_kwh,direct_co2_only,publication,publication_date,source_url
2025,GB,United Kingdom,300.0,false,SYNTHETIC TEST VALUE,2026-05-26,https://example.test
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "portfolio-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  mkdirSync(join(dir, "aib-residual-mix"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
  writeFileSync(join(dir, "aib-residual-mix", "residual-mix.csv"), AIB_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));

function reading(mpxn: string, utility: "electricity" | "gas", start: string, value: number): MeterReading {
  return {
    mpxn, utility, direction: "import", intervalStart: start, intervalEnd: start, value, unit: "kWh",
    provenance: { source: "n3rgy", dataset: "d", retrievedAt: "t", territory: "GB", licence: "consent_based", attribution: "a", basis: "measured" },
  };
}

/** One reading per day across a range, so day counts and period boundaries are exercised. */
function daily(mpxn: string, utility: "electricity" | "gas", fromIso: string, days: number, value: number): MeterReading[] {
  const start = Date.parse(fromIso);
  return Array.from({ length: days }, (_, i) => reading(mpxn, utility, new Date(start + i * 86_400_000).toISOString(), value));
}

describe("allocation shares", () => {
  it("splits a shared meter between assets and never double counts", () => {
    const db = openDatabase(":memory:");
    const assets = new AssetsRepository(db);
    new ReadingsRepository(db).upsertReadings(daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 10));
    const a = assets.create({ name: "Block A", floorAreaM2: 1000 });
    const b = assets.create({ name: "Block B", floorAreaM2: 1000 });
    assets.linkMeter(a.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.6 });
    assets.linkMeter(b.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.4 });

    const period = calendarYear(2025);
    const ca = assetCarbonForPeriod(db, ctx(), assets.meters(a.id), period);
    const cb = assetCarbonForPeriod(db, ctx(), assets.meters(b.id), period);
    expect(ca.energy[0]).toMatchObject({ meteredKwh: 3650, share: 0.6, kwh: 2190 });
    expect(cb.energy[0].kwh).toBe(1460);
    expect(ca.energy[0].kwh + cb.energy[0].kwh).toBe(3650);
    expect(ca.totals.scope2Location).toBeCloseTo(219, 3);
    expect(ca.warnings.join(" ")).toMatch(/Allocated share applied to 1000000000001 \(60%\)/);

    const alloc = assets.allocationForMeter("1000000000001", "electricity", "import");
    expect(alloc.total).toBe(1);
    expect(alloc.links).toHaveLength(2);
  });

  it("flags over-allocation and under-allocation in the portfolio report", () => {
    const db = openDatabase(":memory:");
    const assets = new AssetsRepository(db);
    new ReadingsRepository(db).upsertReadings(daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 10));
    const a = assets.create({ name: "A", floorAreaM2: 100 });
    const b = assets.create({ name: "B", floorAreaM2: 100 });
    assets.linkMeter(a.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.8 });
    assets.linkMeter(b.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.8 });
    const over = portfolioReport(db, ctx(), calendarYear(2025)).issues.filter((i) => i.kind === "over_allocated");
    expect(over.length).toBeGreaterThan(0);
    expect(over[0].detail).toMatch(/160% across 2 assets/);

    assets.linkMeter(b.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.1 });
    const under = portfolioReport(db, ctx(), calendarYear(2025)).issues.filter((i) => i.kind === "under_allocated");
    expect(under[0].detail).toMatch(/90% allocated/);
  });
});

describe("reporting periods", () => {
  it("counts only readings inside a fiscal year", () => {
    const db = openDatabase(":memory:");
    const assets = new AssetsRepository(db);
    new ReadingsRepository(db).upsertReadings([
      ...daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 1),
      ...daily("1000000000001", "electricity", "2026-01-01T00:00:00.000Z", 200, 1),
    ]);
    const a = assets.create({ name: "A" });
    assets.linkMeter(a.id, { mpxn: "1000000000001", utility: "electricity", direction: "import" });
    const meters = assets.meters(a.id);
    expect(assetCarbonForPeriod(db, ctx(), meters, calendarYear(2025)).energy[0].kwh).toBe(365);
    const fy = assetCarbonForPeriod(db, ctx(), meters, fiscalYear(2025, 4));
    expect(fy.energy[0].kwh).toBe(365 - 90 + 90);
    expect(fy.period.label).toBe("FY 2025/26 (Apr-Mar)");
    expect(fy.warnings.join(" ")).toMatch(/2025 DESNZ factor set/);
  });
});

describe("portfolioReport", () => {
  it("rolls up assets, withholds totals when a factor is missing and lists data-quality issues", () => {
    const db = openDatabase(":memory:");
    const assets = new AssetsRepository(db);
    const readings = new ReadingsRepository(db);
    readings.upsertReadings([
      ...daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 10),
      ...daily("3000000000003", "gas", "2025-01-01T00:00:00.000Z", 365, 100),
      ...daily("2000000000002", "electricity", "2025-01-01T00:00:00.000Z", 30, 5),
      ...daily("1000000000001", "electricity", "2026-01-01T00:00:00.000Z", 60, 10),
    ]);
    const full = assets.create({ name: "Full data", postcode: "SW1A1AA", latitude: 51.5, longitude: -0.14, floorAreaM2: 2000 });
    assets.linkMeter(full.id, { mpxn: "1000000000001", utility: "electricity", direction: "import" });
    assets.linkMeter(full.id, { mpxn: "3000000000003", utility: "gas", direction: "import" });
    const partial = assets.create({ name: "Partial" });
    assets.linkMeter(partial.id, { mpxn: "2000000000002", utility: "electricity", direction: "import" });
    assets.create({ name: "Empty" });

    const r = portfolioReport(db, ctx(), calendarYear(2025));
    expect(r.totals).toMatchObject({ assets: 3, assetsWithReadings: 2, meters: 3, floorAreaM2: 2000, electricityKwh: 3800, gasKwh: 36500 });
    expect(r.totals.scope1).toBeCloseTo(7300, 3);
    expect(r.totals.scope2Location).toBeCloseTo(380, 3);
    expect(r.totals.contributing.scope1).toBe(2);
    const fullRow = r.assets.find((a) => a.name === "Full data")!;
    expect(fullRow.eui).toBeCloseTo((3650 + 36500) / 2000, 3);
    expect(fullRow.intensity).toBeCloseTo((7300 + 365) / 2000, 2);
    expect(fullRow.completeness).toBe(100);
    expect(fullRow.factorsComplete).toBe(true);
    expect(r.totals.scope2Market).toBeCloseTo(3800 * 0.3, 2); // both assets’ electricity at the residual mix
    const kinds = r.issues.map((i) => i.kind);
    expect(kinds).toContain("no_meters");
    expect(kinds).toContain("no_floor_area");
    expect(kinds).toContain("no_location");
    expect(kinds).toContain("partial_period");
    expect(r.factorReferences.join(" ")).toMatch(/DESNZ 2025/);

    // Energy but no factor file for that year: totals are null with a reason, never zero.
    const noFactors = portfolioReport(db, ctx(), calendarYear(2026));
    expect(noFactors.totals.electricityKwh).toBe(600);
    expect(noFactors.totals.scope2Location).toBeNull();
    expect(noFactors.issues.some((i) => i.kind === "factors_missing")).toBe(true);

    // No energy at all is genuinely zero, which is a different thing from unavailable.
    const noEnergy = portfolioReport(db, ctx(), calendarYear(2024));
    expect(noEnergy.totals.electricityKwh).toBe(0);
    expect(noEnergy.totals.scope1).toBe(0);
    expect(noEnergy.issues.some((i) => i.kind === "no_readings")).toBe(true);
  });
});
