import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db/sqlite";
import { ApiKeysRepository, hashKey, keyStatus } from "../repo";
import { clientMayRead, presentedKey } from "../scope";

let db: Db;
let repo: ApiKeysRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = new ApiKeysRepository(db);
});
afterEach(() => db.close());

describe("ApiKeysRepository", () => {
  it("issues a key that verifies to its client and stores only the hash", () => {
    const c = repo.createClient("Logicor");
    const { key, secret } = repo.issueKey(c.id, { label: "Power BI" });
    expect(secret.startsWith("nzc_")).toBe(true);
    expect(key.hint).toBe(secret.slice(-4));

    const stored = db.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(key.id) as { key_hash: string };
    expect(stored.key_hash).toBe(hashKey(secret));
    expect(JSON.stringify(db.prepare("SELECT * FROM api_keys").all())).not.toContain(secret);

    const now = new Date("2026-10-10T12:00:00Z");
    expect(repo.verify(secret, now)).toEqual({ keyId: key.id, clientId: c.id, clientName: "Logicor" });
    expect(repo.listKeys(c.id)[0].lastUsedAt).toBe(now.toISOString());
  });

  it("rejects unknown, revoked and expired keys", () => {
    const c = repo.createClient("Logicor");
    expect(repo.verify("nzc_" + "x".repeat(43))).toBeUndefined();
    expect(repo.verify("not-a-key")).toBeUndefined();

    const revoked = repo.issueKey(c.id, { label: "old" });
    expect(repo.revokeKey(revoked.key.id)).toBe(true);
    expect(repo.revokeKey(revoked.key.id)).toBe(false);
    expect(repo.verify(revoked.secret)).toBeUndefined();

    const issuedAt = new Date("2026-10-01T00:00:00Z");
    const expiring = repo.issueKey(c.id, { label: "short", expiresAt: "2026-10-05T00:00:00.000Z" }, issuedAt);
    expect(repo.verify(expiring.secret, new Date("2026-10-04T00:00:00Z"))).toBeDefined();
    expect(repo.verify(expiring.secret, new Date("2026-10-05T00:00:00Z"))).toBeUndefined();
    expect(keyStatus(expiring.key, new Date("2026-10-06T00:00:00Z"))).toBe("expired");
  });

  it("refuses a key without a label, for a missing client, or already expired", () => {
    const c = repo.createClient("Logicor");
    expect(() => repo.issueKey(c.id, { label: " " })).toThrow(/label/);
    expect(() => repo.issueKey("nope", { label: "x" })).toThrow(/not found/);
    expect(() => repo.issueKey(c.id, { label: "x", expiresAt: "2000-01-01T00:00:00.000Z" })).toThrow(/future/);
  });

  it("finds a client by id or by name in any case, and keeps names unique", () => {
    const c = repo.createClient("Logicor");
    expect(repo.findClient(c.id)?.name).toBe("Logicor");
    expect(repo.findClient("logicor")?.id).toBe(c.id);
    expect(() => repo.createClient("LOGICOR")).toThrow();
  });

  it("drops a client's keys with the client and frees its assets", () => {
    const c = repo.createClient("Logicor");
    const { secret } = repo.issueKey(c.id, { label: "x" });
    db.prepare("INSERT INTO assets (id, name, client_id, created_at, updated_at) VALUES ('a', 'A', ?, 'now', 'now')").run(c.id);
    db.prepare("DELETE FROM clients WHERE id = ?").run(c.id);
    expect(repo.verify(secret)).toBeUndefined();
    expect((db.prepare("SELECT client_id FROM assets WHERE id = 'a'").get() as { client_id: string | null }).client_id).toBeNull();
  });
});

describe("presentedKey", () => {
  const key = "nzc_" + "k".repeat(43);
  const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

  it("reads a bearer key or a Basic password with any username", () => {
    expect(presentedKey(`Bearer ${key}`)).toBe(key);
    expect(presentedKey(basic(`logicor:${key}`))).toBe(key);
    expect(presentedKey(basic(`:${key}`))).toBe(key);
  });

  it("ignores everything that is not one of our keys", () => {
    expect(presentedKey(null)).toBeUndefined();
    expect(presentedKey("Bearer some-sync-token")).toBeUndefined();
    expect(presentedKey(basic("portal:secret"))).toBeUndefined();
    expect(presentedKey(basic(`portal:${key}`), `portal:${key}`)).toBeUndefined();
  });
});

describe("clientMayRead", () => {
  it("allows only the client-scoped GET routes", () => {
    for (const path of ["/api/assets", "/api/assets/a1", "/api/assets/a1/carbon", "/api/assets/a1/assessment", "/api/portfolio",
      "/api/exports/portfolio-energy", "/api/exports/portfolio-carbon", "/api/exports/asset-carbon"]) {
      expect(clientMayRead("GET", path), path).toBe(true);
    }
    for (const path of ["/api/assets/a1/meters", "/api/assets/a1/screen", "/api/exports/secr-summary", "/api/exports/readings",
      "/api/exports/consents", "/api/exports/value-chain", "/api/readings", "/api/consents", "/api/value-chain/report", "/assets", "/"]) {
      expect(clientMayRead("GET", path), path).toBe(false);
    }
    expect(clientMayRead("POST", "/api/assets")).toBe(false);
    expect(clientMayRead("DELETE", "/api/assets/a1")).toBe(false);
  });
});
