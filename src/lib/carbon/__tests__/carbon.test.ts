import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { testContext, routedFetch } from "@/lib/integrations/testing";
import { assetCarbon, desnzFactor, DESNZ_SELECTORS, residualMixFactor, syncGridIntensity, intensityCoverage, gridRegionKey } from "..";
import type { MeterReading } from "@/lib/integrations/n3rgy";

// All factor values in these fixtures are synthetic (1.111-style) and exist only to test plumbing.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2026
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.111
2,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2,0.101
3,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.011
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.222
5,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Net CV),kg CO2e,0.233
6,Scope 3,Hotel stay,,Elbonia,,,Room per night,kg CO2e,
`;
const AIB_CSV = `data_year,country_code,country,residual_mix_gco2_per_kwh,direct_co2_only,publication,publication_date,source_url
2024,GB,United Kingdom,333.3,false,AIB European Residual Mixes 2025 (synthetic test value),2026-05-26,https://example.test
2023,GB,United Kingdom,311.1,false,synthetic,2025-05-01,https://example.test
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "carbon-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  mkdirSync(join(dir, "aib-residual-mix"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2026.csv"), DESNZ_CSV);
  writeFileSync(join(dir, "aib-residual-mix", "residual-mix.csv"), AIB_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reading = (mpxn: string, utility: "electricity" | "gas", start: string, value: number): MeterReading => ({
  mpxn, utility, direction: "import", intervalStart: start, intervalEnd: start, value, unit: "kWh",
  provenance: { source: "n3rgy", dataset: "d", retrievedAt: "t", territory: "GB", licence: "consent_based", attribution: "a", basis: "measured" },
});

describe("factor resolution", () => {
  it("finds DESNZ rows by level text and treats blank as unavailable", () => {
    const ctx = testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir });
    expect(desnzFactor(ctx, 2026, DESNZ_SELECTORS.electricityGenerated, "elec")).toMatchObject({ value: 0.111, basis: "measured" });
    expect(desnzFactor(ctx, 2026, DESNZ_SELECTORS.naturalGasGross, "gas")).toMatchObject({ value: 0.222 });
    expect(desnzFactor(ctx, 2026, DESNZ_SELECTORS.electricityTandD, "td")).toMatchObject({ value: 0.011 });
    expect(desnzFactor(ctx, 2026, { level1: "Hotel stay", uom: "Room per night", ghgUnit: "kg CO2e" }, "hotel")).toMatchObject({ value: null, basis: "unavailable" });
    expect(desnzFactor(ctx, 2025, DESNZ_SELECTORS.electricityGenerated, "elec").basis).toBe("unavailable");
  });

  it("uses the residual mix for the year or the latest earlier year", () => {
    const ctx = testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir });
    expect(residualMixFactor(ctx, 2024).value).toBeCloseTo(0.3333, 4);
    const later = residualMixFactor(ctx, 2026);
    expect(later.value).toBeCloseTo(0.3333, 4);
    expect(later.reference).toMatch(/earlier year/);
    expect(residualMixFactor(ctx, 2020).basis).toBe("unavailable");
  });
});

