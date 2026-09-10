import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { assetCarbon, type AssetCarbon } from "@/lib/carbon";
import { computeMisalignment, loadVersions, type PathwayPoint, type VersionIndex } from "@/lib/integrations/crrem-pathways";
import { referenceDir } from "@/lib/integrations/_shared/reference-data";

/**
 * CRREM alignment for one asset and one reporting year.
 *
 * Conventions this module commits to, and states in every result:
 *
 * - Intensity is **location-based Scope 1 + Scope 2** per m2 of the asset's
 *   recorded floor area, which is the CRREM convention. Market-based Scope 2,
 *   the time-varying figure and T&D losses are deliberately excluded.
 * - The asset's intensity is held **constant** from the assessment year
 *   forward: no modelled improvement, no grid decarbonisation, no planned
 *   measures. The misalignment year is therefore the earliest one implied by
 *   today's performance, not a forecast.
 * - Nothing is invented. If the pathway file, the property type, the country
 *   or a DESNZ factor is missing, the result is `assessable: false` with the
 *   reason; values stay null and are never defaulted to zero.
 */

export const CRREM_INTENSITY_BASIS =
  "Location-based Scope 1 + Scope 2 per m2 of recorded floor area (the CRREM convention). Market-based Scope 2, T&D losses and the time-varying figure are excluded.";

export const CRREM_CONSTANT_ASSUMPTION =
  "The asset's intensity is held constant from the assessment year to the end of the pathway: no modelled improvement, no grid decarbonisation and no planned measures are assumed.";

export type PathwayType = "ghg" | "energy";
export type Scenario = "1.5C" | "2C";

/** Intensity in the two units CRREM pathways are published in. */
export interface AssetIntensity {
  year: number;
  floorAreaM2: number | null;
  /** Location-based Scope 1 + 2, kgCO2e/m2/yr. Null when it cannot be computed. */
  ghgKgCo2ePerM2: number | null;
  /** Metered import (electricity + gas), kWh/m2/yr. Null when it cannot be computed. */
  energyKwhPerM2: number | null;
  scope1KgCo2e: number | null;
  scope2LocationKgCo2e: number | null;
  importKwh: number;
  basis: string;
  /** Why a value is null, one sentence each. Empty when both are computed. */
  reasons: string[];
}

/** Provenance for an assessment: the reference files behind every number. */
export interface AssessmentProvenance {
  /** Version label of the reference file used, e.g. "v2.04". Null when none was loaded. */
  version: string | null;
  /** File name within data/reference/<id>/, e.g. "v2.04.csv". */
  file: string | null;
  /** File modification time, ISO 8601. */
  fileModifiedAt: string | null;
  /** DESNZ (and any supplier or residual-mix) factor references behind the carbon figures. */
  factorReferences: string[];
  /** Directory the reference files are read from. */
  referenceDir: string;
}

export interface CrremPathwayPoint {
  year: number;
  pathwayValue: number | null;
  /** The asset's held-constant value, null for years before the assessment year. */
  assetValue: number | null;
}

export interface CrremExcessRow {
  year: number;
  pathwayValue: number;
  assetValue: number;
  /** Asset minus pathway, in the pathway's unit (per m2). */
  excessPerM2: number;
  /** excessPerM2 x floor area. Null when floor area is unknown. */
  excessTotal: number | null;
}

export interface CrremCumulativeExcess {
  fromYear: number;
  toYear: number;
  perM2: number;
  total: number | null;
  /** Unit of `total`, e.g. "kgCO2e" or "kWh". */
  totalUnit: string;
  detail: string;
}

