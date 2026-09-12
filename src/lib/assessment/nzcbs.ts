import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { assetCarbon } from "@/lib/carbon";
import { loadVersions, type LimitRow, type VersionIndex } from "@/lib/integrations/uk-nzcbs";
import { referenceDir } from "@/lib/integrations/_shared/reference-data";
import { assetIntensity, carbonFactorReferences, type AssessmentProvenance, type AssetIntensity } from "./crrem";

/**
 * Indicative check of one asset against the UK Net Zero Carbon Buildings
 * Standard limit table the user has loaded.
 *
 * This is not a verified NZCBS assessment: the Standard requires its own
 * metering, verification and reporting method and, for certification, an
 * approved verifier. Every row here is a comparison of a portal-computed
 * value with a transcribed limit, or a statement that the portal cannot
 * compute that metric at all. No limit, benchmark or asset value is invented:
 * where the file has no limit, or the portal has no value, the row is
 * "not_assessable" with the reason.
 */

export const NZCBS_DISCLAIMER =
  "Indicative check against the loaded UK NZCBS limit table only. It is not a verified NZCBS assessment: the Standard's own metering, verification and reporting method applies, and certification requires an approved verifier. Limits are as transcribed into the reference file; verify them against the current publication.";

export type NzcbsStatus = "pass" | "fail" | "not_assessable";

export interface NzcbsMetricRow {
  metric: string;
  /** Limit as published for this sector and year, or null where the file sets none. */
  limitValue: number | null;
  unit: string;
  /** Year the limit applies to, null for a row that applies to every year. */
  year: number | null;
  /** What the portal computed for this metric, null when it cannot. */
  assetValue: number | null;
  status: NzcbsStatus;
  /** Asset minus limit in the row's unit: positive is above the limit. Null when either side is unknown. */
  gap: number | null;
  /** Why the row is not assessable, or which portal figure the asset value came from. */
  reason: string;
  notes: string;
}

export interface NzcbsAssessment {
  assessable: boolean;
  summary: string;
  reasons: string[];
  year: number;
  sector: string | null;
  version: string | null;
  rows: NzcbsMetricRow[];
  counts: { pass: number; fail: number; notAssessable: number };
  /** The operational energy figure the portal compared, for transparency. */
  intensity: AssetIntensity;
  provenance: AssessmentProvenance;
  disclaimer: string;
  warnings: string[];
}

export interface NzcbsOptions {
  year: number;
  /** Defaults to the asset's property type. Matched against the file's sector names. */
  sector?: string;
  /** NZCBS file name without .csv. Defaults to the newest loaded version. */
  version?: string;
}

const ID = "uk-nzcbs";
const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/**
 * True when a metric key from the loaded file is the Standard's operational
 * energy intensity metric, which is the one figure the portal can compute from
 * meter readings. Nothing else about the metric list is assumed: every other
 * metric in the file is carried through as loaded.
 */
export function isOperationalEnergyMetric(metric: string): boolean {
  const m = norm(metric);
  return m.includes("eui") || (m.includes("operational") && m.includes("energy")) || m.includes("energy_use_intensity");
}

function looksLikeKwhPerM2(unit: string): boolean {
  const u = unit.toLowerCase().replace(/\s+/g, "");
  return u.includes("kwh") && (u.includes("m2") || u.includes("m²"));
}

function provenanceOf(ctx: OperationContext, idx: VersionIndex | undefined, factorReferences: string[]): AssessmentProvenance {
  return {
    version: idx?.version ?? null,
    file: idx?.file.name ?? null,
    fileModifiedAt: idx?.file.modifiedAt ?? null,
    factorReferences,
    referenceDir: referenceDir(ctx.env, ID),
  };
}

