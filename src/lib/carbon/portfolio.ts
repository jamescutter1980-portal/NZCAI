import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { AssetsRepository } from "@/lib/assets/repo";
import type { AssetRecord } from "@/lib/assets/types";
import { assetCarbonForPeriod, type AssetCarbon } from "./scope";
import { gridRegionKey } from "./intensity-sync";
import { elapsedDays, type Period } from "./period";

/**
 * Portfolio roll-up for a reporting period.
 *
 * Totals add only what is actually known: a scope total is null when any asset
 * in it could not be calculated, and the count of assets contributing is always
 * reported so a partial total is never mistaken for a complete one.
 */
export interface AssetSummary {
  assetId: string;
  name: string;
  postcode?: string;
  floorAreaM2?: number;
  propertyType?: string;
  meterCount: number;
  electricityKwh: number;
  gasKwh: number;
  exportKwh: number;
  totalImportKwh: number;
  /** Import kWh per m2 for the period, null without a floor area. */
  eui: number | null;
  scope1: number | null;
  scope2Location: number | null;
  scope2Market: number | null;
  scope3TandD: number | null;
  /** kgCO2e per m2 (Scope 1 + Scope 2 location-based), null if either is unknown. */
  intensity: number | null;
  /** Percentage of elapsed period days that have readings, across linked meters. */
  completeness: number | null;
  factorsComplete: boolean;
  warnings: string[];
}

export interface PortfolioTotals {
  assets: number;
  assetsWithReadings: number;
  meters: number;
  floorAreaM2: number;
  electricityKwh: number;
  gasKwh: number;
  exportKwh: number;
  totalImportKwh: number;
  scope1: number | null;
  scope2Location: number | null;
  scope2Market: number | null;
  scope3TandD: number | null;
  /** Assets that contributed to each scope total. */
  contributing: { scope1: number; scope2Location: number; scope2Market: number; scope3TandD: number };
}

export interface DataQualityIssue {
  assetId?: string;
  assetName?: string;
  kind: "no_meters" | "no_readings" | "no_floor_area" | "no_location" | "factors_missing" | "over_allocated" | "under_allocated" | "partial_period";
  detail: string;
}

export interface PortfolioReport {
  period: Period;
  assets: AssetSummary[];
  totals: PortfolioTotals;
  issues: DataQualityIssue[];
  /** Distinct factor references used, so the whole roll-up is traceable. */
  factorReferences: string[];
}

const sum = (ns: (number | null)[]) => ns.reduce<number>((n, v) => n + (v ?? 0), 0);
const round = (n: number) => Math.round(n * 1000) / 1000;

function totalOf(lines: { kgCo2e: number | null }[]): number | null {
  if (lines.length === 0) return 0;
  return lines.some((l) => l.kgCo2e === null) ? null : round(sum(lines.map((l) => l.kgCo2e)));
}

export function summariseAsset(asset: AssetRecord, carbon: AssetCarbon, meterCount: number, period: Period, now: Date): AssetSummary {
  const elec = carbon.energy.filter((e) => e.utility === "electricity" && e.direction === "import");
  const gas = carbon.energy.filter((e) => e.utility === "gas" && e.direction === "import");
  const exported = carbon.energy.filter((e) => e.direction === "export");
  const electricityKwh = round(sum(elec.map((e) => e.kwh)));
  const gasKwh = round(sum(gas.map((e) => e.kwh)));
  const totalImportKwh = round(electricityKwh + gasKwh);
  const scope1 = totalOf(carbon.scope1);
  const scope2Location = totalOf(carbon.scope2Location);
  const importMeters = carbon.energy.filter((e) => e.direction === "import");
  const expected = Math.max(1, Math.min(period.days, elapsedDays(period, now)));
  const completeness = importMeters.length === 0 ? null : Math.round((Math.max(...importMeters.map((e) => e.days), 0) / expected) * 100);
  const factorsComplete = [...carbon.scope1, ...carbon.scope2Location, ...carbon.scope2Market, ...carbon.scope3TandD].every((l) => l.factor.value !== null);
  return {
    assetId: asset.id,
    name: asset.name,
    postcode: asset.postcode,
    floorAreaM2: asset.floorAreaM2,
    propertyType: asset.propertyType,
    meterCount,
    electricityKwh,
    gasKwh,
    exportKwh: round(sum(exported.map((e) => e.kwh))),
    totalImportKwh,
    eui: asset.floorAreaM2 ? round(totalImportKwh / asset.floorAreaM2) : null,
    scope1,
    scope2Location,
    scope2Market: totalOf(carbon.scope2Market),
    scope3TandD: totalOf(carbon.scope3TandD),
    intensity: asset.floorAreaM2 && scope1 !== null && scope2Location !== null ? round((scope1 + scope2Location) / asset.floorAreaM2) : null,
    completeness,
    factorsComplete,
    warnings: carbon.warnings,
  };
}

