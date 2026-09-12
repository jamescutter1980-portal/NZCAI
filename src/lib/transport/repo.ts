import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import type { ActivityCreate, ActivityRecord, ActivityUpdate, TransportCategory, VehicleCreate, VehicleRecord, VehicleUpdate } from "./types";

export class TransportNotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = "TransportNotFoundError";
  }
}

interface VehicleRow {
  id: string; registration: string | null; make: string | null; model: string | null; fuel_type: string | null;
  engine_capacity_cc: number | null; co2_g_per_km: number | null; year_of_manufacture: number | null; ownership: string;
  enrichment_source: string | null; enriched_at: string | null; enrichment_detail: string | null; notes: string | null;
  created_at: string; updated_at: string;
}
interface ActivityRow {
  id: string; category: string; label: string; period_start: string; period_end: string; asset_id: string | null;
  vehicle_id: string | null; quantity: number; unit: string; factor_id: string | null; factor_year: number | null;
  basis: string; evidence: string | null; notes: string | null; created_at: string; updated_at: string;
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);

/**
 * Registrations are the natural key for a vehicle, so they are normalised on
 * write as well as on lookup. Without this a record created through the
 * repository directly would never be found again by registration.
 */
const normaliseRegistration = (v: string | undefined) => (v === undefined ? undefined : v.toUpperCase().replace(/\s+/g, ""));

export class TransportRepository {
  constructor(private readonly db: Db) {}

  listVehicles(): VehicleRecord[] {
    return (this.db.prepare("SELECT * FROM vehicles ORDER BY registration, make, model").all() as unknown as VehicleRow[]).map(vehicleFromRow);
  }

