// Fixture shape follows the CKAN action API; the raw-key Authorization header follows open-source NGED clients.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import packageSearch from "../../neso-data-portal/__tests__/fixtures/package-search.json";

describe("nged-connected-data", () => {
  it("sends the API key as the bare Authorization header when configured", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(packageSearch), { status: 200 }));
    await runOperation(definition, "search_datasets", { q: "capacity" }, testContext(fetch, { NGED_API_KEY: "abc123" }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connecteddata.nationalgrid.co.uk/api/3/action/package_search?q=capacity&rows=10");
    expect((init.headers as Record<string, string>).Authorization).toBe("abc123");
  });

  it("works without a key and carries the access warning", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(packageSearch), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { q: "capacity" }, testContext(fetch));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result.rows?.length).toBeGreaterThan(0);
    expect(result.warnings?.some((w) => w.includes("NGED_API_KEY"))).toBe(true);
  });

  it("returns an empty result for no matches", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ success: true, result: { count: 0, results: [] } }), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { q: "zzz" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates required params before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "dataset_resources", {}, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
