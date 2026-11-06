import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { AssetsRepository } from "@/lib/assets";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { assetCarbon } from "@/lib/carbon";
import { clearReferenceCache } from "@/lib/integrations/_shared/reference-data";
import { testContext, routedFetch } from "@/lib/integrations/testing";
import type { MeterReading } from "@/lib/integrations/n3rgy";
import { assessAsset, assetIntensity, crremAssessment, nzcbsAssessment } from "..";
import { writeReferenceFixtures } from "./fixtures/reference";

/**
 * Every factor, pathway value and limit used here is SYNTHETIC (0.111, 2.222,
 * 9.999 and so on), written into a temp REFERENCE_DATA_DIR by
 * ./fixtures/reference.ts. They are not real DESNZ, CRREM or UK NZCBS values
 * and prove nothing about numerical accuracy - only that the engine selects,
 * compares and reports nulls and reasons correctly. No network is used.
 *
 * With the fixture factors, an asset of 1,000 m2 metering 10,000 kWh of
 * electricity and 5,000 kWh of gas in 2026 has:
 *   Scope 1 = 5,000 x 0.222 = 1,110 kgCO2e
 *   Scope 2 location = 10,000 x 0.111 = 1,110 kgCO2e
 *   GHG intensity = 2,220 / 1,000 = 2.22 kgCO2e/m2/yr
 *   Energy intensity = 15,000 / 1,000 = 15 kWh/m2/yr
 */

const YEAR = 2026;
const ELEC = "1000000000001";
const GAS = "2000000000002";

const reading = (mpxn: string, utility: "electricity" | "gas", value: number): MeterReading => ({
  mpxn,
  utility,
  direction: "import",
  intervalStart: `${YEAR}-03-01T00:00:00.000Z`,
  intervalEnd: `${YEAR}-03-01T00:30:00.000Z`,
  value,
  unit: "kWh",
  provenance: { source: "n3rgy", dataset: "d", retrievedAt: "t", territory: "GB", licence: "consent_based", attribution: "a", basis: "measured" },
});

let dir: string;
let db: Db;
let assets: AssetsRepository;

function makeAsset(patch: Partial<AssetRecord> = {}): { asset: AssetRecord; meters: AssetMeter[] } {
  const asset = assets.create({ name: "Fixture House", floorAreaM2: 1000, propertyType: "Office", country: "GB", ...patch });
  assets.linkMeter(asset.id, { mpxn: ELEC, utility: "electricity", direction: "import", share: 1 });
  assets.linkMeter(asset.id, { mpxn: GAS, utility: "gas", direction: "import", share: 1 });
  return { asset, meters: assets.meters(asset.id) };
}

const ctxFor = (d: string) => testContext(routedFetch([]), { REFERENCE_DATA_DIR: d });

