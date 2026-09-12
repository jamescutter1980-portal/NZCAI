import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { AssetsRepository } from "@/lib/assets/repo";
import type { AssetRecord } from "@/lib/assets/types";
import { testContext, routedFetch } from "@/lib/integrations/testing";
import type { OperationContext } from "@/lib/integrations/framework";
import type { MeterReading } from "@/lib/integrations/n3rgy";
import type { ConsentRecord } from "@/lib/consent/types";
import {
  buildAssetCarbonExport,
  buildConsentsExport,
  buildPortfolioCarbonExport,
  buildPortfolioEnergyExport,
  buildReadingsExport,
  buildSecrSummaryExport,
  exportHeaders,
  toCsv,
  type ExportTable,
} from "..";

/**
 * Every factor value below is SYNTHETIC (0.111 / 0.222 / 0.011 / 333.3) and
 * exists only to prove the plumbing. None of it is a real DESNZ or AIB figure.
 */
const desnzCsv = (year: number) => `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor ${year}
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.111
2,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.011
3,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.222
`;
const AIB_CSV = `data_year,country_code,country,residual_mix_gco2_per_kwh,direct_co2_only,publication,publication_date,source_url
2024,GB,United Kingdom,333.3,false,Synthetic residual mix for tests,2025-05-26,https://example.test
`;

const YEAR = 2025;
const DAYS_IN_YEAR = 365;

let dir: string;
let emptyDir: string;
let db: Db;
let ctx: OperationContext;
let ctxNoFactors: OperationContext;
let assets: Record<"alpha" | "beta" | "gamma", AssetRecord>;

const reading = (
  mpxn: string,
  utility: "electricity" | "gas",
  direction: "import" | "export",
  start: string,
  value: number,
  extra: Partial<MeterReading> = {},
): MeterReading => ({
  mpxn,
  utility,
  direction,
  intervalStart: start,
  intervalEnd: new Date(Date.parse(start) + 1_800_000).toISOString(),
  value,
  unit: "kWh",
  provenance: {
    source: "n3rgy", dataset: `${utility}/consumption/halfhour`, retrievedAt: "2026-01-02T03:04:05.000Z",
    territory: "GB", licence: "consent_based", attribution: "a", basis: "measured", consentRef: "consent-1",
  },
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-ref-"));
  emptyDir = mkdtempSync(join(tmpdir(), "export-noref-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  mkdirSync(join(dir, "aib-residual-mix"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", `${YEAR}.csv`), desnzCsv(YEAR));
  writeFileSync(join(dir, "aib-residual-mix", "residual-mix.csv"), AIB_CSV);
  ctx = testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir });
  ctxNoFactors = testContext(routedFetch([]), { REFERENCE_DATA_DIR: emptyDir });

  db = openDatabase(":memory:");
  const repo = new AssetsRepository(db);
  assets = {
    // A name with a comma and quotes, so the CSV writer is exercised end to end.
    alpha: repo.create({ name: 'Alpha House, "Old" Mill', uprn: "100023336956", postcode: "SW1A1AA", floorAreaM2: 1000 }),
    beta: repo.create({ name: "Beta Depot", postcode: "M11AE" }),
    gamma: repo.create({ name: "Gamma Site (no meters)", floorAreaM2: 500 }),
  };
  repo.linkMeter(assets.alpha.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 1 });
  repo.linkMeter(assets.alpha.id, { mpxn: "3000000000003", utility: "gas", direction: "import", share: 1 });
  repo.linkMeter(assets.beta.id, {
    mpxn: "2000000000002", utility: "electricity", direction: "import", share: 1,
    supplierFactorKgCo2ePerKwh: 0.05, supplierFactorEvidence: "PPA-42",
  });
  repo.linkMeter(assets.beta.id, { mpxn: "2000000000002", utility: "electricity", direction: "export", share: 1 });

  new ReadingsRepository(db).upsertReadings([
    reading("1000000000001", "electricity", "import", `${YEAR}-03-01T00:00:00.000Z`, 100),
    reading("1000000000001", "electricity", "import", `${YEAR}-03-01T00:30:00.000Z`, 100, { status: "estimated" }),
    reading("1000000000001", "electricity", "import", `${YEAR}-03-02T00:00:00.000Z`, 50),
    reading("3000000000003", "gas", "import", `${YEAR}-03-01T00:00:00.000Z`, 1000),
    reading("2000000000002", "electricity", "import", `${YEAR}-06-01T00:00:00.000Z`, 200),
    reading("2000000000002", "electricity", "export", `${YEAR}-06-01T00:00:00.000Z`, 30),
    // Outside the reporting year; must never appear in a YEAR export.
    reading("1000000000001", "electricity", "import", `${YEAR - 1}-12-31T23:30:00.000Z`, 999),
  ]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

/** Reads a table back as a map per row, the way a spreadsheet user sees it. */
function records(t: ExportTable): Record<string, string>[] {
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, String(row[i] ?? "")])));
}
const byAsset = (t: ExportTable, name: string) => records(t).filter((r) => r.asset.startsWith(name));

