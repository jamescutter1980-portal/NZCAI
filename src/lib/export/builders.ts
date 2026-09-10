import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { AssetsRepository } from "@/lib/assets/repo";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { formatPostcode } from "@/lib/assets/types";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { assetCarbon, type AssetCarbon, type CarbonLine } from "@/lib/carbon/scope";
import { desnzFactor, DESNZ_SELECTORS, type ResolvedFactor } from "@/lib/carbon/factors";
import { calendarYear, elapsedDays, type Period } from "@/lib/carbon/period";
import { gridRegionKey } from "@/lib/carbon/intensity-sync";
import { toView, type ConsentRecord } from "@/lib/consent/types";
import type { CsvValue } from "./csv";
import { safeFilename } from "./csv";
import { transportCarbon } from "@/lib/transport";
import { emissionsCarbon } from "@/lib/emissions";
import { STATE_LABELS, TIER_LABELS, valueChainReport } from "@/lib/value-chain";

/**
 * Export builders.
 *
 * Each builder returns a single flat table: one header row, then data rows.
 * There is no preamble block, so the file opens in Excel and pivots cleanly;
 * provenance travels in columns instead.
 *
 * Two rules run through all of them, and they are the reason this layer
 * exists rather than callers formatting numbers themselves:
 *
 * 1. An unavailable emission factor produces an empty cell and a stated
 *    reason. It never produces 0 and never produces an assumed number. DESNZ
 *    republished the 2026 flat file precisely because unavailable factors had
 *    been rendered as 0, and a 0 in a disclosure is a false statement.
 * 2. Dates are ISO 8601 UTC and numbers are unformatted.
 */

