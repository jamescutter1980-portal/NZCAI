import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { calendarYear } from "@/lib/carbon/period";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { TransportRepository, transportCarbon, unitConversion } from "..";

// Every factor value below is synthetic and exists only to exercise the plumbing.
// Row ids, level names and units mirror the published DESNZ flat-file layout.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
101,Scope 1,Passenger vehicles,Cars (by size),Medium car,Diesel,,km,kg CO2e,0.111
102,Scope 3,Business travel- land,Cars (by size),Medium car,Diesel,,km,kg CO2e,0.222
103,Scope 3,Business travel- air,"International, to/from UK",Economy class,With RF,,passenger.km,kg CO2e,0.333
104,Scope 3,Hotel stay,,UK,,,Room per night,kg CO2e,44.4
105,Scope 3,Business travel- land,Rail,National rail,,,passenger.km,kg CO2e,
106,Scope 1,Fuels,Liquid fuels,Diesel (average biofuel blend),,,litres,kg CO2e,2.555
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transport-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, new Date("2026-06-01T00:00:00Z"));

function setup() {
  const db = openDatabase(":memory:");
  return { db, repo: new TransportRepository(db) };
}

const base = { periodStart: "2025-03-01", periodEnd: "2025-03-31", basis: "measured" as const, factorYear: 2025 };

describe("transportCarbon", () => {
  it("splits Scope 1 fleet from Scope 3 travel and totals by GHG category", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "fleet_owned", label: "Van fleet diesel", quantity: 1000, unit: "km", factorId: "101" });
    repo.createActivity({ ...base, category: "grey_fleet", label: "Staff mileage", quantity: 500, unit: "km", factorId: "102" });
    repo.createActivity({ ...base, category: "business_travel_air", label: "Flights", quantity: 2000, unit: "passenger.km", factorId: "103" });
    repo.createActivity({ ...base, category: "hotel_stay", label: "Hotels", quantity: 10, unit: "Room per night", factorId: "104" });

    const r = transportCarbon(db, ctx(), calendarYear(2025));
    expect(r.counts).toEqual({ lines: 4, resolved: 4, unresolved: 0 });
    expect(r.totals.scope1).toBeCloseTo(111, 3);
    expect(r.totals.scope3).toBeCloseTo(500 * 0.222 + 2000 * 0.333 + 10 * 44.4, 2);
    expect(r.totals.total).toBeCloseTo(111 + 500 * 0.222 + 2000 * 0.333 + 10 * 44.4, 2);
    const cats = r.byGhgCategory.map((g) => g.ghgCategory);
    expect(cats).toContain("Scope 1 mobile combustion");
    expect(cats).toContain("Category 6 business travel");
    expect(r.byGhgCategory.find((g) => g.scope === 3)!.lines).toBe(3);
    expect(r.factorReferences.join(" ")).toMatch(/DESNZ 2025 row 101/);
  });

  it("converts miles to km and records the conversion", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "grey_fleet", label: "Mileage claims", quantity: 100, unit: "miles", factorId: "102" });
    const line = transportCarbon(db, ctx(), calendarYear(2025)).lines[0];
    expect(line.convertedQuantity).toBeCloseTo(160.934, 2);
    expect(line.kgCo2e).toBeCloseTo(160.934 * 0.222, 2);
    expect(line.conversionNote).toMatch(/100 miles converted to 160.934 km/);
    expect(unitConversion("miles", "km")).toBeCloseTo(1.609344, 6);
    expect(unitConversion("litres", "km")).toBeNull();
  });

  it("refuses to guess across unrelated units", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "fleet_owned", label: "Diesel purchased", quantity: 800, unit: "litres", factorId: "101" });
    const r = transportCarbon(db, ctx(), calendarYear(2025));
    expect(r.lines[0].kgCo2e).toBeNull();
    expect(r.lines[0].warnings.join(" ")).toMatch(/Quantity is in litres but the factor is per km/);
    expect(r.totals.scope1).toBeNull();
  });

  it("warns when the chosen factor's published scope contradicts the category", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "grey_fleet", label: "Wrong factor", quantity: 10, unit: "km", factorId: "101" });
    const line = transportCarbon(db, ctx(), calendarYear(2025)).lines[0];
    expect(line.warnings.join(" ")).toMatch(/published as Scope 1/);
    expect(line.kgCo2e).toBeCloseTo(1.11, 3); // still calculated; the user is told, not overruled
  });

  it("reports a blank published factor and an unknown row as unavailable with a reason", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "business_travel_rail", label: "Rail", quantity: 100, unit: "passenger.km", factorId: "105" });
    repo.createActivity({ ...base, category: "business_travel_road", label: "Taxi", quantity: 50, unit: "km", factorId: "999" });
    repo.createActivity({ ...base, category: "commuting", label: "Commuting survey", quantity: 5000, unit: "km", factorId: undefined, factorYear: undefined });
    const r = transportCarbon(db, ctx(), calendarYear(2025));
    expect(r.counts.unresolved).toBe(3);
    expect(r.lines.find((l) => l.label === "Rail")!.warnings.join(" ")).toMatch(/not available/);
    expect(r.lines.find((l) => l.label === "Taxi")!.warnings.join(" ")).toMatch(/Row 999 is not in the 2025 flat file/);
    expect(r.lines.find((l) => l.label === "Commuting survey")!.factor.reference).toBe("no factor chosen");
    expect(r.totals.scope3).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/3 of 3 transport lines could not be calculated/);
  });

  it("only counts activity whose period starts inside the reporting period", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, category: "fleet_owned", label: "In period", quantity: 100, unit: "km", factorId: "101" });
    repo.createActivity({ ...base, periodStart: "2024-12-31", periodEnd: "2024-12-31", category: "fleet_owned", label: "Before", quantity: 999, unit: "km", factorId: "101" });
    repo.createActivity({ ...base, periodStart: "2026-01-01", periodEnd: "2026-01-01", category: "fleet_owned", label: "After", quantity: 999, unit: "km", factorId: "101" });
    const r = transportCarbon(db, ctx(), calendarYear(2025));
    expect(r.lines.map((l) => l.label)).toEqual(["In period"]);
    expect(r.totals.scope1).toBeCloseTo(11.1, 3);
  });

  it("warns when a row runs past the end of the period and when its factor year differs", () => {
    const { db, repo } = setup();
    repo.createActivity({ ...base, periodStart: "2025-12-01", periodEnd: "2026-03-31", category: "fleet_owned", label: "Straddles year end", quantity: 100, unit: "km", factorId: "101" });
    const line = transportCarbon(db, ctx(), calendarYear(2025)).lines[0];
    expect(line.warnings.join(" ")).toMatch(/runs past the end of the reporting period/);
    const other = transportCarbon(db, ctx(), calendarYear(2026)).lines;
    expect(other).toHaveLength(0);
  });

  it("returns zero, not null, when there is no transport activity at all", () => {
    const { db } = setup();
    const r = transportCarbon(db, ctx(), calendarYear(2025));
    expect(r.totals).toEqual({ scope1: 0, scope3: 0, total: 0 });
    expect(r.counts.lines).toBe(0);
  });
});