describe("buildReadingsExport", () => {
  it("exports one row per interval with provenance and the consent reference", () => {
    const t = buildReadingsExport(db, {
      mpxn: "1000000000001", utility: "electricity", direction: "import", start: `${YEAR}-03-01`, end: `${YEAR}-03-02`,
    });
    expect(t.columns).toContain("consent_ref");
    expect(t.rows).toHaveLength(3);
    expect(t.truncated).toBe(false);
    const first = records(t)[0];
    expect(first).toMatchObject({
      mpxn: "1000000000001", utility: "electricity", direction: "import",
      interval_start: `${YEAR}-03-01T00:00:00.000Z`, value: "100", unit: "kWh",
      source: "n3rgy", basis: "measured", consent_ref: "consent-1",
    });
    expect(records(t)[1].status).toBe("estimated");
    expect(t.filename).toBe(`readings-1000000000001-electricity-import-${YEAR}-03-01-to-${YEAR}-03-02.csv`);
  });

  it("excludes readings outside the range and returns a header-only file when there are none", () => {
    const t = buildReadingsExport(db, {
      mpxn: "1000000000001", utility: "electricity", direction: "import", start: `${YEAR}-01-01`, end: `${YEAR}-01-31`,
    });
    expect(t.rows).toHaveLength(0);
    expect(toCsv(t.columns, t.rows)).toBe(`${t.columns.join(",")}\r\n`);
  });

  it("caps rows at the limit and flags the truncation", () => {
    const t = buildReadingsExport(
      db,
      { mpxn: "1000000000001", utility: "electricity", direction: "import", start: `${YEAR}-03-01`, end: `${YEAR}-03-02` },
      2,
    );
    expect(t.rows).toHaveLength(2);
    expect(t.totalRows).toBe(3);
    expect(t.truncated).toBe(true);
    expect(exportHeaders(t)).toMatchObject({ "x-export-truncated": "true", "x-export-row-limit": "2", "x-export-total-rows": "3" });
    expect(exportHeaders(buildReadingsExport(db, {
      mpxn: "1000000000001", utility: "electricity", direction: "import", start: `${YEAR}-03-01`, end: `${YEAR}-03-02`,
    }))["x-export-truncated"]).toBeUndefined();
  });
});

