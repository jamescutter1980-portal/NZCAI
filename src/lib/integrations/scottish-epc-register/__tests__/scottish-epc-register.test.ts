import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { definition, headerScore, indexHeader, isHeaderRow, normalisePostcode, toIsoDate } from "..";
import { runOperation, testContext } from "../../testing";

// Fixture files under fixtures/reference/scottish-epc-register/ are SYNTHETIC:
// every address, UPRN, rating and date is invented for these tests. The
// two-row header layout (descriptive row, then working names mixing
// OSG_UPRN / ADDRESS1 with "Postcode" / "Current energy efficiency rating")
// follows open-source parsers of the statistics.gov.scot extracts; no extract
// was downloaded in this environment.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });
const file = (name: string) => ({ name, path: "/dev/null", modifiedAt: "2026-08-01T00:00:00.000Z", sizeBytes: 1 });

describe("scottish-epc-register", () => {
  it("detects the working header row beneath the descriptive row and maps both naming styles", () => {
    expect(isHeaderRow(["Unique property reference number", "Postcode of the property"])).toBe(false);
    expect(isHeaderRow(["OSG_UPRN", "Postcode", "Current energy efficiency rating"])).toBe(true);
    expect(isHeaderRow(["UPRN", "POSTCODE", "CURRENT_ENERGY_EFFICIENCY"])).toBe(true);
    // A descriptive first row that happens to say "Postcode" and "Energy band" scores lower than the working names beneath it.
    expect(headerScore(["Property UPRN", "First address line", "Postcode", "Energy band"])).toBeLessThan(headerScore(["OSG_UPRN", "Address1", "Post Town", "Postcode", "Energy Band"]));
    expect(toIsoDate("04/03/2021 10:15:00")).toBe("2021-03-04");
    expect(toIsoDate("2023-11-20")).toBe("2023-11-20");
    expect(toIsoDate("unknown")).toBe("unknown");
    const idx = indexHeader([["descriptive", "row", "here"], ["OSG_UPRN", "Postcode", "Current energy efficiency rating band", "Total floor area (m²)"]], "domestic", file("domestic-x.csv"));
    expect(idx.headerRowIndex).toBe(1);
    expect(idx.columns).toMatchObject({ uprn: 0, postcode: 1, current_rating: 2, floor_area: 3 });
    expect(idx.missing).toContain("built_form");
    expect(() => indexHeader([["a", "b"], ["c", "d"]], "domestic", file("domestic-x.csv"))).toThrow(/no header row/);
  });

  it("finds every certificate at a postcode across domestic, republished and non-domestic files, newest first", async () => {
    const res = await runOperation(definition, "by_postcode", { postcode: "zz1 1aa" }, ctx());
    expect(res.rows?.map((r) => [r.file, r.uprn, r.current_rating])).toEqual([
      ["domestic-republished-synthetic.csv", "906700000011", "B"],
      ["domestic-2023q4-synthetic.csv", "906700000001", "D"],
      ["non-domestic-2023q4-synthetic.csv", "6700000009", "C"],
      ["domestic-2023q4-synthetic.csv", "906700000001", "D"],
    ]);
    expect(res.rows?.[1]).toMatchObject({ dataset: "domestic", address: "1 Synthetic Street", post_town: "TESTBURGH", postcode: "zz1 1aa", current_efficiency: 68, potential_rating: "C", floor_area_m2: 72.5, main_fuel: "Mains gas (not community)", main_heating: "Boiler and radiators, mains gas", energy_consumption_kwh_m2: 210, co2_kg_m2: 35, lodgement_date: "2023-11-20" });
    expect(res.rows?.[2]).toMatchObject({ dataset: "non-domestic", current_efficiency: 55, floor_area_m2: 1250, property_type: "B8 Storage or Distribution", main_fuel: "Natural Gas", lodgement_date: "2021-03-04", inspection_date: "2021-03-01" });
    expect(res.summary).toContain("4 certificate(s) at ZZ11AA");
    expect(res.provenance).toMatchObject({ source: "scottish-epc-register", basis: "measured", licence: "OGL" });
    expect(res.provenance.version).toMatch(/file domestic-2023q4-synthetic\.csv; modified/);
    expect(res.warnings?.some((w) => /SAP\/RdSAP/.test(w))).toBe(true);
  });

  it("keeps blank and INVALID! cells as null/text, never 0", async () => {
    const res = await runOperation(definition, "by_postcode", { postcode: "ZZ1 1AB", dataset: "domestic" }, ctx());
    expect(res.rows).toHaveLength(1);
    expect(res.rows?.[0]).toMatchObject({ uprn: "", current_rating: "INVALID!", current_efficiency: null, floor_area_m2: null, energy_consumption_kwh_m2: null });
  });

  it("searches by UPRN, ignoring leading zeros and files without a UPRN column", async () => {
    const res = await runOperation(definition, "by_uprn", { uprn: "006700000009" }, ctx());
    expect(res.rows?.map((r) => r.dataset)).toEqual(["non-domestic"]);
    expect(res.rows?.[0]).toMatchObject({ address: "Unit 9 Synthetic Industrial Estate", current_rating: "C" });
    const none = await runOperation(definition, "by_uprn", { uprn: "1" }, ctx());
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
  });

  it("filters by dataset and caps rows at the limit", async () => {
    const res = await runOperation(definition, "by_postcode", { postcode: "ZZ1 1AA", dataset: "domestic", limit: 1 }, ctx());
    expect(res.rows).toHaveLength(1);
    expect(res.raw).toMatchObject({ total: 3 });
    expect(res.warnings?.some((w) => /3 certificates matched; showing 1/.test(w))).toBe(true);
  });

  it("lists loaded files with header detection and unmatched fields, and reports an empty directory", async () => {
    const res = await runOperation(definition, "files", {}, ctx());
    expect(res.rows?.map((r) => r.file)).toEqual(["domestic-2023q4-synthetic.csv", "domestic-republished-synthetic.csv", "non-domestic-2023q4-synthetic.csv"]);
    expect(res.rows?.[0]).toMatchObject({ dataset: "domestic", header_row: 2, unmatched_fields: "address3" });
    expect(res.rows?.[1]).toMatchObject({ header_row: 1 });
    expect(String(res.rows?.[1].unmatched_fields)).toContain("tenure");
    const empty = await runOperation(definition, "by_postcode", { postcode: "ZZ1 1AA" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    expect(empty.summary).toContain("domestic-<label>.csv");
  });

  it("returns links without touching the network and validates before reading anything", async () => {
    const fetch = vi.fn();
    const res = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(fetch).not.toHaveBeenCalled();
    expect(res.links?.map((l) => l.url)).toContain("https://statistics.gov.scot/data/domestic-energy-performance-certificates");
    await expect(runOperation(definition, "by_postcode", { postcode: "not a postcode" }, ctx())).rejects.toThrow();
    await expect(runOperation(definition, "by_uprn", { uprn: "abc" }, ctx())).rejects.toThrow();
    await expect(runOperation(definition, "by_postcode", { postcode: "ZZ1 1AA", dataset: "commercial" }, ctx())).rejects.toThrow();
    expect(normalisePostcode(" zz1 1aa ")).toBe("ZZ11AA");
    expect(definition.status).toBe("built_unverified");
  });
});
