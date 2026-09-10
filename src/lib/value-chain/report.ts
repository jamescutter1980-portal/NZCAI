import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { ResolvedFactor } from "@/lib/carbon/factors";
import { resolveFactorLine, round3 } from "@/lib/carbon/factor-line";
import type { Period } from "@/lib/carbon/period";
import { nextAction, type NextAction } from "./lifecycle";
import { ActivityLedgerRepository, CounterpartyRepository, EmissionsReportRepository, EngagementRepository } from "./repo";
import {
  ALLOCATION_LABELS,
  categoryLabel,
  directionOf,
  isPrimary,
  type ActivityRecord,
  type CounterpartyRecord,
  type EmissionsReportRecord,
  type EngagementRecord,
  type EngagementState,
  type Tier,
} from "./types";

/**
 * The value chain for a reporting period: every counterparty with the state
 * of its engagement, the emissions attributable to the client from what it
 * returned, the data quality tier of that figure, and what to do next.
 *
 * House rules as elsewhere in the portal: a figure that cannot be computed is
 * null with the reason, never zero; a total that contains a null is null; the
 * allocation basis and the evidence travel with every number.
 */

export interface ReportFigure {
  id: string;
  periodStart: string;
  periodEnd: string;
  scope1Tco2e: number | null;
  scope2LocationTco2e: number | null;
  scope2MarketTco2e: number | null;
  scope3Tco2e: number | null;
  /** Scope 1 + Scope 2 (market where reported, else location) + Scope 3, over the figures that were reported. */
  reportedTotalTco2e: number | null;
  allocationMethod: EmissionsReportRecord["allocationMethod"];
  allocationDetail: string;
  attributableTco2e: number | null;
  tier: Tier | null;
  assurance: EmissionsReportRecord["assurance"];
  assuranceProvider?: string;
  methodology: EmissionsReportRecord["methodology"];
  boundary: EmissionsReportRecord["boundary"];
  basis: EmissionsReportRecord["basis"];
  evidence?: string;
  warnings: string[];
}

export interface LedgerLine {
  id: string;
  label: string;
  activityType: string;
  periodStart: string;
  periodEnd: string;
  quantity: number;
  unit: string;
  sharePct: number;
  factor: ResolvedFactor;
  conversionNote?: string;
  /** Before the share is applied. */
  lineKgCo2e: number | null;
  /** After the share is applied. */
  kgCo2e: number | null;
  tier: Tier | null;
  basis: ActivityRecord["basis"];
  evidence?: string;
  warnings: string[];
}

export interface LedgerSummary {
  lines: LedgerLine[];
  counts: { lines: number; resolved: number; unresolved: number };
  attributableTco2e: number | null;
  tier: Tier | null;
  warnings: string[];
}

export type DataSource = "report" | "ledger" | "none";

export interface CounterpartyView {
  counterparty: CounterpartyRecord;
  direction: ReturnType<typeof directionOf>;
  categories: { id: string; label: string }[];
  engagement?: EngagementRecord;
  state: EngagementState;
  report?: ReportFigure;
  ledger: LedgerSummary;
  dataSource: DataSource;
  attributableTco2e: number | null;
  tier: Tier | null;
  primary: boolean;
  /** Present when both a report and a ledger are held, so the two can be compared. */
  reconciliation?: { reportTco2e: number | null; ledgerTco2e: number | null; variancePct: number | null; detail: string };
  next: NextAction;
  warnings: string[];
}

export interface CategoryTotal {
  category: string;
  label: string;
  counterparties: number;
  withData: number;
  tco2e: number | null;
}