describe("buildAssetCarbonExport", () => {
  it("writes one row per carbon line with the factor that produced it", () => {
    const t = buildAssetCarbonExport(db, ctx, assets.alpha.id, YEAR)!;
    const rows = records(t);
    const scope1 = rows.find((r) => r.scope === "Scope 1")!;
    expect(scope1).toMatchObject({
      asset: 'Alpha House, "Old" Mill', year: String(YEAR), kwh: "1000",
      factor_value: "0.222", factor_unit: "kg CO2e/kWh (Gross CV)", factor_basis: "measured",
      factor_source: "desnz-conversion-factors", kgco2e: "222", unavailable_reason: "",
    });
    expect(scope1.factor_reference).toMatch(new RegExp(`DESNZ ${YEAR} row 3`));
    expect(rows.find((r) => r.scope === "Scope 2 (location-based)")).toMatchObject({ kwh: "250", kgco2e: "27.75" });
    expect(rows.find((r) => r.scope === "Scope 3 category 3 (T&D)")).toMatchObject({ kgco2e: "2.75" });
    // The market-based line falls back to the residual mix: 250 kWh x 0.3333.
    expect(rows.find((r) => r.scope === "Scope 2 (market-based)")).toMatchObject({ factor_source: "aib-residual-mix", kgco2e: "83.325" });
  });

  it("uses the supplier factor where contractual evidence is held", () => {
    const rows = records(buildAssetCarbonExport(db, ctx, assets.beta.id, YEAR)!);
    const market = rows.find((r) => r.scope === "Scope 2 (market-based)")!;
    expect(market).toMatchObject({ factor_source: "asset_meters", factor_basis: "client_declared", kgco2e: "10" });
    expect(market.factor_reference).toContain("PPA-42");
  });

  it("leaves kgCO2e blank and states the reason when the factor set is not loaded", () => {
    const t = buildAssetCarbonExport(db, ctxNoFactors, assets.alpha.id, YEAR)!;
    const rows = records(t);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows.filter((x) => x.factor_source === "desnz-conversion-factors")) {
      expect(r.kgco2e).toBe("");
      expect(r.factor_value).toBe("");
      expect(r.factor_basis).toBe("unavailable");
      expect(r.unavailable_reason).toMatch(new RegExp(`No DESNZ ${YEAR} flat file loaded`));
    }
    // Never 0 and never invented.
    expect(toCsv(t.columns, t.rows)).not.toMatch(/,0\r\n/);
  });

  it("returns undefined for an unknown asset, so the route can answer 404", () => {
    expect(buildAssetCarbonExport(db, ctx, "no-such-asset", YEAR)).toBeUndefined();
  });
});

describe("buildPortfolioEnergyExport", () => {
  it("reports energy, EUI and day coverage per asset", () => {
    const t = buildPortfolioEnergyExport(db, ctx, YEAR);
    expect(t.rows).toHaveLength(3);
    const alpha = byAsset(t, "Alpha")[0];
    expect(alpha).toMatchObject({
      uprn: "100023336956", postcode: "SW1A 1AA", floor_area_m2: "1000",
      electricity_import_kwh: "250", gas_kwh: "1000", export_kwh: "0",
      eui_kwh_per_m2: "1.25", intervals: "4", days_with_data: "2", meter_count: "2",
      days_expected: String(DAYS_IN_YEAR),
      first_reading: `${YEAR}-03-01T00:00:00.000Z`, last_reading: `${YEAR}-03-02T00:00:00.000Z`,
    });
    expect(Number(alpha.data_completeness_pct)).toBeCloseTo((2 / DAYS_IN_YEAR) * 100, 3);
    const beta = byAsset(t, "Beta")[0];
    expect(beta).toMatchObject({ electricity_import_kwh: "200", gas_kwh: "0", export_kwh: "30", floor_area_m2: "", eui_kwh_per_m2: "" });
  });

  it("blanks energy for an asset with no readings rather than reporting zero", () => {
    const gamma = byAsset(buildPortfolioEnergyExport(db, ctx, YEAR), "Gamma")[0];
    expect(gamma).toMatchObject({
      electricity_import_kwh: "", gas_kwh: "", export_kwh: "", eui_kwh_per_m2: "",
      intervals: "0", days_with_data: "0", data_completeness_pct: "0", meter_count: "0",
    });
  });
});

