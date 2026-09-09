import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConsentCreate, ConsentRecord, ConsentUpdate } from "./types";

/**
 * Persistence boundary for consents. The JSON file implementation is for
 * development and single-instance use; replace with a database-backed
 * implementation before multi-user deployment. Callers depend only on this
 * interface.
 */
export interface ConsentStore {
  list(): Promise<ConsentRecord[]>;
  get(id: string): Promise<ConsentRecord | undefined>;
  findByMpxn(mpxn: string): Promise<ConsentRecord[]>;
  create(input: ConsentCreate, now?: Date): Promise<ConsentRecord>;
  update(id: string, patch: ConsentUpdate & Partial<VerificationPatch>, now?: Date): Promise<ConsentRecord>;
}

export interface VerificationPatch {
  lastVerifiedAt: string;
  lastVerificationResult: "granted" | "refused" | "error";
  lastVerificationDetail: string;
}

export class ConsentNotFoundError extends Error {
  constructor(id: string) {
    super(`Consent ${id} not found`);
    this.name = "ConsentNotFoundError";
  }
}

export class JsonFileConsentStore implements ConsentStore {
  constructor(private readonly path: string) {}

  private read(): ConsentRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? (parsed as ConsentRecord[]) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private write(records: ConsentRecord[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2));
    renameSync(tmp, this.path);
  }

  async list() {
    return this.read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string) {
    return this.read().find((c) => c.id === id);
  }

  async findByMpxn(mpxn: string) {
    return this.read().filter((c) => c.mpxn === mpxn);
  }

  async create(input: ConsentCreate, now = new Date()) {
    const records = this.read();
    const stamp = now.toISOString();
    const record: ConsentRecord = { ...input, id: randomUUID(), createdAt: stamp, updatedAt: stamp };
    records.push(record);
    this.write(records);
    return record;
  }

  async update(id: string, patch: ConsentUpdate & Partial<VerificationPatch>, now = new Date()) {
    const records = this.read();
    const idx = records.findIndex((c) => c.id === id);
    if (idx === -1) throw new ConsentNotFoundError(id);
    const current = records[idx];
    const next: ConsentRecord = { ...current, ...stripUndefined(patch), updatedAt: now.toISOString() };
    if (patch.status === "withdrawn" && current.status !== "withdrawn") {
      next.withdrawnAt = now.toISOString();
    }
    if (patch.status && patch.status !== "withdrawn") {
      delete next.withdrawnAt;
      delete next.withdrawnReason;
    }
    records[idx] = next;
    this.write(records);
    return next;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

let singleton: ConsentStore | undefined;

/** Process-wide store. Path from CONSENT_STORE_PATH, default data/consents.json. */
export function getConsentStore(): ConsentStore {
  if (!singleton) {
    singleton = new JsonFileConsentStore(process.env.CONSENT_STORE_PATH?.trim() || "data/consents.json");
  }
  return singleton;
}

/** Test hook. */
export function setConsentStore(store: ConsentStore | undefined) {
  singleton = store;
}
