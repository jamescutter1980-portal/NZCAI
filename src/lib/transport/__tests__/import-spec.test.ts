import { describe, expect, it } from "vitest";
import { applyMapping, previewCsv, suggestMapping } from "@/lib/import";
import { transportActivityImportSpec as spec } from "../import-spec";

/** A realistically messy client mileage export: preamble, UK dates, thousands separators, an alias category. */
const MESSY = `Staff mileage claims export
Generated 04/01/2026

Employee;Type;Start;End;Mileage;Units;Reg;Notes
A Smith;Grey fleet;01/01/2025;31/03/2025;1,240.5;miles;AB12 CDE;Q1
B Jones;grey_fleet;01/04/2025;30/06/2025;980;miles;;Q2
C Brown;Flights;01/06/2025;30/06/2025;15 000;passenger.km;;Long haul
D Green;Hotel;01/06/2025;30/06/2025;40;Room per night;;
`;

describe("transport activity import", () => {
  it("reads a messy export, maps its columns and parses UK dates and separators", () => {
    const preview = previewCsv(MESSY);
    expect(preview.delimiter).toBe(";");
    expect(preview.preambleRows).toBeGreaterThan(0);
    expect(preview.headers).toContain("Mileage");

    const mapping = suggestMapping(spec, preview.headers);
    expect(mapping.category).toBe(preview.headers.indexOf("Type"));
    expect(mapping.quantity).toBe(preview.headers.indexOf("Mileage"));
    expect(mapping.periodStart).toBe(preview.headers.indexOf("Start"));
    expect(mapping.vehicleRegistration).toBe(preview.headers.indexOf("Reg"));
    expect(mapping.label).not.toBeNull();

    const result = applyMapping(spec, preview.headers, preview.rows, mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(4);
    const first = result.rows[0].data;
    expect(first).toMatchObject({ category: "grey_fleet", periodStart: "2025-01-01", periodEnd: "2025-03-31", quantity: 1240.5, unit: "miles", vehicleRegistration: "AB12CDE" });
    // Aliases resolve to the internal ids.
    expect(result.rows[2].data.category).toBe("business_travel_air");
    expect(result.rows[3].data.category).toBe("hotel_stay");
    expect(result.rows[2].data.quantity).toBe(15000);
    // A blank optional cell is absent, not null and not zero.
    expect("vehicleRegistration" in result.rows[1].data).toBe(false);
  });

  it("reports bad rows with their row number rather than dropping them", () => {
    const csv = `Type,Description,Start,End,Quantity,Unit
grey_fleet,Good row,2025-01-01,2025-03-31,100,miles
not_a_category,Bad category,2025-01-01,2025-03-31,100,miles
grey_fleet,Bad number,2025-01-01,2025-03-31,N/A,miles
grey_fleet,US date,03/15/2025,2025-03-31,100,miles
`;
    const preview = previewCsv(csv);
    const result = applyMapping(spec, preview.headers, preview.rows, suggestMapping(spec, preview.headers));
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.rowNumber)).toEqual([3, 4, 5]);
    expect(result.errors[1].message).toMatch(/N\/A/);
    expect(result.errors[2].message).toMatch(/day first|month-first/i);
  });

  it("catches an inverted period and a half-specified factor through rowCheck", () => {
    expect(spec.rowCheck?.({ periodStart: "2025-06-01", periodEnd: "2025-01-01" }, 7)).toEqual([
      "Row 7: To (2025-01-01) is before From (2025-06-01).",
    ]);
    expect(spec.rowCheck?.({ factorId: "101" }, 3)).toEqual(["Row 3: a factor row id needs a factor year."]);
    expect(spec.rowCheck?.({ factorYear: 2025 }, 4)).toEqual(["Row 4: a factor year needs a factor row id."]);
    expect(spec.rowCheck?.({ periodStart: "2025-01-01", periodEnd: "2025-03-31" }, 2)).toEqual([]);
  });
});
