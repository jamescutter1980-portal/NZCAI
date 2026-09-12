import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { round3 } from "@/lib/carbon/factor-line";
import { calendarYear, fiscalYear, type Period } from "@/lib/carbon/period";
import { portfolioReport } from "@/lib/carbon/portfolio";
import { unitConversion } from "@/lib/carbon/units";
import { emissionsCarbon } from "@/lib/emissions";
import { transportCarbon } from "@/lib/transport";
import { CounterpartyRepository } from "./repo";
import { valueChainReport } from "./report";

/**
 * The Request Inbox: data requests that come TO the client from a franchisor,
 * a customer, a parent consolidating under CSRD, a lender or a landlord.
 *
 * Each is a work item with the requester, the fields asked for, a deadline
 * and an owner. The response is drafted from figures the portal already
 * computes (the portfolio roll-up, transport, refrigerants water and waste,
 * the value chain), so the same number goes to every requester. A
 * consistency guard compares each figure with what was already submitted for
 * the same metric and year, because two returns that disagree are an audit
 * finding. Submission snapshots the figures sent, and a recurring request
 * rolls forward to the next year with its template intact.
 */

/* ------------------------------------------------------------------ */
/* the metrics the portal can answer                                    */
/* ------------------------------------------------------------------ */

export interface Resolved {
  value: number | null;
  /** Where the number came from and what it covers, or why it is blank. */
  detail: string;
}

export interface MetricMeta {
  label: string;
  unit: string;
  group: "energy" | "emissions" | "water_waste" | "value_chain" | "manual";
}

export const METRICS: Record<string, MetricMeta> = {
  electricity_kwh: { label: "Electricity imported", unit: "kWh", group: "energy" },
  gas_kwh: { label: "Natural gas", unit: "kWh", group: "energy" },
  total_energy_kwh: { label: "Total metered energy (electricity and gas)", unit: "kWh", group: "energy" },
  export_kwh: { label: "Electricity exported", unit: "kWh", group: "energy" },
  energy_intensity_kwh_m2: { label: "Energy intensity", unit: "kWh/m2", group: "energy" },
  floor_area_m2: { label: "Floor area", unit: "m2", group: "energy" },
  asset_count: { label: "Assets in boundary", unit: "count", group: "energy" },
  scope1_kgco2e: { label: "Scope 1 (gas, own vehicles, refrigerants)", unit: "kgCO2e", group: "emissions" },
  scope2_location_kgco2e: { label: "Scope 2 location-based", unit: "kgCO2e", group: "emissions" },
  scope2_market_kgco2e: { label: "Scope 2 market-based", unit: "kgCO2e", group: "emissions" },
  scope3_tandd_kgco2e: { label: "Scope 3 category 3 (T&D losses)", unit: "kgCO2e", group: "emissions" },
  business_travel_kgco2e: { label: "Scope 3 category 6 (business travel)", unit: "kgCO2e", group: "emissions" },
  commuting_kgco2e: { label: "Scope 3 category 7 (commuting)", unit: "kgCO2e", group: "emissions" },
  transport_scope3_kgco2e: { label: "Scope 3 transport, all categories", unit: "kgCO2e", group: "emissions" },
  refrigerant_kgco2e: { label: "Refrigerant losses", unit: "kgCO2e", group: "emissions" },
  waste_kgco2e: { label: "Waste (category 5)", unit: "kgCO2e", group: "water_waste" },
  waste_tonnes: { label: "Waste generated", unit: "tonnes", group: "water_waste" },
  waste_diversion_pct: { label: "Waste diverted from landfill", unit: "%", group: "water_waste" },
  water_m3: { label: "Water supplied", unit: "m3", group: "water_waste" },
  water_kgco2e: { label: "Water supply and treatment", unit: "kgCO2e", group: "water_waste" },
  value_chain_tco2e: { label: "Scope 3 from counterparties (attributable)", unit: "tCO2e", group: "value_chain" },
  value_chain_primary_share_pct: { label: "Primary-data share of counterparty Scope 3", unit: "%", group: "value_chain" },
  manual: { label: "Entered by hand", unit: "", group: "manual" },
};
export const METRIC_IDS = Object.keys(METRICS) as [string, ...string[]];