export interface CrremAssessment {
  assessable: boolean;
  summary: string;
  reasons: string[];
  year: number;
  country: string;
  propertyType: string | null;
  scenario: Scenario;
  pathwayType: PathwayType;
  /** Unit of the pathway and of `assetValue`, from the loaded file. */
  unit: string | null;
  assumption: string;
  intensity: AssetIntensity;
  /** The asset value compared against the pathway, in the pathway's unit. */
  assetValue: number | null;
  misalignmentYear: number | null;
  /** Whole loaded pathway for charting, with the asset line from the assessment year. */
  pathway: CrremPathwayPoint[];
  /** Only the years the asset exceeds the pathway. */
  excess: CrremExcessRow[];
  /** Cumulative excess from the assessment year to 2050 (or the pathway's end). */
  cumulativeExcess: CrremCumulativeExcess | null;
  provenance: AssessmentProvenance;
  warnings: string[];
}

export interface CrremOptions {
  year: number;
  /** Defaults to the asset's own property type. Matched case-insensitively against the file. */
  propertyType?: string;
  /** Defaults to the asset's country, then "GB". */
  country?: string;
  scenario?: Scenario;
  /** CRREM file name without .csv. Defaults to the newest loaded version. */
  version?: string;
  pathwayType?: PathwayType;
  /** Cumulative excess is summed to this year. */
  horizonYear?: number;
}

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Factor references behind a carbon calculation, for provenance. */
export function carbonFactorReferences(carbon: AssetCarbon): string[] {
  const lines = [...carbon.scope1, ...carbon.scope2Location, ...carbon.scope2Market, ...carbon.scope3TandD];
  return [...new Set(lines.map((l) => `${l.factor.source}: ${l.factor.reference}`))];
}

/**
 * GHG and energy intensity for a year. Location-based Scope 1 + 2 over the
 * recorded floor area; null with a reason when floor area or a factor is missing.
 */
export function assetIntensity(carbon: AssetCarbon, floorAreaM2?: number | null): AssetIntensity {
  const reasons: string[] = [];
  const importKwh = round(carbon.energy.filter((e) => e.direction === "import").reduce((n, e) => n + e.kwh, 0));
  const area = floorAreaM2 && floorAreaM2 > 0 ? floorAreaM2 : null;
  if (area === null) reasons.push("No floor area is recorded for this asset, so no intensity can be computed. Add the floor area (m2, on the same basis as the pathway).");

  const s1 = carbon.totals.scope1;
  const s2 = carbon.totals.scope2Location;
  if (s1 === null || s2 === null) {
    const detail = carbon.warnings.filter((w) => /factor|DESNZ/i.test(w));
    reasons.push(`Location-based Scope 1 + 2 could not be totalled because an emission factor is unavailable${detail.length ? `: ${detail.join(" ")}` : "."}`);
  }
  if (importKwh === 0) reasons.push("No metered import in this year, so the intensity would be zero only because there is no data; treat it as unknown.");

  const ghg = area !== null && s1 !== null && s2 !== null && importKwh > 0 ? round((s1 + s2) / area) : null;
  const energy = area !== null && importKwh > 0 ? round(importKwh / area) : null;

  return {
    year: carbon.year,
    floorAreaM2: area,
    ghgKgCo2ePerM2: ghg,
    energyKwhPerM2: energy,
    scope1KgCo2e: s1,
    scope2LocationKgCo2e: s2,
    importKwh,
    basis: CRREM_INTENSITY_BASIS,
    reasons,
  };
}

function selectSeries(idx: VersionIndex, country: string, propertyType: string, pathwayType: PathwayType, scenario: Scenario): PathwayPoint[] {
  const c = country.trim().toUpperCase();
  const p = propertyType.trim().toLowerCase();
  return idx.points
    .filter((x) => x.country_code === c && x.property_type.toLowerCase() === p && x.pathway_type === pathwayType && x.scenario === scenario)
    .sort((a, b) => a.year - b.year);
}

function emptyProvenance(ctx: OperationContext, idx?: VersionIndex, factorReferences: string[] = []): AssessmentProvenance {
  return {
    version: idx?.version ?? null,
    file: idx?.file.name ?? null,
    fileModifiedAt: idx?.file.modifiedAt ?? null,
    factorReferences,
    referenceDir: referenceDir(ctx.env, "crrem-pathways"),
  };
}

