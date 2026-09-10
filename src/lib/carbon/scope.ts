import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { AssetMeter } from "@/lib/assets/types";
import { desnzFactor, residualMixFactor, DESNZ_SELECTORS, type ResolvedFactor } from "./factors";
import { calendarYear, elapsedDays, type Period } from "./period";

/**
 * Scope 1 and 2 for one asset and reporting period from stored readings.
 *
 * - Scope 1: gas kWh (gross CV, as metered) x DESNZ natural gas factor.
 * - Scope 2 location-based: electricity import kWh x DESNZ UK electricity factor; T&D reported separately (Scope 3 cat 3).
 * - Scope 2 market-based: per meter, supplier factor where evidence is held, else AIB residual mix.
 * - Time-varying: sum over half hours of kWh x regional grid intensity, from the grid_intensity table.
 *   Operational insight only, not a GHG Protocol figure.
 * All calculations keep factor provenance, and unavailable factors yield null totals, never zero.
 *
 * Where a meter serves more than one asset, each link carries an allocation
 * share and only that share of the metered energy counts towards the asset.
 */
export interface MeterEnergy {
  mpxn: string;
  utility: "electricity" | "gas";
  direction: "import" | "export";
  /** Energy attributed to this asset: metered kWh x share. */
  kwh: number;
  /** Energy recorded on the meter before allocation. */
  meteredKwh: number;
  /** Allocation share of this meter to this asset, 0 to 1. */
  share: number;
  intervals: number;
  /** Distinct UTC days with at least one reading. */
  days: number;
  firstInterval?: string;
  lastInterval?: string;
}

export interface CarbonLine {
  label: string;
  kwh: number;
  factor: ResolvedFactor;
  kgCo2e: number | null;
  meters?: string[];
}

export interface AssetCarbon {
  /** Calendar year for a calendar period, otherwise the year the period starts. */
  year: number;
  period: Period;
  energy: MeterEnergy[];
  scope1: CarbonLine[];
  scope2Location: CarbonLine[];
  scope2Market: CarbonLine[];
  scope3TandD: CarbonLine[];
  timeVarying: { kwhMatched: number; kwhUnmatched: number; kgCo2e: number | null; region?: string; detail: string };
  totals: { scope1: number | null; scope2Location: number | null; scope2Market: number | null };
  warnings: string[];
}

