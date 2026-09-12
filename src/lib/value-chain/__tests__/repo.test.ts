import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import {
  ActivityLedgerRepository,
  CounterpartyNotFoundError,
  CounterpartyRepository,
  EmissionsReportRepository,
  EngagementRepository,
  activityLedgerImportSpec,
  counterpartyCreateSchema,
  counterpartyImportSpec,
  directionOf,
  emissionsReportCreateSchema,
  engagementActionSchema,
  transition,
} from "..";
import { applyMapping, suggestMapping, previewCsv } from "@/lib/import";

function setup() {
  const db = openDatabase(":memory:");
  return { db, counterparties: new CounterpartyRepository(db), engagements: new EngagementRepository(db), reports: new EmissionsReportRepository(db), ledger: new ActivityLedgerRepository(db) };
}

describe("counterparty schema", () => {
  it("accepts roles and categories as lists or delimited text and defaults the categories from the roles", () => {
    const a = counterpartyCreateSchema.parse({ name: "X", roles: "supplier; logistics", annualValueGbp: "12,000".replace(",", "") });
    expect(a.roles).toEqual(["supplier", "logistics"]);
    expect(a.ghgCategories).toBeUndefined();
    expect(a.ask).toBe("annual_ghg_report");
    const b = counterpartyCreateSchema.parse({ name: "Y", roles: ["tenant"], ghgCategories: "cat 13, 5", country: "gb" });
    expect(b.ghgCategories).toEqual(["13", "5"]);
    expect(b.country).toBe("GB");
    expect(counterpartyCreateSchema.safeParse({ name: "Z", roles: [] }).success).toBe(false);
    expect(counterpartyCreateSchema.safeParse({ name: "Z", roles: ["nobody"] }).success).toBe(false);
  });

  it("derives direction from the role set", () => {
    expect(directionOf(["supplier"])).toBe("upstream");
    expect(directionOf(["tenant", "franchisee"])).toBe("downstream");
    expect(directionOf(["franchisor", "customer"])).toBe("both");
    expect(directionOf([])).toBe("unknown");
  });
});

describe("CounterpartyRepository", () => {
  it("creates with default categories, updates, lists by status and deletes with cascade", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "Bidfood Ltd", roles: ["distributor"], ask: "annual_ghg_report", status: "active" });
    expect(c.ghgCategories).toEqual(["1", "4"]);
    expect(s.counterparties.get(c.id)?.name).toBe("Bidfood Ltd");
    expect(s.counterparties.findByName("bidfood ltd")?.id).toBe(c.id);

    const updated = s.counterparties.update(c.id, { roles: ["waste_contractor"], annualValueGbp: 5 });
    expect(updated.ghgCategories).toEqual(["5"]); // roles changed, categories not stated: they follow
    expect(s.counterparties.update(c.id, { ghgCategories: ["1", "5"] }).ghgCategories).toEqual(["1", "5"]);
    expect(s.counterparties.update(c.id, { status: "inactive" }).status).toBe("inactive");
    expect(s.counterparties.list({ status: "active" })).toHaveLength(0);
    expect(s.counterparties.list()).toHaveLength(1);

    s.engagements.ensure(c.id, 2025, "annual_ghg_report");
    s.reports.create({ counterpartyId: c.id, reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", scope1Tco2e: 1, allocationMethod: "supplier_total", methodology: "ghg_protocol", boundary: "unknown", assurance: "none", basis: "supplier_reported" });
    s.counterparties.delete(c.id);
    expect(s.engagements.listForYear(2025)).toHaveLength(0);
    expect(s.reports.list()).toHaveLength(0);
    expect(() => s.counterparties.delete(c.id)).toThrow(CounterpartyNotFoundError);
  });

  it("upserts a batch by name, all or nothing", () => {
    const s = setup();
    s.counterparties.create({ name: "A Ltd", roles: ["supplier"], annualValueGbp: 1, ask: "annual_ghg_report", status: "active" });
    const r = s.counterparties.upsertBatch([
      { name: "a ltd", roles: ["supplier"], annualValueGbp: 2, ask: "annual_ghg_report", status: "active" },
      { name: "B Ltd", roles: ["customer"], ask: "either", status: "active" },
    ]);
    expect(r.created.map((c) => c.name)).toEqual(["B Ltd"]);
    expect(r.updated.map((c) => [c.name, c.annualValueGbp])).toEqual([["A Ltd", 2]]);
    expect(s.counterparties.list()).toHaveLength(2);
  });
});