export function portfolioReport(db: Db, ctx: OperationContext, period: Period): PortfolioReport {
  const repo = new AssetsRepository(db);
  const now = ctx.now();
  const assets = repo.list();
  const summaries: AssetSummary[] = [];
  const issues: DataQualityIssue[] = [];
  const factorReferences = new Set<string>();

  for (const asset of assets) {
    const meters = repo.meters(asset.id);
    const region = asset.postcode ? gridRegionKey(asset.postcode) : undefined;
    const carbon = assetCarbonForPeriod(db, ctx, meters, period, region);
    for (const line of [...carbon.scope1, ...carbon.scope2Location, ...carbon.scope2Market, ...carbon.scope3TandD]) {
      if (line.factor.value !== null) factorReferences.add(line.factor.reference);
    }
    const summary = summariseAsset(asset, carbon, meters.length, period, now);
    summaries.push(summary);

    const named = { assetId: asset.id, assetName: asset.name };
    if (meters.length === 0) issues.push({ ...named, kind: "no_meters", detail: "No meters linked, so no energy or carbon." });
    else if (carbon.energy.every((e) => e.intervals === 0)) issues.push({ ...named, kind: "no_readings", detail: `No readings stored for ${period.label}.` });
    else if ((summary.completeness ?? 100) < 95) issues.push({ ...named, kind: "partial_period", detail: `Readings cover about ${summary.completeness}% of the period.` });
    if (!asset.floorAreaM2) issues.push({ ...named, kind: "no_floor_area", detail: "No floor area, so no intensity or EUI." });
    if (asset.latitude === undefined || asset.longitude === undefined) issues.push({ ...named, kind: "no_location", detail: "No coordinates, so location screening cannot run." });
    if (!summary.factorsComplete && meters.length > 0) issues.push({ ...named, kind: "factors_missing", detail: `A conversion factor for ${period.factorYear} is unavailable, so some totals are blank.` });

    for (const m of meters) {
      const alloc = repo.allocationForMeter(m.mpxn, m.utility, m.direction);
      if (alloc.links.length > 1 && alloc.total > 1.0005) {
        issues.push({ ...named, kind: "over_allocated", detail: `${m.mpxn} (${m.utility}) is allocated ${Math.round(alloc.total * 100)}% across ${alloc.links.length} assets; energy is being double counted.` });
      } else if (alloc.links.length > 1 && alloc.total < 0.9995) {
        issues.push({ ...named, kind: "under_allocated", detail: `${m.mpxn} (${m.utility}) is only ${Math.round(alloc.total * 100)}% allocated; the remainder is not attributed to any asset.` });
      }
    }
  }

  const scopeTotal = (key: "scope1" | "scope2Location" | "scope2Market" | "scope3TandD") => {
    const withMeters = summaries.filter((s) => s.meterCount > 0);
    const known = withMeters.filter((s) => s[key] !== null);
    return { value: known.length === withMeters.length ? round(sum(known.map((s) => s[key]))) : null, contributing: known.length };
  };
  const s1 = scopeTotal("scope1");
  const s2l = scopeTotal("scope2Location");
  const s2m = scopeTotal("scope2Market");
  const s3 = scopeTotal("scope3TandD");

  return {
    period,
    assets: summaries,
    totals: {
      assets: summaries.length,
      assetsWithReadings: summaries.filter((s) => s.totalImportKwh > 0).length,
      meters: summaries.reduce((n, s) => n + s.meterCount, 0),
      floorAreaM2: round(sum(summaries.map((s) => s.floorAreaM2 ?? 0))),
      electricityKwh: round(sum(summaries.map((s) => s.electricityKwh))),
      gasKwh: round(sum(summaries.map((s) => s.gasKwh))),
      exportKwh: round(sum(summaries.map((s) => s.exportKwh))),
      totalImportKwh: round(sum(summaries.map((s) => s.totalImportKwh))),
      scope1: s1.value,
      scope2Location: s2l.value,
      scope2Market: s2m.value,
      scope3TandD: s3.value,
      contributing: { scope1: s1.contributing, scope2Location: s2l.contributing, scope2Market: s2m.contributing, scope3TandD: s3.contributing },
    },
    issues,
    factorReferences: [...factorReferences].sort(),
  };
}
