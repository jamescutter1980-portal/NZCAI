import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsentError, requireActiveConsent } from "../gate";
import { JsonFileConsentStore } from "../store";

let dir: string;
let store: JsonFileConsentStore;
const at = new Date("2026-09-09T12:00:00Z");
const input = {
  mpxn: "1234567890123",
  utilities: ["electricity" as const],
  occupierName: "A Tenant Ltd",
  method: "n3rgy_consumer_portal" as const,
  grantedOn: "2026-09-01",
  expiresOn: "2027-08-31",
  status: "active" as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-"));
  store = new JsonFileConsentStore(join(dir, "consents.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function expectCode(p: Promise<unknown>, code: ConsentError["code"]) {
  await expect(p).rejects.toBeInstanceOf(ConsentError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("requireActiveConsent", () => {
  it("bypasses in sandbox", async () => {
    expect(await requireActiveConsent(store, "1234567890123", "gas", { sandbox: true })).toEqual({ consentRef: "sandbox" });
  });

  it("refuses when nothing is recorded", async () => {
    await expectCode(requireActiveConsent(store, "1234567890123", "electricity", { at }), "none");
  });

  it("returns the active consent as the reference", async () => {
    const c = await store.create(input);
    const r = await requireActiveConsent(store, "1234567890123", "electricity", { at });
    expect(r.consentRef).toBe(c.id);
    expect(r.consent?.id).toBe(c.id);
  });

  it("refuses pending, expired, withdrawn and wrong utility", async () => {
    const c = await store.create({ ...input, status: "pending" });
    await expectCode(requireActiveConsent(store, "1234567890123", "electricity", { at }), "pending");
    await expectCode(requireActiveConsent(store, "1234567890123", "gas", { at }), "utility");
    await store.update(c.id, { status: "active", expiresOn: "2026-09-01" });
    await expectCode(requireActiveConsent(store, "1234567890123", "electricity", { at }), "expired");
    await store.update(c.id, { status: "withdrawn", expiresOn: "2027-08-31" });
    await expectCode(requireActiveConsent(store, "1234567890123", "electricity", { at }), "withdrawn");
  });

  it("prefers an active record over a withdrawn one for the same MPxN", async () => {
    const old = await store.create(input);
    await store.update(old.id, { status: "withdrawn" });
    const fresh = await store.create({ ...input, grantedOn: "2026-09-05" });
    expect((await requireActiveConsent(store, "1234567890123", "electricity", { at })).consentRef).toBe(fresh.id);
  });
});
