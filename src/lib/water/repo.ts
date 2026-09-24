import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import type {
  ConsumptionCreate,
  ConsumptionRecord,
  ConsumptionUpdate,
  SupplyPointCreate,
  SupplyPointRecord,
  SupplyPointUpdate,
} from "./types";

export class SupplyPointNotFoundError extends Error {
  constructor(id: string) {
    super(`Water supply point ${id} not found`);
    this.name = "SupplyPointNotFoundError";
  }
}

export class ConsumptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Water consumption ${id} not found`);
    this.name = "ConsumptionNotFoundError";
  }
}

interface SpRow {
  id: string;
  spid: string;
  service: string;
  label: string | null;
  asset_id: string | null;
  postcode: string | null;
  address: string | null;
  retailer_id: string | null;
  wholesaler_id: string | null;
  property_type: string | null;
  floor_area_m2: number | null;
  occupants: number | null;
  consent_ref: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ConsRow {
  id: string;
  supply_point_id: string;
  period_start: string;
  period_end: string;
  volume_m3: number;
  basis: string;
  source: string;
  evidence: string | null;
  reading_start: number | null;
  reading_end: number | null;
  unit_cost_gbp_per_m3: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);

function fromSp(r: SpRow): SupplyPointRecord {
  return {
    id: r.id,
    spid: r.spid,
    service: r.service as SupplyPointRecord["service"],
    label: r.label ?? undefined,
    assetId: r.asset_id ?? undefined,
    postcode: r.postcode ?? undefined,
    address: r.address ?? undefined,
    retailerId: r.retailer_id ?? undefined,
    wholesalerId: r.wholesaler_id ?? undefined,
    propertyType: (r.property_type as SupplyPointRecord["propertyType"]) ?? undefined,
    floorAreaM2: r.floor_area_m2 ?? undefined,
    occupants: r.occupants ?? undefined,
    consentRef: r.consent_ref ?? undefined,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fromCons(r: ConsRow): ConsumptionRecord {
  return {
    id: r.id,
    supplyPointId: r.supply_point_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    volumeM3: r.volume_m3,
    basis: r.basis as ConsumptionRecord["basis"],
    source: r.source as ConsumptionRecord["source"],
    evidence: r.evidence ?? undefined,
    readingStart: r.reading_start ?? undefined,
    readingEnd: r.reading_end ?? undefined,
    unitCostGbpPerM3: r.unit_cost_gbp_per_m3 ?? undefined,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export class WaterRepository {
  constructor(private readonly db: Db) {}

  listSupplyPoints(filter: { assetId?: string; spid?: string; retailerId?: string } = {}): SupplyPointRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.assetId) {
      clauses.push("asset_id = ?");
      args.push(filter.assetId);
    }
    if (filter.spid) {
      clauses.push("spid = ?");
      args.push(filter.spid.toUpperCase());
    }
    if (filter.retailerId) {
      clauses.push("retailer_id = ?");
      args.push(filter.retailerId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM water_supply_points${where} ORDER BY spid`).all(...args) as unknown as SpRow[]).map(fromSp);
  }

  getSupplyPoint(id: string): SupplyPointRecord | undefined {
    const row = this.db.prepare("SELECT * FROM water_supply_points WHERE id = ?").get(id) as unknown as SpRow | undefined;
    return row ? fromSp(row) : undefined;
  }

  getSupplyPointBySpid(spid: string): SupplyPointRecord | undefined {
    const row = this.db.prepare("SELECT * FROM water_supply_points WHERE spid = ?").get(spid.toUpperCase()) as unknown as SpRow | undefined;
    return row ? fromSp(row) : undefined;
  }

  createSupplyPoint(input: SupplyPointCreate, now = new Date()): SupplyPointRecord {
    const stamp = now.toISOString();
    const record: SupplyPointRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO water_supply_points (
           id, spid, service, label, asset_id, postcode, address, retailer_id, wholesaler_id,
           property_type, floor_area_m2, occupants, consent_ref, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.spid,
        record.service,
        n(record.label),
        n(record.assetId),
        n(record.postcode),
        n(record.address),
        n(record.retailerId),
        n(record.wholesalerId),
        n(record.propertyType),
        n(record.floorAreaM2),
        n(record.occupants),
        n(record.consentRef),
        n(record.notes),
        stamp,
        stamp,
      );
    return record;
  }

  updateSupplyPoint(id: string, patch: SupplyPointUpdate, now = new Date()): SupplyPointRecord {
    const current = this.getSupplyPoint(id);
    if (!current) throw new SupplyPointNotFoundError(id);
    const next: SupplyPointRecord = { ...current, ...strip(patch), updatedAt: now.toISOString() };
    this.db
      .prepare(
        `UPDATE water_supply_points SET service = ?, label = ?, asset_id = ?, postcode = ?, address = ?, retailer_id = ?,
           wholesaler_id = ?, property_type = ?, floor_area_m2 = ?, occupants = ?, consent_ref = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.service,
        n(next.label),
        n(next.assetId),
        n(next.postcode),
        n(next.address),
        n(next.retailerId),
        n(next.wholesalerId),
        n(next.propertyType),
        n(next.floorAreaM2),
        n(next.occupants),
        n(next.consentRef),
        n(next.notes),
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteSupplyPoint(id: string): void {
    if (this.db.prepare("DELETE FROM water_supply_points WHERE id = ?").run(id).changes === 0) {
      throw new SupplyPointNotFoundError(id);
    }
  }

  listConsumption(filter: { supplyPointId?: string; assetId?: string; from?: string; to?: string } = {}): ConsumptionRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.supplyPointId) {
      clauses.push("c.supply_point_id = ?");
      args.push(filter.supplyPointId);
    }
    if (filter.assetId) {
      clauses.push("sp.asset_id = ?");
      args.push(filter.assetId);
    }
    if (filter.from) {
      clauses.push("c.period_start >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("c.period_start < ?");
      args.push(filter.to);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = filter.assetId
      ? `SELECT c.* FROM water_consumption c JOIN water_supply_points sp ON sp.id = c.supply_point_id${where} ORDER BY c.period_start DESC`
      : `SELECT c.* FROM water_consumption c${where} ORDER BY c.period_start DESC`;
    return (this.db.prepare(sql).all(...args) as unknown as ConsRow[]).map(fromCons);
  }

  getConsumption(id: string): ConsumptionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM water_consumption WHERE id = ?").get(id) as unknown as ConsRow | undefined;
    return row ? fromCons(row) : undefined;
  }

  createConsumption(input: ConsumptionCreate, now = new Date()): ConsumptionRecord {
    if (!this.getSupplyPoint(input.supplyPointId)) throw new SupplyPointNotFoundError(input.supplyPointId);
    const stamp = now.toISOString();
    const record: ConsumptionRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO water_consumption (
           id, supply_point_id, period_start, period_end, volume_m3, basis, source, evidence,
           reading_start, reading_end, unit_cost_gbp_per_m3, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.supplyPointId,
        record.periodStart,
        record.periodEnd,
        record.volumeM3,
        record.basis,
        record.source,
        n(record.evidence),
        n(record.readingStart),
        n(record.readingEnd),
        n(record.unitCostGbpPerM3),
        n(record.notes),
        stamp,
        stamp,
      );
    return record;
  }

  createConsumptionBatch(inputs: ConsumptionCreate[], now = new Date()): ConsumptionRecord[] {
    const out: ConsumptionRecord[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) out.push(this.createConsumption(input, now));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  updateConsumption(id: string, patch: ConsumptionUpdate, now = new Date()): ConsumptionRecord {
    const current = this.getConsumption(id);
    if (!current) throw new ConsumptionNotFoundError(id);
    const next: ConsumptionRecord = { ...current, ...strip(patch), updatedAt: now.toISOString() };
    this.db
      .prepare(
        `UPDATE water_consumption SET period_start = ?, period_end = ?, volume_m3 = ?, basis = ?, source = ?, evidence = ?,
           reading_start = ?, reading_end = ?, unit_cost_gbp_per_m3 = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.periodStart,
        next.periodEnd,
        next.volumeM3,
        next.basis,
        next.source,
        n(next.evidence),
        n(next.readingStart),
        n(next.readingEnd),
        n(next.unitCostGbpPerM3),
        n(next.notes),
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteConsumption(id: string): void {
    if (this.db.prepare("DELETE FROM water_consumption WHERE id = ?").run(id).changes === 0) {
      throw new ConsumptionNotFoundError(id);
    }
  }
}