export interface ValueChainReport {
  period: Period;
  reportingYear: number;
  counterparties: CounterpartyView[];
  coverage: {
    total: number;
    active: number;
    upstream: number;
    downstream: number;
    both: number;
    asked: number;
    withData: number;
    verified: number;
    declined: number;
    unreachable: number;
    dueNow: number;
    overdue: number;
    /** Annual value across active counterparties, and the share of it backed by returned data. */
    valueTotalGbp: number;
    valueWithDataGbp: number;
    valueCoveredPct: number | null;
    /** Active counterparties with no annual value recorded, which the ranking cannot place. */
    unvalued: number;
  };
  totals: {
    attributableTco2e: number | null;
    resolved: number;
    unresolved: number;
    primaryTco2e: number | null;
    primarySharePct: number | null;
    byDirection: { upstream: number | null; downstream: number | null };
    byCategory: CategoryTotal[];
    byTier: Record<Tier, number>;
  };
  /** Ranked worklist: what is due, most valuable first. */
  plan: { counterpartyId: string; name: string; annualValueGbp?: number; state: EngagementState; action: string; reason: string; overdue: boolean }[];
  factorReferences: string[];
  warnings: string[];
}

/** The reporting year an engagement is keyed on: the year the period starts in. */
export const reportingYearOf = (period: Period) => Number(period.from.slice(0, 4));

export function valueChainReport(db: Db, ctx: OperationContext, period: Period, opts: { today?: string } = {}): ValueChainReport {
  const reportingYear = reportingYearOf(period);
  const today = opts.today ?? ctx.now().toISOString().slice(0, 10);
  const counterparties = new CounterpartyRepository(db).list();
  const engagements = new Map(new EngagementRepository(db).listForYear(reportingYear).map((e) => [e.counterpartyId, e]));
  const reports = groupBy(new EmissionsReportRepository(db).list({ reportingYear }), (r) => r.counterpartyId);
  const activity = groupBy(new ActivityLedgerRepository(db).list({ reportingYear }), (a) => a.counterpartyId);
  const factorReferences = new Set<string>();
  const warnings: string[] = [];

  const views = counterparties.map((c) => buildView(ctx, c, period, reportingYear, today, engagements.get(c.id), reports.get(c.id) ?? [], activity.get(c.id) ?? [], factorReferences));
  for (const v of views) for (const w of v.warnings) warnings.push(`${v.counterparty.name}: ${w}`);

  const active = views.filter((v) => v.counterparty.status === "active");
  const withData = active.filter((v) => v.dataSource !== "none");
  const valueOf = (v: CounterpartyView) => v.counterparty.annualValueGbp ?? 0;
  const valueTotal = active.reduce((n, v) => n + valueOf(v), 0);
  const valueWithData = withData.reduce((n, v) => n + valueOf(v), 0);
  const unvalued = active.filter((v) => v.counterparty.annualValueGbp === undefined).length;
  if (unvalued > 0) warnings.push(`${unvalued} active counterpart${unvalued === 1 ? "y has" : "ies have"} no annual value recorded, so the value-covered figure and the ranking leave ${unvalued === 1 ? "it" : "them"} out.`);

  const resolvedViews = active.filter((v) => v.attributableTco2e !== null);
  const unresolved = withData.filter((v) => v.attributableTco2e === null).length;
  const sum = (vs: CounterpartyView[]) => (vs.some((v) => v.attributableTco2e === null) ? null : round3(vs.reduce((n, v) => n + (v.attributableTco2e ?? 0), 0)));
  const attributable = withData.length === 0 ? 0 : sum(withData);
  const primaryViews = withData.filter((v) => v.primary);
  const primaryTco2e = primaryViews.length === 0 ? 0 : sum(primaryViews);
  const primarySharePct = attributable === null || primaryTco2e === null ? null : attributable > 0 ? round3((primaryTco2e / attributable) * 100) : null;
  if (unresolved > 0) warnings.push(`${unresolved} counterpart${unresolved === 1 ? "y" : "ies"} returned data that cannot be turned into a figure yet, so the attributable total is blank rather than understated.`);

  const byDirection = (dir: "upstream" | "downstream") => {
    const own = withData.filter((v) => v.direction === dir || v.direction === "both");
    return own.length === 0 ? 0 : sum(own);
  };
  const byTier: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const v of resolvedViews) if (v.tier) byTier[v.tier] += 1;

  const plan = active
    .filter((v) => v.next.due)
    .sort((a, b) => Number(b.next.overdue) - Number(a.next.overdue) || (b.counterparty.annualValueGbp ?? -1) - (a.counterparty.annualValueGbp ?? -1) || a.counterparty.name.localeCompare(b.counterparty.name))
    .map((v) => ({ counterpartyId: v.counterparty.id, name: v.counterparty.name, annualValueGbp: v.counterparty.annualValueGbp, state: v.state, action: v.next.action, reason: v.next.reason, overdue: v.next.overdue }));

  return {
    period,
    reportingYear,
    counterparties: views,
    coverage: {
      total: views.length,
      active: active.length,
      upstream: active.filter((v) => v.direction === "upstream").length,
      downstream: active.filter((v) => v.direction === "downstream").length,
      both: active.filter((v) => v.direction === "both").length,
      asked: active.filter((v) => v.state !== "identified").length,
      withData: withData.length,
      verified: active.filter((v) => v.state === "verified").length,
      declined: active.filter((v) => v.state === "declined").length,
      unreachable: active.filter((v) => v.state === "unreachable").length,
      dueNow: plan.length,
      overdue: plan.filter((p) => p.overdue).length,
      valueTotalGbp: round3(valueTotal),
      valueWithDataGbp: round3(valueWithData),
      valueCoveredPct: valueTotal > 0 ? round3((valueWithData / valueTotal) * 100) : null,
      unvalued,
    },
    totals: {
      attributableTco2e: attributable,
      resolved: resolvedViews.length,
      unresolved,
      primaryTco2e,
      primarySharePct,
      byDirection: { upstream: byDirection("upstream"), downstream: byDirection("downstream") },
      byCategory: categoryTotals(active),
      byTier,
    },
    plan,
    factorReferences: [...factorReferences].sort(),
    warnings: [...new Set(warnings)],
  };
}

