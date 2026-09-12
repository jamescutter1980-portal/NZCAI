import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { computeMisalignment, definition } from "..";
import { runOperation, testContext } from "../../testing";

// vTEST.csv is a SYNTHETIC pathway file: 5.555, 4.444 ... are invented numbers,
// not CRREM values. Only the column layout matches the documented loader format.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });
const sel = { country_code: "gb", property_type: "office", pathway_type: "ghg", scenario: "1.5C" };

describe("crrem-pathways", () => {
  it("returns a pathway series with modelled basis and a versioned provenance", async () => {
    const res = await runOperation(definition, "pathway", sel, ctx());
    expect(res.rows?.map((r) => r.year)).toEqual([2025, 2026, 2027, 2028, 2029]);
    expect(res.rows?.[0]).toMatchObject({ value: 5.555, unit: "kgCO2e/m2", property_type: "Office", country_code: "GB" });
    expect(res.rows?.[3].value).toBeNull();
    expect(res.provenance.basis).toBe("modelled");
    expect(res.provenance.version).toMatch(/^vTEST; file vTEST\.csv; modified /);
  });

  it("computes the misalignment year from a projected series and ignores years outside the pathway", () => {
    const pathway = [
      { year: 2025, value: 5 }, { year: 2026, value: 4 }, { year: 2027, value: 3 }, { year: 2028, value: null }, { year: 2029, value: 1 },
    ].map((p) => ({ ...p, version: "v", country_code: "GB", property_type: "Office", pathway_type: "ghg" as const, scenario: "1.5C" as const, unit: "kgCO2e/m2" }));
    const r = computeMisalignment(pathway, [{ year: 2024, value: 9 }, { year: 2025, value: 5 }, { year: 2026, value: 3.9 }, { year: 2027, value: 3.5 }, { year: 2028, value: 2 }, { year: 2029, value: 2 }]);
    expect(r.misalignmentYear).toBe(2027);
    expect(r.rows.map((x) => x.status)).toEqual(["aligned", "aligned", "misaligned", "no_pathway_value", "misaligned"]);
    expect(r.rows[0]).toMatchObject({ year: 2025, excess: 0, status: "aligned" }); // equal is aligned
    expect(r.assetConstant).toBe(false);
  });

  it("holds a single asset value constant and reports aligned when never exceeded", () => {
    const pathway = [{ year: 2025, value: 5 }, { year: 2026, value: 4 }].map((p) => ({ ...p, version: "v", country_code: "GB", property_type: "Office", pathway_type: "ghg" as const, scenario: "1.5C" as const, unit: "u" }));
    const r = computeMisalignment(pathway, [{ year: 2025, value: 4.5 }]);
    expect(r.assetConstant).toBe(true);
    expect(r.misalignmentYear).toBe(2026);
    expect(computeMisalignment(pathway, [{ year: 2025, value: 1 }]).misalignmentYear).toBeNull();
  });

  it("runs the misalignment operation end to end with a text series", async () => {
    const res = await runOperation(definition, "misalignment", { ...sel, asset_series: "year,value\n2025,5.0\n2026,4.5\n2027,4.5" }, ctx());
    expect(res.summary).toMatch(/^Misalignment year 2026/);
    expect(res.rows?.map((r) => r.status)).toEqual(["aligned", "misaligned", "misaligned"]);
    expect(res.rows?.[1]).toMatchObject({ asset_value: 4.5, pathway_value: 4.444, unit: "kgCO2e/m2" });
    expect(res.provenance.basis).toBe("modelled");
    const outside = await runOperation(definition, "misalignment", { ...sel, asset_series: "2030,2.0\n2031,2.0" }, ctx());
    expect(outside.warnings?.some((w) => w.includes("outside the pathway"))).toBe(true);
    expect(outside.summary).toMatch(/^No overlap/);
    expect(outside.provenance.basis).toBe("unavailable");
    const aligned = await runOperation(definition, "misalignment", { ...sel, asset_series: "2025,5.0\n2026,4.0\n2027,3.0" }, ctx());
    expect(aligned.summary).toMatch(/^Aligned/);
    const single = await runOperation(definition, "misalignment", { ...sel, asset_series: "2025,2" }, ctx());
    expect(single.warnings?.[0]).toMatch(/held constant/);
    expect(single.summary).toMatch(/Misalignment year 2029/);
  });

  it("returns unavailable for an unknown property type or version, listing what is loaded", async () => {
    const res = await runOperation(definition, "pathway", { ...sel, property_type: "Hotel" }, ctx());
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
    expect(res.summary).toContain("Retail, High Street");
    const v = await runOperation(definition, "pathway", { ...sel, version: "v9" }, ctx());
    expect(v.summary).toContain("v9.csv");
  });

  it("lists versions and validates select params before reading files", async () => {
    const res = await runOperation(definition, "versions", {}, ctx());
    expect(res.rows?.[0]).toMatchObject({ version: "vTEST", points: 10, countries: "GB", property_types: "Office, Retail, High Street" });
    await expect(runOperation(definition, "pathway", { ...sel, scenario: "3C" }, ctx())).rejects.toThrow();
    await expect(runOperation(definition, "misalignment", { ...sel, asset_series: "2025,abc" }, ctx())).rejects.toThrow(/Invalid value/);
  });
});