export const EXPORT_KINDS = ["readings", "asset-carbon", "portfolio-energy", "portfolio-carbon", "secr-summary", "consents", "value-chain"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

/** Interval readings can run to millions of rows; everything else is small. */
export const READINGS_ROW_LIMIT = 200_000;
export const DEFAULT_ROW_LIMIT = 50_000;

export interface ExportTable {
  kind: ExportKind;
  /** Suggested download filename, already sanitised. */
  filename: string;
  columns: string[];
  rows: CsvValue[][];
  /** True when rows were dropped because rowLimit was reached. */
  truncated: boolean;
  rowLimit: number;
  /** Rows available before the cap, when that is known. */
  totalRows: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const nn = (n: number | null | undefined): CsvValue => (n === null || n === undefined || !Number.isFinite(n) ? "" : n);
const yesNo = (b: boolean) => (b ? "yes" : "no");

function table(kind: ExportKind, filenameStem: string, columns: string[], rows: CsvValue[][], rowLimit: number): ExportTable {
  const truncated = rows.length > rowLimit;
  return {
    kind,
    filename: safeFilename(filenameStem),
    columns,
    rows: truncated ? rows.slice(0, rowLimit) : rows,
    truncated,
    rowLimit,
    totalRows: rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* 1. readings                                                         */
/* ------------------------------------------------------------------ */

export const readingsParamsSchema = z.object({
  mpxn: z.string().trim().regex(/^\d{6,13}$/, "MPxN must be 6 to 13 digits"),
  utility: z.enum(["electricity", "gas"]),
  direction: z.enum(["import", "export"]).default("import"),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
});
export type ReadingsExportParams = z.infer<typeof readingsParamsSchema>;

export const READINGS_COLUMNS = [
  "mpxn", "utility", "direction", "interval_start", "interval_end", "value", "unit", "status",
  "source", "basis", "retrieved_at", "consent_ref",
];

/**
 * Interval readings for one meter over whole UTC days, `start` to `end`
 * inclusive. Columns follow readingsToCsv, plus the consent reference that
 * authorised the retrieval, which an ESOS or SECR evidence pack needs.
 */
export function buildReadingsExport(db: Db, params: ReadingsExportParams, rowLimit = READINGS_ROW_LIMIT): ExportTable {
  const from = `${params.start}T00:00:00.000Z`;
  const to = new Date(Date.parse(`${params.end}T00:00:00.000Z`) + 86_400_000).toISOString();
  const readings = new ReadingsRepository(db).listReadings(
    { mpxn: params.mpxn, utility: params.utility, direction: params.direction },
    from,
    to,
  );
  const rows: CsvValue[][] = readings.map((r) => [
    r.mpxn, r.utility, r.direction, r.intervalStart, r.intervalEnd, r.value, r.unit, r.status ?? "",
    r.provenance.source, r.provenance.basis, r.provenance.retrievedAt, r.provenance.consentRef ?? "",
  ]);
  return table(
    "readings",
    `readings-${params.mpxn}-${params.utility}-${params.direction}-${params.start}-to-${params.end}`,
    READINGS_COLUMNS,
    rows,
    rowLimit,
  );
}

/* ------------------------------------------------------------------ */
/* 2. asset-carbon                                                     */
/* ------------------------------------------------------------------ */

export const ASSET_CARBON_COLUMNS = [
  "asset", "asset_id", "year", "scope", "line", "meters", "kwh",
  "factor_value", "factor_unit", "factor_basis", "factor_source", "factor_reference",
  "kgco2e", "unavailable_reason",
];

const SCOPE_GROUPS: { scope: string; pick: (c: AssetCarbon) => CarbonLine[] }[] = [
  { scope: "Scope 1", pick: (c) => c.scope1 },
  { scope: "Scope 2 (location-based)", pick: (c) => c.scope2Location },
  { scope: "Scope 2 (market-based)", pick: (c) => c.scope2Market },
  { scope: "Scope 3 category 3 (T&D)", pick: (c) => c.scope3TandD },
];

function unavailableReason(f: ResolvedFactor): string {
  if (f.value !== null) return "";
  return f.detail ?? `No ${f.source} factor available for ${f.reference}.`;
}

/**
 * One row per carbon line for one asset and calendar year. Returns undefined
 * when the asset does not exist, so the route can answer 404.
 */
export function buildAssetCarbonExport(db: Db, ctx: OperationContext, assetId: string, year: number): ExportTable | undefined {
  const repo = new AssetsRepository(db);
  const asset = repo.get(assetId);
  if (!asset) return undefined;
  const carbon = carbonFor(db, ctx, repo.meters(assetId), asset, year);
  const rows: CsvValue[][] = [];
  for (const group of SCOPE_GROUPS) {
    for (const line of group.pick(carbon)) {
      rows.push([
        asset.name, asset.id, year, group.scope, line.label, (line.meters ?? []).join(" "), nn(line.kwh),
        nn(line.factor.value), line.factor.unit, line.factor.basis, line.factor.source, line.factor.reference,
        nn(line.kgCo2e), unavailableReason(line.factor),
      ]);
    }
  }
  return table("asset-carbon", `asset-carbon-${asset.name}-${year}`, ASSET_CARBON_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}

function carbonFor(db: Db, ctx: OperationContext, meters: AssetMeter[], asset: AssetRecord, year: number): AssetCarbon {
  const region = asset.postcode ? gridRegionKey(asset.postcode) : undefined;
  return assetCarbon(db, ctx, meters, year, region);
}

/* ------------------------------------------------------------------ */
/* Shared portfolio roll-up                                            */
/* ------------------------------------------------------------------ */

interface AssetRollup {
  asset: AssetRecord;
  meters: AssetMeter[];
  carbon: AssetCarbon;
  /** Allocated kWh by stream. */
  electricityImportKwh: number;
  gasKwh: number;
  exportKwh: number;
  /** Coverage across every linked meter, so a shared day counts once. */
  intervals: number;
  daysWithData: number;
  firstReading?: string;
  lastReading?: string;
  /** Sum of Scope 1 and Scope 2 location-based; null when a factor is missing. */
  totalLocation: number | null;
  /** False when no emission factor was applied to at least one line, or when nothing was calculated at all. */
  factorsComplete: boolean;
  factorIssues: string[];
  /** True when at least one carbon line was produced for this asset. */
  calculated: boolean;
}

interface PortfolioRollup {
  year: number;
  period: Period;
  expectedDays: number;
  assets: AssetRollup[];
}

function coverage(db: Db, meters: AssetMeter[], period: Period) {
  if (meters.length === 0) return { intervals: 0, daysWithData: 0, firstReading: undefined, lastReading: undefined };
  const where = meters.map(() => "(mpxn = ? AND utility = ? AND direction = ?)").join(" OR ");
  const args: string[] = [];
  for (const m of meters) args.push(m.mpxn, m.utility, m.direction);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT substr(interval_start, 1, 10)) AS days, MIN(interval_start) AS first, MAX(interval_start) AS last
       FROM meter_readings WHERE (${where}) AND interval_start >= ? AND interval_start < ?`,
    )
    .get(...args, period.from, period.to) as { n: number; days: number; first: string | null; last: string | null };
  return { intervals: row.n, daysWithData: row.days, firstReading: row.first ?? undefined, lastReading: row.last ?? undefined };
}

function allLines(c: AssetCarbon): CarbonLine[] {
  return [...c.scope1, ...c.scope2Location, ...c.scope2Market, ...c.scope3TandD];
}

/** Sums a set of figures, but returns null if any one of them is unavailable. */
function sumOrNull(values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  return r3(values.reduce<number>((n, v) => n + (v ?? 0), 0));
}

/** Every asset, once, with its energy, carbon and coverage for the year. */
export function portfolioRollup(db: Db, ctx: OperationContext, year: number): PortfolioRollup {
  const repo = new AssetsRepository(db);
  const period = calendarYear(year);
  const expectedDays = Math.max(1, Math.min(period.days, elapsedDays(period, ctx.now())));
  const assets = repo.list().map((asset): AssetRollup => {
    const meters = repo.meters(asset.id);
    const carbon = carbonFor(db, ctx, meters, asset, year);
    const stream = (utility: "electricity" | "gas", direction: "import" | "export") =>
      r3(carbon.energy.filter((e) => e.utility === utility && e.direction === direction).reduce((n, e) => n + e.kwh, 0));
    const lines = allLines(carbon);
    const factorIssues = lines.length
      ? [...new Set(lines.filter((l) => l.factor.value === null).map((l) => unavailableReason(l.factor)))]
      : ["No metered energy for this asset in this period, so no emissions were calculated."];
    return {
      asset,
      meters,
      carbon,
      electricityImportKwh: stream("electricity", "import"),
      gasKwh: stream("gas", "import"),
      exportKwh: r3(carbon.energy.filter((e) => e.direction === "export").reduce((n, e) => n + e.kwh, 0)),
      ...coverage(db, meters, period),
      totalLocation: sumOrNull([carbon.totals.scope1, carbon.totals.scope2Location]),
      factorsComplete: lines.length > 0 && factorIssues.length === 0,
      factorIssues,
      calculated: lines.length > 0,
    };
  });
  return { year, period, expectedDays, assets };
}

/* ------------------------------------------------------------------ */
/* 3. portfolio-energy                                                 */
/* ------------------------------------------------------------------ */

export const PORTFOLIO_ENERGY_COLUMNS = [
  "asset", "asset_id", "uprn", "postcode", "floor_area_m2",
  "electricity_import_kwh", "gas_kwh", "export_kwh", "eui_kwh_per_m2",
  "intervals", "days_with_data", "days_expected", "data_completeness_pct",
  "first_reading", "last_reading", "meter_count",
];

export function buildPortfolioEnergyExport(db: Db, ctx: OperationContext, year: number): ExportTable {
  const roll = portfolioRollup(db, ctx, year);
  const rows: CsvValue[][] = roll.assets.map((a) => {
    // With no readings the energy is unknown, not zero, so those cells stay blank.
    const hasData = a.intervals > 0;
    const importKwh = a.electricityImportKwh + a.gasKwh;
    const eui = hasData && a.asset.floorAreaM2 ? r3(importKwh / a.asset.floorAreaM2) : null;
    return [
      a.asset.name, a.asset.id, a.asset.uprn ?? "", formatPostcode(a.asset.postcode) ?? "", nn(a.asset.floorAreaM2),
      hasData ? a.electricityImportKwh : "", hasData ? a.gasKwh : "", hasData ? a.exportKwh : "", nn(eui),
      a.intervals, a.daysWithData, roll.expectedDays, r3((a.daysWithData / roll.expectedDays) * 100),
      a.firstReading ?? "", a.lastReading ?? "", a.meters.length,
    ];
  });
  return table("portfolio-energy", `portfolio-energy-${year}`, PORTFOLIO_ENERGY_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 4. portfolio-carbon                                                 */
/* ------------------------------------------------------------------ */

export const PORTFOLIO_CARBON_COLUMNS = [
  "asset", "asset_id", "uprn", "postcode", "floor_area_m2",
  "scope1_kgco2e", "scope2_location_kgco2e", "scope2_market_kgco2e", "scope3_td_kgco2e",
  "total_scope1_scope2_location_kgco2e", "intensity_kgco2e_per_m2", "factors_complete", "unavailable_reasons",
];

export function buildPortfolioCarbonExport(db: Db, ctx: OperationContext, year: number): ExportTable {
  const roll = portfolioRollup(db, ctx, year);
  const rows: CsvValue[][] = roll.assets.map((a) => {
    // Nothing metered means the emissions are unknown, not zero, so those cells stay blank.
    const td = a.calculated ? sumOrNull(a.carbon.scope3TandD.map((l) => l.kgCo2e)) : null;
    const total = a.calculated ? a.totalLocation : null;
    const intensity = total !== null && a.asset.floorAreaM2 ? r3(total / a.asset.floorAreaM2) : null;
    const cell = (v: number | null) => (a.calculated ? nn(v) : "");
    return [
      a.asset.name, a.asset.id, a.asset.uprn ?? "", formatPostcode(a.asset.postcode) ?? "", nn(a.asset.floorAreaM2),
      cell(a.carbon.totals.scope1), cell(a.carbon.totals.scope2Location), cell(a.carbon.totals.scope2Market), nn(td),
      nn(total), nn(intensity), yesNo(a.factorsComplete), a.factorIssues.join(" "),
    ];
  });
  return table("portfolio-carbon", `portfolio-carbon-${year}`, PORTFOLIO_CARBON_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 5. secr-summary                                                     */
/* ------------------------------------------------------------------ */

export const SECR_COLUMNS = ["section", "item", "value", "unit", "basis", "source", "reference", "note"];

/**
 * What the portal does not yet hold. SECR requires transport energy and the
 * quoted Scope 1 and 3 figures that go with it, so this has to be stated on
 * the face of the export, not left for the reader to notice.
 */
export const SECR_EXCLUSIONS: [string, string][] = [
  ["Transport energy and emissions", "No transport activity has been recorded for this period. SECR requires transport energy for UK operations; add it on the Transport page before disclosing."],
  ["Business travel (Scope 3 category 6)", "No business travel has been recorded for this period."],
  ["Other Scope 3 categories", "Only category 3 (transmission and distribution losses) is calculated from meter data. Purchased goods and services, waste, downstream leased assets and the rest are not captured."],
  ["Fugitive emissions (refrigerants)", "No refrigerant top-ups recorded for this period. These are Scope 1 and are usually material for air-conditioned buildings."],
  ["Non-metered fuels", "Oil, LPG and biomass are not captured; only electricity and gas meter data is held."],
  ["Water", "No water supply or treatment recorded for this period."],
  ["Waste", "No waste recorded for this period."],
  ["Embodied carbon", "Not captured by the portal. A whole life carbon assessment is a separate exercise."],
];

export function buildSecrSummaryExport(db: Db, ctx: OperationContext, year: number): ExportTable {
  const roll = portfolioRollup(db, ctx, year);
  const transport = transportCarbon(db, ctx, calendarYear(year));
  const hasTransport = transport.counts.lines > 0;
  const site = emissionsCarbon(db, ctx, calendarYear(year));
  const hasRefrigerant = site.lines.some((l) => l.family === "refrigerant");
  const hasWater = site.lines.some((l) => l.family === "water");
  const hasWaste = site.lines.some((l) => l.family === "waste");
  const refrigerantScope1 = hasRefrigerant ? site.byFamily.refrigerant : 0;
  const transportEnergyKwh = transport.lines
    .filter((l) => l.unit.trim().toLowerCase() === "kwh")
    .reduce((n, l) => n + l.quantity, 0);
  const rows: CsvValue[][] = [];
  const add = (section: string, item: string, value: CsvValue, unit = "", basis = "", source = "", reference = "", note = "") =>
    rows.push([section, item, value, unit, basis, source, reference, note]);

  const withData = roll.assets.filter((a) => a.intervals > 0);
  const withFloorArea = roll.assets.filter((a) => a.asset.floorAreaM2);
  const floorArea = r3(withFloorArea.reduce((n, a) => n + (a.asset.floorAreaM2 ?? 0), 0));
  const meterCount = roll.assets.reduce((n, a) => n + a.meters.length, 0);
  const daysWithData = roll.assets.reduce((n, a) => n + a.daysWithData, 0);
  const completeness = roll.assets.length ? r3((daysWithData / (roll.assets.length * roll.expectedDays)) * 100) : null;

  add("Reporting boundary", "Reporting period", roll.period.label, "calendar year", "", "nzc-portal", `${roll.period.from} to ${roll.period.to}`, "Operational control boundary as configured in the portal.");
  add("Reporting boundary", "Assets included", roll.assets.length, "count", "measured", "nzc-portal");
  add("Reporting boundary", "Assets with metered data", withData.length, "count", "measured", "nzc-portal", "", withData.length === roll.assets.length ? "" : "Assets without readings contribute no energy or emissions to the totals below.");
  add("Reporting boundary", "Meters included", meterCount, "count", "measured", "nzc-portal");
  add("Reporting boundary", "Floor area", floorArea > 0 ? floorArea : "", "m2", floorArea > 0 ? "client_declared" : "unavailable", "nzc-portal", "", `${withFloorArea.length} of ${roll.assets.length} assets have a floor area recorded.`);

  const elec = r3(roll.assets.reduce((n, a) => n + a.electricityImportKwh, 0));
  const gas = r3(roll.assets.reduce((n, a) => n + a.gasKwh, 0));
  const exported = r3(roll.assets.reduce((n, a) => n + a.exportKwh, 0));
  add("Energy consumption", "Electricity purchased", elec, "kWh", "measured", "n3rgy", "Half-hourly meter readings stored in the portal.");
  add("Energy consumption", "Natural gas", gas, "kWh", "measured", "n3rgy", "Half-hourly meter readings stored in the portal, gross CV as metered.");
  if (!hasTransport) {
    add("Energy consumption", "Transport fuel", "", "kWh", "unavailable", "", "", "NOT CAPTURED. No transport activity is recorded for this period. This is a required SECR disclosure and is left blank rather than reported as zero.");
  } else if (transportEnergyKwh > 0) {
    add("Energy consumption", "Transport fuel", r3(transportEnergyKwh), "kWh", "measured", "nzc-portal", "", `From ${transport.counts.lines} transport activity lines recorded in kWh. Distance-based lines contribute emissions below but no kWh.`);
  } else {
    add("Energy consumption", "Transport fuel", "", "kWh", "unavailable", "", "", `${transport.counts.lines} transport lines are recorded, but all are distance, passenger-km or room-night based, which give emissions and not energy. SECR asks for transport energy in kWh: record fuel volumes or kWh, or convert using a calorific value the portal does not hold.`);
  }
  add("Energy consumption", "Total energy (electricity and gas only)", r3(elec + gas), "kWh", "measured", "nzc-portal", "", "Excludes transport unless recorded in kWh above, and any non-metered fuel. Not a complete SECR energy total.");
  add("Energy consumption", "Electricity exported (memo)", exported, "kWh", "measured", "n3rgy", "", "Memo only. Not deducted from consumption.");

  const scope1 = sumOrNull(roll.assets.map((a) => a.carbon.totals.scope1));
  const scope2Location = sumOrNull(roll.assets.map((a) => a.carbon.totals.scope2Location));
  const scope2Market = sumOrNull(roll.assets.map((a) => a.carbon.totals.scope2Market));
  const scope3Td = sumOrNull(roll.assets.flatMap((a) => a.carbon.scope3TandD.map((l) => l.kgCo2e)));
  const transportScope1 = hasTransport ? transport.totals.scope1 : 0;
  const scope1Total = sumOrNull([scope1, transportScope1, refrigerantScope1]);
  const totalLocation = sumOrNull([scope1Total, scope2Location]);
  const missingNote = (v: number | null) => (v === null ? "Blank because at least one required factor is unavailable. See the portfolio-carbon export for which asset and which factor." : "");

  add("Emissions", "Scope 1 (natural gas combustion)", nn(scope1), "kgCO2e", scope1 === null ? "unavailable" : "measured", "desnz-conversion-factors", "", missingNote(scope1));
  add(
    "Emissions", "Scope 1 (mobile combustion, own and leased vehicles)", nn(transportScope1), "kgCO2e",
    transportScope1 === null ? "unavailable" : hasTransport ? "measured" : "not_applicable", "desnz-conversion-factors", "",
    !hasTransport
      ? "No transport activity recorded for this period."
      : transportScope1 === null
        ? "Blank because at least one fleet line could not be calculated. See the Transport page for which."
        : "",
  );
  add(
    "Emissions", "Scope 1 (fugitive, refrigerants)", nn(refrigerantScope1), "kgCO2e",
    refrigerantScope1 === null ? "unavailable" : hasRefrigerant ? "measured" : "not_applicable", "desnz-conversion-factors", "",
    !hasRefrigerant
      ? "No refrigerant top-ups recorded for this period."
      : refrigerantScope1 === null
        ? "Blank because at least one refrigerant line could not be calculated. See the Emissions page for which."
        : "Mass-balance approach: refrigerant added over the period is taken as the quantity that leaked.",
  );
  add("Emissions", "Scope 1 total", nn(scope1Total), "kgCO2e", scope1Total === null ? "unavailable" : "measured", "nzc-portal", "", missingNote(scope1Total));
  add("Emissions", "Scope 2 location-based", nn(scope2Location), "kgCO2e", scope2Location === null ? "unavailable" : "measured", "desnz-conversion-factors", "", missingNote(scope2Location));
  add("Emissions", "Scope 2 market-based", nn(scope2Market), "kgCO2e", scope2Market === null ? "unavailable" : "measured", "asset_meters, aib-residual-mix", "", missingNote(scope2Market));
  add("Emissions", "Scope 3 category 3 (transmission and distribution)", nn(scope3Td), "kgCO2e", scope3Td === null ? "unavailable" : "measured", "desnz-conversion-factors", "", missingNote(scope3Td));
  for (const g of transport.byGhgCategory.filter((c) => c.scope === 3)) {
    add(
      "Emissions", `Scope 3 ${g.ghgCategory.toLowerCase()}`, nn(g.kgCo2e), "kgCO2e",
      g.kgCo2e === null ? "unavailable" : "measured", "desnz-conversion-factors", "",
      `${g.lines} transport activity line${g.lines === 1 ? "" : "s"}${g.unresolved > 0 ? `, ${g.unresolved} of which could not be calculated, so this is blank rather than partial` : ""}. Voluntary under SECR; required for a GHG Protocol inventory.`,
    );
  }
  for (const g of site.byGhgCategory.filter((c) => c.scope === 3)) {
    add(
      "Emissions", `Scope 3 ${g.ghgCategory.toLowerCase()}`, nn(g.kgCo2e), "kgCO2e",
      g.kgCo2e === null ? "unavailable" : "measured", "desnz-conversion-factors", "",
      `${g.lines} water or waste line${g.lines === 1 ? "" : "s"}${g.unresolved > 0 ? `, ${g.unresolved} of which could not be calculated, so this is blank rather than partial` : ""}. Voluntary under SECR; required for a GHG Protocol inventory.`,
    );
  }
  if (hasWaste) {
    const w = site.waste;
    add("Waste", "Total waste", nn(w.totalTonnes), "tonnes", w.totalTonnes === null ? "unavailable" : "measured", "nzc-portal", "", w.detail);
    add("Waste", "Diverted from landfill", nn(w.divertedTonnes), "tonnes", w.divertedTonnes === null ? "unavailable" : "measured", "nzc-portal");
    add("Waste", "Landfill", nn(w.landfillTonnes), "tonnes", w.landfillTonnes === null ? "unavailable" : "measured", "nzc-portal");
    add("Waste", "Diversion rate", nn(w.diversionRatePct), "%", w.diversionRatePct === null ? "unavailable" : "measured", "nzc-portal", "", "Energy recovery counts as diverted from landfill.");
  }
  add("Emissions", "Total gross (Scope 1 + Scope 2 location-based)", nn(totalLocation), "kgCO2e", totalLocation === null ? "unavailable" : "measured", "nzc-portal", "", `${missingNote(totalLocation)} Scope 1 includes mobile combustion where transport activity is recorded. Scope 3 is excluded from this total, as SECR requires.`.trim());

  const intensity = totalLocation !== null && floorArea > 0 ? r3(totalLocation / floorArea) : null;
  add(
    "Intensity ratio", "Scope 1 + Scope 2 location-based per m2", nn(intensity), "kgCO2e/m2",
    intensity === null ? "unavailable" : "measured", "nzc-portal", "",
    floorArea > 0
      ? `Over ${floorArea} m2 across ${withFloorArea.length} of ${roll.assets.length} assets (${withFloorArea.filter((a) => a.intervals > 0).length} with metered data). Assets with emissions but no recorded floor area push this ratio up; assets with floor area but no readings pull it down. Check both before quoting it.`
      : "No floor area recorded on any asset.",
  );

  // Methodology: name the factor set actually resolved, not the one requested.
  const elecFactor = desnzFactor(ctx, year, DESNZ_SELECTORS.electricityGenerated, "UK electricity generated");
  const gasFactor = desnzFactor(ctx, year, DESNZ_SELECTORS.naturalGasGross, "Natural gas, kWh gross CV");
  const tdFactor = desnzFactor(ctx, year, DESNZ_SELECTORS.electricityTandD, "T&D UK electricity");
  const factorRow = (item: string, f: ResolvedFactor) =>
    add("Methodology", item, nn(f.value), f.unit, f.basis, f.source, f.reference, unavailableReason(f));
  factorRow("DESNZ factor: UK electricity generated", elecFactor);
  factorRow("DESNZ factor: natural gas (gross CV)", gasFactor);
  factorRow("DESNZ factor: electricity T&D", tdFactor);

  const desnzSets = [...new Set([elecFactor, gasFactor, tdFactor].filter((f) => f.value !== null).map((f) => f.reference))];
  add("Methodology", "DESNZ factor set used", desnzSets.length ? desnzSets.join("; ") : "", "", desnzSets.length ? "measured" : "unavailable", "desnz-conversion-factors", "", desnzSets.length ? "" : `No DESNZ conversion factor file is loaded for ${year}, so no emissions could be calculated.`);

  const marketLines = roll.assets.flatMap((a) => a.carbon.scope2Market);
  const residualRefs = [...new Set(marketLines.filter((l) => l.factor.source === "aib-residual-mix").map((l) => l.factor.reference))];
  const supplierMeters = marketLines.filter((l) => l.factor.source === "asset_meters");
  const noEvidence = supplierMeters.filter((l) => /No evidence recorded/.test(l.factor.reference));
  add(
    "Methodology", "AIB residual mix used for market-based Scope 2", residualRefs.length ? residualRefs.join("; ") : "", "",
    residualRefs.length ? "measured" : "not_applicable", "aib-residual-mix", "",
    residualRefs.length ? "Applied to every supply with no supplier-specific factor on file." : "No supply fell back to the residual mix.",
  );
  add(
    "Methodology", "Supplier-specific factors used", supplierMeters.length, "count", supplierMeters.length ? "client_declared" : "not_applicable", "asset_meters", "",
    noEvidence.length ? `${noEvidence.length} supplier factor(s) have no contractual evidence reference. The GHG Protocol Scope 2 quality criteria require it, so these should not be relied on for a market-based claim.` : "",
  );
  add("Methodology", "Data completeness", nn(completeness), "%", completeness === null ? "unavailable" : "measured", "nzc-portal", "", `Mean share of the ${roll.expectedDays} expected days in the period with at least one reading, across all assets.`);
  add("Methodology", "Calculation basis", "GHG Protocol Corporate Standard, dual reporting of Scope 2", "", "", "nzc-portal", "", "Location-based from the DESNZ UK grid average; market-based from supplier factors where contractual evidence is held, otherwise the AIB residual mix.");

  const travelRecorded = transport.lines.some((l) => l.scope === 3);
  const exclusions = SECR_EXCLUSIONS.filter(([item]) => {
    if (item.startsWith("Transport energy") && hasTransport) return false;
    if (item.startsWith("Business travel") && travelRecorded) return false;
    if (item.startsWith("Fugitive emissions") && hasRefrigerant) return false;
    if (item === "Water" && hasWater) return false;
    if (item === "Waste" && hasWaste) return false;
    return true;
  });
  for (const [item, note] of exclusions) {
    add("Exclusions: NOT INCLUDED in the figures above", item, "", "", "unavailable", "", "", note);
  }
  add(
    "Exclusions: NOT INCLUDED in the figures above", "Readiness for disclosure", "", "", "", "", "",
    hasTransport
      ? "THIS IS NOT A COMPLETE SECR DISCLOSURE. Transport is included, but the exclusions listed above are not, and transport energy in kWh is only present where fuel volumes were recorded. Review the whole return before it is used in a Directors' Report or filed."
      : "THIS IS NOT A COMPLETE SECR DISCLOSURE. Transport energy, business travel and the other Scope 3 categories listed above are not yet captured by the portal and must be added, and the whole return reviewed, before it is used in a Directors' Report or filed.",
  );

  return table("secr-summary", `secr-summary-${year}`, SECR_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 6. consents                                                         */
/* ------------------------------------------------------------------ */

export const CONSENTS_COLUMNS = [
  "mpxn", "utilities", "asset_ref", "site_address", "occupier_name", "occupier_organisation", "occupier_email",
  "method", "evidence_ref", "granted_on", "expires_on", "stored_status", "effective_status", "days_to_expiry",
  "last_verified_at", "last_verification_result", "last_verification_detail", "withdrawn_at", "withdrawn_reason",
];

/** Every consent, with the effective status derived at `at`. */
export function buildConsentsExport(consents: ConsentRecord[], at = new Date()): ExportTable {
  const rows: CsvValue[][] = consents
    .map((c) => toView(c, at))
    .map((c) => [
      c.mpxn, c.utilities.join(" "), c.assetRef ?? "", c.siteAddress ?? "", c.occupierName, c.occupierOrganisation ?? "", c.occupierEmail ?? "",
      c.method, c.evidenceRef ?? "", c.grantedOn, c.expiresOn, c.status, c.effectiveStatus, c.daysToExpiry,
      c.lastVerifiedAt ?? "", c.lastVerificationResult ?? "", c.lastVerificationDetail ?? "", c.withdrawnAt ?? "", c.withdrawnReason ?? "",
    ]);
  return table("consents", `consents-${at.toISOString().slice(0, 10)}`, CONSENTS_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}

/* ------------------------------------------------------------------ */
/* Response headers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Headers the API route serves with a table. `x-export-truncated` is the
 * signal a caller must check before treating the file as the whole dataset.
 */
export function exportHeaders(table: ExportTable): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${table.filename}"`,
    "cache-control": "no-store",
    "x-export-kind": table.kind,
    "x-export-rows": String(table.rows.length),
  };
  if (table.truncated) {
    headers["x-export-truncated"] = "true";
    headers["x-export-row-limit"] = String(table.rowLimit);
    headers["x-export-total-rows"] = String(table.totalRows);
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* 7. value-chain                                                      */
/* ------------------------------------------------------------------ */

export const VALUE_CHAIN_COLUMNS = [
  "counterparty", "roles", "direction", "scope3_categories", "status", "annual_value_gbp", "reporting_year",
  "engagement_state", "ask", "request_due_on", "last_contact_on", "reminders_sent", "escalated", "decline_reason",
  "data_source", "reported_total_tco2e", "allocation_method", "allocation_detail", "attributable_tco2e", "tier", "tier_label", "primary_data",
  "assurance", "methodology", "boundary", "evidence", "ledger_lines", "ledger_unresolved", "next_action", "next_action_reason", "overdue", "warnings",
];

/**
 * One row per counterparty for the reporting year: the engagement, what was
 * returned, the figure attributed to the client with its allocation basis and
 * tier, and the next step. A counterparty with no data has a blank figure and
 * the reason in next_action, never a zero.
 */
export function buildValueChainExport(db: Db, ctx: OperationContext, year: number): ExportTable {
  const report = valueChainReport(db, ctx, calendarYear(year));
  const rows: CsvValue[][] = report.counterparties.map((v) => [
    v.counterparty.name,
    v.counterparty.roles.join("; "),
    v.direction,
    v.counterparty.ghgCategories.join("; "),
    v.counterparty.status,
    nn(v.counterparty.annualValueGbp),
    report.reportingYear,
    STATE_LABELS[v.state],
    v.engagement?.ask ?? v.counterparty.ask,
    v.engagement?.dueOn ?? "",
    v.engagement?.lastContactOn ?? "",
    v.engagement?.remindersSent ?? 0,
    yesNo(v.engagement?.escalated ?? false),
    v.engagement?.declineReason ?? "",
    v.dataSource,
    nn(v.report?.reportedTotalTco2e),
    v.report?.allocationMethod ?? (v.dataSource === "ledger" ? "activity_ledger" : v.dataSource === "spend_estimate" ? "spend_based_estimate" : ""),
    v.report?.allocationDetail ?? (v.dataSource === "ledger" ? `${v.ledger.counts.resolved} of ${v.ledger.counts.lines} ledger lines converted with the share of each line applied.` : v.spendEstimate?.detail ?? ""),
    nn(v.attributableTco2e),
    v.tier ?? "",
    v.tier ? TIER_LABELS[v.tier] : "",
    yesNo(v.primary),
    v.report?.assurance ?? "",
    v.report?.methodology ?? "",
    v.report?.boundary ?? "",
    v.report?.evidence ?? "",
    v.ledger.counts.lines,
    v.ledger.counts.unresolved,
    v.next.action,
    v.next.reason,
    yesNo(v.next.overdue),
    v.warnings.join(" | "),
  ]);
  return table("value-chain", `value-chain-${year}`, VALUE_CHAIN_COLUMNS, rows, DEFAULT_ROW_LIMIT);
}
