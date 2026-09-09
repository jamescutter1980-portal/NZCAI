import { describe, expect, it } from "vitest";
import { absentColumns, cell, columnIndexes, findColumn, normaliseColumn } from "../columns";

describe("columns", () => {
  it("normalises case, punctuation and a BOM", () => {
    expect(normaliseColumn("Current energy efficiency rating band")).toBe("current_energy_efficiency_rating_band");
    expect(normaliseColumn("CO2 g/km")).toBe("co2_g_km");
    expect(normaliseColumn("﻿Property_UPRN")).toBe("property_uprn");
    expect(normaliseColumn("  Installed Capacity (MWelec) ")).toBe("installed_capacity_mwelec");
  });

  it("finds columns by any candidate, exact before prefix", () => {
    const header = ["OSG_UPRN", "Postcode", "Total floor area (m²)", "Total floor area override"];
    expect(findColumn(header, ["UPRN", "OSG_UPRN"])).toBe(0);
    expect(findColumn(header, ["POSTCODE"])).toBe(1);
    expect(findColumn(header, ["TOTAL_FLOOR_AREA", "Total floor area*"])).toBe(2);
    expect(findColumn(header, ["nothing"])).toBe(-1);
  });

  it("resolves a spec to indexes and reports absent ones", () => {
    const idx = columnIndexes(["Ref ID", "Site Name"], { ref: ["Ref ID"], site: ["Site Name"], x: ["X-coordinate"] });
    expect(idx).toEqual({ ref: 0, site: 1, x: -1 });
    expect(absentColumns(idx, ["ref", "x"])).toEqual(["x"]);
    expect(cell(["a", " b "], 1)).toBe("b");
    expect(cell(["a"], 5)).toBe("");
    expect(cell(["a"], -1)).toBe("");
  });
});
