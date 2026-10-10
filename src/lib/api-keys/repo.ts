import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import { KEY_PREFIX, looksLikeKey } from "./scope";

/**
 * Clients and their API keys.
 *
 * A key belongs to one client and reads only that client's assets. The key
 * itself is shown once when issued and stored only as a SHA-256 hash, the
 * same way supplier submission tokens are; 32 random bytes make a slow hash
 * unnecessary. The last four characters are kept so a key can be recognised
 * in a list without being recoverable.
 */

export interface Client {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  clientId: string;
  label: string;
  hint: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export type KeyStatus = "active" | "expired" | "revoked";

/** The caller a valid key resolves to. */
export interface KeyPrincipal {
  keyId: string;
  clientId: string;
  clientName: string;
}

interface ClientRow { id: string; name: string; created_at: string; updated_at: string }
interface KeyRow {
  id: string; client_id: string; label: string; key_hash: string; key_hint: string;
  expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
}

export class ClientNotFoundError extends Error {
  constructor(ref: string) {
    super(`Client ${ref} not found`);
    this.name = "ClientNotFoundError";
  }
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function keyStatus(key: Pick<ApiKey, "expiresAt" | "revokedAt">, now = new Date()): KeyStatus {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && key.expiresAt <= now.toISOString()) return "expired";
  return "active";
}

export class ApiKeysRepository {
  constructor(private readonly db: Db) {}

  createClient(name: string, now = new Date()): Client {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Client name is required");
    const stamp = now.toISOString();
    const client: Client = { id: randomUUID(), name: trimmed, createdAt: stamp, updatedAt: stamp };
    this.db.prepare("INSERT INTO clients (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(client.id, client.name, stamp, stamp);
    return client;
  }

  listClients(): Client[] {
    return (this.db.prepare("SELECT * FROM clients ORDER BY name").all() as unknown as ClientRow[]).map(clientFromRow);
  }

  /** Looks a client up by id or, case-insensitively, by name. */
  findClient(ref: string): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ? OR name = ? COLLATE NOCASE").get(ref, ref.trim()) as unknown as ClientRow | undefined;
    return row ? clientFromRow(row) : undefined;
  }

  /**
   * Issues a new key. The plaintext is in the return value and nowhere else;
   * once the caller has passed it on it cannot be shown again.
   */
  issueKey(clientId: string, input: { label: string; expiresAt?: string }, now = new Date()): { key: ApiKey; secret: string } {
    if (!this.db.prepare("SELECT 1 FROM clients WHERE id = ?").get(clientId)) throw new ClientNotFoundError(clientId);
    const label = input.label.trim();
    if (!label) throw new Error("A key label is required, e.g. the system that will use it");
    if (input.expiresAt && input.expiresAt <= now.toISOString()) throw new Error("Expiry must be in the future");
    const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
    const key: ApiKey = {
      id: randomUUID(), clientId, label, hint: secret.slice(-4),
      expiresAt: input.expiresAt, createdAt: now.toISOString(),
    };
    this.db
      .prepare("INSERT INTO api_keys (id, client_id, label, key_hash, key_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key.id, clientId, label, hashKey(secret), key.hint, key.expiresAt ?? null, key.createdAt);
    return { key, secret };
  }

  listKeys(clientId?: string): ApiKey[] {
    const rows = clientId === undefined
      ? this.db.prepare("SELECT * FROM api_keys ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM api_keys WHERE client_id = ? ORDER BY created_at").all(clientId);
    return (rows as unknown as KeyRow[]).map(keyFromRow);
  }

  /** Revokes a key by id. Returns false when there is no such key or it was already revoked. */
  revokeKey(id: string, now = new Date()): boolean {
    const res = this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id);
    return res.changes > 0;
  }

  /**
   * The principal for a presented key, or undefined when the key is unknown,
   * revoked or expired. A hit records last use so stale keys can be found.
   */
  verify(secret: string, now = new Date()): KeyPrincipal | undefined {
    if (!looksLikeKey(secret)) return undefined;
    const row = this.db
      .prepare(
        `SELECT k.*, c.name AS client_name FROM api_keys k JOIN clients c ON c.id = k.client_id WHERE k.key_hash = ?`,
      )
      .get(hashKey(secret)) as unknown as (KeyRow & { client_name: string }) | undefined;
    if (!row || keyStatus(keyFromRow(row), now) !== "active") return undefined;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    return { keyId: row.id, clientId: row.client_id, clientName: row.client_name };
  }
}

function clientFromRow(r: ClientRow): Client {
  return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
}

function keyFromRow(r: KeyRow): ApiKey {
  return {
    id: r.id, clientId: r.client_id, label: r.label, hint: r.key_hint,
    expiresAt: r.expires_at ?? undefined, lastUsedAt: r.last_used_at ?? undefined,
    revokedAt: r.revoked_at ?? undefined, createdAt: r.created_at,
  };
}
