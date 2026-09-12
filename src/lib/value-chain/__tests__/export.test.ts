import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { VALUE_CHAIN_COLUMNS, buildValueChainExport, isExportKind, toCsv } from "@/lib/export";
import { CounterpartyRepository, EmissionsReportRepository } from "..";

const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.200
`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "value-chain-export-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));

describe("buildValueChainExport", () => {
  it("writes one row per counterparty with a blank figure, never zero, where nothing was returned", () => {
    const db = openDatabase(":memory:");
    const cps = new CounterpartyRepository(db);
    const a = cps.create({ name: "Answered Ltd", roles: ["supplier"], annualValueGbp: 100, ask: "annual_ghg_report", status: "active" });
    cps.create({ name: "Silent Ltd", roles: ["tenant"], ask: "annual_ghg_report", status: "active" });
    new EmissionsReportRepository(db).create({ counterpartyId: a.id, reportingYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", scope1Tco2e: 3, scope2LocationTco2e: 1, allocationMethod: "supplier_allocated", allocatedTco2e: 1.5, methodology: "ghg_protocol", boundary: "operational_control", assurance: "limited", assuranceProvider: "X LLP", basis: "supplier_reported", evidence: "report p.3" });

    expect(isExportKind("value-chain")).toBe(true);
    const t = buildValueChainExport(db, ctx(), 2025);
    expect(t.filename).toBe("value-chain-2025.csv");
    expect(t.columns).toEqual(VALUE_CHAIN_COLUMNS);
    expect(t.rows).toHaveLength(2);
    const row = (name: string) => Object.fromEntries(t.columns.map((c, i) => [c, t.rows.find((r) => r[0] === name)![i]]));
    expect(row("Answered Ltd")).toMatchObject({ direction: "upstream", data_source: "report", reported_total_tco2e: 4, attributable_tco2e: 1.5, tier: "A", primary_data: "yes", assurance: "limited", evidence: "report p.3", engagement_state: "Identified, not yet asked" });
    expect(row("Silent Ltd")).toMatchObject({ direction: "downstream", data_source: "none", attributable_tco2e: "", tier: "", primary_data: "no", next_action: "Send the data request", annual_value_gbp: "" });
    expect(toCsv(t.columns, t.rows)).toMatch(/^counterparty,roles,direction/);
  });
});