  getVehicle(id: string): VehicleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM vehicles WHERE id = ?").get(id) as unknown as VehicleRow | undefined;
    return row ? vehicleFromRow(row) : undefined;
  }

  findVehicleByRegistration(registration: string): VehicleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM vehicles WHERE registration = ?").get(registration.toUpperCase().replace(/\s+/g, "")) as unknown as VehicleRow | undefined;
    return row ? vehicleFromRow(row) : undefined;
  }

  createVehicle(input: VehicleCreate, now = new Date()): VehicleRecord {
    const stamp = now.toISOString();
    const record: VehicleRecord = { ...input, registration: normaliseRegistration(input.registration), id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO vehicles (id, registration, make, model, fuel_type, engine_capacity_cc, co2_g_per_km, year_of_manufacture, ownership,
           enrichment_source, enriched_at, enrichment_detail, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, n(record.registration), n(record.make), n(record.model), n(record.fuelType), n(record.engineCapacityCc), n(record.co2GPerKm),
        n(record.yearOfManufacture), record.ownership ?? "owned", n(record.enrichmentSource), n(record.enrichedAt), n(record.enrichmentDetail), n(record.notes), stamp, stamp);
    return record;
  }

  updateVehicle(id: string, patch: VehicleUpdate, now = new Date()): VehicleRecord {
    const current = this.getVehicle(id);
    if (!current) throw new TransportNotFoundError("Vehicle", id);
    const patched = strip(patch);
    const next: VehicleRecord = { ...current, ...patched, updatedAt: now.toISOString() };
    if ("registration" in patched) next.registration = normaliseRegistration(next.registration);
    this.db
      .prepare(
        `UPDATE vehicles SET registration = ?, make = ?, model = ?, fuel_type = ?, engine_capacity_cc = ?, co2_g_per_km = ?,
           year_of_manufacture = ?, ownership = ?, enrichment_source = ?, enriched_at = ?, enrichment_detail = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(n(next.registration), n(next.make), n(next.model), n(next.fuelType), n(next.engineCapacityCc), n(next.co2GPerKm), n(next.yearOfManufacture),
        next.ownership ?? "owned", n(next.enrichmentSource), n(next.enrichedAt), n(next.enrichmentDetail), n(next.notes), next.updatedAt, id);
    return next;
  }

  deleteVehicle(id: string): void {
    if (this.db.prepare("DELETE FROM vehicles WHERE id = ?").run(id).changes === 0) throw new TransportNotFoundError("Vehicle", id);
  }

  listActivity(filter: { from?: string; to?: string; category?: TransportCategory } = {}): ActivityRecord[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.from) {
      clauses.push("period_start >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("period_start < ?");
      args.push(filter.to);
    }
    if (filter.category) {
      clauses.push("category = ?");
      args.push(filter.category);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM transport_activity${where} ORDER BY period_start DESC, label`).all(...args) as unknown as ActivityRow[]).map(activityFromRow);
  }

  getActivity(id: string): ActivityRecord | undefined {
    const row = this.db.prepare("SELECT * FROM transport_activity WHERE id = ?").get(id) as unknown as ActivityRow | undefined;
    return row ? activityFromRow(row) : undefined;
  }

  createActivity(input: ActivityCreate, now = new Date()): ActivityRecord {
    const stamp = now.toISOString();
    const record: ActivityRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO transport_activity (id, category, label, period_start, period_end, asset_id, vehicle_id, quantity, unit,
           factor_id, factor_year, basis, evidence, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.category, record.label, record.periodStart, record.periodEnd, n(record.assetId), n(record.vehicleId), record.quantity,
        record.unit, n(record.factorId), n(record.factorYear), record.basis ?? "client_declared", n(record.evidence), n(record.notes), stamp, stamp);
    return record;
  }

  /** Inserts many rows in one transaction, for CSV import. */
  createActivityBatch(inputs: ActivityCreate[], now = new Date()): ActivityRecord[] {
    const out: ActivityRecord[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) out.push(this.createActivity(input, now));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  updateActivity(id: string, patch: ActivityUpdate, now = new Date()): ActivityRecord {
    const current = this.getActivity(id);
    if (!current) throw new TransportNotFoundError("Activity", id);
    const next: ActivityRecord = { ...current, ...strip(patch), updatedAt: now.toISOString() };
    this.db
      .prepare(
        `UPDATE transport_activity SET category = ?, label = ?, period_start = ?, period_end = ?, asset_id = ?, vehicle_id = ?,
           quantity = ?, unit = ?, factor_id = ?, factor_year = ?, basis = ?, evidence = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.category, next.label, next.periodStart, next.periodEnd, n(next.assetId), n(next.vehicleId), next.quantity, next.unit,
        n(next.factorId), n(next.factorYear), next.basis ?? "client_declared", n(next.evidence), n(next.notes), next.updatedAt, id);
    return next;
  }

  deleteActivity(id: string): void {
    if (this.db.prepare("DELETE FROM transport_activity WHERE id = ?").run(id).changes === 0) throw new TransportNotFoundError("Activity", id);
  }
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function vehicleFromRow(r: VehicleRow): VehicleRecord {
  return {
    id: r.id, registration: r.registration ?? undefined, make: r.make ?? undefined, model: r.model ?? undefined,
    fuelType: r.fuel_type ?? undefined, engineCapacityCc: r.engine_capacity_cc ?? undefined, co2GPerKm: r.co2_g_per_km ?? undefined,
    yearOfManufacture: r.year_of_manufacture ?? undefined, ownership: r.ownership as VehicleRecord["ownership"],
    enrichmentSource: r.enrichment_source ?? undefined, enrichedAt: r.enriched_at ?? undefined, enrichmentDetail: r.enrichment_detail ?? undefined,
    notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function activityFromRow(r: ActivityRow): ActivityRecord {
  return {
    id: r.id, category: r.category as ActivityRecord["category"], label: r.label, periodStart: r.period_start, periodEnd: r.period_end,
    assetId: r.asset_id ?? undefined, vehicleId: r.vehicle_id ?? undefined, quantity: r.quantity, unit: r.unit,
    factorId: r.factor_id ?? undefined, factorYear: r.factor_year ?? undefined, basis: r.basis as ActivityRecord["basis"],
    evidence: r.evidence ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
