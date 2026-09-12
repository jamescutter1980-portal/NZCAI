// Fixtures follow the Opendatasoft Explore API v2.1 catalog and records shapes; not captured live.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import catalog from "./fixtures/catalog.json";
import records from "./fixtures/records.json";

describe("dno-open-data", () => {
  it("searches the chosen operator's catalogue with an ODSQL text literal", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { operator: "npg", search: "headroom", limit: 5 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://northernpowergrid.opendatasoft.com/api/explore/v2.1/catalog/datasets?where=%22headroom%22&limit=5&order_by=-modified");
    expect(result.rows?.[0]).toMatchObject({ dataset_id: "dfes-network-headroom-report", records: 512, licence: "Open Government Licence v3.0", description: "Indicative headroom by primary substation." });
    expect(result.links?.[0].url).toBe("https://northernpowergrid.opendatasoft.com/explore/dataset/dfes-network-headroom-report/");
  });

  it("sends the Apikey header when configured and searches capacity terms", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const result = await runOperation(definition, "capacity_datasets", { operator: "ukpn" }, testContext(fetch, { DNO_OPENDATASOFT_API_KEY: "k1" }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("ukpowernetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets?where=%22capacity%22+OR+%22headroom%22");
    expect((init.headers as Record<string, string>).Authorization).toBe("Apikey k1");
    expect(result.warnings?.some((w) => w.includes("never a connection offer"))).toBe(true);
  });

  it("fetches records with where/select and stringifies nested values", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(records), { status: 200 }));
    const result = await runOperation(definition, "dataset_records", { operator: "ukpn", dataset_id: "dfes-network-headroom-report", where: "headroom_mva > 1", select: "substation, headroom_mva", limit: 50 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://ukpowernetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/dfes-network-headroom-report/records?where=headroom_mva+%3E+1&select=substation%2C+headroom_mva&limit=50&offset=0");
    expect(result.rows?.[0]).toMatchObject({ substation: "Bermondsey", headroom_mva: 12.5, geo_point_2d: '{"lat":51.5,"lon":-0.08}' });
    expect(result.provenance).toMatchObject({ source: "dno-open-data", basis: "measured" });
  });

  it("reports an unknown dataset as unavailable rather than throwing", async () => {
    const fetch = routedFetch([{ match: "/records", status: 404, body: { error_code: "ODSQLError", message: "Unknown dataset" } }]);
    const result = await runOperation(definition, "dataset_records", { operator: "enwl", dataset_id: "nope" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects an unknown operator or over-large page before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "search_datasets", { operator: "wpd" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "dataset_records", { operator: "spen", dataset_id: "x", limit: 500 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