describe("EngagementRepository", () => {
  it("ensures one engagement per counterparty and year and writes an event per transition", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "C", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    const e = s.engagements.ensure(c.id, 2025, "annual_ghg_report");
    expect(s.engagements.ensure(c.id, 2025, "activity_ledger").id).toBe(e.id);
    expect(e.state).toBe("identified");

    const input = engagementActionSchema.parse({ reportingYear: "2025", action: "request_sent", on: "2026-01-10", dueOn: "2026-03-31", channel: "email", detail: "Sent to A Patel" });
    const { engagement, event } = s.engagements.applyTransition(e, transition(e, input, "2026-01-10"), { action: input.action, at: input.on!, channel: input.channel, detail: input.detail });
    expect(engagement).toMatchObject({ state: "contacted", dueOn: "2026-03-31", lastContactOn: "2026-01-10" });
    expect(event).toMatchObject({ fromState: "identified", toState: "contacted", channel: "email" });
    expect(s.engagements.find(c.id, 2025)?.state).toBe("contacted");
    expect(s.engagements.events(e.id)).toHaveLength(1);
    expect(s.engagements.listForCounterparty(c.id)).toHaveLength(1);
  });

  it("requires a reason for a decline", () => {
    expect(engagementActionSchema.safeParse({ reportingYear: 2025, action: "declined" }).success).toBe(false);
    expect(engagementActionSchema.safeParse({ reportingYear: 2025, action: "declined", declineReason: "no_capability" }).success).toBe(true);
  });
});

describe("emissions report schema", () => {
  const base = { counterpartyId: "c", reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31" };
  it("requires a figure, and the fields each allocation method needs", () => {
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "supplier_total" }).success).toBe(false);
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "supplier_total", scope1Tco2e: "12.5" }).success).toBe(true);
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "spend_share", scope1Tco2e: 1 }).success).toBe(false);
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "spend_share", scope1Tco2e: 1, supplierRevenueGbp: 1000 }).success).toBe(true);
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "supplier_allocated", scope1Tco2e: 1 }).success).toBe(false);
    expect(emissionsReportCreateSchema.safeParse({ ...base, allocationMethod: "product_specific", allocatedTco2e: 0.4 }).success).toBe(true);
  });

  it("updates and deletes", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "C", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    const r = s.reports.create({ ...base, counterpartyId: c.id, scope1Tco2e: 1, allocationMethod: "supplier_total", methodology: "ghg_protocol", boundary: "unknown", assurance: "none", basis: "supplier_reported" });
    expect(s.reports.update(r.id, { assurance: "limited", assuranceProvider: "Auditor LLP" })).toMatchObject({ assurance: "limited", assuranceProvider: "Auditor LLP", scope1Tco2e: 1 });
    expect(s.reports.list({ counterpartyId: c.id, reportingYear: 2025 })).toHaveLength(1);
    s.reports.delete(r.id);
    expect(s.reports.list()).toHaveLength(0);
  });
});

describe("import specs", () => {
  it("reads a counterparty register with delimited roles and categories", () => {
    const csv = `Supplier,Relationship,Category,Annual spend,Contact,Email\nBidfood Ltd,vendor; haulier,"1, 4","£1,250,000",A Patel,a@example.com\nGRIDSERVE,concession,,,,\n`;
    const preview = previewCsv(csv);
    const mapping = suggestMapping(counterpartyImportSpec, preview.headers);
    const result = applyMapping(counterpartyImportSpec, preview.headers, preview.rows, mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.data)).toEqual([
      { name: "Bidfood Ltd", roles: ["supplier", "logistics"], ghgCategories: ["1", "4"], annualValueGbp: 1_250_000, contactName: "A Patel", contactEmail: "a@example.com" },
      { name: "GRIDSERVE", roles: ["tenant"] },
    ]);
    const parsed = counterpartyCreateSchema.parse(result.rows[1].data);
    const s = setup();
    expect(s.counterparties.create(parsed).ghgCategories).toEqual(["13"]);
  });

  it("rejects an unknown role rather than guessing", () => {
    const csv = `Name,Roles\nX,partner\n`;
    const preview = previewCsv(csv);
    const result = applyMapping(counterpartyImportSpec, preview.headers, preview.rows, suggestMapping(counterpartyImportSpec, preview.headers));
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toMatch(/role "partner" is not one of/);
  });

  it("reads a counterparty ledger with a share and a declared figure", () => {
    const csv = `Description,Activity,From,To,Quantity,Unit,Our share,kgCO2e\nDepot electricity,Electricity,01/01/2025,31/03/2025,"48,200",kWh,25,9980\nDeliveries,HGV tonne-km,01/01/2025,31/12/2025,50000,tonne.km,,\n`;
    const preview = previewCsv(csv);
    const result = applyMapping(activityLedgerImportSpec, preview.headers, preview.rows, suggestMapping(activityLedgerImportSpec, preview.headers));
    expect(result.errors).toEqual([]);
    expect(result.rows[0].data).toEqual({ label: "Depot electricity", activityType: "Electricity", periodStart: "2025-01-01", periodEnd: "2025-03-31", quantity: 48_200, unit: "kWh", sharePct: 25, declaredKgCo2e: 9980 });
    expect(result.rows[1].data).toMatchObject({ label: "Deliveries", quantity: 50_000, unit: "tonne.km" });
    expect(result.rows[1].data.sharePct).toBeUndefined(); // blank is not zero; the schema defaults it to 100
  });
});
