// Fixtures mirror the ONS Beta API observations documentation (dp-developer-site); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, parseVersionHref } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import observations from "./fixtures/observations.json";

const catalogue = {
  items: [
    { id: "cpih01", title: "Consumer Prices Index including owner occupiers' housing costs (CPIH)", description: "CPIH index", release_frequency: "Monthly", next_release: "16 September 2026", links: { latest_version: { href: "https://api.beta.ons.gov.uk/v1/datasets/cpih01/editions/time-series/versions/38", id: "38" } } },
    { id: "TS061", title: "Method used to travel to work", description: "Census 2021", type: "cantabular_flexible_table", links: { latest_version: { href: "https://api.beta.ons.gov.uk/v1/datasets/TS061/editions/2021/versions/3", id: "3" } } },
  ],
  count: 2,
  total_count: 2,
  limit: 100,
  offset: 0,
};

describe("ons-api", () => {
  it("lists and filters datasets, extracting edition and version from the latest_version link", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(catalogue), { status: 200 }));
    const result = await runOperation(definition, "datasets", { search: "travel" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.beta.ons.gov.uk/v1/datasets?limit=100&offset=0");
    expect(result.rows).toEqual([expect.objectContaining({ dataset_id: "TS061", latest_edition: "2021", latest_version: "3" })]);
    expect(parseVersionHref(undefined)).toEqual({});
  });

  it("builds the observations URL from dimension lines and maps values", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(observations), { status: 200 }));
    const result = await runOperation(definition, "observations", { dataset_id: "cpih01", edition: "time-series", version: "6", dimensions: "time=*\ngeography=K02000001\naggregate=cpih1dim1A0" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/datasets/cpih01/editions/time-series/versions/6/observations");
    expect(url.searchParams.get("time")).toBe("*");
    expect(url.searchParams.get("geography")).toBe("K02000001");
    expect(result.rows).toEqual([
      { value: 104.9, time: "Feb-18", time_id: "Feb-18" },
      { value: 105.1, time: "Mar-18", time_id: "Mar-18" },
    ]);
    expect(result.summary).toContain("Index: 2015=100");
    expect(result.provenance).toMatchObject({ source: "ons-api", basis: "measured", licence: "OGL" });
  });

  it("treats a 404 as an empty unavailable result", async () => {
    const fetch = routedFetch([{ match: "/datasets/nope", status: 404, body: { message: "not found" } }]);
    const result = await runOperation(definition, "dataset", { dataset_id: "nope" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects two wildcards or no dimensions before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "observations", { dataset_id: "cpih01", edition: "time-series", version: "6", dimensions: "time=*\ngeography=*" }, testContext(fetch))).rejects.toThrow(/Only one/);
    await expect(runOperation(definition, "observations", { dataset_id: "cpih01", edition: "time-series", version: "6", dimensions: "nonsense" }, testContext(fetch))).rejects.toThrow(/At least one/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
