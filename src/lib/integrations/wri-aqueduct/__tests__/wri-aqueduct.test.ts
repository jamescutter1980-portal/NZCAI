// The fixture follows the ArcGIS FeatureServer query response shape; indicator field names (bws_cat, bws_label, bws_score,
// bws_raw and the same suffixes for bwd/iav/sev/gtd/rfr/cfr/drr/w_awr_def_tot, plus name_0/name_1/pfaf_id) come from the
// Aqueduct 4.0 data dictionary and open-source consumers of the Living Atlas layer. No live call was made.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { attributesToRows, definition } from "..";
import { runOperation, testContext } from "../../testing";
import baseline from "./fixtures/baseline-annual.json";

describe("wri-aqueduct", () => {
  it("queries the Living Atlas baseline annual layer at the point and lists one row per indicator", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(baseline), { status: 200 }));
    const result = await runOperation(definition, "water_risk_at_point", { latitude: 51.5074, longitude: -0.1278 }, testContext(fetch));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/aqueduct_water_risk/FeatureServer/1/query");
    expect(u.searchParams.get("geometry")).toBe("-0.1278,51.5074");
    expect(u.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(u.searchParams.get("inSR")).toBe("4326");
    expect(u.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(u.searchParams.has("distance")).toBe(false);
    expect(u.searchParams.get("returnGeometry")).toBe("false");
    expect(u.searchParams.get("resultRecordCount")).toBe("1");
    expect(result.rows).toHaveLength(9);
    expect(result.rows?.[0]).toEqual({ indicator: "Baseline water stress", code: "bws", group: "Physical risk: quantity", category: 4, label: "Extremely High (>80%)", score: 4.12, raw_value: 0.61, source: "Aqueduct 4.0" });
    expect(result.rows?.find((r) => r.code === "gtd")).toMatchObject({ category: -1, label: "No Data" });
    expect(result.rows?.find((r) => r.code === "w_awr_def_tot")).toMatchObject({ category: 3, label: "High (3-4)" });
    expect(result.summary).toContain("Baseline water stress Extremely High (>80%) (score 4.12/5)");
    expect(result.summary).toContain("England, United Kingdom");
    expect(result.summary).toContain("HydroBASINS 231702");
    expect(result.summary).toContain("drought risk Medium-High (0.6-0.8)");
    expect(result.provenance).toMatchObject({ source: "wri-aqueduct", basis: "modelled", licence: "CC_BY", version: "4.0 (baseline 1979-2019)" });
    expect(result.warnings?.[0]).toMatch(/EA water stressed areas/);
  });

  it("uses the env layer override", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(baseline), { status: 200 }));
    await runOperation(definition, "water_risk_at_point", { latitude: 1, longitude: 2 }, testContext(fetch, { AQUEDUCT_ARCGIS_URL: "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Aqueduct40_waterrisk_download_y2023m07d05/FeatureServer/0/" }));
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/services9\.arcgis\.com\/RHVPKKiFTONKtxq3\/arcgis\/rest\/services\/Aqueduct40_waterrisk_download_y2023m07d05\/FeatureServer\/0\/query\?/);
  });

  it("returns unavailable with no rows when no basin covers the point", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
    const result = await runOperation(definition, "water_risk_at_point", { latitude: -70, longitude: 0 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toMatch(/No Aqueduct sub-basin/);
  });

  it("maps attributes tolerant of strings and skips absent indicators, and validates before the network", async () => {
    const rows = attributesToRows({ bws_cat: "2", bws_label: "Medium-High (20-40%)", BWS_SCORE: "2.5" });
    expect(rows).toEqual([{ indicator: "Baseline water stress", code: "bws", group: "Physical risk: quantity", category: 2, label: "Medium-High (20-40%)", score: 2.5, raw_value: null, source: "Aqueduct 4.0" }]);
    const fetch = vi.fn();
    await expect(runOperation(definition, "water_risk_at_point", { latitude: 51, longitude: 200 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