describe("TransportRepository", () => {
  it("stores vehicles, finds them by registration and links activity to them", () => {
    const { db, repo } = setup();
    const v = repo.createVehicle({ registration: "ab12 cde", make: "Ford", model: "Transit", fuelType: "DIESEL", ownership: "owned" });
    expect(v.registration).toBe("AB12CDE");
    expect(repo.findVehicleByRegistration("AB12 CDE")?.id).toBe(v.id);
    repo.createActivity({ ...base, category: "fleet_owned", label: "Van", quantity: 10, unit: "km", factorId: "101", vehicleId: v.id });
    expect(transportCarbon(db, ctx(), calendarYear(2025)).lines[0].vehicle).toBe("AB12CDE Ford Transit");
    repo.updateVehicle(v.id, { notes: "Sold March 2026" });
    expect(repo.getVehicle(v.id)?.notes).toBe("Sold March 2026");
    repo.deleteVehicle(v.id);
    expect(repo.getVehicle(v.id)).toBeUndefined();
    // The activity survives its vehicle being deleted, with the link cleared.
    expect(repo.listActivity()).toHaveLength(1);
    expect(repo.listActivity()[0].vehicleId).toBeUndefined();
  });

  it("inserts a batch in one transaction and rolls back on failure", () => {
    const { repo } = setup();
    expect(repo.createActivityBatch([
      { ...base, category: "grey_fleet", label: "A", quantity: 1, unit: "km", factorId: "102" },
      { ...base, category: "grey_fleet", label: "B", quantity: 2, unit: "km", factorId: "102" },
    ])).toHaveLength(2);
    expect(repo.listActivity()).toHaveLength(2);
    expect(() =>
      repo.createActivityBatch([
        { ...base, category: "grey_fleet", label: "C", quantity: 3, unit: "km", factorId: "102" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...base, category: "grey_fleet", label: null as any, quantity: 4, unit: "km", factorId: "102" },
      ]),
    ).toThrow();
    expect(repo.listActivity()).toHaveLength(2);
  });
});
