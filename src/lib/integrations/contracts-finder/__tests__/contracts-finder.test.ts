// Fixture mirrors the Contracts Finder OCDS search response shape (hitsCount, maxPage, results[].releases[])
// as consumed by open-source OCDS collectors; it was not taken from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import cfSearch from "./fixtures/cf-search.json";

describe("contracts-finder", () => {
  it("builds the documented query and maps releases to rows", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(cfSearch), { status: 200 }));
    const result = await runOperation(definition, "search", { published_from: "2026-08-01", published_to: "2026-08-31", stage: "tender" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search");
    expect(url.searchParams.get("publishedFrom")).toBe("2026-08-01");
    expect(url.searchParams.get("stages")).toBe("tender");
    expect(url.searchParams.get("size")).toBe("100");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ buyer: "Example Borough Council", value: 450000, currency: "GBP", stage: "tender", tender_closes: "2026-09-15T12:00:00Z" });
    expect(result.rows?.[1]).toMatchObject({ suppliers: "Example Facilities Limited", value: 1200000, award_date: "2026-08-09T00:00:00Z" });
    expect(result.provenance).toMatchObject({ source: "contracts-finder", basis: "measured", licence: "OGL" });
  });

  it("filters by keyword client-side and reports an empty result honestly", async () => {
    const fetch = routedFetch([{ match: "OCDS/Search", body: cfSearch }]);
    const hit = await runOperation(definition, "search", { published_from: "2026-08-01", published_to: "2026-08-31", keyword: "solar pv" }, testContext(fetch));
    expect(hit.rows).toHaveLength(1);
    expect(hit.warnings?.[0]).toMatch(/fetched page only/);
    const miss = await runOperation(definition, "search", { published_from: "2026-08-01", published_to: "2026-08-31", keyword: "nuclear" }, testContext(fetch));
    expect(miss.rows).toEqual([]);
    expect(miss.provenance.basis).toBe("unavailable");
  });

  it("queries Find a Tender release packages", async () => {
    const pkg = { uri: "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages", releases: cfSearch.results.flatMap((r) => r.releases), links: { next: "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?cursor=abc" } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(pkg), { status: 200 }));
    const result = await runOperation(definition, "fts_releases", { updated_from: "2026-09-01", updated_to: "2026-09-05" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/1.0/ocdsReleasePackages");
    expect(url.searchParams.get("updatedFrom")).toBe("2026-09-01T00:00:00");
    expect(result.rows).toHaveLength(2);
    expect(result.links?.[0].url).toContain("cursor=abc");
  });

  it("rejects a reversed or over-long window before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "search", { published_from: "2026-08-31", published_to: "2026-08-01" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "fts_releases", { updated_from: "2026-01-01", updated_to: "2026-03-01" }, testContext(fetch))).rejects.toThrow(/maximum is 7 days/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