/* ------------------------------------------------------------------ */
/* one counterparty                                                    */
/* ------------------------------------------------------------------ */

function buildView(
  ctx: OperationContext,
  c: CounterpartyRecord,
  period: Period,
  reportingYear: number,
  today: string,
  engagement: EngagementRecord | undefined,
  reports: EmissionsReportRecord[],
  activity: ActivityRecord[],
  factorReferences: Set<string>,
): CounterpartyView {
  const warnings: string[] = [];
  const report = reports.length > 0 ? reportFigure(c, reports[0], period) : undefined;
  if (reports.length > 1) warnings.push(`${reports.length} annual reports are held for ${reportingYear}; the one covering ${reports[0].periodStart} to ${reports[0].periodEnd} is used. Delete the others.`);
  const ledger = ledgerSummary(ctx, activity, period, factorReferences);
  if (report) warnings.push(...report.warnings);
  warnings.push(...ledger.warnings);

  const dataSource: DataSource = report ? "report" : ledger.counts.lines > 0 ? "ledger" : "none";
  const attributableTco2e = dataSource === "report" ? report!.attributableTco2e : dataSource === "ledger" ? ledger.attributableTco2e : null;
  const tier = dataSource === "report" ? report!.tier : dataSource === "ledger" ? ledger.tier : null;

  let reconciliation: CounterpartyView["reconciliation"];
  if (report && ledger.counts.lines > 0) {
    const a = report.attributableTco2e;
    const b = ledger.attributableTco2e;
    const variancePct = a !== null && b !== null && a > 0 ? round3(((b - a) / a) * 100) : null;
    reconciliation = {
      reportTco2e: a,
      ledgerTco2e: b,
      variancePct,
      detail:
        variancePct === null
          ? "Both a report and a ledger are held but one of them cannot be calculated, so they cannot be compared."
          : `The ledger gives ${round3(b!)} tCO2e against ${round3(a!)} tCO2e from the report, a ${variancePct > 0 ? "+" : ""}${variancePct}% variance. The report is used; a persistent gap is a question for the counterparty.`,
    };
    if (variancePct !== null && Math.abs(variancePct) > 25) warnings.push(reconciliation.detail);
  }

  const state: EngagementState = engagement?.state ?? "identified";
  if (dataSource !== "none" && (state === "declined" || state === "unreachable")) warnings.push(`Data for ${reportingYear} is held but the engagement is marked ${state}. Reopen it and record the data as received.`);
  if (report && !report.evidence) warnings.push("The annual report figures have no evidence reference. Record the document title and page, or the file name, so the figure can be traced.");

  return {
    counterparty: c,
    direction: directionOf(c.roles),
    categories: c.ghgCategories.map((id) => ({ id, label: categoryLabel(id) })),
    engagement,
    state,
    report,
    ledger,
    dataSource,
    attributableTco2e,
    tier,
    primary: isPrimary(tier) && attributableTco2e !== null,
    reconciliation,
    next: nextAction(engagement, c, { report: report !== undefined, ledgerLines: ledger.counts.lines }, today),
    warnings: [...new Set(warnings)],
  };
}

