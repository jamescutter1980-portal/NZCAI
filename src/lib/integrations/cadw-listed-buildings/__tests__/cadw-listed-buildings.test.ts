// Fixtures follow the GeoServer WFS 2.0 GeoJSON output shape ({type:"FeatureCollection", features:[{geometry, properties}],
// totalFeatures, numberMatched}). Listed-building property names come from the Cadw CSV export; SAM and conservation area
// properties are guesses. No live call was made.
import { describe, expect, it, vi } from "vitest";
import { definition, featureToHit, LAYERS, normaliseDate } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import listed from "./fixtures/listed-buildings.json";

const point = { latitude: 51.4816, longitude: -3.1791 };
const conservation = {
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "conservation_areas_wales.7", geometry: { type: "Polygon", coordinates: [[[-3.185, 51.478], [-3.17, 51.478], [-3.17, 51.486], [-3.185, 51.486], [-3.185, 51.478]]] }, properties: { name: "Cathays Park", la_name: "Cardiff" } }],
};
const empty = { type: "FeatureCollection", features: [] };
const exception = `<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>Feature type inspire-wg:Cadw_SAM unknown</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`;

describe("cadw-listed-buildings", () => {
  it("builds a WFS 2.0 GetFeature per layer with an EPSG:4326 bbox and lists hits by distance", async () => {
    const fetch = vi.fn(routedFetch([
      { match: "Cadw_ListedBuildings", body: listed },
      { match: "Cadw_SAM", body: empty },
      { match: "conservation_areas_wales", body: conservation },
    ]));
    const result = await runOperation(definition, "designations_near", { ...point, distance_m: 100 }, testContext(fetch));
    expect(fetch).toHaveBeenCalledTimes(LAYERS.length);
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://datamap.gov.wales/geoserver/ows");
    expect(u.searchParams.get("service")).toBe("WFS");
    expect(u.searchParams.get("version")).toBe("2.0.0");
    expect(u.searchParams.get("request")).toBe("GetFeature");
    expect(u.searchParams.get("typeNames")).toBe("inspire-wg:Cadw_ListedBuildings");
    expect(u.searchParams.get("outputFormat")).toBe("application/json");
    expect(u.searchParams.get("srsName")).toBe("EPSG:4326");
    expect(u.searchParams.get("count")).toBe("100");
    const bbox = u.searchParams.get("bbox")!.split(",");
    expect(bbox).toHaveLength(5);
    expect(bbox[4]).toBe("urn:ogc:def:crs:EPSG::4326");
    expect(Number(bbox[0])).toBeCloseTo(51.4807, 3);
    expect(Number(bbox[1])).toBeCloseTo(-3.1805, 3);
    expect(u.searchParams.has("CQL_FILTER")).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ type: "Conservation area", name: "Cathays Park", authority: "Cardiff", distance_m: 0, reference: "conservation_areas_wales.7" });
    expect(result.rows?.[1]).toMatchObject({ type: "Listed building", name: "Cardiff Market", grade: "II*", reference: "12345", community: "Castle", designated: "1975-01-31", layer: "inspire-wg:Cadw_ListedBuildings" });
    expect(result.rows?.[1].distance_m).toBeGreaterThan(5);
    expect(result.rows?.[1].distance_m).toBeLessThan(30);
    expect(String(result.rows?.[1].link)).toContain("id=12345");
    expect(result.summary).toContain("2 Cadw designation(s) within 100 m");
    expect(result.summary).toContain("1 conservation area, 1 listed building");
    expect(result.provenance).toMatchObject({ source: "cadw-listed-buildings", basis: "measured", licence: "OGL", territory: "Wales" });
  });

  it("honours env overrides for the endpoint and type name and filters to one layer", async () => {
    const fetch = vi.fn(routedFetch([{ match: "custom%3ALB", body: listed }]));
    const result = await runOperation(definition, "designations_near", { ...point, distance_m: 2000, layers: "listed" }, testContext(fetch, { CADW_WFS_BASE: "https://example.test/geoserver/inspire-wg/wfs", CADW_WFS_TYPENAME: "custom:LB" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/example\.test\/geoserver\/inspire-wg\/wfs\?/);
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.map((r) => r.name)).toEqual(["Cardiff Market", "Far Away Chapel"]);
    expect(result.rows?.[1]).toMatchObject({ designated: "1998-05-12", link: null });
  });

  it("reports a WFS exception as a warning and an all-empty result as unavailable", async () => {
    const fetch = routedFetch([
      { match: "Cadw_ListedBuildings", body: empty },
      { match: "Cadw_SAM", body: exception, status: 400, headers: { "content-type": "application/xml" } },
      { match: "conservation_areas_wales", body: empty },
    ]);
    const result = await runOperation(definition, "designations_near", point, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toContain("2 of 3 layer(s)");
    expect(result.warnings?.some((w) => w.includes("Cadw_SAM") && w.includes("unknown"))).toBe(true);
  });

  it("maps bare features, normalises dates and validates before the network", async () => {
    const hit = featureToHit(LAYERS[1], "inspire-wg:Cadw_SAM", { geometry: { type: "Point", coordinates: [-3.1791, 51.4816] }, properties: { Name: "Cardiff Castle", SAM_Number: "GM001" } }, 51.4816, -3.1791);
    expect(hit).toMatchObject({ type: "Scheduled monument", name: "Cardiff Castle", reference: "GM001", grade: null, distance_m: 0 });
    expect(normaliseDate("31/01/1975")).toBe("1975-01-31");
    expect(normaliseDate(null)).toBeNull();
    const fetch = vi.fn();
    await expect(runOperation(definition, "designations_near", { latitude: 51.5, longitude: -3.2, distance_m: 99999 }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "designations_near", { latitude: "abc", longitude: -3.2 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
