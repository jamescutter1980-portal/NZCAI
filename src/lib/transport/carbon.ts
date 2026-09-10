import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { desnzRowById, type ResolvedFactor } from "@/lib/carbon/factors";
import type { Period } from "@/lib/carbon/period";
import { TransportRepository } from "./repo";
import { TRANSPORT_CATEGORIES, normaliseUnit, unitConversion, type ActivityRecord, type TransportCategory, type VehicleRecord } from "./types";

/**
 * Transport and business travel emissions for a reporting period.
 *
 * Each activity points at a DESNZ flat-file row, so the factor value, its unit
 * and its published Scope all come from the loaded file. The engine checks that
 * the row's Scope matches the GHG Protocol category the activity was filed
 * under, and that the activity's unit matches the factor's, converting only
 * between distance units and saying so. A line with no usable factor reports
 * null with the reason, never zero.
 */
export interface TransportLine {
  id: string;
  category: TransportCategory;
  categoryLabel: string;
  ghgCategory: string;
  scope: 1 | 3;
  label: string;
  periodStart: string;
  periodEnd: string;
  quantity: number;
  unit: string;
  /** Quantity in the factor's own unit, when a conversion was needed. */
  convertedQuantity: number | null;
  factorUnit: string | null;
  conversionNote?: string;
  factor: ResolvedFactor;
  kgCo2e: number | null;
  basis: string;
  evidence?: string;
  vehicle?: string;
  assetId?: string;
  warnings: string[];
}

export interface TransportCategoryTotal {
  ghgCategory: string;
  scope: 1 | 3;
  kgCo2e: number | null;
  lines: number;
  /** Lines that could not be calculated, so the total is incomplete. */
  unresolved: number;
}

