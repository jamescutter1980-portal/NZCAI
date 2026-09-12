import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { calendarYear, fiscalYear } from "@/lib/carbon/period";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { ActivityLedgerRepository, CounterpartyRepository, EmissionsReportRepository, EngagementRepository, reportTier, reportingYearOf, transition, valueChainReport } from "..";

// Synthetic factor values; only the plumbing is under test.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.200
7,Scope 3,Freighting goods,HGV (all diesel),All HGVs,,,tonne.km,kg CO2e,0.100
9,Scope 3,Waste disposal,Commercial and industrial waste,Landfill,,,tonnes,kg CO2e,
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "value-chain-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-06-01T00:00:00Z");
const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, NOW);
const period = () => calendarYear(2025);

function setup() {
  const db = openDatabase(":memory:");
  return { db, counterparties: new CounterpartyRepository(db), engagements: new EngagementRepository(db), reports: new EmissionsReportRepository(db), ledger: new ActivityLedgerRepository(db) };
}
const reportBase = { reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", methodology: "ghg_protocol" as const, boundary: "operational_control" as const, assurance: "none" as const, basis: "supplier_reported" as const, evidence: "2025 sustainability report p.14" };

describe("valueChainReport", () => {
  it("allocates a spend share of a reported footprint and tiers it as hybrid", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "Bidfood Ltd", roles: ["distributor"], annualValueGbp: 2_000_000, ask: "annual_ghg_report", status: "active" });
    s.reports.create({ ...reportBase, counterpartyId: c.id, scope1Tco2e: 10_000, scope2LocationTco2e: 5_000, scope2MarketTco2e: 4_000, scope3Tco2e: 86_000, allocationMethod: "spend_share", supplierRevenueGbp: 1_000_000_000 });

    const r = valueChainReport(s.db, ctx(), period());
    const v = r.counterparties[0];
    expect(v.report?.reportedTotalTco2e).toBe(100_000); // market-based Scope 2 preferred
    expect(v.attributableTco2e).toBeCloseTo(200, 3); // 100,000 × 2m ÷ 1bn
    expect(v.tier).toBe("B");
    expect(v.primary).toBe(true);
    expect(v.dataSource).toBe("report");
    expect(v.report?.allocationDetail).toMatch(/0\.2% of their revenue/);
    expect(r.totals.attributableTco2e).toBeCloseTo(200, 3);
    expect(r.totals.primarySharePct).toBe(100);
    expect(r.totals.byDirection).toEqual({ upstream: 200, downstream: 0 });
    expect(r.coverage).toMatchObject({ active: 1, upstream: 1, withData: 1, valueCoveredPct: 100 });
  });

  it("refuses a spend share when our value exceeds their revenue, and when the value is missing", () => {
    const s = setup();
    const a = s.counterparties.create({ name: "Small Co", roles: ["supplier"], annualValueGbp: 500_000, ask: "annual_ghg_report", status: "active" });
    const b = s.counterparties.create({ name: "No Value Co", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    s.reports.create({ ...reportBase, counterpartyId: a.id, scope1Tco2e: 100, allocationMethod: "spend_share", supplierRevenueGbp: 100_000 });
    s.reports.create({ ...reportBase, counterpartyId: b.id, scope1Tco2e: 100, allocationMethod: "spend_share", supplierRevenueGbp: 100_000 });

    const r = valueChainReport(s.db, ctx(), period());
    const [noValue, small] = r.counterparties; // ordered by name
    expect(small.attributableTco2e).toBeNull();
    expect(small.warnings.join(" ")).toMatch(/exceeds their reported revenue/);
    expect(noValue.attributableTco2e).toBeNull();
    expect(noValue.warnings.join(" ")).toMatch(/Record the annual spend/);
    expect(r.totals.attributableTco2e).toBeNull();
    expect(r.totals.unresolved).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/cannot be turned into a figure yet/);
  });

  it("tiers product-specific and assured allocations as supplier-specific, and estimates as E", () => {
    expect(reportTier({ allocationMethod: "product_specific", assurance: "none", basis: "supplier_reported" })).toBe("A");
    expect(reportTier({ allocationMethod: "supplier_allocated", assurance: "limited", basis: "supplier_reported" })).toBe("A");
    expect(reportTier({ allocationMethod: "supplier_allocated", assurance: "none", basis: "supplier_reported" })).toBe("B");
    expect(reportTier({ allocationMethod: "supplier_total", assurance: "reasonable", basis: "supplier_reported" })).toBe("B");
    expect(reportTier({ allocationMethod: "product_specific", assurance: "none", basis: "estimated" })).toBe("E");
  });

  it("converts a ledger with the published factors, applies the share, and blanks the total when a line cannot resolve", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "Haulier Ltd", roles: ["logistics"], annualValueGbp: 300_000, ask: "activity_ledger", status: "active" });
    const line = { counterpartyId: c.id, reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", basis: "measured" as const, sharePct: 100 };
    s.ledger.create({ ...line, label: "Depot electricity", activityType: "Electricity", quantity: 10_000, unit: "kWh", factorId: "1", factorYear: 2025, sharePct: 25 });
    s.ledger.create({ ...line, label: "Deliveries", activityType: "HGV tonne-km", quantity: 50_000, unit: "tonne.km", factorId: "7", factorYear: 2025 });
    s.ledger.create({ ...line, label: "Own calc", activityType: "Vans", quantity: 1, unit: "trip", declaredKgCo2e: 500 });

    const r1 = valueChainReport(s.db, ctx(), period());
    const v1 = r1.counterparties[0];
    expect(v1.dataSource).toBe("ledger");
    // Lines sort by period then label: Deliveries (50,000 × 0.1), Depot electricity (25% of 2,000), Own calc (declared).
    expect(v1.ledger.lines.map((l) => l.kgCo2e)).toEqual([5000, 500, 500]);
    expect(v1.ledger.lines.map((l) => l.tier)).toEqual(["C", "C", "B"]);
    expect(v1.attributableTco2e).toBeCloseTo(6, 3);
    expect(v1.tier).toBe("C");
    expect(v1.primary).toBe(false);
    expect(r1.totals.primarySharePct).toBe(0);
    expect(r1.factorReferences.length).toBeGreaterThan(0);

    s.ledger.create({ ...line, label: "Landfill", activityType: "Waste", quantity: 3, unit: "tonnes", factorId: "9", factorYear: 2025 });
    const v2 = valueChainReport(s.db, ctx(), period()).counterparties[0];
    expect(v2.attributableTco2e).toBeNull();
    expect(v2.ledger.counts).toEqual({ lines: 4, resolved: 3, unresolved: 1 });
    expect(v2.warnings.join(" ")).toMatch(/blank rather than understated/);
  });

  it("uses the report when both a report and a ledger exist and reports the variance", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "Both Ltd", roles: ["supplier"], annualValueGbp: 100, ask: "either", status: "active" });
    s.reports.create({ ...reportBase, counterpartyId: c.id, scope1Tco2e: 10, allocationMethod: "supplier_allocated", allocatedTco2e: 8 });
    s.ledger.create({ counterpartyId: c.id, reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", basis: "measured", sharePct: 100, label: "Elec", activityType: "Electricity", quantity: 60_000, unit: "kWh", factorId: "1", factorYear: 2025 });
    const v = valueChainReport(s.db, ctx(), period()).counterparties[0];
    expect(v.dataSource).toBe("report");
    expect(v.attributableTco2e).toBe(8);
    expect(v.reconciliation).toMatchObject({ reportTco2e: 8, ledgerTco2e: 12, variancePct: 50 });
    expect(v.warnings.join(" ")).toMatch(/\+50% variance/);
  });

  it("ranks the plan by what is overdue and then by value, and counts coverage", () => {
    const s = setup();
    s.counterparties.create({ name: "Big Spend", roles: ["supplier"], annualValueGbp: 5_000_000, ask: "annual_ghg_report", status: "active" });
    const late = s.counterparties.create({ name: "Late Co", roles: ["supplier"], annualValueGbp: 50_000, ask: "annual_ghg_report", status: "active" });
    const done = s.counterparties.create({ name: "Done Co", roles: ["tenant"], annualValueGbp: 1_000_000, ask: "annual_ghg_report", status: "active" });
    s.counterparties.create({ name: "Old Co", roles: ["supplier"], annualValueGbp: 9_000_000, ask: "annual_ghg_report", status: "inactive" });

    const lateEng = s.engagements.ensure(late.id, 2025, "annual_ghg_report");
    s.engagements.applyTransition(lateEng, transition(lateEng, { reportingYear: 2025, action: "request_sent", on: "2026-01-05", dueOn: "2026-03-31" }, "2026-01-05"), { action: "request_sent", at: "2026-01-05" });
    const doneEng = s.engagements.ensure(done.id, 2025, "annual_ghg_report");
    const sent = s.engagements.applyTransition(doneEng, transition(doneEng, { reportingYear: 2025, action: "request_sent", on: "2026-01-05" }, "2026-01-05"), { action: "request_sent", at: "2026-01-05" }).engagement;
    const complete = s.engagements.applyTransition(sent, transition(sent, { reportingYear: 2025, action: "data_received", complete: true }, "2026-02-01"), { action: "data_received", at: "2026-02-01" }).engagement;
    s.engagements.applyTransition(complete, transition(complete, { reportingYear: 2025, action: "verified" }, "2026-02-02"), { action: "verified", at: "2026-02-02" });
    s.reports.create({ ...reportBase, counterpartyId: done.id, scope1Tco2e: 40, scope2LocationTco2e: 10, allocationMethod: "supplier_total" });

    const r = valueChainReport(s.db, ctx(), period());
    expect(r.plan.map((p) => p.name)).toEqual(["Late Co", "Big Spend"]);
    expect(r.plan[0]).toMatchObject({ overdue: true, action: "Fall back to a secondary estimate and disclose it" });
    expect(r.plan[1]).toMatchObject({ overdue: false, action: "Send the data request", state: "identified" });
    expect(r.coverage).toMatchObject({ total: 4, active: 3, upstream: 2, downstream: 1, asked: 2, withData: 1, verified: 1, dueNow: 2, overdue: 1, valueTotalGbp: 6_050_000, valueWithDataGbp: 1_000_000 });
    expect(r.coverage.valueCoveredPct).toBeCloseTo(16.529, 3);
    expect(r.totals.byDirection).toEqual({ upstream: 0, downstream: 50 });
    expect(r.totals.byCategory.map((c) => [c.category, c.tco2e])).toEqual([["1", 0], ["13", 50]]);
    expect(r.totals.byTier).toEqual({ A: 0, B: 1, C: 0, D: 0, E: 0 });
    expect(r.counterparties.find((v) => v.counterparty.name === "Old Co")?.next.due).toBe(true); // still listed, just not planned
  });

  it("keys engagements on the year the period starts in, and flags a report that does not overlap it", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "FY Co", roles: ["supplier"], annualValueGbp: 1, ask: "annual_ghg_report", status: "active" });
    s.reports.create({ ...reportBase, counterpartyId: c.id, reportingYear: 2025, periodStart: "2024-01-01", periodEnd: "2024-12-31", scope1Tco2e: 1, allocationMethod: "supplier_total" });
    const fy = fiscalYear(2025, 4);
    expect(reportingYearOf(fy)).toBe(2025);
    const v = valueChainReport(s.db, ctx(), fy).counterparties[0];
    expect(v.warnings.join(" ")).toMatch(/does not overlap the reporting period FY 2025\/26/);
  });

  it("puts a counterparty serving several categories under 'multiple' rather than splitting it", () => {
    const s = setup();
    const c = s.counterparties.create({ name: "Multi", roles: ["distributor"], ask: "annual_ghg_report", status: "active" });
    expect(c.ghgCategories).toEqual(["1", "4"]);
    s.reports.create({ ...reportBase, counterpartyId: c.id, scope1Tco2e: 3, allocationMethod: "supplier_total" });
    const r = valueChainReport(s.db, ctx(), period());
    expect(r.totals.byCategory).toEqual([{ category: "multiple", label: "Several categories (not split)", counterparties: 1, withData: 1, tco2e: 3 }]);
  });

  it("returns zeros, not nulls, when nothing is recorded", () => {
    const s = setup();
    const r = valueChainReport(s.db, ctx(), period());
    expect(r.totals.attributableTco2e).toBe(0);
    expect(r.coverage.valueCoveredPct).toBeNull();
    expect(r.plan).toEqual([]);
  });
});
