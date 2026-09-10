import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { ResolvedFactor } from "@/lib/carbon/factors";
import { resolveFactorLine, round3 } from "@/lib/carbon/factor-line";
import type { Period } from "@/lib/carbon/period";
import { unitConversion } from "@/lib/carbon/units";
import { SiteActivityRepository } from "./repo";
import { EMISSION_CATEGORIES, type SiteActivityRecord } from "./types";

/**
 * Refrigerants, water and waste for a reporting period, on the same contract
 * as transport: each line points at a published DESNZ row, the unit and the
 * row's published scope are checked, and a line that cannot be calculated is
 * null with the reason rather than zero.
 */
export interface EmissionLine {
  id: string;
  category: string;
  categoryLabel: string;
  ghgCategory: string;
  scope: 1 | 3;
  family: "refrigerant" | "water" | "waste";
  label: string;
  assetId?: string;
  periodStart: string;
  periodEnd: string;
  quantity: number;
  unit: string;
  convertedQuantity: number | null;
  factorUnit: string | null;
  conversionNote?: string;
  refrigerantType?: string;
  wasteMaterial?: string;
  factor: ResolvedFactor;
  kgCo2e: number | null;
  basis: string;
  evidence?: string;
  warnings: string[];
}

export interface EmissionCategoryTotal {
  ghgCategory: string;
  scope: 1 | 3;
  kgCo2e: number | null;
  lines: number;
  unresolved: number;
}

/**
 * Landfill diversion over the waste lines, by mass. Null when any waste line is
 * in a unit that cannot be reconciled to a common mass, because a diversion
 * rate that mixes units is meaningless.
 */
export interface WasteSummary {
  totalTonnes: number | null;
  divertedTonnes: number | null;
  landfillTonnes: number | null;
  diversionRatePct: number | null;
  detail: string;
}

export interface EmissionsCarbon {
  period: Period;
  lines: EmissionLine[];
  byGhgCategory: EmissionCategoryTotal[];
  totals: { scope1: number | null; scope3: number | null; total: number | null };
  byFamily: { refrigerant: number | null; water: number | null; waste: number | null };
  waste: WasteSummary;
  counts: { lines: number; resolved: number; unresolved: number };
  factorReferences: string[];
  warnings: string[];
}

export function emissionsCarbon(db: Db, ctx: OperationContext, period: Period): EmissionsCarbon {
  const activities = new SiteActivityRepository(db).list({ from: period.from.slice(0, 10), to: period.to.slice(0, 10) });
  const factorReferences = new Set<string>();
  const warnings: string[] = [];
  const periodEndDate = period.to.slice(0, 10);

  const lines = activities.map((a) => buildLine(ctx, a, period, periodEndDate, factorReferences));
  for (const l of lines) for (const w of l.warnings) warnings.push(`${l.label}: ${w}`);

  const groups = new Map<string, EmissionCategoryTotal & { known: number[] }>();
  for (const l of lines) {
    const g = groups.get(l.ghgCategory) ?? { ghgCategory: l.ghgCategory, scope: l.scope, kgCo2e: 0, lines: 0, unresolved: 0, known: [] };
    g.lines += 1;
    if (l.kgCo2e === null) g.unresolved += 1;
    else g.known.push(l.kgCo2e);
    groups.set(l.ghgCategory, g);
  }
  const byGhgCategory: EmissionCategoryTotal[] = [...groups.values()].map((g) => ({
    ghgCategory: g.ghgCategory, scope: g.scope, lines: g.lines, unresolved: g.unresolved,
    kgCo2e: g.unresolved > 0 ? null : round3(g.known.reduce((n, v) => n + v, 0)),
  }));

  const familyTotal = (family: EmissionLine["family"]) => {
    const inFamily = lines.filter((l) => l.family === family);
    if (inFamily.length === 0) return 0;
    return inFamily.some((l) => l.kgCo2e === null) ? null : round3(inFamily.reduce((n, l) => n + (l.kgCo2e ?? 0), 0));
  };
  const scopeTotal = (scope: 1 | 3) => {
    const inScope = byGhgCategory.filter((g) => g.scope === scope);
    if (inScope.length === 0) return 0;
    return inScope.some((g) => g.kgCo2e === null) ? null : round3(inScope.reduce((n, g) => n + (g.kgCo2e ?? 0), 0));
  };
  const scope1 = scopeTotal(1);
  const scope3 = scopeTotal(3);
  const unresolved = lines.filter((l) => l.kgCo2e === null).length;
  if (unresolved > 0) warnings.push(`${unresolved} of ${lines.length} lines could not be calculated, so the totals they belong to are blank rather than zero.`);

  return {
    period,
    lines,
    byGhgCategory: byGhgCategory.sort((a, b) => a.scope - b.scope || a.ghgCategory.localeCompare(b.ghgCategory)),
    totals: { scope1, scope3, total: scope1 === null || scope3 === null ? null : round3(scope1 + scope3) },
    byFamily: { refrigerant: familyTotal("refrigerant"), water: familyTotal("water"), waste: familyTotal("waste") },
    waste: wasteSummary(lines),
    counts: { lines: lines.length, resolved: lines.length - unresolved, unresolved },
    factorReferences: [...factorReferences].sort(),
    warnings: [...new Set(warnings)],
  };
}