const nn = (v: number | null | undefined) => (v === null || v === undefined ? null : round3(v));
const sumNullable = (parts: { label: string; value: number | null }[]): Resolved => {
  const missing = parts.filter((p) => p.value === null);
  if (missing.length > 0) return { value: null, detail: `Blank because ${missing.map((m) => m.label).join(", ")} cannot be calculated (a factor or reading is missing).` };
  return { value: round3(parts.reduce((n, p) => n + (p.value ?? 0), 0)), detail: parts.map((p) => `${p.label} ${p.value}`).join(" + ") };
};

/** Resolves every metric for a period once, so a request with twenty fields does not recompute the portfolio twenty times. */
export function resolveMetrics(db: Db, ctx: OperationContext, period: Period): Record<string, Resolved> {
  const out: Record<string, Resolved> = {};
  const fail = (keys: string[], what: string, e: unknown) => {
    for (const k of keys) out[k] = { value: null, detail: `${what} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  };

  try {
    const p = portfolioReport(db, ctx, period);
    const t = p.totals;
    const src = `portfolio roll-up, ${t.assets} assets, ${period.label}`;
    out.electricity_kwh = { value: nn(t.electricityKwh), detail: src };
    out.gas_kwh = { value: nn(t.gasKwh), detail: src };
    out.total_energy_kwh = { value: nn(t.totalImportKwh), detail: `${src}; electricity and gas meters only` };
    out.export_kwh = { value: nn(t.exportKwh), detail: src };
    out.floor_area_m2 = { value: nn(t.floorAreaM2), detail: src };
    out.asset_count = { value: t.assets, detail: src };
    out.energy_intensity_kwh_m2 = t.floorAreaM2 > 0 ? { value: round3(t.totalImportKwh / t.floorAreaM2), detail: `${t.totalImportKwh} kWh over ${t.floorAreaM2} m2 with a floor area` } : { value: null, detail: "No floor area recorded, so no intensity." };
    out.scope2_location_kgco2e = { value: nn(t.scope2Location), detail: t.scope2Location === null ? "Blank: a factor or reading is missing on at least one asset." : `${src}, ${t.contributing.scope2Location} assets contributing` };
    out.scope2_market_kgco2e = { value: nn(t.scope2Market), detail: t.scope2Market === null ? "Blank: no supplier factor or residual mix for at least one asset." : `${src}, ${t.contributing.scope2Market} assets contributing` };
    out.scope3_tandd_kgco2e = { value: nn(t.scope3TandD), detail: t.scope3TandD === null ? "Blank: the T&D factor is missing." : src };
    out.__portfolio_scope1 = { value: nn(t.scope1), detail: "" };
  } catch (e) {
    fail(["electricity_kwh", "gas_kwh", "total_energy_kwh", "export_kwh", "floor_area_m2", "asset_count", "energy_intensity_kwh_m2", "scope2_location_kgco2e", "scope2_market_kgco2e", "scope3_tandd_kgco2e", "__portfolio_scope1"], "The portfolio roll-up", e);
  }

  try {
    const tr = transportCarbon(db, ctx, period);
    const cat = (prefix: string) => {
      const groups = tr.byGhgCategory.filter((g) => g.ghgCategory.startsWith(prefix));
      if (groups.length === 0) return { value: 0, detail: `No ${prefix} lines recorded for ${period.label}.` };
      return groups.some((g) => g.kgCo2e === null) ? { value: null, detail: `Blank: a factor is missing on at least one ${prefix} line.` } : { value: round3(groups.reduce((n, g) => n + (g.kgCo2e ?? 0), 0)), detail: `${groups.reduce((n, g) => n + g.lines, 0)} transport lines, ${period.label}` };
    };
    out.business_travel_kgco2e = cat("Category 6");
    out.commuting_kgco2e = cat("Category 7");
    out.transport_scope3_kgco2e = { value: nn(tr.totals.scope3), detail: tr.totals.scope3 === null ? "Blank: a factor is missing on at least one transport line." : `${tr.counts.lines} transport lines, Scope 3 categories 3, 4, 6, 7 and 9` };
    out.__transport_scope1 = { value: nn(tr.totals.scope1), detail: "" };
  } catch (e) {
    fail(["business_travel_kgco2e", "commuting_kgco2e", "transport_scope3_kgco2e", "__transport_scope1"], "Transport", e);
  }

  try {
    const em = emissionsCarbon(db, ctx, period);
    out.refrigerant_kgco2e = { value: nn(em.byFamily.refrigerant), detail: em.byFamily.refrigerant === null ? "Blank: a refrigerant factor is missing." : `${em.lines.filter((l) => l.family === "refrigerant").length} refrigerant lines, ${period.label}` };
    out.waste_kgco2e = { value: nn(em.byFamily.waste), detail: em.byFamily.waste === null ? "Blank: a waste factor is missing." : `${em.lines.filter((l) => l.family === "waste").length} waste lines, ${period.label}` };
    out.water_kgco2e = { value: nn(em.byFamily.water), detail: em.byFamily.water === null ? "Blank: a water factor is missing." : `${em.lines.filter((l) => l.family === "water").length} water lines, ${period.label}` };
    out.waste_tonnes = { value: nn(em.waste.totalTonnes), detail: em.waste.detail };
    out.waste_diversion_pct = { value: nn(em.waste.diversionRatePct), detail: em.waste.detail };
    const water = em.lines.filter((l) => l.category === "water_supply");
    const m3 = water.map((l) => ({ l, k: unitConversion(l.unit, "m3") }));
    const bad = m3.filter((x) => x.k === null);
    out.water_m3 = water.length === 0
      ? { value: 0, detail: `No water supply recorded for ${period.label}.` }
      : bad.length > 0
        ? { value: null, detail: `Blank: ${bad.map((x) => `${x.l.label} (${x.l.unit})`).join(", ")} not in a unit that converts to m3.` }
        : { value: round3(m3.reduce((n, x) => n + x.l.quantity * (x.k ?? 0), 0)), detail: `${water.length} water supply lines, ${period.label}` };
  } catch (e) {
    fail(["refrigerant_kgco2e", "waste_kgco2e", "water_kgco2e", "waste_tonnes", "waste_diversion_pct", "water_m3"], "Refrigerants, water and waste", e);
  }

  out.scope1_kgco2e = sumNullable([
    { label: "gas combustion", value: out.__portfolio_scope1?.value ?? null },
    { label: "own and leased vehicles", value: out.__transport_scope1?.value ?? null },
    { label: "refrigerant losses", value: out.refrigerant_kgco2e?.value ?? null },
  ]);
  delete out.__portfolio_scope1;
  delete out.__transport_scope1;

  try {
    const vc = valueChainReport(db, ctx, period);
    out.value_chain_tco2e = { value: nn(vc.totals.attributableTco2e), detail: vc.totals.attributableTco2e === null ? "Blank: at least one counterparty's data cannot be turned into a figure." : `${vc.coverage.withData} counterparties with data${vc.coverage.estimated ? ` and ${vc.coverage.estimated} on a tier D spend estimate` : ""}, ${period.label}` };
    out.value_chain_primary_share_pct = { value: nn(vc.totals.primarySharePct), detail: vc.totals.primarySharePct === null ? "Blank: no resolved counterparty figure." : "Tiers A and B as a share of the attributable total" };
  } catch (e) {
    fail(["value_chain_tco2e", "value_chain_primary_share_pct"], "The value chain", e);
  }

  out.manual = { value: null, detail: "Entered by hand on the request." };
  return out;
}

/* ------------------------------------------------------------------ */
/* records                                                             */
/* ------------------------------------------------------------------ */

const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const INBOX_STATES = ["open", "submitted", "closed"] as const;
export type InboxState = (typeof INBOX_STATES)[number];
export const CADENCES = ["once", "annual"] as const;

export const requestFieldSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/i, "letters, digits and underscores"),
  /** The requester's own wording for the field. */
  label: z.string().min(1).max(200),
  metric: z.enum(METRIC_IDS),
  /** The unit the requester wants; the portal states its own alongside and does not convert. */
  unit: optionalText(40),
  /** A value entered by hand: required for `manual`, optional as a correction elsewhere. */
  override: optionalNumber.pipe(z.number().optional()),
  note: optionalText(500),
});
export type RequestField = z.infer<typeof requestFieldSchema>;

export const inboundRequestCreateSchema = z.object({
  counterpartyId: z.string().min(1),
  title: z.string().min(1).max(200),
  reportingYear: z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(2000).max(2100)),
  /** 1 for a calendar year, 4 for a UK financial year starting April. */
  periodStartMonth: z.preprocess((v) => (v === "" || v === null || v === undefined ? 1 : Number(v)), z.number().int().min(1).max(12)),
  template: optionalText(200),
  fields: z.array(requestFieldSchema).min(1).max(100),
  dueOn: isoDate.optional(),
  owner: optionalText(120),
  cadence: z.enum(CADENCES).default("annual"),
  notes: optionalText(2000),
});
export type InboundRequestCreate = z.infer<typeof inboundRequestCreateSchema>;

export const inboundRequestUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  reportingYear: z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(2000).max(2100)).optional(),
  periodStartMonth: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().int().min(1).max(12).optional()),
  template: optionalText(200),
  fields: z.array(requestFieldSchema).min(1).max(100).optional(),
  dueOn: isoDate.optional(),
  owner: optionalText(120),
  cadence: z.enum(CADENCES).optional(),
  state: z.enum(INBOX_STATES).optional(),
  notes: optionalText(2000),
});
export type InboundRequestUpdate = z.infer<typeof inboundRequestUpdateSchema>;

export interface SubmittedFigure {
  key: string;
  label: string;
  metric: string;
  value: number | null;
  unit: string;
  source: string;
}

export interface InboundRequestRecord extends Omit<InboundRequestCreate, "fields"> {
  id: string;
  fields: RequestField[];
  state: InboxState;
  submittedOn?: string;
  submittedFigures?: SubmittedFigure[];
  submissionNote?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; counterparty_id: string; title: string; reporting_year: number; period_start_month: number; template: string | null; fields: string; due_on: string | null;
  owner: string | null; cadence: string; state: string; submitted_on: string | null; submitted_figures: string | null; submission_note: string | null; notes: string | null; created_at: string; updated_at: string;
}
const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export class InboundRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Inbound request ${id} not found`);
    this.name = "InboundRequestNotFoundError";
  }
}

