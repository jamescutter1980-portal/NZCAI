import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import { CATEGORY_STATUS, CATEGORY_STATUS_LABELS, RELEVANCE, SCOPE3_CATEGORIES, SCOPE3_CATEGORY_IDS, categoryLabel, type CategoryStatus, type CounterpartyRecord, type Relevance } from "./types";
import { CounterpartyRepository } from "./repo";
import type { ValueChainReport } from "./report";

/**
 * Every Scope 3 category assessed for relevance, with a justification on
 * record for each one excluded.
 *
 * A footprint that simply omits a category is indistinguishable from one that
 * considered it and ruled it out. The difference is the justification, and an
 * assurer asks for it first. This layer makes the fifteen categories a
 * checklist that has to be answered rather than a list that happens to be
 * partly populated.
 */

export const categoryAssessmentSchema = z
  .object({
    reportingYear: z.number().int().min(1990).max(2100),
    category: z.enum(SCOPE3_CATEGORY_IDS),
    relevance: z.enum(RELEVANCE),
    status: z.enum(CATEGORY_STATUS),
    justification: z.string().min(3).max(2000),
    method: z.string().max(2000).optional(),
    evidence: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
    assessedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((v) => v.relevance !== "not_relevant" || v.status === "excluded", {
    message: "A category judged not relevant is excluded; set the status to excluded.",
    path: ["status"],
  })
  .refine((v) => v.relevance !== "relevant" || v.status !== "excluded", {
    message: "A relevant category cannot be excluded. Either it is not relevant, or it is relevant and has to be quantified.",
    path: ["status"],
  });
export type CategoryAssessmentInput = z.infer<typeof categoryAssessmentSchema>;
export interface CategoryAssessmentRecord extends CategoryAssessmentInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const stamp = (d: Date) => d.toISOString();

interface Row {
  id: string; reporting_year: number; category: string; relevance: string; status: string; justification: string;
  method: string | null; evidence: string | null; notes: string | null; assessed_on: string; created_at: string; updated_at: string;
}

export class CategoryAssessmentRepository {
  constructor(private readonly db: Db) {}

  list(reportingYear: number): CategoryAssessmentRecord[] {
    return (this.db.prepare("SELECT * FROM scope3_category_assessments WHERE reporting_year = ? ORDER BY CAST(category AS INTEGER)").all(reportingYear) as unknown as Row[]).map(fromRow);
  }

  find(reportingYear: number, category: string): CategoryAssessmentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM scope3_category_assessments WHERE reporting_year = ? AND category = ?").get(reportingYear, category) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** One assessment per category per year: recording again replaces the earlier answer. */
  upsert(input: CategoryAssessmentInput, now = new Date()): CategoryAssessmentRecord {
    const at = stamp(now);
    const existing = this.find(input.reportingYear, input.category);
    const record: CategoryAssessmentRecord = { ...input, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO scope3_category_assessments (id, reporting_year, category, relevance, status, justification, method, evidence, notes, assessed_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (reporting_year, category) DO UPDATE SET
           relevance = excluded.relevance, status = excluded.status, justification = excluded.justification, method = excluded.method,
           evidence = excluded.evidence, notes = excluded.notes, assessed_on = excluded.assessed_on, updated_at = excluded.updated_at`,
      )
      .run(record.id, record.reportingYear, record.category, record.relevance, record.status, record.justification, n(record.method), n(record.evidence), n(record.notes), record.assessedOn, record.createdAt, at);
    return this.find(input.reportingYear, input.category)!;
  }

  /** Copies last year's answers forward so only what changed has to be revisited. */
  rollForward(fromYear: number, toYear: number, now = new Date()): CategoryAssessmentRecord[] {
    const source = this.list(fromYear);
    const out: CategoryAssessmentRecord[] = [];
    for (const a of source) {
      if (this.find(toYear, a.category)) continue;
      out.push(this.upsert({ ...a, reportingYear: toYear, assessedOn: stamp(now).slice(0, 10) }, now));
    }
    return out;
  }

  delete(reportingYear: number, category: string): void {
    this.db.prepare("DELETE FROM scope3_category_assessments WHERE reporting_year = ? AND category = ?").run(reportingYear, category);
  }
}

function fromRow(r: Row): CategoryAssessmentRecord {
  return {
    id: r.id,
    reportingYear: r.reporting_year,
    category: r.category,
    relevance: r.relevance as Relevance,
    status: r.status as CategoryStatus,
    justification: r.justification,
    method: r.method ?? undefined,
    evidence: r.evidence ?? undefined,
    notes: r.notes ?? undefined,
    assessedOn: r.assessed_on,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* the completeness view                                               */
/* ------------------------------------------------------------------ */

export interface CategoryLine {
  category: string;
  label: string;
  assessment?: CategoryAssessmentRecord;
  relevance: Relevance;
  status: CategoryStatus;
  /** Counterparties on the register carrying this category. */
  counterparties: number;
  /** Of those, how many returned data for the year. */
  withData: number;
  /** From the value chain report, when the category is carried by counterparties that serve only it. */
  tco2e: number | null;
  /** What is wrong, in a sentence a reviewer can act on. Empty when the category is settled. */
  gap?: string;
}

export interface CompletenessReport {
  reportingYear: number;
  lines: CategoryLine[];
  counts: {
    assessed: number;
    unassessed: number;
    relevant: number;
    notRelevant: number;
    quantified: number;
    /** Relevant, but nothing quantified for it. */
    relevantWithoutData: number;
    /** Excluded with no justification worth the name. */
    unjustifiedExclusions: number;
  };
  /** True only when all fifteen carry an assessment and every relevant one is quantified. */
  complete: boolean;
  detail: string;
  warnings: string[];
}

/**
 * Joins the assessments to what the register and the report actually hold, so
 * a category claimed as calculated with no counterparty behind it shows up.
 */
export function categoryCompleteness(db: Db, report: ValueChainReport): CompletenessReport {
  const year = report.reportingYear;
  const assessments = new Map(new CategoryAssessmentRepository(db).list(year).map((a) => [a.category, a]));
  const counterparties = new CounterpartyRepository(db).list({ status: "active" });
  const withData = new Set(report.counterparties.filter((v) => v.dataSource === "report" || v.dataSource === "ledger").map((v) => v.counterparty.id));
  const byCategory = new Map(report.totals.byCategory.map((c) => [c.category, c]));
  const warnings: string[] = [];

  const lines: CategoryLine[] = SCOPE3_CATEGORY_IDS.map((id) => {
    const assessment = assessments.get(id);
    const holders = counterparties.filter((c: CounterpartyRecord) => c.ghgCategories.includes(id));
    const holdersWithData = holders.filter((c) => withData.has(c.id)).length;
    const total = byCategory.get(id);
    const relevance: Relevance = assessment?.relevance ?? "not_yet_assessed";
    const status: CategoryStatus = assessment?.status ?? "not_started";

    let gap: string | undefined;
    if (!assessment) {
      gap = `Category ${id} has never been assessed. Record whether it is relevant and, if not, why not.`;
    } else if (relevance === "relevant" && status === "not_started") {
      gap = `Category ${id} is judged relevant but nothing has been quantified for it.`;
    } else if (relevance === "relevant" && holders.length === 0 && status !== "estimated") {
      gap = `Category ${id} is judged relevant and marked ${CATEGORY_STATUS_LABELS[status].toLowerCase()}, but no counterparty on the register carries it, so there is nothing behind the claim.`;
    } else if (status === "calculated" && holdersWithData === 0 && holders.length > 0) {
      gap = `Category ${id} is marked calculated but none of its ${holders.length} counterpart${holders.length === 1 ? "y has" : "ies have"} returned data for ${year}.`;
    } else if (relevance === "not_relevant" && holders.length > 0) {
      gap = `Category ${id} is excluded as not relevant, yet ${holders.length} counterpart${holders.length === 1 ? "y is" : "ies are"} registered against it. Either the exclusion or the register is wrong.`;
    }

    return {
      category: id,
      label: categoryLabel(id),
      assessment,
      relevance,
      status,
      counterparties: holders.length,
      withData: holdersWithData,
      tco2e: total?.tco2e ?? null,
      gap,
    };
  });

  const counts = {
    assessed: lines.filter((l) => l.assessment).length,
    unassessed: lines.filter((l) => !l.assessment).length,
    relevant: lines.filter((l) => l.relevance === "relevant").length,
    notRelevant: lines.filter((l) => l.relevance === "not_relevant").length,
    quantified: lines.filter((l) => l.status === "calculated" || l.status === "estimated").length,
    relevantWithoutData: lines.filter((l) => l.relevance === "relevant" && l.status === "not_started").length,
    unjustifiedExclusions: lines.filter((l) => l.status === "excluded" && (l.assessment?.justification ?? "").trim().length < 20).length,
  };

  if (counts.unassessed > 0) warnings.push(`${counts.unassessed} of ${SCOPE3_CATEGORY_IDS.length} categories have never been assessed for ${year}. An omission with no reasoning on record cannot be told apart from an oversight.`);
  if (counts.relevantWithoutData > 0) warnings.push(`${counts.relevantWithoutData} categor${counts.relevantWithoutData === 1 ? "y is" : "ies are"} judged relevant with nothing quantified.`);
  if (counts.unjustifiedExclusions > 0) warnings.push(`${counts.unjustifiedExclusions} exclusion${counts.unjustifiedExclusions === 1 ? " has" : "s have"} a justification too short to stand up to a reviewer.`);

  const complete = counts.unassessed === 0 && counts.relevantWithoutData === 0 && counts.unjustifiedExclusions === 0;
  const detail = complete
    ? `All ${SCOPE3_CATEGORY_IDS.length} categories are assessed for ${year}: ${counts.relevant} relevant and quantified, ${counts.notRelevant} excluded with a justification on record.`
    : `${counts.assessed} of ${SCOPE3_CATEGORY_IDS.length} categories are assessed for ${year}. ${counts.unassessed} untouched, ${counts.relevantWithoutData} relevant with no figure, ${counts.unjustifiedExclusions} thinly justified exclusion${counts.unjustifiedExclusions === 1 ? "" : "s"}.`;

  return { reportingYear: year, lines, counts, complete, detail, warnings };
}

export { SCOPE3_CATEGORIES };
