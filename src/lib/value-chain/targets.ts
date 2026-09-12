import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import { round3 } from "@/lib/carbon/factor-line";
import {
  INITIATIVE_STATUS,
  LEVERS,
  LEVER_LABELS,
  PIPELINE_STATUSES,
  SCOPE3_CATEGORY_IDS,
  TARGET_KINDS,
  TARGET_KIND_META,
  TARGET_STATUS,
  categoryLabel,
  type InitiativeStatus,
  type Lever,
  type TargetKind,
  type TargetStatus,
} from "./types";
import type { ValueChainTrend, YearTotals } from "./trend";

/**
 * Targets and the initiatives meant to meet them.
 *
 * Two rules hold this together. Expected savings are never subtracted from
 * measured emissions: a planned reduction is a plan, and mixing it into the
 * inventory is how a footprint stops being a measurement. And progress is
 * always shown against the straight line from baseline to target, so being
 * behind is visible in the year it happens rather than the year before the
 * deadline.
 */

/* ------------------------------------------------------------------ */
/* targets                                                             */
/* ------------------------------------------------------------------ */

export const targetCreateSchema = z
  .object({
    name: z.string().min(2).max(200),
    kind: z.enum(TARGET_KINDS),
    baselineYear: z.number().int().min(1990).max(2100),
    /** Left blank to take the baseline from the report for that year when it is run. */
    baselineValue: z.number().optional(),
    targetYear: z.number().int().min(1990).max(2100),
    targetValue: z.number(),
    direction: z.enum(["upstream", "downstream"]).optional(),
    category: z.enum(SCOPE3_CATEGORY_IDS).optional(),
    status: z.enum(TARGET_STATUS).default("draft"),
    owner: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.targetYear > v.baselineYear, { message: "The target year has to be after the baseline year.", path: ["targetYear"] })
  .refine((v) => v.kind !== "primary_share_pct" || (v.targetValue >= 0 && v.targetValue <= 100), { message: "A share target is a percentage between 0 and 100.", path: ["targetValue"] })
  .refine((v) => v.kind !== "data_coverage_pct" || (v.targetValue >= 0 && v.targetValue <= 100), { message: "A share target is a percentage between 0 and 100.", path: ["targetValue"] });
export type TargetCreate = z.infer<typeof targetCreateSchema>;
export interface TargetRecord extends TargetCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* initiatives                                                         */
/* ------------------------------------------------------------------ */

const initiativeBaseSchema = z.object({
  counterpartyId: z.string().uuid().optional(),
  name: z.string().min(2).max(200),
  lever: z.enum(LEVERS),
  category: z.enum(SCOPE3_CATEGORY_IDS).optional(),
  status: z.enum(INITIATIVE_STATUS).default("proposed"),
  expectedAnnualTco2e: z.number().min(0).optional(),
  expectedFromYear: z.number().int().min(1990).max(2100).optional(),
  actualAnnualTco2e: z.number().min(0).optional(),
  actualFromYear: z.number().int().min(1990).max(2100).optional(),
  costGbp: z.number().min(0).optional(),
  owner: z.string().max(200).optional(),
  evidence: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

export const initiativeCreateSchema = initiativeBaseSchema
  .refine((v) => v.expectedAnnualTco2e === undefined || v.expectedFromYear !== undefined, {
    message: "An expected saving needs the year it starts, or it cannot be placed on the trajectory.",
    path: ["expectedFromYear"],
  })
  .refine((v) => v.actualAnnualTco2e === undefined || v.actualFromYear !== undefined, {
    message: "A delivered saving needs the year it started.",
    path: ["actualFromYear"],
  })
  .refine((v) => v.status !== "delivered" || v.actualAnnualTco2e !== undefined, {
    message: "An initiative marked delivered needs the saving that was actually achieved, not just the one expected.",
    path: ["actualAnnualTco2e"],
  });
export type InitiativeCreate = z.infer<typeof initiativeCreateSchema>;
export const initiativeUpdateSchema = initiativeBaseSchema.partial();
export type InitiativeUpdate = z.infer<typeof initiativeUpdateSchema>;
export interface InitiativeRecord extends InitiativeCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const stamp = (d: Date) => d.toISOString();

interface TargetRow {
  id: string; name: string; kind: string; baseline_year: number; baseline_value: number | null; target_year: number; target_value: number;
  direction: string | null; category: string | null; status: string; owner: string | null; notes: string | null; created_at: string; updated_at: string;
}
interface InitiativeRow {
  id: string; counterparty_id: string | null; name: string; lever: string; category: string | null; status: string; expected_annual_tco2e: number | null;
  expected_from_year: number | null; actual_annual_tco2e: number | null; actual_from_year: number | null; cost_gbp: number | null; owner: string | null;
  evidence: string | null; notes: string | null; created_at: string; updated_at: string;
}

export class TargetRepository {
  constructor(private readonly db: Db) {}

  list(): TargetRecord[] {
    return (this.db.prepare("SELECT * FROM value_chain_targets ORDER BY target_year, name COLLATE NOCASE").all() as unknown as TargetRow[]).map(targetFromRow);
  }

  get(id: string): TargetRecord | undefined {
    const row = this.db.prepare("SELECT * FROM value_chain_targets WHERE id = ?").get(id) as unknown as TargetRow | undefined;
    return row ? targetFromRow(row) : undefined;
  }

  create(input: TargetCreate, now = new Date()): TargetRecord {
    const at = stamp(now);
    const record: TargetRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO value_chain_targets (id, name, kind, baseline_year, baseline_value, target_year, target_value, direction, category, status, owner, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.name, record.kind, record.baselineYear, n(record.baselineValue), record.targetYear, record.targetValue, n(record.direction), n(record.category), record.status, n(record.owner), n(record.notes), at, at);
    return record;
  }

  update(id: string, patch: Partial<TargetCreate>, now = new Date()): TargetRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Target ${id} not found`);
    const next: TargetRecord = { ...current, ...strip(patch), updatedAt: stamp(now) };
    this.db
      .prepare(
        `UPDATE value_chain_targets SET name = ?, kind = ?, baseline_year = ?, baseline_value = ?, target_year = ?, target_value = ?, direction = ?, category = ?, status = ?, owner = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.kind, next.baselineYear, n(next.baselineValue), next.targetYear, next.targetValue, n(next.direction), n(next.category), next.status, n(next.owner), n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM value_chain_targets WHERE id = ?").run(id).changes === 0) throw new Error(`Target ${id} not found`);
  }
}

export class InitiativeRepository {
  constructor(private readonly db: Db) {}

  list(filter: { counterpartyId?: string; status?: InitiativeStatus } = {}): InitiativeRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.counterpartyId) { clauses.push("counterparty_id = ?"); args.push(filter.counterpartyId); }
    if (filter.status) { clauses.push("status = ?"); args.push(filter.status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM abatement_initiatives${where} ORDER BY COALESCE(expected_from_year, 9999), name COLLATE NOCASE`).all(...args) as unknown as InitiativeRow[]).map(initiativeFromRow);
  }

  get(id: string): InitiativeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM abatement_initiatives WHERE id = ?").get(id) as unknown as InitiativeRow | undefined;
    return row ? initiativeFromRow(row) : undefined;
  }

  create(input: InitiativeCreate, now = new Date()): InitiativeRecord {
    const at = stamp(now);
    const record: InitiativeRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO abatement_initiatives (id, counterparty_id, name, lever, category, status, expected_annual_tco2e, expected_from_year, actual_annual_tco2e, actual_from_year, cost_gbp, owner, evidence, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, n(record.counterpartyId), record.name, record.lever, n(record.category), record.status, n(record.expectedAnnualTco2e), n(record.expectedFromYear),
        n(record.actualAnnualTco2e), n(record.actualFromYear), n(record.costGbp), n(record.owner), n(record.evidence), n(record.notes), at, at);
    return record;
  }

  update(id: string, patch: InitiativeUpdate, now = new Date()): InitiativeRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Initiative ${id} not found`);
    const next: InitiativeRecord = { ...current, ...strip(patch), updatedAt: stamp(now) };
    this.db
      .prepare(
        `UPDATE abatement_initiatives SET counterparty_id = ?, name = ?, lever = ?, category = ?, status = ?, expected_annual_tco2e = ?, expected_from_year = ?, actual_annual_tco2e = ?,
           actual_from_year = ?, cost_gbp = ?, owner = ?, evidence = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(n(next.counterpartyId), next.name, next.lever, n(next.category), next.status, n(next.expectedAnnualTco2e), n(next.expectedFromYear), n(next.actualAnnualTco2e),
        n(next.actualFromYear), n(next.costGbp), n(next.owner), n(next.evidence), n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM abatement_initiatives WHERE id = ?").run(id).changes === 0) throw new Error(`Initiative ${id} not found`);
  }
}

function targetFromRow(r: TargetRow): TargetRecord {
  return {
    id: r.id, name: r.name, kind: r.kind as TargetKind, baselineYear: r.baseline_year, baselineValue: r.baseline_value ?? undefined,
    targetYear: r.target_year, targetValue: r.target_value, direction: (r.direction as "upstream" | "downstream" | null) ?? undefined,
    category: r.category ?? undefined, status: r.status as TargetStatus, owner: r.owner ?? undefined, notes: r.notes ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function initiativeFromRow(r: InitiativeRow): InitiativeRecord {
  return {
    id: r.id, counterpartyId: r.counterparty_id ?? undefined, name: r.name, lever: r.lever as Lever, category: r.category ?? undefined,
    status: r.status as InitiativeStatus, expectedAnnualTco2e: r.expected_annual_tco2e ?? undefined, expectedFromYear: r.expected_from_year ?? undefined,
    actualAnnualTco2e: r.actual_annual_tco2e ?? undefined, actualFromYear: r.actual_from_year ?? undefined, costGbp: r.cost_gbp ?? undefined,
    owner: r.owner ?? undefined, evidence: r.evidence ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* progress                                                            */
/* ------------------------------------------------------------------ */

export interface TargetProgress {
  target: TargetRecord;
  unit: string;
  baselineValue: number | null;
  latestYear: number | null;
  latestValue: number | null;
  /** Where the straight line from baseline to target says it should be in the latest year. */
  requiredValue: number | null;
  /** Positive when ahead of the line. */
  varianceToLine: number | null;
  achievedPct: number | null;
  onTrack: boolean | null;
  /** Still to find between the latest value and the target. */
  remaining: number | null;
  detail: string;
  warnings: string[];
}

export interface InitiativePipeline {
  /** Expected annual savings that have started by the target year, from initiatives credible enough to count. */
  expectedTco2e: number;
  /** Savings recorded as actually achieved. */
  actualTco2e: number;
  byStatus: { status: InitiativeStatus; count: number; expectedTco2e: number; actualTco2e: number }[];
  byLever: { lever: Lever; label: string; count: number; expectedTco2e: number }[];
  /** Initiatives with no expected saving attached, which cannot be counted towards anything. */
  unquantified: { id: string; name: string; status: InitiativeStatus }[];
  detail: string;
  warnings: string[];
}

export interface TargetReport {
  progress: TargetProgress[];
  pipeline: InitiativePipeline;
  /** Only for absolute targets: does the pipeline cover what is left to find? */
  gapAnalysis?: { targetId: string; targetName: string; remainingTco2e: number | null; pipelineTco2e: number; shortfallTco2e: number | null; detail: string }[];
  warnings: string[];
}

/** The value a target is measured on, from a year of the trend. */
export function valueForKind(kind: TargetKind, year: YearTotals, valueGbp?: number): number | null {
  switch (kind) {
    case "absolute_tco2e":
      return year.attributableTco2e;
    case "primary_share_pct":
      return year.primarySharePct;
    case "data_coverage_pct":
      return year.valueCoveredPct;
    case "intensity_tco2e_per_gbp_m":
      if (year.attributableTco2e === null || valueGbp === undefined || valueGbp <= 0) return null;
      return round3(year.attributableTco2e / (valueGbp / 1_000_000));
  }
}

export function targetReport(db: Db, trend: ValueChainTrend, opts: { valueGbpByYear?: Record<number, number>; today?: string } = {}): TargetReport {
  const targets = new TargetRepository(db).list().filter((t) => t.status === "active" || t.status === "draft");
  const initiatives = new InitiativeRepository(db).list();
  const warnings: string[] = [];

  const progress = targets.map((t) => targetProgress(t, trend, opts.valueGbpByYear));
  const latestYear = trend.years[trend.years.length - 1]?.reportingYear;
  const pipeline = initiativePipeline(initiatives, latestYear);

  const absolute = progress.filter((p) => p.target.kind === "absolute_tco2e");
  const gapAnalysis = absolute.map((p) => {
    const shortfall = p.remaining === null ? null : round3(Math.max(0, p.remaining - pipeline.expectedTco2e));
    return {
      targetId: p.target.id,
      targetName: p.target.name,
      remainingTco2e: p.remaining,
      pipelineTco2e: pipeline.expectedTco2e,
      shortfallTco2e: shortfall,
      detail:
        p.remaining === null
          ? "The gap to target cannot be worked out while the latest figure is blank, so there is nothing to size the pipeline against."
          : shortfall === 0
            ? `The initiative pipeline of ${pipeline.expectedTco2e} tCO2e covers the ${p.remaining} tCO2e still to find, on the assumption that every initiative delivers what it promises.`
            : `The pipeline of ${pipeline.expectedTco2e} tCO2e leaves ${shortfall} tCO2e of the ${p.remaining} tCO2e gap with nothing behind it.`,
    };
  });

  if (targets.length === 0) warnings.push("No target is set, so there is nothing to measure the trend against.");
  warnings.push(...progress.flatMap((p) => p.warnings), ...pipeline.warnings);

  return { progress, pipeline, gapAnalysis: gapAnalysis.length > 0 ? gapAnalysis : undefined, warnings: [...new Set(warnings)] };
}

function targetProgress(target: TargetRecord, trend: ValueChainTrend, valueGbpByYear?: Record<number, number>): TargetProgress {
  const meta = TARGET_KIND_META[target.kind];
  const warnings: string[] = [];
  const baselineYear = trend.years.find((y) => y.reportingYear === target.baselineYear);
  const latest = trend.years[trend.years.length - 1];

  const baselineValue = target.baselineValue ?? (baselineYear ? valueForKind(target.kind, baselineYear, valueGbpByYear?.[target.baselineYear]) : null);
  const latestValue = latest ? valueForKind(target.kind, latest, valueGbpByYear?.[latest.reportingYear]) : null;
  const latestYear = latest?.reportingYear ?? null;

  if (!baselineYear && target.baselineValue === undefined) {
    warnings.push(`${target.name}: the baseline year ${target.baselineYear} is not in the trend and no baseline value is recorded, so progress cannot be worked out.`);
  }

  let requiredValue: number | null = null;
  if (baselineValue !== null && latestYear !== null && latestYear > target.baselineYear) {
    const span = target.targetYear - target.baselineYear;
    const elapsed = Math.min(latestYear - target.baselineYear, span);
    requiredValue = round3(baselineValue + ((target.targetValue - baselineValue) * elapsed) / span);
  }

  const down = meta.direction === "down";
  const varianceToLine = requiredValue === null || latestValue === null ? null : round3(down ? requiredValue - latestValue : latestValue - requiredValue);
  const achievedPct =
    baselineValue === null || latestValue === null || baselineValue === target.targetValue ? null : round3(((latestValue - baselineValue) / (target.targetValue - baselineValue)) * 100);
  const onTrack = varianceToLine === null ? null : varianceToLine >= 0;
  const remaining = latestValue === null ? null : round3(down ? Math.max(0, latestValue - target.targetValue) : Math.max(0, target.targetValue - latestValue));

  const detail =
    latestValue === null || baselineValue === null
      ? `${target.name} cannot be scored: ${baselineValue === null ? "the baseline" : "the latest year"} has no value on this measure. ${meta.source}`
      : onTrack === null
        ? `${target.name} has a baseline of ${baselineValue} ${meta.unit} and a target of ${target.targetValue} by ${target.targetYear}. There is no later year yet to measure against.`
        : `${target.name} stands at ${latestValue} ${meta.unit} in ${latestYear}, against ${requiredValue} on the straight line to ${target.targetValue} by ${target.targetYear}. ${onTrack ? "Ahead of" : "Behind"} the line by ${Math.abs(varianceToLine!)} ${meta.unit}.`;

  if (onTrack === false) warnings.push(`${target.name} is behind the straight line to its ${target.targetYear} target by ${Math.abs(varianceToLine!)} ${meta.unit}.`);

  return { target, unit: meta.unit, baselineValue, latestYear, latestValue, requiredValue, varianceToLine, achievedPct, onTrack, remaining, detail, warnings };
}

function initiativePipeline(initiatives: InitiativeRecord[], byYear?: number): InitiativePipeline {
  const warnings: string[] = [];
  const counted = initiatives.filter((i) => PIPELINE_STATUSES.includes(i.status));
  const started = (i: InitiativeRecord) => byYear === undefined || i.expectedFromYear === undefined || i.expectedFromYear <= byYear;

  const expectedTco2e = round3(counted.filter(started).reduce((n, i) => n + (i.expectedAnnualTco2e ?? 0), 0));
  const actualTco2e = round3(initiatives.reduce((n, i) => n + (i.actualAnnualTco2e ?? 0), 0));

  const byStatus = INITIATIVE_STATUS.map((status) => {
    const set = initiatives.filter((i) => i.status === status);
    return {
      status,
      count: set.length,
      expectedTco2e: round3(set.reduce((n, i) => n + (i.expectedAnnualTco2e ?? 0), 0)),
      actualTco2e: round3(set.reduce((n, i) => n + (i.actualAnnualTco2e ?? 0), 0)),
    };
  }).filter((s) => s.count > 0);

  const byLever = LEVERS.map((lever) => {
    const set = counted.filter((i) => i.lever === lever);
    return { lever, label: LEVER_LABELS[lever], count: set.length, expectedTco2e: round3(set.reduce((n, i) => n + (i.expectedAnnualTco2e ?? 0), 0)) };
  })
    .filter((l) => l.count > 0)
    .sort((a, b) => b.expectedTco2e - a.expectedTco2e);

  const unquantified = initiatives.filter((i) => i.expectedAnnualTco2e === undefined && i.status !== "dropped").map((i) => ({ id: i.id, name: i.name, status: i.status }));
  if (unquantified.length > 0) warnings.push(`${unquantified.length} initiative${unquantified.length === 1 ? " has" : "s have"} no expected saving, so ${unquantified.length === 1 ? "it does" : "they do"} not count towards any target.`);

  const proposed = initiatives.filter((i) => i.status === "proposed").reduce((n, i) => n + (i.expectedAnnualTco2e ?? 0), 0);
  if (proposed > 0) warnings.push(`${round3(proposed)} tCO2e of expected saving sits at proposed and is left out of the pipeline until it is agreed.`);

  const detail =
    counted.length === 0
      ? "No initiative has reached agreed, so the pipeline is empty. Expected savings from proposals are not counted."
      : `${counted.length} initiative${counted.length === 1 ? "" : "s"} at agreed or beyond carry ${expectedTco2e} tCO2e of expected annual saving${byYear === undefined ? "" : ` starting by ${byYear}`}. ${actualTco2e} tCO2e is recorded as achieved. Expected savings are never subtracted from measured emissions.`;

  return { expectedTco2e, actualTco2e, byStatus, byLever, unquantified, detail, warnings };
}

export { categoryLabel };