function matchSector(idx: VersionIndex, sector: string): string | null {
  const s = sector.trim().toLowerCase();
  const exact = idx.sectors.find((x) => x.toLowerCase() === s);
  if (exact) return exact;
  const partial = idx.sectors.filter((x) => x.toLowerCase().includes(s) || s.includes(x.toLowerCase()));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Compares the asset's computed values with the loaded NZCBS limits for a
 * sector and year. Absent file, absent sector or absent year is an explicit
 * not-assessable result with the reason, never an exception.
 */
export function nzcbsAssessment(db: Db, ctx: OperationContext, asset: AssetRecord, meters: AssetMeter[], opts: NzcbsOptions): NzcbsAssessment {
  const carbon = assetCarbon(db, ctx, meters, opts.year);
  const intensity = assetIntensity(carbon, asset.floorAreaM2);
  const factorRefs = carbonFactorReferences(carbon);
  const requestedSector = (opts.sector ?? asset.propertyType ?? "").trim();

  const base = {
    year: opts.year,
    intensity,
    disclaimer: NZCBS_DISCLAIMER,
    rows: [] as NzcbsMetricRow[],
    counts: { pass: 0, fail: 0, notAssessable: 0 },
    warnings: [] as string[],
  };

  const versions = loadVersions(ctx);
  const idx = opts.version ? versions.find((v) => v.version === opts.version) : versions[0];
  if (!idx) {
    const loaded = versions.map((v) => v.version).join(", ") || "none";
    const reason = opts.version
      ? `UK NZCBS version ${opts.version} is not loaded (loaded: ${loaded}). Save it as ${opts.version}.csv in ${referenceDir(ctx.env, ID)}.`
      : `No UK NZCBS limit file is loaded in ${referenceDir(ctx.env, ID)}, so there is nothing to check against.`;
    return { ...base, assessable: false, sector: requestedSector || null, version: null, summary: "Cannot check against the UK NZCBS: no limit table loaded.", reasons: [reason], provenance: provenanceOf(ctx, undefined, factorRefs) };
  }

  const provenance = provenanceOf(ctx, idx, factorRefs);

  if (!requestedSector) {
    return {
      ...base,
      assessable: false,
      sector: null,
      version: idx.version,
      summary: "Cannot check against the UK NZCBS: no sector.",
      reasons: [`No sector was supplied and the asset has no property type, so no limits can be selected. Sectors in ${idx.version}: ${idx.sectors.join(", ") || "none"}.`],
      provenance,
    };
  }

  const sector = matchSector(idx, requestedSector);
  if (!sector) {
    return {
      ...base,
      assessable: false,
      sector: requestedSector,
      version: idx.version,
      summary: `Cannot check against the UK NZCBS: sector "${requestedSector}" is not in the loaded limit table.`,
      reasons: [`UK NZCBS ${idx.version} has no sector matching "${requestedSector}". Sectors loaded: ${idx.sectors.join(", ") || "none"}.`],
      provenance,
    };
  }

  const forSector = idx.rows.filter((r) => r.sector === sector);
  const forYear = forSector.filter((r) => r.year === null || r.year === opts.year);
  if (forYear.length === 0) {
    const years = [...new Set(forSector.map((r) => r.year).filter((y): y is number => y !== null))].sort((a, b) => a - b);
    return {
      ...base,
      assessable: false,
      sector,
      version: idx.version,
      summary: `Cannot check against the UK NZCBS: no ${sector} limits for ${opts.year} in ${idx.version}.`,
      reasons: [`UK NZCBS ${idx.version} has ${forSector.length} row(s) for ${sector} but none for ${opts.year}. Years in the file for this sector: ${years.join(", ") || "none"}.`],
      provenance,
    };
  }

  const eui = intensity.energyKwhPerM2;
  const rows: NzcbsMetricRow[] = forYear.map((r: LimitRow) => {
    const operational = isOperationalEnergyMetric(r.metric);
    const unitOk = looksLikeKwhPerM2(r.unit);
    let assetValue: number | null = null;
    let reason = `The portal does not compute "${r.metric}" from meter data. Supply it from the relevant assessment (for example a RICS whole life carbon assessment for embodied carbon, or generation metering for on-site renewables).`;

    if (operational && !unitOk) {
      reason = `Metric "${r.metric}" is an operational energy metric but its unit "${r.unit}" is not kWh/m2, so the portal's energy use intensity was not compared with it.`;
    } else if (operational && eui === null) {
      reason = `The portal could not compute the asset's energy use intensity for ${opts.year}: ${intensity.reasons.join(" ") || "no metered import and no floor area."}`;
    } else if (operational) {
      assetValue = eui;
      reason = `Asset value is the portal's metered energy use intensity for ${opts.year} (import electricity + gas over ${intensity.floorAreaM2} m2). Check the floor-area basis matches the Standard's.`;
    }

    if (r.limit_value === null) {
      return { metric: r.metric, limitValue: null, unit: r.unit, year: r.year, assetValue, status: "not_assessable" as const, gap: null, reason: `The loaded ${idx.version} table sets no limit for ${sector} / ${r.metric}${r.year === null ? "" : ` in ${r.year}`} (blank in the file, which is not a limit of zero).`, notes: r.notes };
    }
    if (assetValue === null) {
      return { metric: r.metric, limitValue: r.limit_value, unit: r.unit, year: r.year, assetValue: null, status: "not_assessable" as const, gap: null, reason, notes: r.notes };
    }
    const gap = round(assetValue - r.limit_value);
    return { metric: r.metric, limitValue: r.limit_value, unit: r.unit, year: r.year, assetValue, status: (gap > 0 ? "fail" : "pass") as NzcbsStatus, gap, reason, notes: r.notes };
  });

  const counts = {
    pass: rows.filter((r) => r.status === "pass").length,
    fail: rows.filter((r) => r.status === "fail").length,
    notAssessable: rows.filter((r) => r.status === "not_assessable").length,
  };

  const headline = rows.find((r) => isOperationalEnergyMetric(r.metric) && r.status !== "not_assessable");
  const summary =
    `Indicative check of ${asset.name} against the loaded UK NZCBS ${idx.version} limits for ${sector} in ${opts.year}: ` +
    `${counts.pass} pass, ${counts.fail} fail, ${counts.notAssessable} not assessable from portal data` +
    (headline ? `. Operational energy: ${headline.assetValue} against a limit of ${headline.limitValue} ${headline.unit} (${headline.status === "pass" ? "within" : "above"} the limit by ${Math.abs(headline.gap ?? 0)} ${headline.unit}).` : ".") +
    " This is not a verified NZCBS assessment.";

  return {
    ...base,
    assessable: true,
    sector,
    version: idx.version,
    summary,
    reasons: [],
    rows,
    counts,
    provenance,
    warnings: [...new Set([NZCBS_DISCLAIMER, ...(counts.notAssessable ? ["Metrics the portal cannot compute (embodied carbon, on-site renewables and similar) are reported as not assessable, never as a pass."] : []), ...carbon.warnings])],
  };
}
