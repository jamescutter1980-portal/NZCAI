import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { definition, parseFlatFile } from "..";
import { runOperation, testContext } from "../../testing";

// Fixture files under fixtures/reference/desnz-conversion-factors/ are SYNTHETIC:
// every factor (1.111, 2.222 ...) is invented for the tests. The column layout
// mirrors the DESNZ flat file as documented by open-source parsers; it was not
// downloaded from gov.uk in this environment.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });

describe("desnz-conversion-factors", () => {
  it("parses the flat file, skipping preamble rows and keeping blank factors unavailable", () => {
    const text = 'title row\n\nID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2026,Lookup\n1,Scope 1,Fuels,Gaseous fuels,"Natural gas, ""mains""",,,kWh,kg CO2e,1.111,x\n2,Scope 3,WTT,Cars,Small,,,km,kg CO2e,,y\n3,Outside of scopes,Bio,Biogas,,,,t,kg CO2e,0,z\n';
    const file = { name: "2026.csv", path: "/dev/null", modifiedAt: "2026-08-01T00:00:00.000Z", sizeBytes: 1 };
    const idx = parseFlatFile(text, 2026, file);
    expect(idx.factorColumn).toBe("GHG Conversion Factor 2026");
    expect(idx.rows).toHaveLength(3);
    expect(idx.rows[0]).toMatchObject({ id: "1", level3: 'Natural gas, "mains"', factor: 1.111, availability: "available" });
    expect(idx.rows[1]).toMatchObject({ id: "2", factor: null, factor_text: "", availability: "unavailable" });
    expect(idx.rows[2]).toMatchObject({ id: "3", factor: 0, availability: "available" });
  });

  it("rejects a file without the expected columns", () => {
    const file = { name: "2026.csv", path: "/dev/null", modifiedAt: "x", sizeBytes: 1 };
    expect(() => parseFlatFile("a,b\n1,2\n", 2026, file)).toThrow(/missing columns|header/);
    expect(() => parseFlatFile("ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,Value\n1,,,,,,,,,1\n", 2026, file)).toThrow(/GHG Conversion Factor/);
  });

  it("searches with keyword, scope and GHG-unit filters and defaults to the latest year", async () => {
    const res = await runOperation(definition, "search", { keywords: "electricity uk", scope: "Scope 2" }, ctx());
    expect(res.rows).toHaveLength(1); // per-gas row hidden by the default kg CO2e filter
    expect(res.rows?.[0]).toMatchObject({ id: "1001", factor: 1.111, year: 2026, availability: "available" });
    expect(res.provenance.basis).toBe("measured");
    expect(res.provenance.version).toMatch(/^2026; file 2026\.csv; modified /);

    const all = await runOperation(definition, "search", { keywords: "electricity uk", scope: "Scope 2", ghg_unit: "any" }, ctx());
    expect(all.rows?.map((r) => r.id)).toEqual(["1001", "1002"]);

    const td = await runOperation(definition, "search", { keywords: "electricity", level1: "transmission" }, ctx());
    expect(td.rows?.map((r) => r.id)).toEqual(["1003"]);
  });

  it("reports unavailable and non-numeric factors as unavailable, never 0", async () => {
    const res = await runOperation(definition, "search", { keywords: "wtt", scope: "Scope 3" }, ctx());
    expect(res.rows?.[0]).toMatchObject({ id: "1005", factor: null, availability: "unavailable" });
    expect(res.warnings?.[0]).toMatch(/unavailable, not 0/);
    const na = await runOperation(definition, "factor", { id: "1007" }, ctx());
    expect(na.rows?.[0]).toMatchObject({ factor: null, availability: "unavailable" });
    expect(na.provenance.basis).toBe("unavailable");
    const zero = await runOperation(definition, "factor", { id: "1006" }, ctx());
    expect(zero.rows?.[0]).toMatchObject({ factor: 0, availability: "available" });
    expect(zero.provenance.basis).toBe("measured");
  });

  it("gets a factor by id and year, and handles quoted column text", async () => {
    const res = await runOperation(definition, "factor", { id: "1004" }, ctx());
    expect(res.rows?.[0]).toMatchObject({ column_text: 'Gross CV, "as delivered"', factor: 2.222, uom: "kWh (Gross CV)" });
    expect(res.summary).toContain("2.222 kg CO2e per kWh (Gross CV)");
    const prior = await runOperation(definition, "factor", { id: "1001", year: 2025 }, ctx());
    expect(prior.rows?.[0]).toMatchObject({ factor: 1.222, year: 2025 });
    const missing = await runOperation(definition, "factor", { id: "9999" }, ctx());
    expect(missing.rows).toEqual([]);
    expect(missing.provenance.basis).toBe("unavailable");
  });

  it("returns an unavailable result for a year that is not loaded and when the directory is empty", async () => {
    const res = await runOperation(definition, "search", { keywords: "gas", year: 2019 }, ctx());
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
    expect(res.summary).toContain("2019.csv");
    const empty = await runOperation(definition, "years", {}, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(empty.rows).toEqual([]);
  });

  it("lists loaded years with counts and mtime", async () => {
    const res = await runOperation(definition, "years", {}, ctx());
    expect(res.rows?.map((r) => r.year)).toEqual([2026, 2025]);
    expect(res.rows?.[0]).toMatchObject({ rows: 7, available: 5, unavailable: 2, factor_column: "GHG Conversion Factor 2026" });
    expect(typeof res.rows?.[0].modified_at).toBe("string");
  });

  it("provides publication links and never touches the network", async () => {
    const fetch = vi.fn();
    const res = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(res.links?.map((l) => l.url)).toContain("https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates params before reading anything", async () => {
    await expect(runOperation(definition, "search", { keywords: "x", scope: "Scope 9" }, ctx())).rejects.toThrow();
    await expect(runOperation(definition, "search", { keywords: "x", limit: 1000 }, ctx())).rejects.toThrow();
  });
});
