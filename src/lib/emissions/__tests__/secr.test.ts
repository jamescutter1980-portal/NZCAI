import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { buildSecrSummaryExport } from "@/lib/export";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { SiteActivityRepository } from "..";

// Synthetic factor values; only the plumbing is under test.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.200
201,Scope 1,Refrigerant & other,Kyoto protocol - standard,R410A,,,kg,kg CO2e,1000.0
202,Scope 3,Water supply,,,,,cubic metres,kg CO2e,0.100
204,Scope 3,Waste disposal,Commercial and industrial waste,Landfill,,,tonnes,kg CO2e,400.0
205,Scope 3,Waste disposal,Commercial and industrial waste,Closed-loop,,,tonnes,kg CO2e,20.0
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secr-site-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));
const cell = (rows: unknown[][], item: string) => rows.find((r) => String(r[1]) === item);
const base = { periodStart: "2025-04-01", periodEnd: "2025-04-30", basis: "measured" as const, factorYear: 2025 };

describe("SECR summary with refrigerants, water and waste", () => {
  it("lists them as exclusions when nothing is recorded", () => {
    const rows = buildSecrSummaryExport(openDatabase(":memory:"), ctx(), 2025).rows;
    const items = rows.filter((r) => String(r[0]).startsWith("Exclusions")).map((r) => String(r[1]));
    expect(items).toContain("Fugitive emissions (refrigerants)");
    expect(items).toContain("Water");
    expect(items).toContain("Waste");
    expect(items).toContain("Embodied carbon");
    expect(cell(rows, "Scope 1 (fugitive, refrigerants)")?.[2]).toBe(0);
  });

  it("includes refrigerant leakage in Scope 1 and reports waste diversion", () => {
    const db = openDatabase(":memory:");
    const repo = new SiteActivityRepository(db);
    repo.create({ ...base, category: "refrigerant_topup", label: "Chiller", quantity: 3, unit: "kg", refrigerantType: "R410A", factorId: "201" });
    repo.create({ ...base, category: "water_supply", label: "Water", quantity: 1000, unit: "m3", factorId: "202" });
    repo.create({ ...base, category: "waste_landfill", label: "Landfill", quantity: 2, unit: "tonnes", factorId: "204" });
    repo.create({ ...base, category: "waste_recycling", label: "Recycling", quantity: 8, unit: "tonnes", factorId: "205" });

    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(cell(rows, "Scope 1 (fugitive, refrigerants)")?.[2]).toBeCloseTo(3000, 3);
    expect(cell(rows, "Scope 1 total")?.[2]).toBeCloseTo(3000, 3);
    expect(cell(rows, "Scope 3 category 1 purchased goods and services")?.[2]).toBeCloseTo(100, 3);
    expect(cell(rows, "Scope 3 category 5 waste generated in operations")?.[2]).toBeCloseTo(2 * 400 + 8 * 20, 3);
    expect(cell(rows, "Diversion rate")?.[2]).toBeCloseTo(80, 3);
    expect(cell(rows, "Total waste")?.[2]).toBeCloseTo(10, 3);

    const items = rows.filter((r) => String(r[0]).startsWith("Exclusions")).map((r) => String(r[1]));
    expect(items).not.toContain("Fugitive emissions (refrigerants)");
    expect(items).not.toContain("Water");
    expect(items).not.toContain("Waste");
    // Embodied carbon is still out, and the return still says it is not complete.
    expect(items).toContain("Embodied carbon");
    expect(items).toContain("Readiness for disclosure");
  });

  it("blanks Scope 1 rather than reporting it partial when a refrigerant line fails", () => {
    const db = openDatabase(":memory:");
    new SiteActivityRepository(db).create({ ...base, category: "refrigerant_topup", label: "Bad unit", quantity: 3, unit: "litres", refrigerantType: "R410A", factorId: "201" });
    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(cell(rows, "Scope 1 (fugitive, refrigerants)")?.[2]).toBe("");
    expect(cell(rows, "Scope 1 total")?.[2]).toBe("");
  });
});
