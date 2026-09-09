import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { SqliteConsentStore } from "../sqlite-store";
import { ConsentNotFoundError } from "../store";

const input = {
  mpxn: "1234567890123",
  utilities: ["electricity" as const, "gas" as const],
  occupierName: "A Tenant Ltd",
  occupierEmail: "t@example.com",
  method: "letter_of_authority" as const,
  evidenceRef: "LOA-42",
  grantedOn: "2026-09-01",
  expiresOn: "2027-08-31",
  status: "pending" as const,
};

describe("SqliteConsentStore", () => {
  it("round-trips a record including the utilities array", async () => {
    const store = new SqliteConsentStore(openDatabase(":memory:"));
    const c = await store.create(input, new Date("2026-09-09T10:00:00Z"));
    const got = await store.get(c.id);
    expect(got).toEqual(c);
    expect(got?.utilities).toEqual(["electricity", "gas"]);
    expect(got?.assetRef).toBeUndefined();
    expect(await store.findByMpxn("1234567890123")).toHaveLength(1);
    expect(await store.findByMpxn("0")).toHaveLength(0);
  });

  it("updates, withdraws and reactivates like the JSON store", async () => {
    const store = new SqliteConsentStore(openDatabase(":memory:"));
    const c = await store.create(input);
    const w = await store.update(c.id, { status: "withdrawn", withdrawnReason: "left" }, new Date("2026-10-01T00:00:00Z"));
    expect(w.withdrawnAt).toBe("2026-10-01T00:00:00.000Z");
    expect((await store.get(c.id))?.withdrawnReason).toBe("left");
    const a = await store.update(c.id, { status: "active", lastVerifiedAt: "x", lastVerificationResult: "granted", lastVerificationDetail: "ok" });
    expect(a.withdrawnAt).toBeUndefined();
    expect((await store.get(c.id))?.lastVerificationResult).toBe("granted");
    await expect(store.update("nope", { status: "active" })).rejects.toBeInstanceOf(ConsentNotFoundError);
  });

  it("lists newest first", async () => {
    const store = new SqliteConsentStore(openDatabase(":memory:"));
    await store.create(input, new Date("2026-09-01T00:00:00Z"));
    const b = await store.create({ ...input, mpxn: "999999" }, new Date("2026-09-02T00:00:00Z"));
    expect((await store.list())[0].id).toBe(b.id);
  });
});