beforeEach(() => {
  clearReferenceCache();
  dir = mkdtempSync(join(tmpdir(), "assessment-"));
  writeReferenceFixtures(dir);
  db = openDatabase(":memory:");
  new ReadingsRepository(db).upsertReadings([reading(ELEC, "electricity", 10_000), reading(GAS, "gas", 5_000)]);
  assets = new AssetsRepository(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("assetIntensity", () => {
  it("gives location-based Scope 1 + 2 per m2 and energy per m2, and says so", () => {
    const { meters } = makeAsset();
    const intensity = assetIntensity(assetCarbon(db, ctxFor(dir), meters, YEAR), 1000);
    expect(intensity.ghgKgCo2ePerM2).toBeCloseTo(2.22, 6);
    expect(intensity.energyKwhPerM2).toBeCloseTo(15, 6);
    expect(intensity.scope1KgCo2e).toBeCloseTo(1110, 3);
    expect(intensity.scope2LocationKgCo2e).toBeCloseTo(1110, 3);
    expect(intensity.reasons).toEqual([]);
    expect(intensity.basis).toMatch(/Location-based Scope 1 \+ Scope 2/);
  });

  it("returns null with a reason when there is no floor area", () => {
    const { meters } = makeAsset({ floorAreaM2: undefined });
    const intensity = assetIntensity(assetCarbon(db, ctxFor(dir), meters, YEAR), undefined);
    expect(intensity.ghgKgCo2ePerM2).toBeNull();
    expect(intensity.energyKwhPerM2).toBeNull();
    expect(intensity.floorAreaM2).toBeNull();
    expect(intensity.reasons.join(" ")).toMatch(/No floor area is recorded/);
  });

  it("returns null with a reason when a factor is missing, never zero", () => {
    const { meters } = makeAsset();
    const intensity = assetIntensity(assetCarbon(db, ctxFor(join(dir, "empty")), meters, YEAR), 1000);
    expect(intensity.ghgKgCo2ePerM2).toBeNull();
    expect(intensity.reasons.join(" ")).toMatch(/emission factor is unavailable/);
    // Energy intensity needs no factor, so it still stands.
    expect(intensity.energyKwhPerM2).toBeCloseTo(15, 6);
  });
});

describe("crremAssessment", () => {
  it("finds the misalignment year for a pathway the asset crosses and accumulates the excess", () => {
    const { asset, meters } = makeAsset();
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.assessable).toBe(true);
    expect(r.assetValue).toBeCloseTo(2.22, 6);
    expect(r.unit).toBe("kgCO2e/m2");
    // 2026 3.3, 2027 2.5, 2028 2.222 all above the asset; 2029 1.111 is the first below it.
    expect(r.misalignmentYear).toBe(2029);
    expect(r.excess.map((e) => e.year)).toEqual([2029, 2030]);
    expect(r.excess[0].excessPerM2).toBeCloseTo(2.22 - 1.111, 3);
    expect(r.excess[0].excessTotal).toBeCloseTo((2.22 - 1.111) * 1000, 1);
    expect(r.cumulativeExcess?.perM2).toBeCloseTo(2.22 - 1.111 + (2.22 - 1.0), 3);
    expect(r.cumulativeExcess?.total).toBeCloseTo((2.22 - 1.111 + (2.22 - 1.0)) * 1000, 1);
    expect(r.cumulativeExcess?.totalUnit).toBe("kgCO2e");
    // The pathway ends in 2030, well before 2050, and the result says so.
    expect(r.cumulativeExcess?.toYear).toBe(2030);
    expect(r.warnings.join(" ")).toMatch(/ends in 2030/);
    // Charting series: whole pathway, asset line only from the assessment year.
    expect(r.pathway).toHaveLength(6);
    expect(r.pathway[0]).toEqual({ year: 2025, pathwayValue: 4.4, assetValue: null });
    expect(r.pathway[1]).toEqual({ year: 2026, pathwayValue: 3.3, assetValue: r.assetValue });
    expect(r.assumption).toMatch(/held constant/);
    expect(r.summary).toMatch(/Misalignment year 2029/);
  });

  it("reports alignment with no excess for a pathway the asset never crosses", () => {
    const { asset, meters } = makeAsset({ propertyType: "Warehouse" });
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.assessable).toBe(true);
    expect(r.misalignmentYear).toBeNull();
    expect(r.excess).toEqual([]);
    expect(r.cumulativeExcess).toBeNull();
    expect(r.summary).toMatch(/^Aligned:/);
  });

  it("uses the energy pathway when asked, in the file's own unit", () => {
    const { asset, meters } = makeAsset();
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR, pathwayType: "energy" });
    expect(r.unit).toBe("kWh/m2");
    expect(r.assetValue).toBeCloseTo(15, 6);
    expect(r.misalignmentYear).toBe(2027);
    expect(r.cumulativeExcess?.totalUnit).toBe("kWh");
  });

  it("cannot assess when no pathway file is loaded, and says where to put one", () => {
    const { asset, meters } = makeAsset();
    const r = crremAssessment(db, ctxFor(join(dir, "empty")), asset, meters, { year: YEAR });
    expect(r.assessable).toBe(false);
    expect(r.misalignmentYear).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/No CRREM pathway file is loaded/);
    expect(r.reasons.join(" ")).toContain("crrem-pathways");
    expect(r.provenance.version).toBeNull();
  });

  it("cannot assess an unknown property type, an unknown country or a missing version", () => {
    const { asset, meters } = makeAsset({ propertyType: "Data centre" });
    const unknownType = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(unknownType.assessable).toBe(false);
    expect(unknownType.reasons.join(" ")).toMatch(/no 1\.5C ghg pathway for GB \/ Data centre/);
    expect(unknownType.reasons.join(" ")).toMatch(/Office, Warehouse/);

    const { asset: fr, meters: frMeters } = makeAsset({ country: "FR" });
    const unknownCountry = crremAssessment(db, ctxFor(dir), fr, frMeters, { year: YEAR });
    expect(unknownCountry.assessable).toBe(false);
    expect(unknownCountry.reasons.join(" ")).toMatch(/no pathway for country FR. Countries loaded: GB/);

    const { asset: plain, meters: plainMeters } = makeAsset();
    const missingVersion = crremAssessment(db, ctxFor(dir), plain, plainMeters, { year: YEAR, version: "v0.01" });
    expect(missingVersion.assessable).toBe(false);
    expect(missingVersion.reasons.join(" ")).toMatch(/v0\.01 is not loaded \(loaded: v9\.99\)/);

    const { asset: noType, meters: noTypeMeters } = makeAsset({ propertyType: undefined });
    const noPropertyType = crremAssessment(db, ctxFor(dir), noType, noTypeMeters, { year: YEAR });
    expect(noPropertyType.assessable).toBe(false);
    expect(noPropertyType.reasons.join(" ")).toMatch(/No property type is set/);
  });

  it("cannot assess without an intensity, but still returns the pathway for charting", () => {
    const { asset, meters } = makeAsset({ floorAreaM2: undefined });
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.assessable).toBe(false);
    expect(r.assetValue).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/No floor area is recorded/);
    expect(r.pathway.length).toBe(6);
    expect(r.pathway.every((p) => p.assetValue === null)).toBe(true);
  });

  it("cannot assess a year after the end of the loaded pathway", () => {
    const { asset, meters } = makeAsset();
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: 2031 });
    expect(r.assessable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/covers 2025-2030/);
  });

  it("carries the version file name, its modification time and the DESNZ factor references", () => {
    const { asset, meters } = makeAsset();
    const r = crremAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.provenance.version).toBe("v9.99");
    expect(r.provenance.file).toBe("v9.99.csv");
    expect(r.provenance.fileModifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.provenance.factorReferences.join(" ")).toMatch(/desnz-conversion-factors: DESNZ 2026 row \d+ \(2026\.csv\)/);
  });
});