/* ------------------------------------------------------------------ */
/* annual report: allocation and tier                                  */
/* ------------------------------------------------------------------ */

export function reportFigure(c: CounterpartyRecord, r: EmissionsReportRecord, period: Period): ReportFigure {
  const warnings: string[] = [];
  const s1 = r.scope1Tco2e ?? null;
  const s2l = r.scope2LocationTco2e ?? null;
  const s2m = r.scope2MarketTco2e ?? null;
  const s3 = r.scope3Tco2e ?? null;
  const s2 = s2m ?? s2l;
  const parts = [s1, s2, s3].filter((v): v is number => v !== null);
  const reportedTotal = parts.length > 0 ? round3(parts.reduce((n, v) => n + v, 0)) : null;

  const periodFrom = period.from.slice(0, 10);
  const periodTo = period.to.slice(0, 10);
  if (r.periodEnd < periodFrom || r.periodStart >= periodTo) {
    warnings.push(`The report covers ${r.periodStart} to ${r.periodEnd}, which does not overlap the reporting period ${period.label}. Check the reporting year it is filed under.`);
  }
  if (s1 !== null && s2 === null) warnings.push("Scope 2 is not reported, so the total omits their purchased energy.");
  if (s3 === null && (r.allocationMethod === "spend_share" || r.allocationMethod === "supplier_total")) {
    warnings.push("Scope 3 is not reported, so the attributable figure covers their Scope 1 and 2 only, not cradle-to-gate.");
  }
  if (s3 !== null && (r.allocationMethod === "spend_share" || r.allocationMethod === "supplier_total")) {
    warnings.push("Their Scope 3 is included. Check that it is upstream only; a counterparty's downstream Scope 3 would double count what we report elsewhere.");
  }
  if (s2m !== null && s2l !== null) warnings.push("Market-based Scope 2 is used for the total; the location-based figure is held alongside it.");

  let attributable: number | null = null;
  let allocationDetail = ALLOCATION_LABELS[r.allocationMethod];
  switch (r.allocationMethod) {
    case "supplier_total":
      attributable = reportedTotal;
      allocationDetail = `Whole reported footprint of ${reportedTotal ?? "unknown"} tCO2e counted. Appropriate only where ${c.name} works solely for us or the asset is wholly ours.`;
      break;
    case "spend_share": {
      if (reportedTotal === null) {
        allocationDetail = "No reported total to take a share of.";
        warnings.push("A spend share needs at least one reported scope figure.");
      } else if (c.annualValueGbp === undefined) {
        allocationDetail = "Our annual value with the counterparty is not recorded, so the share cannot be calculated.";
        warnings.push("Record the annual spend with (or revenue from) this counterparty to calculate a spend share.");
      } else if (r.supplierRevenueGbp === undefined || r.supplierRevenueGbp <= 0) {
        allocationDetail = "The counterparty's revenue is not recorded, so the share cannot be calculated.";
        warnings.push("Record the counterparty's revenue for the period to calculate a spend share.");
      } else {
        const share = c.annualValueGbp / r.supplierRevenueGbp;
        if (share > 1) {
          allocationDetail = `Our value (£${c.annualValueGbp}) exceeds their revenue (£${r.supplierRevenueGbp}), so the share is refused rather than capped.`;
          warnings.push("Our annual value with the counterparty exceeds their reported revenue. One of the two figures is wrong.");
        } else {
          attributable = round3(reportedTotal * share);
          allocationDetail = `${reportedTotal} tCO2e × £${c.annualValueGbp} ÷ £${r.supplierRevenueGbp} (${round3(share * 100)}% of their revenue).`;
        }
      }
      break;
    }
    case "supplier_allocated":
      attributable = r.allocatedTco2e ?? null;
      allocationDetail = `${c.name} stated ${attributable ?? "no"} tCO2e as attributable to us${reportedTotal !== null ? ` out of a reported ${reportedTotal} tCO2e` : ""}.`;
      break;
    case "product_specific":
      attributable = r.allocatedTco2e ?? null;
      allocationDetail = `Product- or service-specific footprint of ${attributable ?? "unknown"} tCO2e for what we bought.`;
      break;
  }
  if (attributable !== null && reportedTotal !== null && attributable > reportedTotal) warnings.push("The attributable figure exceeds the counterparty's whole reported footprint. Check the allocation.");

  return {
    id: r.id,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    scope1Tco2e: s1,
    scope2LocationTco2e: s2l,
    scope2MarketTco2e: s2m,
    scope3Tco2e: s3,
    reportedTotalTco2e: reportedTotal,
    allocationMethod: r.allocationMethod,
    allocationDetail,
    attributableTco2e: attributable,
    tier: attributable === null ? null : reportTier(r),
    assurance: r.assurance,
    assuranceProvider: r.assuranceProvider,
    methodology: r.methodology,
    boundary: r.boundary,
    basis: r.basis,
    evidence: r.evidence,
    warnings,
  };
}