/** Diversion is a mass ratio, so every waste line must reconcile to tonnes. */
export function wasteSummary(lines: EmissionLine[]): WasteSummary {
  const waste = lines.filter((l) => l.family === "waste");
  if (waste.length === 0) {
    return { totalTonnes: null, divertedTonnes: null, landfillTonnes: null, diversionRatePct: null, detail: "No waste recorded for this period." };
  }
  let total = 0;
  let diverted = 0;
  let landfill = 0;
  const unconvertible: string[] = [];
  for (const l of waste) {
    const toTonnes = unitConversion(l.unit, "tonnes");
    if (toTonnes === null) {
      unconvertible.push(`${l.label} (${l.unit})`);
      continue;
    }
    const t = l.quantity * toTonnes;
    total += t;
    if (EMISSION_CATEGORIES[l.category]?.diverted) diverted += t;
    else landfill += t;
  }
  if (unconvertible.length > 0) {
    return {
      totalTonnes: null, divertedTonnes: null, landfillTonnes: null, diversionRatePct: null,
      detail: `Diversion cannot be calculated because ${unconvertible.join(", ")} ${unconvertible.length === 1 ? "is" : "are"} not in a unit that converts to tonnes. Record waste in kg or tonnes.`,
    };
  }
  return {
    totalTonnes: round3(total),
    divertedTonnes: round3(diverted),
    landfillTonnes: round3(landfill),
    diversionRatePct: total > 0 ? round3((diverted / total) * 100) : null,
    detail: total > 0
      ? `${round3(diverted)} of ${round3(total)} tonnes diverted from landfill. Energy recovery counts as diverted.`
      : "Waste lines are recorded but total zero tonnes.",
  };
}

function buildLine(ctx: OperationContext, a: SiteActivityRecord, period: Period, periodEndDate: string, factorReferences: Set<string>): EmissionLine {
  const meta = EMISSION_CATEGORIES[a.category];
  const warnings: string[] = [];
  if (a.periodEnd >= periodEndDate) {
    warnings.push(`Covers ${a.periodStart} to ${a.periodEnd}, which runs past the end of the reporting period. The whole quantity is counted here.`);
  }
  if (meta?.family === "refrigerant" && !a.refrigerantType) {
    warnings.push("No refrigerant named, so the chosen factor cannot be checked against the gas. Record the refrigerant, for example R410A.");
  }
  const resolved = resolveFactorLine(ctx, {
    factorId: a.factorId,
    factorYear: a.factorYear,
    quantity: a.quantity,
    unit: a.unit,
    periodFactorYear: period.factorYear,
    expectedScope: meta?.expectedScope,
    categoryLabel: meta?.ghgCategory,
  });
  warnings.push(...resolved.warnings);
  if (resolved.kgCo2e !== null) factorReferences.add(resolved.factor.reference);
  return {
    id: a.id,
    category: a.category,
    categoryLabel: meta?.label ?? a.category,
    ghgCategory: meta?.ghgCategory ?? "Uncategorised",
    scope: (meta?.scope ?? 3) as 1 | 3,
    family: meta?.family ?? "waste",
    label: a.label,
    assetId: a.assetId,
    periodStart: a.periodStart,
    periodEnd: a.periodEnd,
    quantity: a.quantity,
    unit: a.unit,
    convertedQuantity: resolved.convertedQuantity,
    factorUnit: resolved.factorUnit,
    conversionNote: resolved.conversionNote,
    refrigerantType: a.refrigerantType,
    wasteMaterial: a.wasteMaterial,
    factor: resolved.factor,
    kgCo2e: resolved.kgCo2e,
    basis: a.basis ?? "client_declared",
    evidence: a.evidence,
    warnings,
  };
}
