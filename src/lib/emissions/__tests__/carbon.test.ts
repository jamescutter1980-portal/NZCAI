import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { calendarYear } from "@/lib/carbon/period";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { SiteActivityRepository, emissionsCarbon } from "..";

// Synthetic factor values; only the plumbing is under test. Row ids, level names
// and units follow the published DESNZ flat-file layout.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
201,Scope 1,Refrigerant & other,Kyoto protocol - standard,R410A,,,kg,kg CO2e,1000.0
202,Scope 3,Water supply,,,,,cubic metres,kg CO2e,0.100
203,Scope 3,Water treatment,,,,,cubic metres,kg CO2e,0.200
204,Scope 3,Waste disposal,Commercial and industrial waste,Landfill,,,tonnes,kg CO2e,400.0
205,Scope 3,Waste disposal,Commercial and industrial waste,Closed-loop,,,tonnes,kg CO2e,20.0
206,Scope 3,Waste disposal,Commercial and industrial waste,Combustion,,,tonnes,kg CO2e,
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "emissions-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));
const base = { periodStart: "2025-04-01", periodEnd: "2025-04-30", basis: "measured" as const, factorYear: 2025 };
function setup() {
  const db = openDatabase(":memory:");
  return { db, repo: new SiteActivityRepository(db) };
}