/** Data quality tier of a reported figure, per the GHG Protocol Scope 3 method hierarchy. */
export function reportTier(r: Pick<EmissionsReportRecord, "allocationMethod" | "assurance" | "basis">): Tier {
  if (r.basis === "estimated") return "E";
  switch (r.allocationMethod) {
    case "product_specific":
      return "A";
    case "supplier_allocated":
      return r.assurance === "none" ? "B" : "A";
    case "spend_share":
    case "supplier_total":
      return "B";
  }
}

/* ------------------------------------------------------------------ */
/* activity ledger                                                     */
/* ------------------------------------------------------------------ */

export function ledgerSummary(ctx: OperationContext, activity: ActivityRecord[], period: Period, factorReferences: Set<string>): LedgerSummary {
  const periodEndDate = period.to.slice(0, 10);
  const lines = activity.map((a) => ledgerLine(ctx, a, period, periodEndDate, factorReferences));
  const unresolved = lines.filter((l) => l.kgCo2e === null).length;
  const warnings = lines.flatMap((l) => l.warnings.map((w) => `${l.label}: ${w}`));
  if (unresolved > 0) warnings.push(`${unresolved} of ${lines.length} ledger lines cannot be calculated, so the ledger total is blank rather than understated.`);
  const attributableTco2e = lines.length === 0 ? null : unresolved > 0 ? null : round3(lines.reduce((n, l) => n + (l.kgCo2e ?? 0), 0) / 1000);
  const tiers = lines.filter((l) => l.kgCo2e !== null).map((l) => l.tier).filter((t): t is Tier => t !== null);
  const tier: Tier | null = attributableTco2e === null ? null : tiers.includes("E") ? "E" : tiers.includes("C") ? "C" : tiers.includes("B") ? "B" : null;
  return { lines, counts: { lines: lines.length, resolved: lines.length - unresolved, unresolved }, attributableTco2e, tier, warnings: [...new Set(warnings)] };
}

