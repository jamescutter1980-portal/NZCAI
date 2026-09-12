import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import { ConsentNotFoundError, type ConsentStore, type VerificationPatch } from "./store";
import type { ConsentCreate, ConsentRecord, ConsentUpdate } from "./types";

interface Row {
  id: string;
  mpxn: string;
  utilities: string;
  asset_ref: string | null;
  site_address: string | null;
  occupier_name: string;
  occupier_email: string | null;
  occupier_organisation: string | null;
  method: string;
  evidence_ref: string | null;
  granted_on: string;
  expires_on: string;
  status: string;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  last_verified_at: string | null;
  last_verification_result: string | null;
  last_verification_detail: string | null;
}

const COLUMNS: [keyof Row, keyof ConsentRecord][] = [
  ["id", "id"],
  ["mpxn", "mpxn"],
  ["utilities", "utilities"],
  ["asset_ref", "assetRef"],
  ["site_address", "siteAddress"],
  ["occupier_name", "occupierName"],
  ["occupier_email", "occupierEmail"],
  ["occupier_organisation", "occupierOrganisation"],
  ["method", "method"],
  ["evidence_ref", "evidenceRef"],
  ["granted_on", "grantedOn"],
  ["expires_on", "expiresOn"],
  ["status", "status"],
  ["notes", "notes"],
  ["recorded_by", "recordedBy"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
  ["withdrawn_at", "withdrawnAt"],
  ["withdrawn_reason", "withdrawnReason"],
  ["last_verified_at", "lastVerifiedAt"],
  ["last_verification_result", "lastVerificationResult"],
  ["last_verification_detail", "lastVerificationDetail"],
];

/** Database-backed consent store. Same behaviour as the JSON store. */
export class SqliteConsentStore implements ConsentStore {
  constructor(private readonly db: Db) {}

  async list() {
    return (this.db.prepare("SELECT * FROM consents ORDER BY created_at DESC").all() as unknown as Row[]).map(fromRow);
  }

  async get(id: string) {
    const row = this.db.prepare("SELECT * FROM consents WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  async findByMpxn(mpxn: string) {
    return (this.db.prepare("SELECT * FROM consents WHERE mpxn = ? ORDER BY created_at DESC").all(mpxn) as unknown as Row[]).map(fromRow);
  }

  async create(input: ConsentCreate, now = new Date()) {
    const stamp = now.toISOString();
    const record: ConsentRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    const cols = COLUMNS.map(([c]) => c).join(", ");
    const placeholders = COLUMNS.map(() => "?").join(", ");
    this.db.prepare(`INSERT INTO consents (${cols}) VALUES (${placeholders})`).run(...toValues(record));
    return record;
  }

  async update(id: string, patch: ConsentUpdate & Partial<VerificationPatch>, now = new Date()) {
    const current = await this.get(id);
    if (!current) throw new ConsentNotFoundError(id);
    const next: ConsentRecord = { ...current, ...stripUndefined(patch), updatedAt: now.toISOString() };
    if (patch.status === "withdrawn" && current.status !== "withdrawn") next.withdrawnAt = now.toISOString();
    if (patch.status && patch.status !== "withdrawn") {
      delete next.withdrawnAt;
      delete next.withdrawnReason;
    }
    const sets = COLUMNS.filter(([c]) => c !== "id").map(([c]) => `${c} = ?`).join(", ");
    const values = toValues(next);
    values.shift(); // id
    this.db.prepare(`UPDATE consents SET ${sets} WHERE id = ?`).run(...values, id);
    return next;
  }
}

function toValues(r: ConsentRecord): (string | null)[] {
  return COLUMNS.map(([, k]) => {
    const v = r[k];
    if (v === undefined || v === null) return null;
    return k === "utilities" ? JSON.stringify(v) : String(v);
  });
}

function fromRow(row: Row): ConsentRecord {
  const out: Record<string, unknown> = {};
  for (const [c, k] of COLUMNS) {
    const v = row[c];
    if (v === null) continue;
    out[k] = k === "utilities" ? JSON.parse(v as string) : v;
  }
  return out as unknown as ConsentRecord;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