/**
 * CRREM alignment for an asset: misalignment year, pathway series for
 * charting, and excess emissions per year and cumulative to 2050.
 * Missing reference data is a result with reasons, never an exception.
 */
export function crremAssessment(db: Db, ctx: OperationContext, asset: AssetRecord, meters: AssetMeter[], opts: CrremOptions): CrremAssessment {
  const scenario: Scenario = opts.scenario ?? "1.5C";
  const pathwayType: PathwayType = opts.pathwayType ?? "ghg";
  const country = (opts.country ?? asset.country ?? "GB").trim().toUpperCase();
  const propertyType = (opts.propertyType ?? asset.propertyType ?? "").trim() || null;
  const horizon = opts.horizonYear ?? 2050;

  const carbon = assetCarbon(db, ctx, meters, opts.year);
  const intensity = assetIntensity(carbon, asset.floorAreaM2);
  const factorRefs = carbonFactorReferences(carbon);
  const assetValue = pathwayType === "ghg" ? intensity.ghgKgCo2ePerM2 : intensity.energyKwhPerM2;

  const base = {
    year: opts.year,
    country,
    propertyType,
    scenario,
    pathwayType,
    assumption: CRREM_CONSTANT_ASSUMPTION,
    intensity,
    assetValue,
    misalignmentYear: null,
    pathway: [] as CrremPathwayPoint[],
    excess: [] as CrremExcessRow[],
    cumulativeExcess: null,
    warnings: [] as string[],
  };

  const versions = loadVersions(ctx);
  const idx = opts.version ? versions.find((v) => v.version === opts.version) : versions[0];
  if (!idx) {
    const loaded = versions.map((v) => v.version).join(", ") || "none";
    const reason = opts.version
      ? `CRREM version ${opts.version} is not loaded (loaded: ${loaded}). Save it as ${opts.version}.csv in ${referenceDir(ctx.env, "crrem-pathways")}.`
      : `No CRREM pathway file is loaded in ${referenceDir(ctx.env, "crrem-pathways")}, so no pathway can be compared.`;
    return { ...base, assessable: false, unit: null, summary: "Cannot assess against CRREM: no pathway loaded.", reasons: [reason, ...intensity.reasons], provenance: emptyProvenance(ctx, undefined, factorRefs) };
  }

  const provenance = emptyProvenance(ctx, idx, factorRefs);

  if (!propertyType) {
    return {
      ...base,
      assessable: false,
      unit: null,
      summary: "Cannot assess against CRREM: no property type.",
      reasons: [`No property type is set on the asset and none was supplied, so no CRREM pathway can be selected. Property types in ${idx.version}: ${idx.propertyTypes.join(", ") || "none"}.`, ...intensity.reasons],
      provenance,
    };
  }

  const series = selectSeries(idx, country, propertyType, pathwayType, scenario);
  if (series.length === 0) {
    const knownCountry = idx.countries.includes(country);
    const reason = knownCountry
      ? `CRREM ${idx.version} has no ${scenario} ${pathwayType} pathway for ${country} / ${propertyType}. Property types loaded for this file: ${idx.propertyTypes.join(", ") || "none"}.`
      : `CRREM ${idx.version} has no pathway for country ${country}. Countries loaded: ${idx.countries.join(", ") || "none"}.`;
    return { ...base, assessable: false, unit: null, summary: `Cannot assess against CRREM: no pathway for ${country} / ${propertyType}.`, reasons: [reason, ...intensity.reasons], provenance };
  }

  const unit = series.find((p) => p.unit)?.unit ?? null;
  const firstYear = series[0].year;
  const lastYear = series[series.length - 1].year;
  const pathwayChart: CrremPathwayPoint[] = series.map((p) => ({ year: p.year, pathwayValue: p.value, assetValue: assetValue !== null && p.year >= opts.year ? assetValue : null }));

  const forward = series.filter((p) => p.year >= opts.year);
  if (forward.length === 0) {
    return {
      ...base,
      assessable: false,
      unit,
      pathway: pathwayChart,
      summary: `Cannot assess against CRREM: the ${idx.version} pathway ends in ${lastYear}, before the ${opts.year} assessment year.`,
      reasons: [`The loaded ${idx.version} pathway covers ${firstYear}-${lastYear}, so there is no year from ${opts.year} onwards to compare.`],
      provenance,
    };
  }

  if (assetValue === null) {
    return {
      ...base,
      assessable: false,
      unit,
      pathway: pathwayChart,
      summary: `Cannot assess against CRREM: the asset's ${pathwayType === "ghg" ? "GHG" : "energy"} intensity for ${opts.year} is unknown.`,
      reasons: intensity.reasons.length ? intensity.reasons : ["The asset intensity could not be computed for this year."],
      provenance,
    };
  }

  const result = computeMisalignment(forward, [{ year: opts.year, value: assetValue }]);
  const area = intensity.floorAreaM2;
  const excess: CrremExcessRow[] = result.rows
    .filter((r) => r.status === "misaligned" && r.pathway_value !== null && r.excess !== null)
    .map((r) => ({
      year: r.year,
      pathwayValue: r.pathway_value as number,
      assetValue: r.asset_value,
      excessPerM2: round(r.excess as number),
      excessTotal: area === null ? null : round((r.excess as number) * area),
    }));

  const inHorizon = excess.filter((r) => r.year <= horizon);
  const totalUnit = pathwayType === "ghg" ? "kgCO2e" : "kWh";
  const cumulativeExcess: CrremCumulativeExcess | null = inHorizon.length
    ? {
        fromYear: inHorizon[0].year,
        toYear: Math.min(horizon, lastYear),
        perM2: round(inHorizon.reduce((n, r) => n + r.excessPerM2, 0)),
        total: area === null ? null : round(inHorizon.reduce((n, r) => n + (r.excessTotal ?? 0), 0)),
        totalUnit,
        detail:
          lastYear < horizon
            ? `Summed over the loaded pathway years only: it ends in ${lastYear}, before ${horizon}.`
            : `Summed over every year from ${inHorizon[0].year} to ${Math.min(horizon, lastYear)} in which the asset exceeds the pathway.`,
      }
    : null;

  const warnings = [
    CRREM_CONSTANT_ASSUMPTION,
    "Check that the floor area basis and the scope of the metered supplies (whole building vs landlord-controlled) match the pathway's before reporting.",
    ...(result.rows.some((r) => r.status === "no_pathway_value") ? [`Some years in ${idx.version} carry no pathway value and were skipped.`] : []),
    ...(lastYear < horizon ? [`The loaded pathway ends in ${lastYear}; cumulative excess is not summed to ${horizon}.`] : []),
    ...carbon.warnings,
  ];

  const label = `${country} ${series[0].property_type}, ${scenario} ${pathwayType} (CRREM ${idx.version})`;
  const summary =
    result.misalignmentYear === null
      ? `Aligned: at ${assetValue} ${unit ?? ""} the asset stays at or below the ${label} pathway for every year from ${forward[0].year} to ${lastYear}, holding today's intensity constant.`.replace(/\s+/g, " ")
      : result.misalignmentYear === opts.year
        ? `Already misaligned in ${opts.year}: the asset is at ${assetValue} ${unit ?? ""} against a ${label} pathway value of ${excess[0]?.pathwayValue}, holding today's intensity constant.`.replace(/\s+/g, " ")
        : `Misalignment year ${result.misalignmentYear}: holding today's intensity of ${assetValue} ${unit ?? ""} constant, the asset first exceeds the ${label} pathway in ${result.misalignmentYear}.`.replace(/\s+/g, " ");

  return {
    ...base,
    assessable: true,
    unit,
    summary,
    reasons: [],
    misalignmentYear: result.misalignmentYear,
    pathway: pathwayChart,
    excess,
    cumulativeExcess,
    provenance,
    warnings: [...new Set(warnings)],
  };
}
