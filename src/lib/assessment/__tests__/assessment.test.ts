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
  // The limits here are the published Rev 1 values from the bundled tables
  // (reference/uk-nzcbs/v1r1), cross-checked in src/lib/nzcbs/__tests__.
  // The asset is an Existing Building on the one-go route, so Table OE-2 for
  // 2025 applies: Offices General whole building 105 kWh/m2GIA/yr.
  it("compares the metered EUI with the Rev 1 limit for the asset's sector", () => {
    const { asset, meters } = makeAsset();
    const office = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(office.assessable).toBe(true);
    expect(office.sector).toBe("Offices");
    expect(office.subsector).toBe("General");
    expect(office.buildingType).toBe("Existing Building");
    expect(office.limitYear).toBe(2025);
    expect(office.version).toBe("v1r1");
    const eui = office.rows.find((r) => r.metric === "Energy use intensity")!;
    expect(eui).toMatchObject({ status: "pass", label: "within limit", limitValue: 105, unit: "kWh/m2GIA/yr", section: "5.2.7.1" });
    expect(eui.assetValue).toBeCloseTo(15, 6);
    expect(eui.gap).toBeCloseTo(15 - 105, 3);
    expect(office.summary).toMatch(/targeting verification to the UK Net Zero Carbon Buildings Standard/);
    expect(office.summary).not.toMatch(/aligned/i);
  });

  it("uses the Standard's carbon basis only when all four grid lines are loaded", () => {
    const { asset, meters } = makeAsset();
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    const carbon = r.rows.find((x) => x.metric === "Annual operational carbon emissions intensity")!;
    // The synthetic DESNZ fixture has no WTT rows, so the figure is withheld rather than computed on the wrong basis.
    expect(carbon.status).toBe("not_assessable");
    expect(r.warnings.join(" ")).toMatch(/four DESNZ lines/);
  });

  it("marks what the portal cannot supply as not assessable, never as a pass", () => {
    const { asset, meters } = makeAsset();
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    const renewables = r.rows.find((x) => x.metric.startsWith("Annual on-site renewable electricity generation per m2"))!;
    expect(renewables).toMatchObject({ status: "not_assessable", gap: null });
    const occupancy = r.rows.find((x) => x.metric.startsWith("Occupancy rate"))!;
    expect(occupancy.status).toBe("not_assessable");
    const refrigerants = r.rows.find((x) => x.metric.startsWith("GWP of refrigerants"))!;
    expect(refrigerants).toMatchObject({ status: "not_assessable", limitValue: 677 });
    // Apart from the classification requirements, only the EUI comparison can pass from portal data.
    expect(r.rows.filter((x) => x.status === "pass" && x.aspect !== "Classification and reporting periods").map((x) => x.metric)).toEqual(["Energy use intensity"]);
    expect(r.counts.notAssessable).toBeGreaterThan(3);
  });

  it("explains an unmappable property type, an unknown version, and an asset with no floor area", () => {
    const { asset: unknown, meters: unknownMeters } = makeAsset({ propertyType: "Zeppelin hangar" });
    const badSector = nzcbsAssessment(db, ctxFor(dir), unknown, unknownMeters, { year: YEAR });
    expect(badSector.assessable).toBe(false);
    expect(badSector.reasons.join(" ")).toMatch(/not a Table 6 sector/);

    const { asset, meters } = makeAsset();
    const badVersion = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR, version: "v0.1" });
    expect(badVersion.assessable).toBe(false);
    expect(badVersion.reasons.join(" ")).toMatch(/v0\.1 is not loaded/);

    const { asset: noArea, meters: noAreaMeters } = makeAsset({ floorAreaM2: undefined });
    const r = nzcbsAssessment(db, ctxFor(dir), noArea, noAreaMeters, { year: YEAR });
    expect(r.assessable).toBe(true);
    const eui = r.rows.find((x) => x.metric === "Energy use intensity")!;
    expect(eui).toMatchObject({ status: "not_assessable", assetValue: null, gap: null, limitValue: 105 });
  });

  it("accepts an explicit sector, subsector and scope", () => {
    const { asset, meters } = makeAsset({ propertyType: "Mixed" });
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR, sector: "Retail / Supermarket" });
    expect(r.sector).toBe("Retail");
    expect(r.rows.find((x) => x.metric === "Energy use intensity")!.limitValue).toBe(230);
  });

  it("carries the reference version and the factor references in provenance", () => {
    const { asset, meters } = makeAsset();
    const r = nzcbsAssessment(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.provenance.version).toBe("v1r1");
    expect(r.provenance.file).toMatch(/limits\.csv$/);
    expect(r.provenance.factorReferences.length).toBeGreaterThan(0);
    expect(r.disclaimer).toMatch(/not a verified claim/i);
    expect(r.assessment?.aspects.length).toBe(11);
  });
});

describe("assessAsset", () => {
  it("returns both views from one call", () => {
    const { asset, meters } = makeAsset();
    const r = assessAsset(db, ctxFor(dir), asset, meters, { year: YEAR });
    expect(r.crrem.misalignmentYear).toBe(2029);
    expect(r.nzcbs.sector).toBe("Offices");
  });

  it("returns two unassessable views, not an error, when nothing is loaded", () => {
    const { asset, meters } = makeAsset();
    const r = assessAsset(db, ctxFor(join(dir, "empty")), asset, meters, { year: YEAR });
    expect(r.crrem.assessable).toBe(false);
    expect(r.crrem.reasons.length).toBeGreaterThan(0);
    // The NZCBS tables are bundled, so that view still runs; without DESNZ factors its carbon rows are withheld.
    expect(r.nzcbs.assessable).toBe(true);
    expect(r.nzcbs.rows.find((x) => x.metric === "Annual operational carbon emissions intensity")!.status).toBe("not_assessable");
  });
});