describe("buildPortfolioCarbonExport", () => {
  it("totals each scope, derives intensity and confirms the factors are complete", () => {
    const t = buildPortfolioCarbonExport(db, ctx, YEAR);
    expect(byAsset(t, "Alpha")[0]).toMatchObject({
      scope1_kgco2e: "222", scope2_location_kgco2e: "27.75", scope2_market_kgco2e: "83.325", scope3_td_kgco2e: "2.75",
      total_scope1_scope2_location_kgco2e: "249.75", intensity_kgco2e_per_m2: "0.25",
      factors_complete: "yes", unavailable_reasons: "",
    });
    // No floor area on Beta, so no intensity; the emissions still stand.
    expect(byAsset(t, "Beta")[0]).toMatchObject({ scope2_location_kgco2e: "22.2", intensity_kgco2e_per_m2: "", factors_complete: "yes" });
  });

  it("blanks every total when the factors are missing and says why", () => {
    const alpha = byAsset(buildPortfolioCarbonExport(db, ctxNoFactors, YEAR), "Alpha")[0];
    expect(alpha).toMatchObject({
      scope1_kgco2e: "", scope2_location_kgco2e: "", scope3_td_kgco2e: "",
      total_scope1_scope2_location_kgco2e: "", intensity_kgco2e_per_m2: "", factors_complete: "no",
    });
    expect(alpha.unavailable_reasons).toMatch(new RegExp(`No DESNZ ${YEAR} flat file loaded`));
  });

  it("blanks an asset with nothing metered rather than claiming zero emissions", () => {
    const gamma = byAsset(buildPortfolioCarbonExport(db, ctx, YEAR), "Gamma")[0];
    expect(gamma).toMatchObject({ scope1_kgco2e: "", scope2_location_kgco2e: "", scope2_market_kgco2e: "", factors_complete: "no" });
    expect(gamma.unavailable_reasons).toMatch(/No metered energy/);
  });
});

describe("buildSecrSummaryExport", () => {
  const find = (t: ExportTable, item: string) => records(t).find((r) => r.item === item)!;

  it("summarises energy, emissions and intensity for the whole portfolio", () => {
    const t = buildSecrSummaryExport(db, ctx, YEAR);
    expect(find(t, "Electricity purchased")).toMatchObject({ value: "450", unit: "kWh" });
    expect(find(t, "Natural gas")).toMatchObject({ value: "1000", unit: "kWh" });
    expect(find(t, "Total energy (electricity and gas only)").value).toBe("1450");
    expect(find(t, "Electricity exported (memo)").value).toBe("30");
    expect(find(t, "Scope 1 (natural gas combustion)").value).toBe("222");
    expect(find(t, "Scope 2 location-based").value).toBe("49.95");
    expect(find(t, "Scope 2 market-based").value).toBe("93.325");
    expect(find(t, "Scope 3 category 3 (transmission and distribution)").value).toBe("4.95");
    expect(find(t, "Total gross (Scope 1 + Scope 2 location-based)").value).toBe("271.95");
    // Alpha (1000 m2) and Gamma (500 m2) have a floor area, so the ratio is 271.95 / 1500.
    const intensity = find(t, "Scope 1 + Scope 2 location-based per m2");
    expect(intensity).toMatchObject({ value: "0.181", unit: "kgCO2e/m2" });
    expect(intensity.note).toMatch(/Over 1500 m2 across 2 of 3 assets \(1 with metered data\)/);
    expect(find(t, "Assets included").value).toBe("3");
    expect(find(t, "Meters included").value).toBe("4");
  });

  it("reports transport as absent in a note rather than inventing a number", () => {
    const transport = find(buildSecrSummaryExport(db, ctx, YEAR), "Transport fuel");
    expect(transport.value).toBe("");
    expect(transport.basis).toBe("unavailable");
    expect(transport.note).toMatch(/NOT CAPTURED/);
    expect(transport.note).toMatch(/rather than reported as zero/);
  });

  it("names the factor set and residual mix actually used", () => {
    const t = buildSecrSummaryExport(db, ctx, YEAR);
    expect(find(t, "DESNZ factor set used").value).toMatch(new RegExp(`DESNZ ${YEAR} row .*${YEAR}\\.csv`));
    expect(find(t, "DESNZ factor: UK electricity generated").value).toBe("0.111");
    const aib = find(t, "AIB residual mix used for market-based Scope 2");
    expect(aib.value).toMatch(/AIB residual mix GB data year 2024/);
    expect(aib.value).toMatch(/latest earlier year used/);
    expect(find(t, "Supplier-specific factors used").value).toBe("1");
  });

  it("carries the exclusions and the do-not-file warning", () => {
    const rows = records(buildSecrSummaryExport(db, ctx, YEAR));
    const exclusions = rows.filter((r) => r.section.startsWith("Exclusions"));
    expect(exclusions.length).toBeGreaterThanOrEqual(7);
    expect(exclusions.map((r) => r.item)).toContain("Transport energy and emissions");
    expect(exclusions.map((r) => r.item)).toContain("Business travel (Scope 3 category 6)");
    expect(exclusions.map((r) => r.item)).toContain("Other Scope 3 categories");
    expect(rows.find((r) => r.item === "Readiness for disclosure")!.note).toMatch(/NOT A COMPLETE SECR DISCLOSURE/);
  });

  it("blanks every emission figure but keeps the energy when no factor file is loaded", () => {
    const t = buildSecrSummaryExport(db, ctxNoFactors, YEAR);
    expect(find(t, "Electricity purchased").value).toBe("450");
    for (const item of ["Scope 1 (natural gas combustion)", "Scope 2 location-based", "Scope 3 category 3 (transmission and distribution)", "Total gross (Scope 1 + Scope 2 location-based)"]) {
      expect(find(t, item)).toMatchObject({ value: "", basis: "unavailable" });
      expect(find(t, item).note).toMatch(/at least one required factor is unavailable/);
    }
    expect(find(t, "Scope 1 + Scope 2 location-based per m2").value).toBe("");
    expect(find(t, "DESNZ factor set used")).toMatchObject({ value: "", basis: "unavailable" });
    expect(find(t, "DESNZ factor set used").note).toMatch(new RegExp(`No DESNZ conversion factor file is loaded for ${YEAR}`));
  });

  it("stays a single flat table with one header row", () => {
    const t = buildSecrSummaryExport(db, ctx, YEAR);
    const csv = toCsv(t.columns, t.rows, { bom: true });
    expect(csv.split("\r\n")[0]).toBe(`﻿${t.columns.join(",")}`);
    for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
  });
});

