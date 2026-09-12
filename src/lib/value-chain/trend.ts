import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { round3 } from "@/lib/carbon/factor-line";
import { calendarYear, fiscalYear, type Period } from "@/lib/carbon/period";
import { valueChainReport, type CounterpartyView, type ValueChainReport } from "./report";
import { RESTATEMENT_REASONS, type RestatementReason, type Tier } from "./types";

/**
 * Value chain emissions over time: a baseline year, the years since, and an
 * honest account of what moved.
 *
 * The headline change between two years mixes three different things: real
 * abatement, counterparties entering or leaving the register, and the figure
 * for the same counterparty being measured a different way. Only the first is
 * a reduction. The engine separates them rather than reporting one number and
 * letting the reader assume.
 */

/* ------------------------------------------------------------------ */
/* baseline                                                            */
/* ------------------------------------------------------------------ */

export const baselineSchema = z.object({
  baselineYear: z.number().int().min(1990).max(2100),
  rationale: z.string().min(3).max(2000),
  setOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).optional(),
});
export type BaselineInput = z.infer<typeof baselineSchema>;
export interface BaselineRecord extends BaselineInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const restatementSchema = z.object({
  reportingYear: z.number().int().min(1990).max(2100),
  reason: z.enum(RESTATEMENT_REASONS),
  detail: z.string().min(3).max(2000),
  previousTco2e: z.number().min(0).optional(),
  restatedTco2e: z.number().min(0).optional(),
  recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type RestatementInput = z.infer<typeof restatementSchema>;
export interface RestatementRecord extends RestatementInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const stamp = (d: Date) => d.toISOString();

interface BaselineRow { id: string; baseline_year: number; rationale: string; set_on: string; notes: string | null; created_at: string; updated_at: string }
interface RestatementRow { id: string; reporting_year: number; reason: string; detail: string; previous_tco2e: number | null; restated_tco2e: number | null; recorded_on: string; created_at: string; updated_at: string }

/** At most one baseline is held. Setting a new one replaces it, which is a decision worth a rationale. */
export class BaselineRepository {
  constructor(private readonly db: Db) {}

  get(): BaselineRecord | undefined {
    const row = this.db.prepare("SELECT * FROM value_chain_baseline ORDER BY created_at DESC LIMIT 1").get() as unknown as BaselineRow | undefined;
    return row ? { id: row.id, baselineYear: row.baseline_year, rationale: row.rationale, setOn: row.set_on, notes: row.notes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  set(input: BaselineInput, now = new Date()): BaselineRecord {
    const at = stamp(now);
    const record: BaselineRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db.exec("DELETE FROM value_chain_baseline");
    this.db
      .prepare("INSERT INTO value_chain_baseline (id, baseline_year, rationale, set_on, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.baselineYear, record.rationale, record.setOn, n(record.notes), at, at);
    return record;
  }

  clear(): void {
    this.db.exec("DELETE FROM value_chain_baseline");
  }
}

export class RestatementRepository {
  constructor(private readonly db: Db) {}

  list(filter: { reportingYear?: number } = {}): RestatementRecord[] {
    const where = filter.reportingYear === undefined ? "" : " WHERE reporting_year = ?";
    const args = filter.reportingYear === undefined ? [] : [filter.reportingYear];
    return (this.db.prepare(`SELECT * FROM value_chain_restatements${where} ORDER BY reporting_year DESC, recorded_on DESC`).all(...args) as unknown as RestatementRow[]).map(fromRow);
  }

  create(input: RestatementInput, now = new Date()): RestatementRecord {
    const at = stamp(now);
    const record: RestatementRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db
      .prepare("INSERT INTO value_chain_restatements (id, reporting_year, reason, detail, previous_tco2e, restated_tco2e, recorded_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.reportingYear, record.reason, record.detail, n(record.previousTco2e), n(record.restatedTco2e), record.recordedOn, at, at);
    return record;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM value_chain_restatements WHERE id = ?").run(id);
  }
}

function fromRow(r: RestatementRow): RestatementRecord {
  return {
    id: r.id,
    reportingYear: r.reporting_year,
    reason: r.reason as RestatementReason,
    detail: r.detail,
    previousTco2e: r.previous_tco2e ?? undefined,
    restatedTco2e: r.restated_tco2e ?? undefined,
    recordedOn: r.recorded_on,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* the trend                                                           */
/* ------------------------------------------------------------------ */

export interface YearTotals {
  reportingYear: number;
  attributableTco2e: number | null;
  returnedTco2e: number | null;
  estimatedTco2e: number | null;
  primarySharePct: number | null;
  active: number;
  withData: number;
  estimatedCount: number;
  valueCoveredPct: number | null;
  restatements: RestatementRecord[];
  warnings: string[];
}

export interface Movement {
  counterpartyId: string;
  name: string;
  fromTco2e: number | null;
  toTco2e: number | null;
  changeTco2e: number | null;
  fromTier: Tier | null;
  toTier: Tier | null;
  /** True when the figure is measured a different way in the two years, so the movement is not abatement. */
  basisChanged: boolean;
  detail: string;
}

export interface YearOnYear {
  reportingYear: number;
  previousYear: number;
  /** Every counterparty in each year. Mixes abatement with register churn and with measurement changes. */
  headline: { fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; changePct: number | null };
  /** Counterparties with a figure in both years and the same basis in both. The nearest thing to real movement. */
  likeForLike: { counterparties: number; fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; changePct: number | null };
  entered: Movement[];
  left: Movement[];
  /** In both years but measured differently, so the movement is a measurement change. */
  rebased: Movement[];
  /** In both years on the same basis, largest fall first. */
  moved: Movement[];
  detail: string;
  warnings: string[];
}

export interface ValueChainTrend {
  years: YearTotals[];
  baseline?: BaselineRecord;
  /** Against the baseline year, when one is set and both years resolve. */
  vsBaseline?: { baselineYear: number; latestYear: number; fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; changePct: number | null; detail: string };
  yearOnYear: YearOnYear[];
  warnings: string[];
}

/** The period for a reporting year, on the same basis as the period handed in. */
export function periodForYear(year: number, basis: Period): Period {
  const startMonth = Number(basis.from.slice(5, 7));
  return startMonth === 1 ? calendarYear(year) : fiscalYear(year, startMonth);
}

/**
 * Runs the value chain report for each year and compares them. Years with no
 * counterparty data at all are still listed, so a gap in the series is visible
 * rather than silently skipped.
 */
export function valueChainTrend(db: Db, ctx: OperationContext, basis: Period, opts: { years?: number[]; today?: string } = {}): ValueChainTrend {
  const baseline = new BaselineRepository(db).get();
  const latest = Number(basis.from.slice(0, 4));
  const first = opts.years ? Math.min(...opts.years) : baseline ? Math.min(baseline.baselineYear, latest) : latest - 2;
  const wanted = opts.years ?? range(first, latest);
  const restatements = new RestatementRepository(db).list();
  const warnings: string[] = [];

  const reports = new Map<number, ValueChainReport>();
  for (const year of wanted) reports.set(year, valueChainReport(db, ctx, periodForYear(year, basis), { today: opts.today }));

  const years: YearTotals[] = wanted.map((year) => {
    const r = reports.get(year)!;
    return {
      reportingYear: year,
      attributableTco2e: r.totals.attributableTco2e,
      returnedTco2e: r.totals.returnedTco2e,
      estimatedTco2e: r.totals.estimatedTco2e,
      primarySharePct: r.totals.primarySharePct,
      active: r.coverage.active,
      withData: r.coverage.withData,
      estimatedCount: r.coverage.estimated,
      valueCoveredPct: r.coverage.valueCoveredPct,
      restatements: restatements.filter((x) => x.reportingYear === year),
      warnings: r.warnings,
    };
  });

  const yearOnYear: YearOnYear[] = [];
  for (let i = 1; i < wanted.length; i++) yearOnYear.push(compareYears(reports.get(wanted[i - 1])!, reports.get(wanted[i])!));

  let vsBaseline: ValueChainTrend["vsBaseline"];
  if (baseline) {
    const from = years.find((y) => y.reportingYear === baseline.baselineYear);
    const to = years[years.length - 1];
    if (!from) {
      warnings.push(`The baseline year ${baseline.baselineYear} is outside the years shown, so progress against it cannot be worked out here.`);
    } else if (to && from.reportingYear !== to.reportingYear) {
      const change = delta(from.attributableTco2e, to.attributableTco2e);
      vsBaseline = {
        baselineYear: from.reportingYear,
        latestYear: to.reportingYear,
        fromTco2e: from.attributableTco2e,
        toTco2e: to.attributableTco2e,
        ...change,
        detail:
          change.changePct === null
            ? `Progress against the ${from.reportingYear} baseline cannot be worked out: one of the two years has no attributable total.`
            : `${change.changePct > 0 ? "Up" : "Down"} ${Math.abs(change.changePct)}% against the ${from.reportingYear} baseline. Coverage moved from ${from.withData} to ${to.withData} counterparties with returned data, so read the like-for-like figures before calling this abatement.`,
      };
      const restated = restatements.filter((x) => x.reportingYear === from.reportingYear);
      if (restated.length > 0) warnings.push(`The baseline year ${from.reportingYear} carries ${restated.length} restatement${restated.length === 1 ? "" : "s"}; the comparison uses the current figures, not the ones first published.`);
    }
  } else {
    warnings.push("No baseline year is set, so there is nothing to measure progress against. Set one with the rationale for choosing it.");
  }

  for (const y of years) {
    if (y.attributableTco2e === null) warnings.push(`${y.reportingYear} has no attributable total, so every comparison touching it is blank rather than wrong.`);
  }

  return { years, baseline, vsBaseline, yearOnYear, warnings: [...new Set(warnings)] };
}

function compareYears(prev: ValueChainReport, curr: ValueChainReport): YearOnYear {
  const warnings: string[] = [];
  const figureOf = (v: CounterpartyView) => (v.dataSource === "none" ? undefined : v);
  const before = new Map(prev.counterparties.map((v) => [v.counterparty.id, v]).filter(([, v]) => figureOf(v as CounterpartyView)) as [string, CounterpartyView][]);
  const after = new Map(curr.counterparties.map((v) => [v.counterparty.id, v]).filter(([, v]) => figureOf(v as CounterpartyView)) as [string, CounterpartyView][]);

  const entered: Movement[] = [];
  const left: Movement[] = [];
  const rebased: Movement[] = [];
  const moved: Movement[] = [];

  for (const [id, v] of after) {
    const was = before.get(id);
    if (!was) {
      entered.push(movement(v, undefined, v));
      continue;
    }
    const basisChanged = was.dataSource !== v.dataSource || was.tier !== v.tier;
    const m = movement(v, was, v, basisChanged);
    (basisChanged ? rebased : moved).push(m);
  }
  for (const [id, v] of before) if (!after.has(id)) left.push(movement(v, v, undefined));

  const sumOf = (vs: CounterpartyView[]) => (vs.length === 0 ? 0 : vs.some((v) => v.attributableTco2e === null) ? null : round3(vs.reduce((t, v) => t + (v.attributableTco2e ?? 0), 0)));
  const headlineChange = delta(prev.totals.attributableTco2e, curr.totals.attributableTco2e);
  const lflAfter = moved.map((m) => after.get(m.counterpartyId)!);
  const lflBefore = moved.map((m) => before.get(m.counterpartyId)!);
  const lflFrom = sumOf(lflBefore);
  const lflTo = sumOf(lflAfter);
  const lflChange = delta(lflFrom, lflTo);

  moved.sort((a, b) => (a.changeTco2e ?? 0) - (b.changeTco2e ?? 0));
  entered.sort((a, b) => (b.toTco2e ?? 0) - (a.toTco2e ?? 0));
  left.sort((a, b) => (b.fromTco2e ?? 0) - (a.fromTco2e ?? 0));
  rebased.sort((a, b) => Math.abs(b.changeTco2e ?? 0) - Math.abs(a.changeTco2e ?? 0));

  if (entered.length > 0 || left.length > 0) {
    warnings.push(
      `The register changed between ${prev.reportingYear} and ${curr.reportingYear}: ${entered.length} counterpart${entered.length === 1 ? "y" : "ies"} entered and ${left.length} left. The headline change is not like for like; use the like-for-like figure.`,
    );
  }
  if (rebased.length > 0) {
    warnings.push(
      `${rebased.length} counterpart${rebased.length === 1 ? "y is" : "ies are"} measured on a different basis than last year, so ${rebased.length === 1 ? "its" : "their"} movement is a measurement change, not abatement. They are left out of the like-for-like figure.`,
    );
  }

  const detail =
    lflChange.changePct === null
      ? `A like-for-like comparison of ${prev.reportingYear} and ${curr.reportingYear} is not possible: at least one counterparty on the same basis in both years has no figure.`
      : moved.length === 0
        ? `No counterparty was measured on the same basis in both ${prev.reportingYear} and ${curr.reportingYear}, so there is no like-for-like movement to report.`
        : `Like for like across ${moved.length} counterpart${moved.length === 1 ? "y" : "ies"} measured the same way in both years, emissions are ${lflChange.changePct > 0 ? "up" : "down"} ${Math.abs(lflChange.changePct)}%. The headline change of ${headlineChange.changePct === null ? "n/a" : `${headlineChange.changePct > 0 ? "+" : ""}${headlineChange.changePct}%`} also carries ${entered.length} arrival${entered.length === 1 ? "" : "s"}, ${left.length} departure${left.length === 1 ? "" : "s"} and ${rebased.length} change${rebased.length === 1 ? "" : "s"} of basis.`;

  return {
    reportingYear: curr.reportingYear,
    previousYear: prev.reportingYear,
    headline: { fromTco2e: prev.totals.attributableTco2e, toTco2e: curr.totals.attributableTco2e, ...headlineChange },
    likeForLike: { counterparties: moved.length, fromTco2e: lflFrom, toTco2e: lflTo, ...lflChange },
    entered,
    left,
    rebased,
    moved,
    detail,
    warnings,
  };
}

function movement(identity: CounterpartyView, from: CounterpartyView | undefined, to: CounterpartyView | undefined, basisChanged = false): Movement {
  const a = from?.attributableTco2e ?? null;
  const b = to?.attributableTco2e ?? null;
  const change = from && to ? (a === null || b === null ? null : round3(b - a)) : null;
  const detail = !from
    ? `Entered the register with a figure this year; nothing to compare against.`
    : !to
      ? `Held a figure last year and none this year. A departure is not a reduction: record whether the relationship ended or the data is simply missing.`
      : basisChanged
        ? `Measured as ${sourceLabel(from)} last year and ${sourceLabel(to)} this year, so the movement is a measurement change rather than abatement.`
        : `Measured as ${sourceLabel(to)} in both years.`;
  return {
    counterpartyId: identity.counterparty.id,
    name: identity.counterparty.name,
    fromTco2e: a,
    toTco2e: b,
    changeTco2e: change,
    fromTier: from?.tier ?? null,
    toTier: to?.tier ?? null,
    basisChanged,
    detail,
  };
}

const sourceLabel = (v: CounterpartyView) =>
  v.dataSource === "report" ? `an annual report at tier ${v.tier ?? "?"}` : v.dataSource === "ledger" ? `an activity ledger at tier ${v.tier ?? "?"}` : v.dataSource === "spend_estimate" ? "a tier D spend estimate" : "no data";

function delta(from: number | null, to: number | null): { changeTco2e: number | null; changePct: number | null } {
  if (from === null || to === null) return { changeTco2e: null, changePct: null };
  return { changeTco2e: round3(to - from), changePct: from === 0 ? null : round3(((to - from) / from) * 100) };
}

const range = (from: number, to: number) => (to < from ? [from] : Array.from({ length: to - from + 1 }, (_, i) => from + i));
