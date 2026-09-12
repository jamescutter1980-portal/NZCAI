import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import type { AssetCreate, AssetMeter, AssetMeterInput, AssetRecord, AssetUpdate } from "./types";
import type { ScreeningRun } from "./screening";

interface AssetRow {
  id: string; name: string; uprn: string | null; address: string | null; postcode: string | null; latitude: number | null; longitude: number | null;
  floor_area_m2: number | null; property_type: string | null; country: string | null; notes: string | null; created_at: string; updated_at: string;
}
interface MeterRow {
  asset_id: string; mpxn: string; utility: string; direction: string; label: string | null; supplier_factor_kgco2e_per_kwh: number | null; supplier_factor_evidence: string | null; share: number | null; created_at: string;
}

export class AssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Asset ${id} not found`);
    this.name = "AssetNotFoundError";
  }
}

export class AssetsRepository {
  constructor(private readonly db: Db) {}

  list(): AssetRecord[] {
    return (this.db.prepare("SELECT * FROM assets ORDER BY name").all() as unknown as AssetRow[]).map(fromRow);
  }

  get(id: string): AssetRecord | undefined {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as unknown as AssetRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: AssetCreate, now = new Date()): AssetRecord {
    const stamp = now.toISOString();
    const record: AssetRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    this.db
      .prepare(
        `INSERT INTO assets (id, name, uprn, address, postcode, latitude, longitude, floor_area_m2, property_type, country, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.name, n(record.uprn), n(record.address), n(record.postcode), n(record.latitude), n(record.longitude), n(record.floorAreaM2), n(record.propertyType), n(record.country), n(record.notes), stamp, stamp);
    return record;
  }

  update(id: string, patch: AssetUpdate, now = new Date()): AssetRecord {
    const current = this.get(id);
    if (!current) throw new AssetNotFoundError(id);
    const next: AssetRecord = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: now.toISOString() };
    this.db
      .prepare(
        `UPDATE assets SET name = ?, uprn = ?, address = ?, postcode = ?, latitude = ?, longitude = ?, floor_area_m2 = ?, property_type = ?, country = ?, notes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, n(next.uprn), n(next.address), n(next.postcode), n(next.latitude), n(next.longitude), n(next.floorAreaM2), n(next.propertyType), n(next.country), n(next.notes), next.updatedAt, id);
    return next;
  }

  delete(id: string): void {
    const res = this.db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    if (res.changes === 0) throw new AssetNotFoundError(id);
  }

  meters(assetId: string): AssetMeter[] {
    return (this.db.prepare("SELECT * FROM asset_meters WHERE asset_id = ? ORDER BY utility, direction, mpxn").all(assetId) as unknown as MeterRow[]).map(meterFromRow);
  }

  linkMeter(assetId: string, input: AssetMeterInput, now = new Date()): AssetMeter {
    if (!this.get(assetId)) throw new AssetNotFoundError(assetId);
    const stamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO asset_meters (asset_id, mpxn, utility, direction, label, supplier_factor_kgco2e_per_kwh, supplier_factor_evidence, share, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, mpxn, utility, direction) DO UPDATE SET label = excluded.label,
           supplier_factor_kgco2e_per_kwh = excluded.supplier_factor_kgco2e_per_kwh, supplier_factor_evidence = excluded.supplier_factor_evidence,
           share = excluded.share`,
      )
      .run(assetId, input.mpxn, input.utility, input.direction, n(input.label), n(input.supplierFactorKgCo2ePerKwh), n(input.supplierFactorEvidence), input.share ?? 1, stamp);
    return { assetId, ...input, createdAt: stamp };
  }

  unlinkMeter(assetId: string, mpxn: string, utility: string, direction: string): boolean {
    return this.db.prepare("DELETE FROM asset_meters WHERE asset_id = ? AND mpxn = ? AND utility = ? AND direction = ?").run(assetId, mpxn, utility, direction).changes > 0;
  }

  /**
   * Total share allocated across every asset for a meter. More than 1 means
   * the same energy is counted twice; less than 1 means some is unallocated.
   */
  allocationForMeter(mpxn: string, utility: string, direction: string): { total: number; links: { assetId: string; assetName: string; share: number }[] } {
    const rows = this.db
      .prepare(
        `SELECT m.asset_id AS assetId, a.name AS assetName, m.share AS share
         FROM asset_meters m JOIN assets a ON a.id = m.asset_id
         WHERE m.mpxn = ? AND m.utility = ? AND m.direction = ? ORDER BY a.name`,
      )
      .all(mpxn, utility, direction) as unknown as { assetId: string; assetName: string; share: number | null }[];
    const links = rows.map((r) => ({ ...r, share: r.share ?? 1 }));
    return { total: Math.round(links.reduce((n, l) => n + l.share, 0) * 1000) / 1000, links };
  }

  /** Which assets a meter is linked to (a shared supply can serve several). */
  assetsForMeter(mpxn: string): AssetRecord[] {
    return (this.db.prepare("SELECT a.* FROM assets a JOIN asset_meters m ON m.asset_id = a.id WHERE m.mpxn = ? ORDER BY a.name").all(mpxn) as unknown as AssetRow[]).map(fromRow);
  }

  saveScreening(run: ScreeningRun): void {
    this.db
      .prepare("INSERT INTO asset_screenings (id, asset_id, ran_at, results, ok_count, error_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run(run.id, run.assetId, run.ranAt, JSON.stringify(run.results), run.okCount, run.errorCount);
  }

  latestScreening(assetId: string): ScreeningRun | undefined {
    const row = this.db.prepare("SELECT * FROM asset_screenings WHERE asset_id = ? ORDER BY ran_at DESC LIMIT 1").get(assetId) as
      | { id: string; asset_id: string; ran_at: string; results: string; ok_count: number; error_count: number }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, assetId: row.asset_id, ranAt: row.ran_at, results: JSON.parse(row.results), okCount: row.ok_count, errorCount: row.error_count };
  }

  listScreenings(assetId: string, limit = 10): Omit<ScreeningRun, "results">[] {
    return (this.db.prepare("SELECT id, asset_id, ran_at, ok_count, error_count FROM asset_screenings WHERE asset_id = ? ORDER BY ran_at DESC LIMIT ?").all(assetId, limit) as unknown as { id: string; asset_id: string; ran_at: string; ok_count: number; error_count: number }[]).map((r) => ({
      id: r.id, assetId: r.asset_id, ranAt: r.ran_at, okCount: r.ok_count, errorCount: r.error_count,
    }));
  }
}

const n = <T>(v: T | undefined) => (v === undefined ? null : v);

function fromRow(r: AssetRow): AssetRecord {
  return {
    id: r.id, name: r.name, uprn: r.uprn ?? undefined, address: r.address ?? undefined, postcode: r.postcode ?? undefined,
    latitude: r.latitude ?? undefined, longitude: r.longitude ?? undefined, floorAreaM2: r.floor_area_m2 ?? undefined,
    propertyType: r.property_type ?? undefined, country: r.country ?? undefined, notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function meterFromRow(r: MeterRow): AssetMeter {
  return {
    assetId: r.asset_id, mpxn: r.mpxn, utility: r.utility as "electricity" | "gas", direction: r.direction as "import" | "export", label: r.label ?? undefined,
    supplierFactorKgCo2ePerKwh: r.supplier_factor_kgco2e_per_kwh ?? undefined, supplierFactorEvidence: r.supplier_factor_evidence ?? undefined,
    share: r.share ?? 1, createdAt: r.created_at,
  };
}
