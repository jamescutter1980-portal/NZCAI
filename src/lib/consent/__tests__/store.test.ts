import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsentNotFoundError, JsonFileConsentStore } from "../store";

let dir: string;
let store: JsonFileConsentStore;

const input = {
  mpxn: "1234567890123",
  utilities: ["electricity" as const],
  occupierName: "A Tenant Ltd",
  method: "n3rgy_consumer_portal" as const,
  grantedOn: "2026-09-01",
  expiresOn: "2027-08-31",
  status: "pending" as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "consents-"));
  store = new JsonFileConsentStore(join(dir, "nested", "consents.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JsonFileConsentStore", () => {
  it("starts empty and creates the file on first write", async () => {
    expect(await store.list()).toEqual([]);
    const created = await store.create(input, new Date("2026-09-09T10:00:00Z"));
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.createdAt).toBe("2026-09-09T10:00:00.000Z");
    expect(JSON.parse(readFileSync(join(dir, "nested", "consents.json"), "utf8"))).toHaveLength(1);
  });

  it("finds by MPxN and lists newest first", async () => {
    await store.create(input, new Date("2026-09-01T00:00:00Z"));
    const b = await store.create({ ...input, mpxn: "9999999999" }, new Date("2026-09-02T00:00:00Z"));
    expect((await store.list())[0].id).toBe(b.id);
    expect(await store.findByMpxn("9999999999")).toHaveLength(1);
    expect(await store.findByMpxn("0000000000")).toEqual([]);
  });

  it("updates, stamps withdrawal and clears it on reactivation", async () => {
    const c = await store.create(input);
    const withdrawn = await store.update(c.id, { status: "withdrawn", withdrawnReason: "tenant left" }, new Date("2026-10-01T00:00:00Z"));
    expect(withdrawn.withdrawnAt).toBe("2026-10-01T00:00:00.000Z");
    expect(withdrawn.withdrawnReason).toBe("tenant left");
    const active = await store.update(c.id, { status: "active" });
    expect(active.withdrawnAt).toBeUndefined();
    expect(active.withdrawnReason).toBeUndefined();
    expect((await store.get(c.id))?.status).toBe("active");
  });

  it("records verification results", async () => {
    const c = await store.create(input);
    const v = await store.update(c.id, {
      lastVerifiedAt: "2026-09-09T11:00:00.000Z",
      lastVerificationResult: "granted",
      lastVerificationDetail: "200 from n3rgy",
    });
    expect(v.lastVerificationResult).toBe("granted");
  });

  it("throws for unknown ids", async () => {
    await expect(store.update("nope", { status: "active" })).rejects.toBeInstanceOf(ConsentNotFoundError);
  });
});
