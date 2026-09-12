// Fixtures follow the CKAN 2.x action API shapes (package_search, package_show, datastore_search) as documented at
// docs.ckan.org and NESO's API guidance; not captured from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import packageSearch from "./fixtures/package-search.json";
import datastore from "./fixtures/datastore-search.json";

describe("neso-data-portal", () => {
  it("searches datasets and flattens to one row per resource", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(packageSearch), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { q: "demand", rows: 5 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.neso.energy/api/3/action/package_search?q=demand&rows=5");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ dataset_id: "historic-demand-data", resource_id: "f6d02c0f-957b-48cb-82ee-09003f2ba759", datastore: true, format: "CSV" });
    expect(result.summary).toContain("2 datasets");
    expect(result.provenance).toMatchObject({ source: "neso-data-portal", basis: "measured", licence: "OGL" });
  });

  it("queries a datastore resource and hides CKAN internal columns", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(datastore), { status: 200 }));
    const result = await runOperation(definition, "query_resource", { resource_id: "bb44a1b5-75b1-4db2-8491-257f23385006", limit: 2, q: "" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.neso.energy/api/3/action/datastore_search?resource_id=bb44a1b5-75b1-4db2-8491-257f23385006&limit=2&offset=0");
    expect(result.columns).toEqual(["SETTLEMENT_DATE", "SETTLEMENT_PERIOD", "ND"]);
    expect(result.rows?.[1]).toEqual({ SETTLEMENT_DATE: "2025-01-01", SETTLEMENT_PERIOD: 2, ND: 21000 });
    expect(result.summary).toContain("2 of 17520 rows");
  });

  it("treats a missing dataset as an empty result", async () => {
    const fetch = routedFetch([{ match: "package_show", status: 404, body: { success: false, error: { __type: "Not Found Error" } } }]);
    const result = await runOperation(definition, "dataset_resources", { dataset_id: "does-not-exist" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("offers a curated dataset select that reuses package_show", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ success: true, result: packageSearch.result.results[0] }), { status: 200 }));
    const result = await runOperation(definition, "known_dataset", { dataset: "historic-demand-data" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.neso.energy/api/3/action/package_show?id=historic-demand-data");
    expect(result.rows).toHaveLength(2);
    expect(result.links).toHaveLength(2);
  });

  it("rejects an unknown curated dataset and an over-large page before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "known_dataset", { dataset: "made-up" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "query_resource", { resource_id: "x", limit: 5000 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
