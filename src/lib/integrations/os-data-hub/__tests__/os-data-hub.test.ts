// names-find.json and places-uprn.json mirror captured responses published in
// the osdatahub R package test suite (cran/osdatahub). ngd-buildingpart.json
// follows the OGC API Features GeoJSON shape with attribute names from the
// OS NGD building part schema; it is not a captured response.
import { describe, expect, it, vi } from "vitest";
import { bboxAround, definition } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import namesFind from "./fixtures/names-find.json";
import placesUprn from "./fixtures/places-uprn.json";
import ngd from "./fixtures/ngd-buildingpart.json";

const env = { OS_DATA_HUB_API_KEY: "KEY123" };

describe("os-data-hub", () => {
  it("passes the key as a query parameter to OS Names and maps gazetteer rows", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(namesFind), { status: 200 }));
    const result = await runOperation(definition, "names-find", { query: "Norwich", maxresults: 2 }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://api.os.uk/search/names/v1/find?query=Norwich&maxresults=2&key=KEY123");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ name: "Norwich Road", local_type: "Named Road", easting: 601732, county_unitary: "Norfolk" });
    expect(result.rows?.[1].populated_place).toBe("Yaxham");
    expect(result.provenance).toMatchObject({ source: "os-data-hub", basis: "measured", licence: "restricted" });
  });

  it("builds the Places postcode URL with a spaced postcode, dataset and key", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(placesUprn), { status: 200 }));
    await runOperation(definition, "places-postcode", { postcode: "so160as", dataset: "DPA,LPI" }, testContext(fetch, env));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://api.os.uk/search/places/v1/postcode");
    expect(url.searchParams.get("postcode")).toBe("SO16 0AS");
    expect(url.searchParams.get("dataset")).toBe("DPA,LPI");
    expect(url.searchParams.get("output_srs")).toBe("WGS84");
    expect(url.searchParams.get("key")).toBe("KEY123");
  });

  it("maps a DPA record for a UPRN", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(placesUprn), { status: 200 }));
    const result = await runOperation(definition, "places-uprn", { uprn: "200010019924" }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://api.os.uk/search/places/v1/uprn?uprn=200010019924&dataset=DPA&output_srs=WGS84&key=KEY123");
    expect(result.rows?.[0]).toMatchObject({
      dataset: "DPA",
      uprn: "200010019924",
      postcode: "SO16 0AS",
      organisation: "ORDNANCE SURVEY",
      classification_code: "CO01GV",
      blpu_state: "In use",
      latitude: 50.938,
      longitude: -1.4708,
      toid: "osgb1000002682081995",
    });
    expect(result.provenance.version).toBe("epoch 105");
  });

  it("reports an empty Places result as unavailable", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ header: { totalresults: 0 }, results: [] }), { status: 200 }));
    const result = await runOperation(definition, "places-find", { query: "nowhere" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("queries NGD building parts with a CRS84 bbox around the point", async () => {
    const fetch = routedFetch([{ match: "/features/ngd/ofa/v1/collections/bld-fts-buildingpart/items", body: ngd }]);
    const spy = vi.fn(fetch);
    const result = await runOperation(definition, "ngd-buildings-near-point", { latitude: 50.938, longitude: -1.4708, radius: 25 }, testContext(spy, env));
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/features/ngd/ofa/v1/collections/bld-fts-buildingpart/items");
    expect(url.searchParams.get("bbox")).toBe(bboxAround(50.938, -1.4708, 25));
    expect(url.searchParams.get("bbox-crs")).toBe("http://www.opengis.net/def/crs/OGC/1.3/CRS84");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("key")).toBe("KEY123");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ toid: "osgb1000002682081995", height_absolute_max_m: 38.9, land_use_tier_a: "Offices", geometry_area_m2: 4820.5 });
    expect(result.summary).toContain("tallest 38.9 m");
    expect(result.provenance.dataset).toBe("bld-fts-buildingpart");
  });

  it("bboxAround is a square in degrees around the point", () => {
    const [w, s, e, n] = bboxAround(51.5, -0.1, 100).split(",").map(Number);
    expect(e - w).toBeCloseTo(2 * (100 / (111_320 * Math.cos((51.5 * Math.PI) / 180))), 5);
    expect(n - s).toBeCloseTo(2 * (100 / 111_320), 5);
  });

  it("fails before any request when the key is missing or the input is invalid", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "names-find", { query: "London" }, testContext(fetch, {}))).rejects.toThrow(/OS_DATA_HUB_API_KEY/);
    await expect(runOperation(definition, "places-uprn", { uprn: "abc" }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "ngd-buildings-near-point", { latitude: 95, longitude: 0 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
