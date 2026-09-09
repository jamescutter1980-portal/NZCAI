// Fixture follows the biocache /occurrences/search response shape used by the NBN Atlas (ALA software); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { buildFq, definition, parseNamesFacet } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import search from "./fixtures/search.json";

describe("nbn-atlas", () => {
  it("queries by lat/lon/radius with year and species-list filters and summarises per species", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(search), { status: 200 }));
    const result = await runOperation(definition, "records_near", { latitude: 51.501, longitude: -0.142, radius_km: 2, from_year: 2016, species_list_uid: "dr1940" }, testContext(fetch, { NBN_ATLAS_API_KEY: "k" }));
    const [urlStr, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(urlStr);
    expect(url.origin + url.pathname).toBe("https://records-ws.nbnatlas.org/occurrences/search");
    expect(url.searchParams.get("lat")).toBe("51.501");
    expect(url.searchParams.get("radius")).toBe("2");
    expect(url.searchParams.getAll("fq")).toEqual(["-occurrence_status:absent", "year:[2016 TO *]", "species_list_uid:dr1940"]);
    expect(url.searchParams.get("facets")).toBe("names_and_lsid");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(result.rows).toEqual([
      { scientific_name: "Rhinolophus hipposideros", common_name: "Lesser Horseshoe Bat", kingdom: "Animalia", family: "Rhinolophidae", records: 2 },
      { scientific_name: "Triturus cristatus", common_name: "Great Crested Newt", kingdom: "Animalia", family: "Salamandridae", records: 1 },
    ]);
    expect(result.summary).toContain("3 records of 2 taxa within 2 km");
    expect(result.warnings?.[0]).toMatch(/not evidence of no ecological risk/);
    expect(result.provenance).toMatchObject({ source: "nbn-atlas", basis: "measured" });
    const raw = result.raw as { records: { date: string | null; licence: string | null }[] };
    expect(raw.records[0]).toMatchObject({ date: "2024-06-01", licence: "CC-BY-NC" });
  });

  it("parses facet labels and builds fq lists", () => {
    expect(parseNamesFacet("Aves|lsid1||Animalia|")).toEqual({ scientific: "Aves", lsid: "lsid1", vernacular: null, kingdom: "Animalia", family: null });
    expect(buildFq({})).toEqual(["-occurrence_status:absent"]);
  });

  it("returns an empty unavailable result with the no-records warning", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ totalRecords: 0, occurrences: [], facetResults: [] }), { status: 200 }));
    const result = await runOperation(definition, "records_near", { latitude: 57, longitude: -5 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toContain("does not mean no species are present");
  });

  it("rejects an out-of-range radius before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "records_near", { latitude: 51.5, longitude: -0.1, radius_km: 50 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
