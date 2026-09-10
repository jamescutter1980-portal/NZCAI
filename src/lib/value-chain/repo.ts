import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import {
  defaultCategories,
  type ActivityCreate,
  type ActivityRecord,
  type Ask,
  type CounterpartyCreate,
  type CounterpartyRecord,
  type CounterpartyUpdate,
  type EmissionsReportCreate,
  type EmissionsReportRecord,
  type EmissionsReportUpdate,
  type EngagementAction,
  type EngagementEvent,
  type EngagementRecord,
  type EngagementState,
} from "./types";

export class CounterpartyNotFoundError extends Error {
  constructor(id: string) {
    super(`Counterparty ${id} not found`);
    this.name = "CounterpartyNotFoundError";
  }
}
export class ValueChainRecordNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "ValueChainRecordNotFoundError";
  }
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const stamp = (d: Date) => d.toISOString();

/* ------------------------------------------------------------------ */
/* counterparties                                                      */
/* ------------------------------------------------------------------ */

interface CounterpartyRow {
  id: string; name: string; company_number: string | null; sector: string | null; country: string | null; roles: string; ghg_categories: string;
  annual_value_gbp: number | null; contact_name: string | null; contact_email: string | null; escalation_name: string | null; escalation_email: string | null;
  ask: string; status: string; notes: string | null; created_at: string; updated_at: string;
}

export class CounterpartyRepository {
  constructor(private readonly db: Db) {}

  list(filter: { status?: "active" | "inactive" } = {}): CounterpartyRecord[] {
    const where = filter.status ? " WHERE status = ?" : "";
    const args = filter.status ? [filter.status] : [];
    return (this.db.prepare(`SELECT * FROM counterparties${where} ORDER BY name COLLATE NOCASE`).all(...args) as unknown as CounterpartyRow[]).map(counterpartyFromRow);
  }