export interface TransportCarbon {
  period: Period;
  lines: TransportLine[];
  byGhgCategory: TransportCategoryTotal[];
  totals: { scope1: number | null; scope3: number | null; total: number | null };
  counts: { lines: number; resolved: number; unresolved: number };
  factorReferences: string[];
  warnings: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function transportCarbon(db: Db, ctx: OperationContext, period: Period, vehicles?: VehicleRecord[]): TransportCarbon {
  const repo = new TransportRepository(db);
  const activities = repo.listActivity({ from: period.from.slice(0, 10), to: period.to.slice(0, 10) });
  const vehicleById = new Map((vehicles ?? repo.listVehicles()).map((v) => [v.id, v]));
  const warnings: string[] = [];
  const factorReferences = new Set<string>();
  const periodEndDate = period.to.slice(0, 10);

  const lines = activities.map((a) => buildLine(ctx, a, vehicleById, period, periodEndDate, factorReferences));

  for (const l of lines) for (const w of l.warnings) warnings.push(`${l.label}: ${w}`);

  const groups = new Map<string, TransportCategoryTotal & { known: number[] }>();
  for (const l of lines) {
    const key = l.ghgCategory;
    const g = groups.get(key) ?? { ghgCategory: key, scope: l.scope, kgCo2e: 0, lines: 0, unresolved: 0, known: [] };
    g.lines += 1;
    if (l.kgCo2e === null) g.unresolved += 1;
    else g.known.push(l.kgCo2e);
    groups.set(key, g);
  }
  const byGhgCategory: TransportCategoryTotal[] = [...groups.values()].map((g) => ({
    ghgCategory: g.ghgCategory,
    scope: g.scope,
    lines: g.lines,
    unresolved: g.unresolved,
    kgCo2e: g.unresolved > 0 ? null : round(g.known.reduce((n, v) => n + v, 0)),
  }));

  const scopeTotal = (scope: 1 | 3) => {
    const inScope = byGhgCategory.filter((g) => g.scope === scope);
    if (inScope.length === 0) return 0;
    return inScope.some((g) => g.kgCo2e === null) ? null : round(inScope.reduce((n, g) => n + (g.kgCo2e ?? 0), 0));
  };
  const scope1 = scopeTotal(1);
  const scope3 = scopeTotal(3);

  const unresolved = lines.filter((l) => l.kgCo2e === null).length;
  if (unresolved > 0) warnings.push(`${unresolved} of ${lines.length} transport lines could not be calculated, so the totals they belong to are blank rather than zero.`);

  return {
    period,
    lines,
    byGhgCategory: byGhgCategory.sort((a, b) => a.scope - b.scope || a.ghgCategory.localeCompare(b.ghgCategory)),
    totals: { scope1, scope3, total: scope1 === null || scope3 === null ? null : round(scope1 + scope3) },
    counts: { lines: lines.length, resolved: lines.length - unresolved, unresolved },
    factorReferences: [...factorReferences].sort(),
    warnings: [...new Set(warnings)],
  };
}

function buildLine(
  ctx: OperationContext,
  a: ActivityRecord,
  vehicleById: Map<string, VehicleRecord>,
  period: Period,
  periodEndDate: string,
  factorReferences: Set<string>,
): TransportLine {
  const meta = TRANSPORT_CATEGORIES[a.category];
  const lineWarnings: string[] = [];
  const vehicle = a.vehicleId ? vehicleById.get(a.vehicleId) : undefined;

  if (a.periodEnd >= periodEndDate) {
    lineWarnings.push(`Covers ${a.periodStart} to ${a.periodEnd}, which runs past the end of the reporting period. The whole quantity is counted here.`);
  }

  const base: Omit<TransportLine, "factor" | "kgCo2e" | "convertedQuantity" | "factorUnit"> = {
    id: a.id,
    category: a.category,
    categoryLabel: meta.label,
    ghgCategory: meta.ghgCategory,
    scope: meta.scope as 1 | 3,
    label: a.label,
    periodStart: a.periodStart,
    periodEnd: a.periodEnd,
    quantity: a.quantity,
    unit: a.unit,
    basis: a.basis ?? "client_declared",
    evidence: a.evidence,
    vehicle: vehicle ? [vehicle.registration, vehicle.make, vehicle.model].filter(Boolean).join(" ") : undefined,
    assetId: a.assetId,
    warnings: lineWarnings,
  };

  if (!a.factorId || a.factorYear === undefined) {
    return {
      ...base,
      convertedQuantity: null,
      factorUnit: null,
      factor: { value: null, unit: "", basis: "unavailable", source: "desnz-conversion-factors", reference: "no factor chosen", detail: "No conversion factor has been chosen for this activity." },
      kgCo2e: null,
    };
  }

  const factorYear = a.factorYear;
  const { row, factor } = desnzRowById(ctx, factorYear, a.factorId);
  if (factorYear !== period.factorYear) {
    lineWarnings.push(`Uses the ${factorYear} factor set while the period reports against ${period.factorYear}.`);
  }
  if (row && meta.expectedScope && !row.scope.toLowerCase().startsWith(meta.expectedScope.toLowerCase())) {
    lineWarnings.push(`Filed under ${meta.ghgCategory} but the chosen DESNZ row is published as ${row.scope}. Check the category or the factor.`);
  }
  if (factor.value === null) {
    if (factor.detail) lineWarnings.push(factor.detail);
    return { ...base, convertedQuantity: null, factorUnit: row ? row.uom : null, factor, kgCo2e: null };
  }

  const factorUnit = row?.uom ?? "";
  const conversion = unitConversion(a.unit, factorUnit);
  if (conversion === null) {
    lineWarnings.push(`Quantity is in ${a.unit} but the factor is per ${factorUnit}. Convert the quantity or choose a factor in ${a.unit}.`);
    return {
      ...base,
      convertedQuantity: null,
      factorUnit,
      factor: { ...factor, basis: "unavailable", detail: `Unit mismatch: ${a.unit} against a factor per ${factorUnit}.` },
      kgCo2e: null,
    };
  }
  const converted = round(a.quantity * conversion);
  const conversionNote =
    conversion === 1 ? undefined : `${a.quantity} ${a.unit} converted to ${converted} ${factorUnit} at ${conversion} ${factorUnit} per ${normaliseUnit(a.unit)}.`;
  factorReferences.add(factor.reference);
  return {
    ...base,
    convertedQuantity: converted,
    factorUnit,
    conversionNote,
    factor,
    kgCo2e: round(converted * factor.value),
  };
}
