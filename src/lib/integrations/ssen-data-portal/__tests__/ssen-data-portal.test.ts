// Fixture shape follows the CKAN action API. The data-api.ssen.co.uk host and User-Agent filtering are from
// open-source clients and a 2026-08 probe recorded on GitHub, not from a live call here.
import { describe, expect, it, vi } from "vitest";
import { SSEN_USER_AGENT, definition } from "..";
import { runOperation, testContext } from "../../testing";
import packageSearch from "../../neso-data-portal/__tests__/fixtures/package-search.json";
import datastore from "../../neso-data-portal/__tests__/fixtures/datastore-search.json";

describe("ssen-data-portal", () => {
  it("calls the data-api host with a browser-style user agent", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(packageSearch), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { q: "headroom", rows: 3 }, testContext(fetch));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://data-api.ssen.co.uk/api/3/action/package_search?q=headroom&rows=3");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(SSEN_USER_AGENT);
    expect(result.warnings?.some((w) => w.includes("never a connection offer"))).toBe(true);
  });

  it("honours the base URL override", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(datastore), { status: 200 }));
    await runOperation(definition, "query_resource", { resource_id: "abc", limit: 10 }, testContext(fetch, { SSEN_DATA_PORTAL_BASE: "https://data.ssen.co.uk/api/3/action" }));
    expect(fetch.mock.calls[0][0]).toBe("https://data.ssen.co.uk/api/3/action/datastore_search?resource_id=abc&limit=10&offset=0");
  });

  it("reports a resource that is not in the datastore as empty", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ success: false, error: { message: "Not found" } }), { status: 404 }));
    const result = await runOperation(definition, "query_resource", { resource_id: "nope" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects a bad page size before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "query_resource", { resource_id: "abc", limit: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
