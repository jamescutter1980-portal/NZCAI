import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { SiteActivityRepository } from "@/lib/emissions";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { TransportRepository } from "@/lib/transport/repo";
import {
  CounterpartyRepository,
  EmissionsReportRepository,
  InboundRequestRepository,
  METRICS,
  SubmissionBlockedError,
  draftResponse,
  inboundRequestCreateSchema,
  inboxSummary,
  resolveMetrics,
  rollForward,
  submitResponse,
} from "..";
import { calendarYear } from "@/lib/carbon/period";

const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.200
3,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.010
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.200
5,Scope 1,Refrigerant & other,Kyoto protocol - standard,R410A,,,kg,kg CO2e,1000.0
6,Scope 3,Waste disposal,Commercial and industrial waste,Landfill,,,tonnes,kg CO2e,400.0
7,Scope 3,Water supply,,,,,cubic metres,kg CO2e,0.100
8,Scope 3,Business travel- air,Short-haul,,,,passenger.km,kg CO2e,0.150
`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inbox-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date("2026-03-01T00:00:00Z");
const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, NOW);

function seed() {
  const db = openDatabase(":memory:");
  const cps = new CounterpartyRepository(db);
  const yum = cps.create({ name: "Yum! Brands", roles: ["franchisor"], ask: "annual_ghg_report", status: "active" });
  const parent = cps.create({ name: "Applegreen plc", roles: ["customer"], ask: "annual_ghg_report", status: "active" });
  const supplier = cps.create({ name: "Bidfood", roles: ["supplier"], annualValueGbp: 100, ask: "annual_ghg_report", status: "active" });
  new EmissionsReportRepository(db).create({ counterpartyId: supplier.id, reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", scope1Tco2e: 10, allocationMethod: "supplier_allocated", allocatedTco2e: 2.5, methodology: "ghg_protocol", boundary: "unknown", assurance: "limited", basis: "supplier_reported", evidence: "x" });
  const site = new SiteActivityRepository(db);
  site.create({ category: "refrigerant_topup", label: "Chiller", periodStart: "2025-02-01", periodEnd: "2025-02-01", quantity: 2, unit: "kg", refrigerantType: "R410A", factorId: "5", factorYear: 2025, basis: "measured" });
  site.create({ category: "waste_landfill", label: "General", periodStart: "2025-03-01", periodEnd: "2025-03-31", quantity: 3, unit: "tonnes", factorId: "6", factorYear: 2025, basis: "measured" });
  site.create({ category: "water_supply", label: "Mains", periodStart: "2025-03-01", periodEnd: "2025-03-31", quantity: 1500, unit: "litres", factorId: "7", factorYear: 2025, basis: "measured" });
  new TransportRepository(db).createActivity({ category: "business_travel_air", label: "Flights", periodStart: "2025-05-01", periodEnd: "2025-05-31", quantity: 1000, unit: "passenger.km", factorId: "8", factorYear: 2025, basis: "measured" });
  return { db, yum, parent, supplier, inbox: new InboundRequestRepository(db) };
}
const fields = [
  { key: "s1", label: "Scope 1 emissions", metric: "scope1_kgco2e" },
  { key: "waste", label: "Waste tonnage", metric: "waste_tonnes" },
  { key: "water", label: "Water use", metric: "water_m3" },
  { key: "travel", label: "Business travel", metric: "business_travel_kgco2e", unit: "tCO2e" },
  { key: "vc", label: "Supplier Scope 3", metric: "value_chain_tco2e" },
  { key: "outlets", label: "Number of restaurants", metric: "manual" },
];

describe("resolveMetrics", () => {
  it("answers from the portal's own modules and blanks what it cannot compute", () => {
    const { db } = seed();
    const m = resolveMetrics(db, ctx(), calendarYear(2025));
    expect(Object.keys(m).sort()).toEqual(Object.keys(METRICS).sort()); // every catalogue entry resolves, and nothing internal leaks
    expect(m.scope1_kgco2e.value).toBe(2000); // no gas, no fleet, 2 kg × 1000
    expect(m.scope1_kgco2e.detail).toMatch(/gas combustion 0 \+ own and leased vehicles 0 \+ refrigerant losses 2000/);
    expect(m.waste_tonnes.value).toBe(3);
    expect(m.water_m3.value).toBe(1.5);
    expect(m.business_travel_kgco2e.value).toBe(150);
    expect(m.value_chain_tco2e.value).toBe(2.5);
    expect(m.value_chain_primary_share_pct.value).toBe(100);
    expect(m.electricity_kwh.value).toBe(0);
    expect(m.energy_intensity_kwh_m2).toMatchObject({ value: null });
    expect(m.manual.value).toBeNull();
  });
});

describe("inbound requests", () => {
  it("validates a request and drafts a response with sources, overrides and unit warnings", () => {
    const { db, yum, inbox } = seed();
    expect(inboundRequestCreateSchema.safeParse({ counterpartyId: yum.id, title: "x", reportingYear: 2025, fields: [] }).success).toBe(false);
    expect(inboundRequestCreateSchema.safeParse({ counterpartyId: yum.id, title: "x", reportingYear: 2025, fields: [{ key: "bad key", label: "l", metric: "waste_tonnes" }] }).success).toBe(false);
    const input = inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Yum! outlet return 2025", reportingYear: "2025", periodStartMonth: "", dueOn: "2026-03-31", cadence: "annual", fields: [...fields.slice(0, 5), { ...fields[5], override: "42" }] });
    const r = inbox.create(input, NOW);
    expect(r).toMatchObject({ state: "open", periodStartMonth: 1, fields: expect.arrayContaining([expect.objectContaining({ key: "outlets", override: 42 })]) });

    const d = draftResponse(db, ctx(), r);
    expect(d.requesterName).toBe("Yum! Brands");
    expect(d.period.label).toBe("2025");
    expect(d.fields.map((f) => [f.key, f.value])).toEqual([["s1", 2000], ["waste", 3], ["water", 1.5], ["travel", 150], ["vc", 2.5], ["outlets", 42]]);
    expect(d.fields[3].warnings.join(" ")).toMatch(/Requested in tCO2e; the portal gives kgCO2e/);
    expect(d.fields[5]).toMatchObject({ overridden: true, source: "Entered by hand" });
    expect(d.counts).toEqual({ fields: 6, answered: 6, blank: 0, conflicts: 0 });
    expect(d.warnings).toEqual([]);

    const r2 = inbox.update(r.id, { fields: [{ key: "s1", label: "Scope 1", metric: "scope1_kgco2e", override: 1900, note: "Excludes the closed site" }, { key: "n", label: "Headcount", metric: "manual" }] }, NOW);
    const d2 = draftResponse(db, ctx(), r2);
    expect(d2.fields[0]).toMatchObject({ value: 1900, overridden: true });
    expect(d2.fields[0].warnings.join(" ")).toMatch(/Overrides the portal's 2000 kgCO2e/);
    expect(d2.fields[1].warnings.join(" ")).toMatch(/hand-entered field with no value/);
    expect(d2.warnings.join(" ")).toMatch(/1 of 2 fields are blank.*do not send a zero/);
  });

  it("uses the financial year when the request says so", () => {
    const { db, yum, inbox } = seed();
    const r = inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "FY", reportingYear: 2025, periodStartMonth: 4, fields: [fields[1]] }), NOW);
    const d = draftResponse(db, ctx(), r);
    expect(d.period.label).toBe("FY 2025/26 (Apr-Mar)");
    expect(d.fields[0].value).toBeNull(); // the March 2025 waste falls before April; nothing recorded is blank, never zero
    expect(d.fields[0].source).toMatch(/No waste recorded/);
  });

  it("snapshots the figures on submission, then blocks a divergent return to another requester until a note explains it", () => {
    const { db, yum, parent, inbox } = seed();
    const a = inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Yum! return", reportingYear: 2025, dueOn: "2026-03-31", fields: fields.slice(0, 2) }), NOW);
    const sent = submitResponse(db, ctx(), a.id, { on: "2026-02-10" });
    expect(sent.request).toMatchObject({ state: "submitted", submittedOn: "2026-02-10" });
    expect(sent.request.submittedFigures).toEqual([
      expect.objectContaining({ key: "s1", metric: "scope1_kgco2e", value: 2000, unit: "kgCO2e" }),
      expect.objectContaining({ key: "waste", metric: "waste_tonnes", value: 3, unit: "tonnes" }),
    ]);

    // The parent asks for the same Scope 1 figure, but a hand override makes it differ.
    const b = inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: parent.id, title: "CSRD consolidation", reportingYear: 2025, fields: [{ key: "s1", label: "Scope 1", metric: "scope1_kgco2e", override: 2100 }, fields[1]] }), NOW);
    const d = draftResponse(db, ctx(), b);
    expect(d.fields[0].conflicts).toHaveLength(1);
    expect(d.fields[0].conflicts[0]).toMatchObject({ requesterName: "Yum! Brands", submittedOn: "2026-02-10", value: 2000, variancePct: 5 });
    expect(d.fields[0].conflicts[0].detail).toMatch(/2000 kgCO2e was sent to Yum! Brands on 2026-02-10 for "Yum! return"; this draft says 2100 kgCO2e \(\+5%\)/);
    expect(d.fields[1].conflicts).toHaveLength(0); // same waste figure, no conflict
    expect(d.counts.conflicts).toBe(1);
    expect(() => submitResponse(db, ctx(), b.id)).toThrow(SubmissionBlockedError);
    expect(inbox.get(b.id)?.state).toBe("open");
    const forced = submitResponse(db, ctx(), b.id, { note: "Parent boundary includes the closed depot" });
    expect(forced.request).toMatchObject({ state: "submitted", submissionNote: "Parent boundary includes the closed depot" });
  });

  it("rolls an annual request forward with its template and without last year's overrides", () => {
    const { db, yum, inbox } = seed();
    const a = inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Yum! return 2025", reportingYear: 2025, dueOn: "2026-03-31", owner: "JC", template: "Yum March template", cadence: "annual", fields: [{ ...fields[5], override: 42, note: "as at Dec" }, fields[1]] }), NOW);
    submitResponse(db, ctx(), a.id, { on: "2026-02-10" });
    let s = inboxSummary(db, "2026-03-01");
    expect(s.counts).toMatchObject({ open: 0, submitted: 1, needsRollForward: 1 });

    const next = rollForward(db, a.id, NOW);
    expect(next).toMatchObject({ title: "Yum! return 2026", reportingYear: 2026, dueOn: "2027-03-31", owner: "JC", template: "Yum March template", state: "open" });
    expect(next.fields[0]).toEqual({ key: "outlets", label: "Number of restaurants", metric: "manual" });
    s = inboxSummary(db, "2026-03-01");
    expect(s.counts).toMatchObject({ open: 1, submitted: 1, needsRollForward: 0 });
    expect(s.items[0].request.id).toBe(next.id); // open first
  });

  it("flags overdue and due-soon requests in the summary", () => {
    const { db, yum, inbox } = seed();
    inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Late", reportingYear: 2025, dueOn: "2026-02-01", cadence: "once", fields: [fields[1]] }), NOW);
    inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Soon", reportingYear: 2025, dueOn: "2026-03-20", cadence: "once", fields: [fields[1]] }), NOW);
    inbox.create(inboundRequestCreateSchema.parse({ counterpartyId: yum.id, title: "Later", reportingYear: 2025, dueOn: "2026-09-01", cadence: "once", fields: [fields[1]] }), NOW);
    const s = inboxSummary(db, "2026-03-01");
    expect(s.counts).toMatchObject({ open: 3, overdue: 1, dueSoon: 1, needsRollForward: 0 });
    expect(s.items.map((i) => [i.request.title, i.overdue, i.daysToDue])).toEqual([["Late", true, -28], ["Soon", false, 19], ["Later", false, 184]]);
    const late = s.items[0].request;
    expect(draftResponse(db, ctx(), late).warnings.join(" ")).toMatch(/2026-02-01 deadline has passed/);
  });
});
