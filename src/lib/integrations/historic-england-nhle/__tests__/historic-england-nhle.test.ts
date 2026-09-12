// Fixture shapes follow the ArcGIS REST query response format (features[].attributes,
// dates as epoch milliseconds) with the NHLE field names reported by open-source users
// of the service (ListEntry, Name, Grade, ListDate, NGR, hyperlink). Not captured live:
// the FeatureServer host is unreachable from this build environment.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVICE, definition } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import listedPoints from "./fixtures/listed-points.json";
import monuments from "./fixtures/scheduled-monuments.json";

const empty = { features: [] };

describe("historic-england-nhle", () => {
  it("queries each designation layer around the point with metre distance in WGS84 and merges rows", async () => {
    const fetch = vi.fn(
      routedFetch([
        { match: "/FeatureServer/0/query", body: listedPoints },
        { match: "/FeatureServer/3/query", body: { features: [listedPoints.features[0]] } },
        { match: "/FeatureServer/6/query", body: monuments },
        { match: /\/FeatureServer\/(7|8|10)\/query/, body: empty },
      ]),
    );
    const result = await runOperation(definition, "designations-near-point", { latitude: 51.4947, longitude: -0.1204, distance: 150 }, testContext(fetch));
    const first = new URL(fetch.mock.calls[0][0] as string);
    expect(first.origin + first.pathname).toBe(`${DEFAULT_SERVICE}/0/query`);
    expect(first.searchParams.get("geometry")).toBe("-0.1204,51.4947");
    expect(first.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(first.searchParams.get("inSR")).toBe("4326");
    expect(first.searchParams.get("distance")).toBe("150");
    expect(first.searchParams.get("units")).toBe("esriSRUnit_Meter");
    expect(first.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(first.searchParams.get("outFields")).toBe("*");
    expect(first.searchParams.get("returnGeometry")).toBe("false");
    expect(first.searchParams.get("f")).toBe("json");
    expect(fetch.mock.calls.map((c) => new URL(c[0] as string).pathname.split("/").at(-2))).toEqual(["0", "3", "6", "7", "8", "10"]);
    // Lambeth Palace appears in both point and polygon layers and is de-duplicated
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ designation: "Listed building", name: "LAMBETH PALACE", grade: "I", list_entry: "1357311", list_date: "1950-01-01", link: "https://historicengland.org.uk/listing/the-list/list-entry/1357311" });
    expect(result.rows?.[2]).toMatchObject({ designation: "Scheduled monument", list_entry: "1001960", grade: null, list_date: "2002-10-25" });
    expect(result.summary).toContain("2 listed buildings");
    expect(result.summary).toContain("1 scheduled monument");
    expect(result.provenance).toMatchObject({ source: "historic-england-nhle", basis: "measured", licence: "OGL" });
  });

  it("honours NHLE_FEATURESERVER_URL and reports no designations as unavailable", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(empty), { status: 200 }));
    const result = await runOperation(definition, "designations-near-point", { latitude: 53, longitude: -1, distance: 50, include_polygons: false }, testContext(fetch, { NHLE_FEATURESERVER_URL: "https://example.test/arcgis/rest/services/NHLE/FeatureServer/" }));
    expect(fetch.mock.calls[0][0]).toContain("https://example.test/arcgis/rest/services/NHLE/FeatureServer/0/query?");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("surfaces an ArcGIS-level error object as an HTTP error", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: { code: 400, message: "Invalid query parameters" } }), { status: 200 }));
    await expect(runOperation(definition, "designations-near-point", { latitude: 53, longitude: -1 }, testContext(fetch))).rejects.toThrow(/ArcGIS error 400/);
  });

  it("looks up a list entry number with a where clause and stops at the first layer that matches", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/FeatureServer/0/query", body: { features: [listedPoints.features[1]] } }]));
    const result = await runOperation(definition, "list-entry", { list_entry: "1080374" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("where")).toBe("ListEntry = 1080374");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.rows?.[0]).toMatchObject({ name: "LAMBETH PALACE COTTAGES WALL", grade: "II" });
    expect(result.summary).toContain("grade II");
    expect(result.links?.[0].url).toBe("https://historicengland.org.uk/listing/the-list/list-entry/1080374");
  });

  it("rejects invalid coordinates and list entry numbers before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "designations-near-point", { latitude: 51, longitude: 200 }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "list-entry", { list_entry: "abc" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
