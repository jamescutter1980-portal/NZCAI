// Fixture mirrors the GBIF occurrence search response schema (techdocs.gbif.org); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import occurrences from "./fixtures/occurrences.json";

describe("gbif", () => {
  it("builds geoDistance as lat,lon,km and maps records and facets", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(occurrences), { status: 200 }));
    const result = await runOperation(definition, "occurrences_near", { latitude: 51.501, longitude: -0.142, distance_km: 2, from_year: 2016 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://api.gbif.org/v1/occurrence/search");
    expect(url.searchParams.get("geoDistance")).toBe("51.501,-0.142,2km");
    expect(url.searchParams.get("country")).toBe("GB");
    expect(url.searchParams.get("year")).toBe("2016,2026");
    expect(url.searchParams.getAll("facet")).toEqual(["speciesKey", "license"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ scientific_name: "Rhinolophus hipposideros (Bechstein, 1800)", class: "Mammalia", licence: "CC_BY_NC_4_0", iucn_category: "LC" });
    expect(result.summary).toContain("2 occurrence records within 2 km in GB");
    expect(result.summary).toContain("CC_BY_NC_4_0: 1");
    const raw = result.raw as { species: { name: string | null; records: number }[] };
    expect(raw.species[0]).toEqual({ species_key: "2432437", name: "Rhinolophus hipposideros", records: 1 });
    expect(result.provenance).toMatchObject({ source: "gbif", basis: "measured" });
  });

  it("matches a species name and reports no match honestly", async () => {
    const fetch = routedFetch([
      { match: "name=Triturus", body: { usageKey: 2431885, scientificName: "Triturus cristatus (Laurenti, 1768)", canonicalName: "Triturus cristatus", rank: "SPECIES", status: "ACCEPTED", confidence: 99, matchType: "EXACT", kingdom: "Animalia", class: "Amphibia", order: "Caudata", family: "Salamandridae" } },
      { match: "name=Nonsense", body: { confidence: 100, matchType: "NONE", synonym: false, note: "No match because of too little confidence" } },
    ]);
    const hit = await runOperation(definition, "species_match", { name: "Triturus cristatus" }, testContext(fetch));
    expect(hit.rows?.[0]).toMatchObject({ canonical_name: "Triturus cristatus", match_type: "EXACT", usage_key: 2431885 });
    expect(hit.summary).toContain("Animalia > Amphibia > Caudata > Salamandridae");
    const miss = await runOperation(definition, "species_match", { name: "Nonsense name" }, testContext(fetch));
    expect(miss.rows).toEqual([]);
    expect(miss.provenance.basis).toBe("unavailable");
  });

  it("returns an empty unavailable result for no occurrences and validates before the network", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ count: 0, results: [], facets: [] }), { status: 200 }));
    const result = await runOperation(definition, "occurrences_near", { latitude: 0, longitude: 0, country: "fr" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("country")).toBe("FR");
    const noNet = vi.fn();
    await expect(runOperation(definition, "occurrences_near", { latitude: 51.5, longitude: -200 }, testContext(noNet))).rejects.toThrow();
    expect(noNet).not.toHaveBeenCalled();
  });
});
