import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { buildSecrSummaryExport } from "@/lib/export";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { TransportRepository } from "..";

// Synthetic factor values; only the plumbing is under test.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.100
3,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.010
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.200
101,Scope 1,Passenger vehicles,Cars (by size),Medium car,Diesel,,km,kg CO2e,0.500
103,Scope 3,Business travel- air,"International, to/from UK",Economy class,With RF,,passenger.km,kg CO2e,0.300
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secr-transport-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));
const cell = (rows: unknown[][], item: string) => rows.find((r) => String(r[1]) === item);
const note = (rows: unknown[][], item: string) => String(cell(rows, item)?.[7] ?? "");

describe("SECR summary with transport", () => {
  it("says transport is not captured when nothing is recorded", () => {
    const db = openDatabase(":memory:");
    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(note(rows, "Transport fuel")).toMatch(/NOT CAPTURED/);
    expect(cell(rows, "Scope 1 (mobile combustion, own and leased vehicles)")?.[2]).toBe(0);
    expect(rows.some((r) => String(r[1]).startsWith("Transport energy"))).toBe(true);
    expect(note(rows, "Readiness for disclosure")).toMatch(/Transport energy, business travel/);
  });

  it("includes fleet in Scope 1, lists travel by GHG category and drops the transport exclusions", () => {
    const db = openDatabase(":memory:");
    const repo = new TransportRepository(db);
    const base = { periodStart: "2025-05-01", periodEnd: "2025-05-31", basis: "measured" as const, factorYear: 2025 };
    repo.createActivity({ ...base, category: "fleet_owned", label: "Fleet", quantity: 1000, unit: "km", factorId: "101" });
    repo.createActivity({ ...base, category: "business_travel_air", label: "Flights", quantity: 2000, unit: "passenger.km", factorId: "103" });

    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(cell(rows, "Scope 1 (mobile combustion, own and leased vehicles)")?.[2]).toBeCloseTo(500, 3);
    expect(cell(rows, "Scope 1 total")?.[2]).toBeCloseTo(500, 3);
    expect(cell(rows, "Scope 3 category 6 business travel")?.[2]).toBeCloseTo(600, 3);
    // The two transport exclusions are gone; the rest remain.
    expect(rows.some((r) => String(r[1]).startsWith("Transport energy"))).toBe(false);
    expect(rows.some((r) => String(r[1]).startsWith("Business travel"))).toBe(false);
    expect(rows.some((r) => String(r[1]).startsWith("Fugitive emissions"))).toBe(true);
    // Distance-based lines give emissions but not kWh, and the export says exactly that.
    expect(cell(rows, "Transport fuel")?.[2]).toBe("");
    expect(note(rows, "Transport fuel")).toMatch(/give emissions and not energy/);
    expect(note(rows, "Readiness for disclosure")).toMatch(/Transport is included/);
  });

  it("leaves Scope 1 blank rather than partial when a fleet line cannot be calculated", () => {
    const db = openDatabase(":memory:");
    const repo = new TransportRepository(db);
    const base = { periodStart: "2025-05-01", periodEnd: "2025-05-31", basis: "measured" as const, factorYear: 2025 };
    repo.createActivity({ ...base, category: "fleet_owned", label: "Fleet", quantity: 1000, unit: "km", factorId: "101" });
    repo.createActivity({ ...base, category: "fleet_owned", label: "Diesel litres", quantity: 500, unit: "litres", factorId: "101" });
    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(cell(rows, "Scope 1 (mobile combustion, own and leased vehicles)")?.[2]).toBe("");
    expect(cell(rows, "Scope 1 total")?.[2]).toBe("");
    expect(note(rows, "Scope 1 (mobile combustion, own and leased vehicles)")).toMatch(/could not be calculated/);
  });

  it("reports transport energy in kWh when fuel is recorded that way", () => {
    const db = openDatabase(":memory:");
    const repo = new TransportRepository(db);
    repo.createActivity({ periodStart: "2025-05-01", periodEnd: "2025-05-31", basis: "measured", factorYear: 2025, category: "fleet_owned", label: "Fuel card kWh", quantity: 12_000, unit: "kWh", factorId: "101" });
    const rows = buildSecrSummaryExport(db, ctx(), 2025).rows;
    expect(cell(rows, "Transport fuel")?.[2]).toBeCloseTo(12_000, 0);
    expect(note(rows, "Transport fuel")).toMatch(/recorded in kWh/);
  });
});
