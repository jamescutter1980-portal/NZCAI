// Fixtures follow the ArcGIS MapServer layer query response ({features:[{attributes}]}); attribute names DES_REF, DES_TITLE,
// CATEGORY, LINK are from a third-party HES adapter and the HES_Designations sub-layer ids are unverified. No live call was made.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { DEFAULT_LAYERS, definition, featureToHit, layersFor, portalUrl } from "..";
import { runOperation, testContext } from "../../testing";

const listed = { features: [{ attributes: { OBJECTID: 1, DES_REF: "LB27823", DES_TITLE: "1 Charlotte Square, Edinburgh", ENT_TITLE: "1 Charlotte Square", CATEGORY: "A", LOCAL_AUTH: "City of Edinburgh" } }, { attributes: { OBJECTID: 2, DES_REF: "LB27823", DES_TITLE: "1 Charlotte Square, Edinburgh", CATEGORY: "A" } }] };
const gardens = { features: [{ attributes: { DES_REF: "GDL00123", DES_TITLE: "Charlotte Square Gardens", LINK: "https://portal.historicenvironment.scot/designation/GDL00123" } }] };
const empty = { features: [] };
const arcgisError = { error: { code: 400, message: "Invalid or missing input parameters." } };

function fetchFor(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const path = url.match(/rest\/services\/HES\/(.+?)\/query/)?.[1] ?? "";
    const body = overrides[path] ?? (path === "Listed_Buildings/MapServer/0" ? listed : path === "HES_Designations/MapServer/4" ? gardens : empty);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("hes-designations", () => {
  it("queries each HES layer with a point-distance query and dedupes hits", async () => {
    const fetch = fetchFor();
    const result = await runOperation(definition, "designations_near", { latitude: 55.9533, longitude: -3.1883, distance_m: 100 }, testContext(fetch));
    expect(fetch).toHaveBeenCalledTimes(DEFAULT_LAYERS.length);
    const first = new URL(fetch.mock.calls[0][0] as string);
    expect(first.origin + first.pathname).toBe("https://inspire.hes.scot/arcgis/rest/services/HES/Listed_Buildings/MapServer/0/query");
    expect(first.searchParams.get("geometry")).toBe("-3.1883,55.9533");
    expect(first.searchParams.get("inSR")).toBe("4326");
    expect(first.searchParams.get("distance")).toBe("100");
    expect(first.searchParams.get("units")).toBe("esriSRUnit_Meter");
    expect(first.searchParams.get("f")).toBe("json");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ type: "Garden and designed landscape", name: "Charlotte Square Gardens", reference: "GDL00123", link: "https://portal.historicenvironment.scot/designation/GDL00123", layer: "HES_Designations/MapServer/4" });
    expect(result.rows?.[1]).toMatchObject({ type: "Listed building", name: "1 Charlotte Square, Edinburgh", category: "A", reference: "LB27823", local_authority: "City of Edinburgh", link: portalUrl("LB27823") });
    expect(result.summary).toContain("2 HES designation(s) within 100 m");
    expect(result.summary).toContain("category A");
    expect(result.warnings?.some((w) => w.includes("unverified"))).toBe(true);
    expect(result.provenance).toMatchObject({ source: "hes-designations", basis: "measured", licence: "OGL", territory: "Scotland" });
  });

  it("uses env base and layer overrides and the statutory filter", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(listed), { status: 200 }));
    const env = { HES_ARCGIS_BASE: "https://example.test/arcgis/rest/services/HES/", HES_ARCGIS_LAYERS: "Listed building=Listed_Buildings/MapServer/0;Scheduled monument=https://other.test/SM/FeatureServer/0;Conservation area=Conservation_Areas/MapServer/0" };
    expect(layersFor(env)).toHaveLength(3);
    const result = await runOperation(definition, "designations_near", { latitude: 55.95, longitude: -3.19, layers: "statutory" }, testContext(fetch, env));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/example\.test\/arcgis\/rest\/services\/HES\/Listed_Buildings\/MapServer\/0\/query/);
    expect(String(fetch.mock.calls[1][0])).toMatch(/^https:\/\/other\.test\/SM\/FeatureServer\/0\/query/);
    expect(result.rows).toHaveLength(2);
  });

  it("reports a failing layer as a warning and an all-empty result as unavailable", async () => {
    const fetch = fetchFor({ "Listed_Buildings/MapServer/0": arcgisError, "HES_Designations/MapServer/4": empty });
    const result = await runOperation(definition, "designations_near", { latitude: 55.9533, longitude: -3.1883 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toContain("5 of 6 layer(s)");
    expect(result.warnings?.some((w) => w.includes("Listed_Buildings") && w.includes("ArcGIS error 400"))).toBe(true);
  });

  it("maps a bare feature and validates before the network", async () => {
    expect(featureToHit(DEFAULT_LAYERS[1], { DES_REF: "SM90123", DES_TITLE: "Roman fort" })).toMatchObject({ type: "Scheduled monument", name: "Roman fort", category: null, reference: "SM90123", link: "https://portal.historicenvironment.scot/designation/SM90123" });
    const fetch = vi.fn();
    await expect(runOperation(definition, "designations_near", { latitude: 55.9, longitude: -3.2, distance_m: 0 }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "designations_near", { latitude: 95, longitude: -3.2 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