export class InboundRequestRepository {
  constructor(private readonly db: Db) {}

  list(filter: { reportingYear?: number; counterpartyId?: string; state?: InboxState } = {}): InboundRequestRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.reportingYear !== undefined) { clauses.push("reporting_year = ?"); args.push(filter.reportingYear); }
    if (filter.counterpartyId) { clauses.push("counterparty_id = ?"); args.push(filter.counterpartyId); }
    if (filter.state) { clauses.push("state = ?"); args.push(filter.state); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM inbound_requests${where} ORDER BY COALESCE(due_on, '9999') , title`).all(...args) as unknown as Row[]).map(fromRow);
  }

  get(id: string): InboundRequestRecord | undefined {
    const row = this.db.prepare("SELECT * FROM inbound_requests WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: InboundRequestCreate, now = new Date()): InboundRequestRecord {
    const at = now.toISOString();
    const record: InboundRequestRecord = { ...input, id: randomUUID(), state: "open", createdAt: at, updatedAt: at };
    this.write(record, true);
    return record;
  }

  update(id: string, patch: InboundRequestUpdate, now = new Date()): InboundRequestRecord {
    const current = this.get(id);
    if (!current) throw new InboundRequestNotFoundError(id);
    const next: InboundRequestRecord = { ...current, ...strip(patch), updatedAt: now.toISOString() };
    this.write(next, false);
    return next;
  }

  /** Records what was sent: the figures as a snapshot, the date, and any note about a knowingly different figure. */
  markSubmitted(id: string, figures: SubmittedFigure[], on: string, note: string | undefined, now = new Date()): InboundRequestRecord {
    const current = this.get(id);
    if (!current) throw new InboundRequestNotFoundError(id);
    const next: InboundRequestRecord = { ...current, state: "submitted", submittedOn: on, submittedFigures: figures, submissionNote: note, updatedAt: now.toISOString() };
    this.write(next, false);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM inbound_requests WHERE id = ?").run(id).changes === 0) throw new InboundRequestNotFoundError(id);
  }

  private write(r: InboundRequestRecord, insert: boolean) {
    const args = [r.counterpartyId, r.title, r.reportingYear, r.periodStartMonth, n(r.template), JSON.stringify(r.fields), n(r.dueOn), n(r.owner), r.cadence, r.state,
      n(r.submittedOn), r.submittedFigures ? JSON.stringify(r.submittedFigures) : null, n(r.submissionNote), n(r.notes), r.updatedAt];
    if (insert) {
      this.db.prepare(`INSERT INTO inbound_requests (counterparty_id, title, reporting_year, period_start_month, template, fields, due_on, owner, cadence, state, submitted_on, submitted_figures, submission_note, notes, updated_at, id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...args, r.id, r.createdAt);
    } else {
      this.db.prepare(`UPDATE inbound_requests SET counterparty_id = ?, title = ?, reporting_year = ?, period_start_month = ?, template = ?, fields = ?, due_on = ?, owner = ?, cadence = ?, state = ?,
        submitted_on = ?, submitted_figures = ?, submission_note = ?, notes = ?, updated_at = ? WHERE id = ?`).run(...args, r.id);
    }
  }
}