describe("emissionsCarbon", () => {
  it("puts refrigerant leakage in Scope 1 and water and waste in Scope 3", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "refrigerant_topup", label: "Chiller top-up", quantity: 4, unit: "kg", refrigerantType: "R410A", factorId: "201" });
    repo.create({ ...base, category: "water_supply", label: "Water in", quantity: 1500, unit: "m3", factorId: "202" });
    repo.create({ ...base, category: "water_treatment", label: "Wastewater", quantity: 1200, unit: "m3", factorId: "203" });
    repo.create({ ...base, category: "waste_landfill", label: "General waste", quantity: 3, unit: "tonnes", wasteMaterial: "Mixed commercial", factorId: "204" });
    repo.create({ ...base, category: "waste_recycling", label: "Dry mixed recycling", quantity: 7, unit: "tonnes", wasteMaterial: "Mixed recycling", factorId: "205" });

    const r = emissionsCarbon(db, ctx(), calendarYear(2025));
    expect(r.counts).toEqual({ lines: 5, resolved: 5, unresolved: 0 });
    expect(r.totals.scope1).toBeCloseTo(4000, 3);
    expect(r.byFamily.refrigerant).toBeCloseTo(4000, 3);
    expect(r.byFamily.water).toBeCloseTo(1500 * 0.1 + 1200 * 0.2, 3);
    expect(r.byFamily.waste).toBeCloseTo(3 * 400 + 7 * 20, 3);
    expect(r.totals.scope3).toBeCloseTo(390 + 1340, 3);
    expect(r.byGhgCategory.map((g) => g.ghgCategory)).toEqual([
      "Scope 1 fugitive emissions",
      "Category 1 purchased goods and services",
      "Category 5 waste generated in operations",
    ]);
  });

  it("computes landfill diversion by mass, counting energy recovery as diverted", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "waste_landfill", label: "Landfill", quantity: 2, unit: "tonnes", factorId: "204" });
    repo.create({ ...base, category: "waste_recycling", label: "Recycling", quantity: 6000, unit: "kg", factorId: "205" });
    repo.create({ ...base, category: "waste_combustion", label: "Energy recovery", quantity: 2, unit: "tonnes", factorId: "206" });
    const w = emissionsCarbon(db, ctx(), calendarYear(2025)).waste;
    expect(w.totalTonnes).toBeCloseTo(10, 3);
    expect(w.divertedTonnes).toBeCloseTo(8, 3);
    expect(w.landfillTonnes).toBeCloseTo(2, 3);
    expect(w.diversionRatePct).toBeCloseTo(80, 3);
    expect(w.detail).toMatch(/Energy recovery counts as diverted/);
  });

  it("refuses a diversion rate when a waste line is in a unit that is not a mass", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "waste_landfill", label: "Landfill", quantity: 2, unit: "tonnes", factorId: "204" });
    repo.create({ ...base, category: "waste_recycling", label: "Skips", quantity: 5, unit: "skips", factorId: "205" });
    const w = emissionsCarbon(db, ctx(), calendarYear(2025)).waste;
    expect(w.diversionRatePct).toBeNull();
    expect(w.detail).toMatch(/Skips \(skips\).*not in a unit that converts to tonnes/);
  });

  it("keeps a blank published factor out of the total rather than treating it as zero", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "waste_combustion", label: "Energy recovery", quantity: 2, unit: "tonnes", factorId: "206" });
    const r = emissionsCarbon(db, ctx(), calendarYear(2025));
    expect(r.lines[0].kgCo2e).toBeNull();
    expect(r.totals.scope3).toBeNull();
    expect(r.byFamily.waste).toBeNull();
    expect(r.lines[0].warnings.join(" ")).toMatch(/not available/);
  });

  it("warns when a refrigerant row does not name the gas", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "refrigerant_topup", label: "Unknown top-up", quantity: 1, unit: "kg", factorId: "201" });
    const line = emissionsCarbon(db, ctx(), calendarYear(2025)).lines[0];
    expect(line.warnings.join(" ")).toMatch(/No refrigerant named/);
    expect(line.kgCo2e).toBeCloseTo(1000, 3);
  });

  it("converts m3 to litres and kg to tonnes but refuses unrelated units", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "waste_landfill", label: "In kg", quantity: 1500, unit: "kg", factorId: "204" });
    repo.create({ ...base, category: "water_supply", label: "In litres", quantity: 500, unit: "litres", factorId: "202" });
    repo.create({ ...base, category: "water_supply", label: "In kWh", quantity: 500, unit: "kWh", factorId: "202" });
    const r = emissionsCarbon(db, ctx(), calendarYear(2025));
    expect(r.lines.find((l) => l.label === "In kg")!.kgCo2e).toBeCloseTo(1.5 * 400, 3);
    expect(r.lines.find((l) => l.label === "In litres")!.kgCo2e).toBeCloseTo(0.5 * 0.1, 5);
    const bad = r.lines.find((l) => l.label === "In kWh")!;
    expect(bad.kgCo2e).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/Quantity is in kWh but the factor is per cubic metres/);
  });

  it("warns when the chosen row's published scope contradicts the category", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "water_supply", label: "Wrong factor", quantity: 10, unit: "m3", factorId: "201" });
    expect(emissionsCarbon(db, ctx(), calendarYear(2025)).lines[0].warnings.join(" ")).toMatch(/published as Scope 1/);
  });

  it("returns zero, not null, when nothing is recorded", () => {
    const { db } = setup();
    const r = emissionsCarbon(db, ctx(), calendarYear(2025));
    expect(r.totals).toEqual({ scope1: 0, scope3: 0, total: 0 });
    expect(r.waste.diversionRatePct).toBeNull();
    expect(r.waste.detail).toMatch(/No waste recorded/);
  });

  it("only counts activity whose period starts inside the reporting period", () => {
    const { db, repo } = setup();
    repo.create({ ...base, category: "waste_landfill", label: "In", quantity: 1, unit: "tonnes", factorId: "204" });
    repo.create({ ...base, periodStart: "2024-12-31", periodEnd: "2024-12-31", category: "waste_landfill", label: "Out", quantity: 99, unit: "tonnes", factorId: "204" });
    expect(emissionsCarbon(db, ctx(), calendarYear(2025)).lines.map((l) => l.label)).toEqual(["In"]);
  });
});

describe("SiteActivityRepository", () => {
  it("creates, updates, deletes and batches", () => {
    const { repo } = setup();
    const a = repo.create({ ...base, category: "water_supply", label: "Water", quantity: 10, unit: "m3", factorId: "202" });
    expect(repo.get(a.id)?.label).toBe("Water");
    expect(repo.update(a.id, { quantity: 20 }).quantity).toBe(20);
    expect(repo.createBatch([
      { ...base, category: "waste_landfill", label: "A", quantity: 1, unit: "tonnes" },
      { ...base, category: "waste_recycling", label: "B", quantity: 2, unit: "tonnes" },
    ])).toHaveLength(2);
    expect(repo.list()).toHaveLength(3);
    repo.delete(a.id);
    expect(repo.list()).toHaveLength(2);
  });
});