function ledgerLine(ctx: OperationContext, a: ActivityRecord, period: Period, periodEndDate: string, factorReferences: Set<string>): LedgerLine {
  const warnings: string[] = [];
  if (a.periodEnd >= periodEndDate) warnings.push(`Covers ${a.periodStart} to ${a.periodEnd}, which runs past the end of the reporting period. The whole quantity is counted here.`);

  let factor: ResolvedFactor;
  let lineKg: number | null;
  let tier: Tier | null;
  let conversionNote: string | undefined;
  if (a.factorId) {
    const resolved = resolveFactorLine(ctx, { factorId: a.factorId, factorYear: a.factorYear, quantity: a.quantity, unit: a.unit, periodFactorYear: period.factorYear });
    warnings.push(...resolved.warnings);
    factor = resolved.factor;
    lineKg = resolved.kgCo2e;
    conversionNote = resolved.conversionNote;
    tier = a.basis === "estimated" ? "E" : "C";
    if (lineKg !== null) factorReferences.add(factor.reference);
    if (a.declaredKgCo2e !== undefined && lineKg !== null && a.declaredKgCo2e > 0) {
      const variance = round3(((lineKg - a.declaredKgCo2e) / a.declaredKgCo2e) * 100);
      if (Math.abs(variance) > 10) warnings.push(`The DESNZ factor gives ${lineKg} kgCO2e against the counterparty's own ${a.declaredKgCo2e} kgCO2e (${variance > 0 ? "+" : ""}${variance}%). The factor figure is used.`);
    }
  } else if (a.declaredKgCo2e !== undefined) {
    factor = { value: null, unit: "", basis: "client_declared", source: "counterparty", reference: "counterparty's own calculation", detail: "No DESNZ row chosen; the counterparty's own kgCO2e is used as declared." };
    lineKg = round3(a.declaredKgCo2e);
    tier = a.basis === "estimated" ? "E" : "B";
  } else {
    factor = { value: null, unit: "", basis: "unavailable", source: "desnz-conversion-factors", reference: "no factor chosen", detail: "No conversion factor has been chosen and the counterparty declared no kgCO2e." };
    lineKg = null;
    tier = null;
    warnings.push("Choose a DESNZ factor row for this line, or record the kgCO2e the counterparty declared.");
  }
  const kg = lineKg === null ? null : round3((lineKg * a.sharePct) / 100);
  return {
    id: a.id, label: a.label, activityType: a.activityType, periodStart: a.periodStart, periodEnd: a.periodEnd, quantity: a.quantity, unit: a.unit, sharePct: a.sharePct,
    factor, conversionNote, lineKgCo2e: lineKg, kgCo2e: kg, tier, basis: a.basis, evidence: a.evidence, warnings,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tonnes by Scope 3 category. A counterparty serving one category is counted
 * under it; one serving several is listed under "multiple", because splitting
 * its figure between them would be an invented allocation.
 */
function categoryTotals(views: CounterpartyView[]): CategoryTotal[] {
  const groups = new Map<string, { views: CounterpartyView[] }>();
  for (const v of views) {
    const key = v.counterparty.ghgCategories.length === 1 ? v.counterparty.ghgCategories[0] : "multiple";
    const g = groups.get(key) ?? { views: [] };
    g.views.push(v);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([category, g]) => {
      const withData = g.views.filter((v) => v.dataSource !== "none");
      return {
        category,
        label: category === "multiple" ? "Several categories (not split)" : categoryLabel(category),
        counterparties: g.views.length,
        withData: withData.length,
        tco2e: withData.length === 0 ? 0 : withData.some((v) => v.attributableTco2e === null) ? null : round3(withData.reduce((n, v) => n + (v.attributableTco2e ?? 0), 0)),
      };
    })
    .sort((a, b) => (a.category === "multiple" ? 1 : b.category === "multiple" ? -1 : Number(a.category) - Number(b.category)));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = m.get(k) ?? [];
    g.push(it);
    m.set(k, g);
  }
  return m;
}