describe("assetCarbon", () => {
  it("computes scope 1, location, market and T&D with provenance and null where factors are missing", () => {
    const db = openDatabase(":memory:");
    const repo = new ReadingsRepository(db);
    repo.upsertReadings([
      reading("1000000000001", "electricity", "2026-03-01T00:00:00.000Z", 100),
      reading("1000000000001", "electricity", "2026-03-01T00:30:00.000Z", 100),
      reading("2000000000002", "electricity", "2026-03-01T00:00:00.000Z", 50),
      reading("3000000000003", "gas", "2026-03-01T00:00:00.000Z", 1000),
      reading("1000000000001", "electricity", "2025-12-31T23:30:00.000Z", 999), // previous year, excluded
    ]);
    const meters = [
      { assetId: "a", mpxn: "1000000000001", utility: "electricity" as const, direction: "import" as const, createdAt: "t" },
      { assetId: "a", mpxn: "2000000000002", utility: "electricity" as const, direction: "import" as const, supplierFactorKgCo2ePerKwh: 0, supplierFactorEvidence: "PPA ref 42", createdAt: "t" },
      { assetId: "a", mpxn: "3000000000003", utility: "gas" as const, direction: "import" as const, createdAt: "t" },
    ];
    const ctx = testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir });
    const c = assetCarbon(db, ctx, meters, 2026, "SW1A");
    expect(c.totals.scope1).toBeCloseTo(222, 3);
    expect(c.totals.scope2Location).toBeCloseTo(250 * 0.111, 3);
    expect(c.scope3TandD[0].kgCo2e).toBeCloseTo(250 * 0.011, 3);
    expect(c.scope2Market).toHaveLength(2);
    expect(c.scope2Market.find((l) => l.meters?.[0] === "2000000000002")).toMatchObject({ kgCo2e: 0, factor: { basis: "client_declared" } });
    expect(c.scope2Market.find((l) => l.meters?.[0] === "1000000000001")?.kgCo2e).toBeCloseTo(200 * 0.3333, 2);
    expect(c.totals.scope2Market).toBeCloseTo(200 * 0.3333, 2);
    expect(c.timeVarying.kgCo2e).toBeNull();
    expect(c.warnings.join(" ")).toMatch(/Partial period.*1 of \d+ days/);
    expect(c.energy[0].days).toBe(1);
    const empty = assetCarbon(db, ctx, meters, 2024, "SW1A");
    expect(empty.totals.scope1).toBe(0);
    expect(empty.warnings.join(" ")).toMatch(/No readings stored for 2024/);

    const noFactors = assetCarbon(db, testContext(routedFetch([]), { REFERENCE_DATA_DIR: join(dir, "nowhere") }), meters, 2026);
    expect(noFactors.totals.scope1).toBeNull();
    expect(noFactors.totals.scope2Location).toBeNull();
    expect(noFactors.warnings.join(" ")).toMatch(/No DESNZ 2026/);
  });
});

describe("grid intensity sync", () => {
  it("stores regional half-hourly intensity and joins it to readings", async () => {
    const db = openDatabase(":memory:");
    const repo = new ReadingsRepository(db);
    repo.upsertReadings([reading("1000000000001", "electricity", "2026-03-01T00:00:00.000Z", 10), reading("1000000000001", "electricity", "2026-03-01T00:30:00.000Z", 10)]);
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain("/regional/intensity/");
      expect(url).toMatch(/postcode\/SW1A$/);
      return new Response(JSON.stringify({ data: [{ regionid: 13, dnoregion: "UKPN London", shortname: "London", postcode: "SW1A", data: [
        { from: "2026-03-01T00:00Z", to: "2026-03-01T00:30Z", intensity: { forecast: 100, index: "low" } },
        { from: "2026-03-01T00:30Z", to: "2026-03-01T01:00Z", intensity: { forecast: 300, index: "high" } },
      ] }] }), { status: 200 });
    });
    const ctx = testContext(fetch, { REFERENCE_DATA_DIR: dir });
    const r = await syncGridIntensity(db, ctx, "SW1A 1AA", "2026-03-01", "2026-03-01");
    expect(r).toEqual({ region: "SW1A", rows: 2, batches: 1 });
    expect(gridRegionKey("sw1a 1aa")).toBe("SW1A");
    expect(intensityCoverage(db, "SW1A", 2026).intervals).toBe(2);
    const c = assetCarbon(db, ctx, [{ assetId: "a", mpxn: "1000000000001", utility: "electricity", direction: "import", createdAt: "t" }], 2026, "SW1A");
    expect(c.timeVarying).toMatchObject({ kwhMatched: 20, kwhUnmatched: 0, kgCo2e: (10 * 100 + 10 * 300) / 1000 });
  });
});