export function energyByMeterForPeriod(db: Db, meters: AssetMeter[], period: Period): MeterEnergy[] {
  const { from, to } = period;
  const stmt = db.prepare(
    `SELECT COALESCE(SUM(value), 0) AS kwh, COUNT(*) AS n, COUNT(DISTINCT substr(interval_start, 1, 10)) AS days, MIN(interval_start) AS first, MAX(interval_start) AS last
     FROM meter_readings WHERE mpxn = ? AND utility = ? AND direction = ? AND interval_start >= ? AND interval_start < ?`,
  );
  return meters.map((m) => {
    const r = stmt.get(m.mpxn, m.utility, m.direction, from, to) as { kwh: number; n: number; days: number; first: string | null; last: string | null };
    const share = m.share ?? 1;
    return {
      mpxn: m.mpxn,
      utility: m.utility,
      direction: m.direction,
      meteredKwh: round3(r.kwh),
      share,
      kwh: round3(r.kwh * share),
      intervals: r.n,
      days: r.days,
      firstInterval: r.first ?? undefined,
      lastInterval: r.last ?? undefined,
    };
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Calendar-year energy. Kept for callers that report on calendar years. */
export function energyByMeterForYear(db: Db, meters: AssetMeter[], year: number): MeterEnergy[] {
  return energyByMeterForPeriod(db, meters, calendarYear(year));
}

function timeVarying(db: Db, meters: AssetMeter[], period: Period, region: string | undefined) {
  if (!region) return { kwhMatched: 0, kwhUnmatched: 0, kgCo2e: null, detail: "No postcode on the asset, so no grid region." };
  const { from, to } = period;
  let matched = 0;
  let unmatched = 0;
  let g = 0;
  const stmt = db.prepare(
    `SELECT r.value AS kwh, gi.gco2_per_kwh AS g
     FROM meter_readings r LEFT JOIN grid_intensity gi ON gi.region = ? AND gi.interval_start = r.interval_start
     WHERE r.mpxn = ? AND r.utility = 'electricity' AND r.direction = 'import' AND r.interval_start >= ? AND r.interval_start < ?`,
  );
  for (const m of meters.filter((x) => x.utility === "electricity" && x.direction === "import")) {
    const share = m.share ?? 1;
    for (const row of stmt.all(region, m.mpxn, from, to) as { kwh: number; g: number | null }[]) {
      const kwh = row.kwh * share;
      if (row.g === null || row.g === undefined) unmatched += kwh;
      else {
        matched += kwh;
        g += kwh * row.g;
      }
    }
  }
  const total = matched + unmatched;
  return {
    kwhMatched: Math.round(matched * 1000) / 1000,
    kwhUnmatched: Math.round(unmatched * 1000) / 1000,
    kgCo2e: matched > 0 ? Math.round(g) / 1000 : null,
    region,
    detail:
      total === 0
        ? "No electricity import readings in this period."
        : matched === 0
          ? "No grid intensity stored for these intervals. Run the grid intensity sync for this asset."
          : `${Math.round((matched / total) * 100)}% of import kWh matched to half-hourly regional intensity.`,
  };
}

/** Scope 1 and 2 for one asset over a calendar year. */
export function assetCarbon(db: Db, ctx: OperationContext, meters: AssetMeter[], year: number, gridRegion?: string): AssetCarbon {
  return assetCarbonForPeriod(db, ctx, meters, calendarYear(year), gridRegion);
}

/** Scope 1 and 2 for one asset over any reporting period. */
export function assetCarbonForPeriod(db: Db, ctx: OperationContext, meters: AssetMeter[], period: Period, gridRegion?: string): AssetCarbon {
  const year = period.factorYear;
  const energy = energyByMeterForPeriod(db, meters, period);
  const warnings: string[] = [];
  const gasKwh = energy.filter((e) => e.utility === "gas" && e.direction === "import").reduce((n, e) => n + e.kwh, 0);
  const elecImport = energy.filter((e) => e.utility === "electricity" && e.direction === "import");
  const elecKwh = elecImport.reduce((n, e) => n + e.kwh, 0);

  const gasFactor = desnzFactor(ctx, period.factorYear, DESNZ_SELECTORS.naturalGasGross, "Natural gas, kWh gross CV");
  const elecFactor = desnzFactor(ctx, period.factorYear, DESNZ_SELECTORS.electricityGenerated, "UK electricity generated");
  const tdFactor = desnzFactor(ctx, period.factorYear, DESNZ_SELECTORS.electricityTandD, "T&D UK electricity");

  const line = (label: string, kwh: number, factor: ResolvedFactor, meters?: string[]): CarbonLine => ({
    label, kwh: Math.round(kwh * 1000) / 1000, factor, kgCo2e: factor.value === null ? null : Math.round(kwh * factor.value * 1000) / 1000, meters,
  });

  const scope1 = gasKwh > 0 ? [line("Natural gas combustion", gasKwh, gasFactor, energy.filter((e) => e.utility === "gas").map((e) => e.mpxn))] : [];
  const scope2Location = elecKwh > 0 ? [line("Purchased electricity (location-based)", elecKwh, elecFactor, elecImport.map((e) => e.mpxn))] : [];
  const scope3TandD = elecKwh > 0 ? [line("Electricity transmission and distribution losses", elecKwh, tdFactor, elecImport.map((e) => e.mpxn))] : [];

  const scope2Market: CarbonLine[] = [];
  for (const e of elecImport) {
    const meter = meters.find((m) => m.mpxn === e.mpxn && m.utility === "electricity" && m.direction === "import");
    if (e.kwh === 0) continue;
    if (meter?.supplierFactorKgCo2ePerKwh !== undefined) {
      scope2Market.push(
        line(`Supplier-specific factor for ${e.mpxn}`, e.kwh, {
          value: meter.supplierFactorKgCo2ePerKwh, unit: "kgCO2e/kWh", basis: "client_declared", source: "asset_meters",
          reference: meter.supplierFactorEvidence ? `Evidence: ${meter.supplierFactorEvidence}` : "No evidence recorded",
        }, [e.mpxn]),
      );
      if (!meter.supplierFactorEvidence) warnings.push(`Supplier factor for ${e.mpxn} has no evidence reference; the GHG Protocol Scope 2 quality criteria require contractual evidence.`);
    } else {
      scope2Market.push(line(`Residual mix for ${e.mpxn}`, e.kwh, residualMixFactor(ctx, period.factorYear, "GB"), [e.mpxn]));
    }
  }

  for (const f of [gasFactor, elecFactor, tdFactor]) if (f.basis === "unavailable" && f.detail) warnings.push(f.detail);
  const expectedDays = Math.max(1, Math.min(period.days, elapsedDays(period, ctx.now())));
  const missingData = energy.filter((e) => e.days > 0 && e.days < expectedDays - 5);
  if (missingData.length) warnings.push(`Partial period for ${missingData.map((e) => `${e.mpxn} (${e.days} of ${expectedDays} days)`).join(", ")}.`);
  if (energy.length > 0 && energy.every((e) => e.intervals === 0)) warnings.push(`No readings stored for ${period.label} on the linked meters.`);
  if (energy.length === 0) warnings.push("No meters linked to this asset.");
  const shared = energy.filter((e) => e.share < 1);
  if (shared.length) warnings.push(`Allocated share applied to ${shared.map((e) => `${e.mpxn} (${Math.round(e.share * 100)}%)`).join(", ")}; the rest belongs to other assets.`);
  if (period.kind !== "calendar") warnings.push(`${period.label} reports against the ${period.factorYear} DESNZ factor set. Check that matches your disclosure basis.`);

  const sum = (lines: CarbonLine[]) => (lines.length === 0 ? 0 : lines.some((l) => l.kgCo2e === null) ? null : Math.round(lines.reduce((n, l) => n + (l.kgCo2e ?? 0), 0) * 1000) / 1000);

  return {
    year,
    period,
    energy,
    scope1,
    scope2Location,
    scope2Market,
    scope3TandD,
    timeVarying: timeVarying(db, meters, period, gridRegion),
    totals: { scope1: sum(scope1), scope2Location: sum(scope2Location), scope2Market: sum(scope2Market) },
    warnings: [...new Set(warnings)],
  };
}
