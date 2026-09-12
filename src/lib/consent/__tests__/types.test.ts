import { describe, expect, it } from "vitest";
import { consentCreateSchema, defaultExpiry, effectiveStatus, toView, type ConsentRecord } from "../types";

const base: ConsentRecord = {
  id: "c1",
  mpxn: "1234567890123",
  utilities: ["electricity"],
  occupierName: "A Tenant Ltd",
  method: "n3rgy_consumer_portal",
  grantedOn: "2026-01-01",
  expiresOn: "2026-12-31",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("effectiveStatus", () => {
  it("is active until the end of the expiry day, then expired", () => {
    expect(effectiveStatus(base, new Date("2026-12-31T23:59:00Z"))).toBe("active");
    expect(effectiveStatus(base, new Date("2027-01-01T00:00:00Z"))).toBe("expired");
  });
  it("withdrawn beats everything", () => {
    expect(effectiveStatus({ ...base, status: "withdrawn" }, new Date("2026-06-01"))).toBe("withdrawn");
  });
  it("pending stays pending until expiry", () => {
    expect(effectiveStatus({ ...base, status: "pending" }, new Date("2026-06-01"))).toBe("pending");
    expect(effectiveStatus({ ...base, status: "pending" }, new Date("2027-06-01"))).toBe("expired");
  });
});

describe("toView", () => {
  it("adds days to expiry", () => {
    expect(toView(base, new Date("2026-12-30T12:00:00Z")).daysToExpiry).toBe(2);
  });
});

describe("defaultExpiry", () => {
  it("is twelve months less a day", () => {
    expect(defaultExpiry("2026-03-15")).toBe("2027-03-14");
    expect(defaultExpiry("2026-01-31", 1)).toBe("2026-03-02");
  });
});

describe("consentCreateSchema", () => {
  it("defaults status to pending and validates MPxN", () => {
    const ok = consentCreateSchema.parse({
      mpxn: "1234567890123",
      utilities: ["gas"],
      occupierName: "X",
      method: "letter_of_authority",
      grantedOn: "2026-09-01",
      expiresOn: "2027-08-31",
    });
    expect(ok.status).toBe("pending");
    expect(() => consentCreateSchema.parse({ ...ok, mpxn: "12" })).toThrow();
    expect(() => consentCreateSchema.parse({ ...ok, utilities: [] })).toThrow();
  });
});