function fromRow(r: Row): InboundRequestRecord {
  return {
    id: r.id, counterpartyId: r.counterparty_id, title: r.title, reportingYear: r.reporting_year, periodStartMonth: r.period_start_month, template: r.template ?? undefined,
    fields: JSON.parse(r.fields) as RequestField[], dueOn: r.due_on ?? undefined, owner: r.owner ?? undefined, cadence: r.cadence as InboundRequestRecord["cadence"], state: r.state as InboxState,
    submittedOn: r.submitted_on ?? undefined, submittedFigures: r.submitted_figures ? (JSON.parse(r.submitted_figures) as SubmittedFigure[]) : undefined, submissionNote: r.submission_note ?? undefined,
    notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* drafting, the consistency guard, submission, roll-forward           */
/* ------------------------------------------------------------------ */

export const periodForRequest = (r: Pick<InboundRequestRecord, "reportingYear" | "periodStartMonth">): Period =>
  r.periodStartMonth === 1 ? calendarYear(r.reportingYear) : fiscalYear(r.reportingYear, r.periodStartMonth);

/** Above this, two figures for the same metric and year are treated as disagreeing. */
export const CONSISTENCY_TOLERANCE_PCT = 0.5;

export interface Conflict {
  requestId: string;
  requestTitle: string;
  requesterName: string;
  submittedOn: string;
  value: number | null;
  variancePct: number | null;
  detail: string;
}

export interface DraftField {
  key: string;
  label: string;
  metric: string;
  metricLabel: string;
  value: number | null;
  /** The portal's unit for the metric. The requester's unit is shown alongside; nothing is converted. */
  unit: string;
  requestedUnit?: string;
  source: string;
  overridden: boolean;
  note?: string;
  conflicts: Conflict[];
  warnings: string[];
}

export interface DraftResponse {
  request: InboundRequestRecord;
  requesterName: string;
  period: Period;
  fields: DraftField[];
  counts: { fields: number; answered: number; blank: number; conflicts: number };
  warnings: string[];
}

export function draftResponse(db: Db, ctx: OperationContext, request: InboundRequestRecord, resolved?: Record<string, Resolved>): DraftResponse {
  const period = periodForRequest(request);
  const metrics = resolved ?? resolveMetrics(db, ctx, period);
  const requester = new CounterpartyRepository(db).get(request.counterpartyId);
  const others = new InboundRequestRepository(db).list({ reportingYear: request.reportingYear, state: "submitted" }).filter((o) => o.id !== request.id);
  const names = new Map(new CounterpartyRepository(db).list().map((c) => [c.id, c.name]));
  const warnings: string[] = [];

  const fields: DraftField[] = request.fields.map((f) => {
    const meta = METRICS[f.metric];
    const r = metrics[f.metric] ?? { value: null, detail: "Unknown metric." };
    const overridden = f.override !== undefined;
    const value = overridden ? round3(f.override as number) : r.value;
    const source = overridden ? `Entered by hand${f.metric !== "manual" ? ` (the portal computes ${r.value ?? "blank"} ${meta.unit}: ${r.detail})` : ""}` : r.detail;
    const fieldWarnings: string[] = [];
    if (f.metric === "manual" && !overridden) fieldWarnings.push("A hand-entered field with no value.");
    if (overridden && f.metric !== "manual" && r.value !== null && Math.abs((f.override as number) - r.value) > 0) fieldWarnings.push(`Overrides the portal's ${r.value} ${meta.unit}. Say why in the note.`);
    if (f.unit && meta.unit && f.unit.toLowerCase() !== meta.unit.toLowerCase()) fieldWarnings.push(`Requested in ${f.unit}; the portal gives ${meta.unit}. Convert before sending, or ask them to accept ${meta.unit}.`);

    const conflicts: Conflict[] = [];
    if (f.metric !== "manual") {
      for (const o of others) {
        for (const s of o.submittedFigures ?? []) {
          if (s.metric !== f.metric) continue;
          const variancePct = value !== null && s.value !== null ? (s.value === 0 ? (value === 0 ? 0 : null) : round3(((value - s.value) / s.value) * 100)) : null;
          const disagree = variancePct === null ? value !== s.value : Math.abs(variancePct) > CONSISTENCY_TOLERANCE_PCT;
          if (!disagree) continue;
          conflicts.push({
            requestId: o.id, requestTitle: o.title, requesterName: names.get(o.counterpartyId) ?? o.counterpartyId, submittedOn: o.submittedOn ?? "", value: s.value, variancePct,
            detail: `${s.value ?? "blank"} ${s.unit} was sent to ${names.get(o.counterpartyId) ?? "another requester"} on ${o.submittedOn} for "${o.title}"; this draft says ${value ?? "blank"} ${meta.unit}${variancePct === null ? "" : ` (${variancePct > 0 ? "+" : ""}${variancePct}%)`}.`,
          });
        }
      }
    }
    return { key: f.key, label: f.label, metric: f.metric, metricLabel: meta.label, value, unit: meta.unit, requestedUnit: f.unit, source, overridden, note: f.note, conflicts, warnings: fieldWarnings };
  });

  const blank = fields.filter((f) => f.value === null).length;
  const conflicts = fields.reduce((n, f) => n + f.conflicts.length, 0);
  if (blank > 0) warnings.push(`${blank} of ${fields.length} fields are blank. Fill the gap in the portal or enter the value by hand with a note; do not send a zero.`);
  if (conflicts > 0) warnings.push(`${conflicts} figure${conflicts === 1 ? "" : "s"} disagree with what was already sent to another requester for ${request.reportingYear}. Resolve before submitting, or record why they differ.`);
  if (request.dueOn && request.state === "open") {
    const today = ctx.now().toISOString().slice(0, 10);
    if (today > request.dueOn) warnings.push(`The ${request.dueOn} deadline has passed.`);
  }

  return { request, requesterName: requester?.name ?? request.counterpartyId, period, fields, counts: { fields: fields.length, answered: fields.length - blank, blank, conflicts }, warnings };
}

export class SubmissionBlockedError extends Error {
  constructor(public readonly conflicts: Conflict[]) {
    super(`${conflicts.length} figure${conflicts.length === 1 ? " disagrees" : "s disagree"} with what was already sent to another requester. Resolve ${conflicts.length === 1 ? "it" : "them"}, or submit with a note explaining the difference.`);
    this.name = "SubmissionBlockedError";
  }
}

/**
 * Submits the drafted response: snapshots the figures as sent. A conflict
 * with a previous submission blocks it unless a note records why the figures
 * differ, so a divergent return is never sent silently.
 */
export function submitResponse(db: Db, ctx: OperationContext, id: string, opts: { on?: string; note?: string } = {}): DraftResponse {
  const repo = new InboundRequestRepository(db);
  const request = repo.get(id);
  if (!request) throw new InboundRequestNotFoundError(id);
  const draft = draftResponse(db, ctx, request);
  const conflicts = draft.fields.flatMap((f) => f.conflicts);
  if (conflicts.length > 0 && !opts.note?.trim()) throw new SubmissionBlockedError(conflicts);
  const figures: SubmittedFigure[] = draft.fields.map((f) => ({ key: f.key, label: f.label, metric: f.metric, value: f.value, unit: f.unit, source: f.source }));
  const updated = repo.markSubmitted(id, figures, opts.on ?? ctx.now().toISOString().slice(0, 10), opts.note?.trim() || undefined, ctx.now());
  return { ...draft, request: updated };
}

/** The next year's request from a recurring one: same requester, template and fields, overrides cleared, deadline a year on. */
export function rollForward(db: Db, id: string, now = new Date()): InboundRequestRecord {
  const repo = new InboundRequestRepository(db);
  const current = repo.get(id);
  if (!current) throw new InboundRequestNotFoundError(id);
  const dueOn = current.dueOn ? `${Number(current.dueOn.slice(0, 4)) + 1}${current.dueOn.slice(4)}` : undefined;
  return repo.create({
    counterpartyId: current.counterpartyId,
    title: current.title.replace(String(current.reportingYear), String(current.reportingYear + 1)),
    reportingYear: current.reportingYear + 1,
    periodStartMonth: current.periodStartMonth,
    template: current.template,
    fields: current.fields.map((f) => ({ ...f, override: undefined, note: undefined })),
    dueOn,
    owner: current.owner,
    cadence: current.cadence,
    notes: current.notes,
  }, now);
}

/* ------------------------------------------------------------------ */
/* the inbox view                                                      */
/* ------------------------------------------------------------------ */

export interface InboxItem {
  request: InboundRequestRecord;
  requesterName: string;
  daysToDue: number | null;
  overdue: boolean;
  /** A closed or submitted annual request whose next year has not been rolled forward. */
  needsRollForward: boolean;
}

export function inboxSummary(db: Db, today: string): { items: InboxItem[]; counts: { open: number; overdue: number; dueSoon: number; submitted: number; needsRollForward: number } } {
  const repo = new InboundRequestRepository(db);
  const all = repo.list();
  const names = new Map(new CounterpartyRepository(db).list().map((c) => [c.id, c.name]));
  const MS = 86_400_000;
  const items: InboxItem[] = all.map((r) => {
    const daysToDue = r.dueOn ? Math.floor((Date.parse(r.dueOn) - Date.parse(today)) / MS) : null;
    const hasNext = all.some((o) => o.counterpartyId === r.counterpartyId && o.title.replace(/\d{4}/g, "") === r.title.replace(/\d{4}/g, "") && o.reportingYear === r.reportingYear + 1);
    return {
      request: r,
      requesterName: names.get(r.counterpartyId) ?? r.counterpartyId,
      daysToDue,
      overdue: r.state === "open" && daysToDue !== null && daysToDue < 0,
      needsRollForward: r.cadence === "annual" && r.state !== "open" && !hasNext,
    };
  });
  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(a.request.state !== "open") - Number(b.request.state !== "open") || (a.daysToDue ?? 9e9) - (b.daysToDue ?? 9e9));
  return {
    items,
    counts: {
      open: items.filter((i) => i.request.state === "open").length,
      overdue: items.filter((i) => i.overdue).length,
      dueSoon: items.filter((i) => i.request.state === "open" && i.daysToDue !== null && i.daysToDue >= 0 && i.daysToDue <= 30).length,
      submitted: items.filter((i) => i.request.state === "submitted").length,
      needsRollForward: items.filter((i) => i.needsRollForward).length,
    },
  };
}