describe("nzcbsAssessment", () => {
  it("fails a metric above the limit and passes one below it", () => {
    const { asset, meters } = makeAsset();
    const office = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(office.assessable).toBe(true);
    expect(office.sector).toBe("Office");
    const eui = office.rows.find((r) => r.metric === "operational_energy_eui")!;
    expect(eui).toMatchObject({ status: "fail", limitValue: 11.11, unit: "kWh/m2/yr" });
    expect(eui.assetValue).toBeCloseTo(15, 6);
    expect(eui.gap).toBeCloseTo(15 - 11.11, 3);
    expect(office.summary).toMatch(/not a verified NZCBS assessment/);

    const { asset: retail, meters: retailMeters } = makeAsset({ propertyType: "Retail" });
    const pass = nzcbsAssessment(db, ctxFor(dir), retail, retailMeters, { year: YEAR });
    const retailEui = pass.rows.find((r) => r.metric === "operational_energy_eui")!;
    expect(retailEui.status).toBe("pass");
    expect(retailEui.gap).toBeCloseTo(15 - 55.5, 3);
    expect(pass.counts).toMatchObject({ pass: 1, fail: 0 });
  });

  it("marks metrics the portal cannot compute, and blank limits, as not assessable", () => {
    const { asset, meters } = makeAsset();
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    const embodied = r.rows.find((x) => x.metric === "embodied_upfront")!;
    expect(embodied).toMatchObject({ status: "not_assessable", assetValue: null, gap: null, limitValue: 222.2 });
    expect(embodied.reason).toMatch(/does not compute "embodied_upfront"/);
    const renewables = r.rows.find((x) => x.metric === "onsite_renewables")!;
    expect(renewables).toMatchObject({ status: "not_assessable", limitValue: null, gap: null });
    expect(renewables.reason).toMatch(/sets no limit .*not a limit of zero/);
    expect(r.counts.notAssessable).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/never as a pass/);
  });

  it("is not assessable without a limit file, an unknown sector or a year with no rows", () => {
    const { asset, meters } = makeAsset();
    const noFile = nzcbsAssessment(db, ctxFor(join(dir, "empty")), asset, meters, { year: YEAR });
    expect(noFile.assessable).toBe(false);
    expect(noFile.reasons.join(" ")).toMatch(/No UK NZCBS limit file is loaded/);
    expect(noFile.rows).toEqual([]);

    const { asset: unknown, meters: unknownMeters } = makeAsset({ propertyType: "Data centre" });
    const badSector = nzcbsAssessment(db, ctxFor(dir), unknown, unknownMeters, { year: YEAR });
    expect(badSector.assessable).toBe(false);
    expect(badSector.reasons.join(" ")).toMatch(/no sector matching "Data centre". Sectors loaded: Office, Retail/);

    const badYear = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: 2035 });
    expect(badYear.assessable).toBe(false);
    expect(badYear.reasons.join(" ")).toMatch(/none for 2035. Years in the file for this sector: 2026/);

    const badVersion = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR, version: "v0.1" });
    expect(badVersion.assessable).toBe(false);
    expect(badVersion.reasons.join(" ")).toMatch(/v0\.1 is not loaded/);
  });

  it("says why the operational metric is not assessable when the portal has no EUI", () => {
    const { asset, meters } = makeAsset({ floorAreaM2: undefined });
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.assessable).toBe(true);
    const eui = r.rows.find((x) => x.metric === "operational_energy_eui")!;
    expect(eui).toMatchObject({ status: "not_assessable", assetValue: null, gap: null });
    expect(eui.reason).toMatch(/could not compute the asset's energy use intensity/);
  });

  it("carries the limit file name and the factor references in provenance", () => {
    const { asset, meters } = makeAsset();
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.provenance).toMatchObject({ version: "v1.0", file: "v1.0.csv" });
    expect(r.provenance.factorReferences.length).toBeGreaterThan(0);
    expect(r.disclaimer).toMatch(/not a verified NZCBS assessment/);
  });
});

describe("assessAsset", () => {
  it("returns both views from one call", () => {
    const { asset, meters } = makeAsset();
    const r = assessAsset(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.crrem.misalignmentYear).toBe(2029);
    expect(r.nzcbs.sector).toBe("Office");
  });

  it("returns two unassessable views, not an error, when nothing is loaded", () => {
    const { asset, meters } = makeAsset();
    const r = assessAsset(db, ctxFor(join(dir, "empty")), asset, meters, { year: YEAR });
    expect(r.crrem.assessable).toBe(false);
    expect(r.nzcbs.assessable).toBe(false);
    expect(r.crrem.reasons.length).toBeGreaterThan(0);
    expect(r.nzcbs.reasons.length).toBeGreaterThan(0);
  });
});
