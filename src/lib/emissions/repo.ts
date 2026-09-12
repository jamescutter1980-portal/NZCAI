import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import type { SiteActivityCreate, SiteActivityRecord, SiteActivityUpdate } from "./types";

export class SiteActivityNotFoundError extends Error {
  constructor(id: string) {
    super(`Site activity ${id} not found`);
    this.name = "SiteActivityNotFoundError";
  }
}

interface Row {
  id: string; category: string; label: string; asset_id: string | null; period_start: string; period_end: string;
  quantity: number; unit: string; refrigerant_type: string | null; waste_material: string | null;
  factor_id: string | null; factor_year: number | null; basis: string; evidence: string | null; notes: string | null;
  created_at: string; updated_at: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);

export class SiteActivityRepository {
  constructor(private readonly db: Db) {}

  list(filter: { from?: string; to?: string; assetId?: string } = {}): SiteActivityRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.from) {
      clauses.push("period_start >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("period_start < ?");
      args.push(filter.to);
    }
    if (filter.assetId) {
      clauses.push("asset_id = ?");
      args.push(filter.assetId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM site_activity${where} ORDER BY period_start DESC, label`).all(...args) as unknown as Row[]).map(fromRow);
  }

  get(id: string): SiteActivityRecord | undefined {
    const row = this.db.prepare("SELECT * FROM site_activity WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: SiteActivityCreate, now = new Date()): SiteActivityRecord {
    const stamp = now.toISOString();
    const record: SiteActivityRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO site_activity (id, category, label, asset_id, period_start, period_end, quantity, unit,
           refrigerant_type, waste_material, factor_id, factor_year, basis, evidence, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.category, record.label, n(record.assetId), record.periodStart, record.periodEnd, record.quantity, record.unit,
        n(record.refrigerantType), n(record.wasteMaterial), n(record.factorId), n(record.factorYear), record.basis ?? "client_declared",
        n(record.evidence), n(record.notes), stamp, stamp);
    return record;
  }

  createBatch(inputs: SiteActivityCreate[], now = new Date()): SiteActivityRecord[] {
    const out: SiteActivityRecord[] = [];
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

  update(id: string, patch: SiteActivityUpdate, now = new Date()): SiteActivityRecord {
    const current = this.get(id);
    if (!current) throw new SiteActivityNotFoundError(id);
    const next: SiteActivityRecord = { ...current, ...strip(patch), updatedAt: now.toISOString() };
    this.db
      .prepare(
        `UPDATE site_activity SET category = ?, label = ?, asset_id = ?, period_start = ?, period_end = ?, quantity = ?, unit = ?,
           refrigerant_type = ?, waste_material = ?, factor_id = ?, factor_year = ?, basis = ?, evidence = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.category, next.label, n(next.assetId), next.periodStart, next.periodEnd, next.quantity, next.unit,
        n(next.refrigerantType), n(next.wasteMaterial), n(next.factorId), n(next.factorYear), next.basis ?? "client_declared",
        n(next.evidence), n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM site_activity WHERE id = ?").run(id).changes === 0) throw new SiteActivityNotFoundError(id);
  }
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function fromRow(r: Row): SiteActivityRecord {
  return {
    id: r.id, category: r.category, label: r.label, assetId: r.asset_id ?? undefined, periodStart: r.period_start, periodEnd: r.period_end,
    quantity: r.quantity, unit: r.unit, refrigerantType: r.refrigerant_type ?? undefined, wasteMaterial: r.waste_material ?? undefined,
    factorId: r.factor_id ?? undefined, factorYear: r.factor_year ?? undefined, basis: r.basis as SiteActivityRecord["basis"],
    evidence: r.evidence ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