describe("buildConsentsExport", () => {
  const consent = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
    id: "c1", mpxn: "1000000000001", utilities: ["electricity", "gas"], occupierName: "Tenant Ltd",
    occupierOrganisation: "Tenant Ltd", method: "letter_of_authority", evidenceRef: "LOA-7",
    grantedOn: "2026-01-01", expiresOn: "2026-12-31", status: "active",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
  });

  it("writes the effective status and the last verification", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    const t = buildConsentsExport(
      [
        consent({ lastVerifiedAt: "2026-05-01T00:00:00.000Z", lastVerificationResult: "granted", lastVerificationDetail: "n3rgy returned data" }),
        consent({ id: "c2", mpxn: "2000000000002", expiresOn: "2026-03-31", utilities: ["electricity"] }),
        consent({ id: "c3", mpxn: "3000000000003", status: "withdrawn", withdrawnAt: "2026-04-01T00:00:00.000Z", withdrawnReason: "Tenant left" }),
      ],
      at,
    );
    const rows = records(t);
    expect(rows[0]).toMatchObject({
      mpxn: "1000000000001", utilities: "electricity gas", occupier_name: "Tenant Ltd",
      method: "letter_of_authority", evidence_ref: "LOA-7", granted_on: "2026-01-01", expires_on: "2026-12-31",
      stored_status: "active", effective_status: "active",
      last_verified_at: "2026-05-01T00:00:00.000Z", last_verification_result: "granted",
    });
    expect(rows[1].effective_status).toBe("expired");
    expect(rows[2]).toMatchObject({ effective_status: "withdrawn", withdrawn_reason: "Tenant left" });
    expect(Number(rows[0].days_to_expiry)).toBeGreaterThan(0);
    expect(t.filename).toBe("consents-2026-06-01.csv");
  });

  it("writes a header-only file when there are no consents", () => {
    const t = buildConsentsExport([], new Date("2026-06-01T00:00:00Z"));
    expect(t.rows).toHaveLength(0);
    expect(toCsv(t.columns, t.rows).trimEnd()).toBe(t.columns.join(","));
  });
});