  get(id: string): CounterpartyRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparties WHERE id = ?").get(id) as unknown as CounterpartyRow | undefined;
    return row ? counterpartyFromRow(row) : undefined;
  }

  /** Case-insensitive exact name match, used by imports to update rather than duplicate. */
  findByName(name: string): CounterpartyRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparties WHERE name = ? COLLATE NOCASE").get(name.trim()) as unknown as CounterpartyRow | undefined;
    return row ? counterpartyFromRow(row) : undefined;
  }

  create(input: CounterpartyCreate, now = new Date()): CounterpartyRecord {
    const at = stamp(now);
    const record: CounterpartyRecord = {
      ...input,
      ghgCategories: input.ghgCategories && input.ghgCategories.length > 0 ? input.ghgCategories : defaultCategories(input.roles),
      id: randomUUID(),
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO counterparties (id, name, company_number, sector, country, roles, ghg_categories, annual_value_gbp, contact_name, contact_email,
           escalation_name, escalation_email, ask, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.name, n(record.companyNumber), n(record.sector), n(record.country), JSON.stringify(record.roles), JSON.stringify(record.ghgCategories),
        n(record.annualValueGbp), n(record.contactName), n(record.contactEmail), n(record.escalationName), n(record.escalationEmail), record.ask, record.status, n(record.notes), at, at);
    return record;
  }

  /** Imports: rows are matched by name; an existing counterparty is updated, a new one created. All or nothing. */
  upsertBatch(inputs: CounterpartyCreate[], now = new Date()): { created: CounterpartyRecord[]; updated: CounterpartyRecord[] } {
    const created: CounterpartyRecord[] = [];
    const updated: CounterpartyRecord[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) {
        const existing = this.findByName(input.name);
        // The register's spelling of the name is kept; the match is case-insensitive.
        if (existing) updated.push(this.update(existing.id, { ...input, name: existing.name }, now));
        else created.push(this.create(input, now));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { created, updated };
  }

  update(id: string, patch: CounterpartyUpdate, now = new Date()): CounterpartyRecord {
    const current = this.get(id);
    if (!current) throw new CounterpartyNotFoundError(id);
    const merged = { ...current, ...strip(patch) };
    const roles = merged.roles;
    const next: CounterpartyRecord = {
      ...merged,
      roles,
      ghgCategories: patch.ghgCategories && patch.ghgCategories.length > 0 ? patch.ghgCategories : patch.roles && !patch.ghgCategories ? defaultCategories(roles) : merged.ghgCategories,
      updatedAt: stamp(now),
    };
    this.db
      .prepare(
        `UPDATE counterparties SET name = ?, company_number = ?, sector = ?, country = ?, roles = ?, ghg_categories = ?, annual_value_gbp = ?, contact_name = ?,
           contact_email = ?, escalation_name = ?, escalation_email = ?, ask = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, n(next.companyNumber), n(next.sector), n(next.country), JSON.stringify(next.roles), JSON.stringify(next.ghgCategories), n(next.annualValueGbp),
        n(next.contactName), n(next.contactEmail), n(next.escalationName), n(next.escalationEmail), next.ask, next.status, n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM counterparties WHERE id = ?").run(id).changes === 0) throw new CounterpartyNotFoundError(id);
  }
}

function counterpartyFromRow(r: CounterpartyRow): CounterpartyRecord {
  return {
    id: r.id, name: r.name, companyNumber: r.company_number ?? undefined, sector: r.sector ?? undefined, country: r.country ?? undefined,
    roles: JSON.parse(r.roles) as string[], ghgCategories: JSON.parse(r.ghg_categories) as string[], annualValueGbp: r.annual_value_gbp ?? undefined,
    contactName: r.contact_name ?? undefined, contactEmail: r.contact_email ?? undefined, escalationName: r.escalation_name ?? undefined, escalationEmail: r.escalation_email ?? undefined,
    ask: r.ask as Ask, status: r.status as CounterpartyRecord["status"], notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* engagements and their audit trail                                   */
/* ------------------------------------------------------------------ */

interface EngagementRow {
  id: string; counterparty_id: string; reporting_year: number; state: string; ask: string; due_on: string | null; last_contact_on: string | null;
  reminders_sent: number; escalated: number; decline_reason: string | null; notes: string | null; created_at: string; updated_at: string;
}
interface EventRow {
  id: string; engagement_id: string; at: string; action: string; from_state: string; to_state: string; channel: string | null; detail: string | null; actor: string | null;
}

export class EngagementRepository {
  constructor(private readonly db: Db) {}

  listForYear(reportingYear: number): EngagementRecord[] {
    return (this.db.prepare("SELECT * FROM counterparty_engagements WHERE reporting_year = ?").all(reportingYear) as unknown as EngagementRow[]).map(engagementFromRow);
  }

  listForCounterparty(counterpartyId: string): EngagementRecord[] {
    return (this.db.prepare("SELECT * FROM counterparty_engagements WHERE counterparty_id = ? ORDER BY reporting_year DESC").all(counterpartyId) as unknown as EngagementRow[]).map(engagementFromRow);
  }

  get(id: string): EngagementRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparty_engagements WHERE id = ?").get(id) as unknown as EngagementRow | undefined;
    return row ? engagementFromRow(row) : undefined;
  }

  find(counterpartyId: string, reportingYear: number): EngagementRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparty_engagements WHERE counterparty_id = ? AND reporting_year = ?").get(counterpartyId, reportingYear) as unknown as EngagementRow | undefined;
    return row ? engagementFromRow(row) : undefined;
  }

  /** The engagement for a counterparty and year, created in the identified state if it does not exist. */
  ensure(counterpartyId: string, reportingYear: number, ask: Ask, now = new Date()): EngagementRecord {
    const existing = this.find(counterpartyId, reportingYear);
    if (existing) return existing;
    const at = stamp(now);
    const record: EngagementRecord = { id: randomUUID(), counterpartyId, reportingYear, state: "identified", ask, remindersSent: 0, escalated: false, createdAt: at, updatedAt: at };
    this.db
      .prepare("INSERT INTO counterparty_engagements (id, counterparty_id, reporting_year, state, ask, reminders_sent, escalated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)")
      .run(record.id, counterpartyId, reportingYear, record.state, ask, at, at);
    return record;
  }

  /** Writes the new state and the audit event in one transaction. */
  applyTransition(
    engagement: EngagementRecord,
    next: Omit<EngagementRecord, "id" | "counterpartyId" | "reportingYear" | "createdAt" | "updatedAt">,
    event: { action: EngagementAction; at: string; channel?: string; detail?: string; actor?: string },
    now = new Date(),
  ): { engagement: EngagementRecord; event: EngagementEvent } {
    const updated: EngagementRecord = { ...engagement, ...next, updatedAt: stamp(now) };
    const ev: EngagementEvent = {
      id: randomUUID(), engagementId: engagement.id, at: event.at, action: event.action, fromState: engagement.state, toState: next.state,
      channel: event.channel, detail: event.detail, actor: event.actor,
    };
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE counterparty_engagements SET state = ?, ask = ?, due_on = ?, last_contact_on = ?, reminders_sent = ?, escalated = ?, decline_reason = ?, notes = ?, updated_at = ? WHERE id = ?")
        .run(updated.state, updated.ask, n(updated.dueOn), n(updated.lastContactOn), updated.remindersSent, updated.escalated ? 1 : 0, n(updated.declineReason), n(updated.notes), updated.updatedAt, updated.id);
      this.db
        .prepare("INSERT INTO counterparty_engagement_events (id, engagement_id, at, action, from_state, to_state, channel, detail, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(ev.id, ev.engagementId, ev.at, ev.action, ev.fromState, ev.toState, n(ev.channel), n(ev.detail), n(ev.actor));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { engagement: updated, event: ev };
  }

  events(engagementId: string): EngagementEvent[] {
    return (this.db.prepare("SELECT * FROM counterparty_engagement_events WHERE engagement_id = ? ORDER BY at, rowid").all(engagementId) as unknown as EventRow[]).map((r) => ({
      id: r.id, engagementId: r.engagement_id, at: r.at, action: r.action as EngagementAction, fromState: r.from_state as EngagementState, toState: r.to_state as EngagementState,
      channel: r.channel ?? undefined, detail: r.detail ?? undefined, actor: r.actor ?? undefined,
    }));
  }
}

function engagementFromRow(r: EngagementRow): EngagementRecord {
  return {
    id: r.id, counterpartyId: r.counterparty_id, reportingYear: r.reporting_year, state: r.state as EngagementState, ask: r.ask as Ask,
    dueOn: r.due_on ?? undefined, lastContactOn: r.last_contact_on ?? undefined, remindersSent: r.reminders_sent, escalated: r.escalated === 1,
    declineReason: r.decline_reason ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* annual GHG reports                                                  */
/* ------------------------------------------------------------------ */

interface ReportRow {
  id: string; counterparty_id: string; reporting_year: number; period_start: string; period_end: string;
  scope1_tco2e: number | null; scope2_location_tco2e: number | null; scope2_market_tco2e: number | null; scope3_tco2e: number | null;
  allocation_method: string; allocated_tco2e: number | null; supplier_revenue_gbp: number | null; methodology: string; boundary: string; assurance: string;
  assurance_provider: string | null; basis: string; evidence: string | null; document_date: string | null; notes: string | null; created_at: string; updated_at: string;
}

export class EmissionsReportRepository {
  constructor(private readonly db: Db) {}

  list(filter: { counterpartyId?: string; reportingYear?: number } = {}): EmissionsReportRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.counterpartyId) { clauses.push("counterparty_id = ?"); args.push(filter.counterpartyId); }
    if (filter.reportingYear !== undefined) { clauses.push("reporting_year = ?"); args.push(filter.reportingYear); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM counterparty_emissions${where} ORDER BY reporting_year DESC, period_start DESC`).all(...args) as unknown as ReportRow[]).map(reportFromRow);
  }

  get(id: string): EmissionsReportRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparty_emissions WHERE id = ?").get(id) as unknown as ReportRow | undefined;
    return row ? reportFromRow(row) : undefined;
  }

  create(input: EmissionsReportCreate, now = new Date()): EmissionsReportRecord {
    const at = stamp(now);
    const record: EmissionsReportRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO counterparty_emissions (id, counterparty_id, reporting_year, period_start, period_end, scope1_tco2e, scope2_location_tco2e, scope2_market_tco2e, scope3_tco2e,
           allocation_method, allocated_tco2e, supplier_revenue_gbp, methodology, boundary, assurance, assurance_provider, basis, evidence, document_date, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.counterpartyId, record.reportingYear, record.periodStart, record.periodEnd, n(record.scope1Tco2e), n(record.scope2LocationTco2e), n(record.scope2MarketTco2e),
        n(record.scope3Tco2e), record.allocationMethod, n(record.allocatedTco2e), n(record.supplierRevenueGbp), record.methodology, record.boundary, record.assurance,
        n(record.assuranceProvider), record.basis, n(record.evidence), n(record.documentDate), n(record.notes), at, at);
    return record;
  }

  update(id: string, patch: EmissionsReportUpdate, now = new Date()): EmissionsReportRecord {
    const current = this.get(id);
    if (!current) throw new ValueChainRecordNotFoundError("Emissions report", id);
    const next: EmissionsReportRecord = { ...current, ...strip(patch), updatedAt: stamp(now) };
    this.db
      .prepare(
        `UPDATE counterparty_emissions SET period_start = ?, period_end = ?, scope1_tco2e = ?, scope2_location_tco2e = ?, scope2_market_tco2e = ?, scope3_tco2e = ?, allocation_method = ?,
           allocated_tco2e = ?, supplier_revenue_gbp = ?, methodology = ?, boundary = ?, assurance = ?, assurance_provider = ?, basis = ?, evidence = ?, document_date = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.periodStart, next.periodEnd, n(next.scope1Tco2e), n(next.scope2LocationTco2e), n(next.scope2MarketTco2e), n(next.scope3Tco2e), next.allocationMethod, n(next.allocatedTco2e),
        n(next.supplierRevenueGbp), next.methodology, next.boundary, next.assurance, n(next.assuranceProvider), next.basis, n(next.evidence), n(next.documentDate), n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM counterparty_emissions WHERE id = ?").run(id).changes === 0) throw new ValueChainRecordNotFoundError("Emissions report", id);
  }
}

function reportFromRow(r: ReportRow): EmissionsReportRecord {
  return {
    id: r.id, counterpartyId: r.counterparty_id, reportingYear: r.reporting_year, periodStart: r.period_start, periodEnd: r.period_end,
    scope1Tco2e: r.scope1_tco2e ?? undefined, scope2LocationTco2e: r.scope2_location_tco2e ?? undefined, scope2MarketTco2e: r.scope2_market_tco2e ?? undefined, scope3Tco2e: r.scope3_tco2e ?? undefined,
    allocationMethod: r.allocation_method as EmissionsReportRecord["allocationMethod"], allocatedTco2e: r.allocated_tco2e ?? undefined, supplierRevenueGbp: r.supplier_revenue_gbp ?? undefined,
    methodology: r.methodology as EmissionsReportRecord["methodology"], boundary: r.boundary as EmissionsReportRecord["boundary"], assurance: r.assurance as EmissionsReportRecord["assurance"],
    assuranceProvider: r.assurance_provider ?? undefined, basis: r.basis as EmissionsReportRecord["basis"], evidence: r.evidence ?? undefined, documentDate: r.document_date ?? undefined,
    notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* activity ledger                                                     */
/* ------------------------------------------------------------------ */

interface ActivityRow {
  id: string; counterparty_id: string; reporting_year: number; label: string; activity_type: string; period_start: string; period_end: string; quantity: number; unit: string;
  factor_id: string | null; factor_year: number | null; declared_kgco2e: number | null; share_pct: number; basis: string; evidence: string | null; notes: string | null; created_at: string; updated_at: string;
}

export class ActivityLedgerRepository {
  constructor(private readonly db: Db) {}

  list(filter: { counterpartyId?: string; reportingYear?: number } = {}): ActivityRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.counterpartyId) { clauses.push("counterparty_id = ?"); args.push(filter.counterpartyId); }
    if (filter.reportingYear !== undefined) { clauses.push("reporting_year = ?"); args.push(filter.reportingYear); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM counterparty_activity${where} ORDER BY period_start, label`).all(...args) as unknown as ActivityRow[]).map(activityFromRow);
  }

  get(id: string): ActivityRecord | undefined {
    const row = this.db.prepare("SELECT * FROM counterparty_activity WHERE id = ?").get(id) as unknown as ActivityRow | undefined;
    return row ? activityFromRow(row) : undefined;
  }

  create(input: ActivityCreate, now = new Date()): ActivityRecord {
    const at = stamp(now);
    const record: ActivityRecord = { ...input, id: randomUUID(), createdAt: at, updatedAt: at };
    this.db
      .prepare(
        `INSERT INTO counterparty_activity (id, counterparty_id, reporting_year, label, activity_type, period_start, period_end, quantity, unit, factor_id, factor_year, declared_kgco2e,
           share_pct, basis, evidence, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.counterpartyId, record.reportingYear, record.label, record.activityType, record.periodStart, record.periodEnd, record.quantity, record.unit,
        n(record.factorId), n(record.factorYear), n(record.declaredKgCo2e), record.sharePct, record.basis, n(record.evidence), n(record.notes), at, at);
    return record;
  }

  createBatch(inputs: ActivityCreate[], now = new Date()): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) out.push(this.create(input, now));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM counterparty_activity WHERE id = ?").run(id).changes === 0) throw new ValueChainRecordNotFoundError("Activity line", id);
  }
}

function activityFromRow(r: ActivityRow): ActivityRecord {
  return {
    id: r.id, counterpartyId: r.counterparty_id, reportingYear: r.reporting_year, label: r.label, activityType: r.activity_type, periodStart: r.period_start, periodEnd: r.period_end,
    quantity: r.quantity, unit: r.unit, factorId: r.factor_id ?? undefined, factorYear: r.factor_year ?? undefined, declaredKgCo2e: r.declared_kgco2e ?? undefined, sharePct: r.share_pct,
    basis: r.basis as ActivityRecord["basis"], evidence: r.evidence ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
