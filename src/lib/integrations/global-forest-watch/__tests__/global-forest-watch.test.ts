// Fixtures follow the wri/gfw-data-api Dataset pydantic model (data[]: dataset, is_downloadable, metadata, versions); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";

const env = { GFW_API_KEY: "gfw-key" };
const catalogue = {
  data: [
    { dataset: "umd_tree_cover_loss", is_downloadable: true, metadata: { title: "Tree cover loss", license: "CC BY 4.0", source: "UMD/GLAD", geographic_coverage: "Global", resolution: "30 m", update_frequency: "Annual" }, versions: ["v1.10", "v1.11", "v1.9"] },
    { dataset: "gadm_administrative_boundaries", is_downloadable: false, metadata: { title: "GADM administrative boundaries", license: "GADM" }, versions: ["v4.1"] },
  ],
  status: "success",
  links: { next: "" },
  meta: { total_items: 2 },
};

describe("global-forest-watch", () => {
  it("lists datasets with the x-api-key header and filters by search text", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(catalogue), { status: 200 }));
    const result = await runOperation(definition, "datasets", { search: "tree cover" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(url)).toBe("https://data-api.globalforestwatch.org/datasets?page[size]=100&page[number]=1");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("gfw-key");
    expect(result.rows).toEqual([expect.objectContaining({ dataset: "umd_tree_cover_loss", latest_version: "v1.9", versions: 3, licence: "CC BY 4.0" })]);
    expect(result.provenance).toMatchObject({ source: "global-forest-watch", basis: "measured" });
  });

  it("returns dataset detail and treats 404 as unavailable", async () => {
    const fetch = routedFetch([
      { match: "/dataset/umd_tree_cover_loss", body: { data: catalogue.data[0] } },
      { match: "/dataset/nope", status: 404, body: { status: "failed", message: "Dataset not found" } },
    ]);
    const hit = await runOperation(definition, "dataset", { dataset: "umd_tree_cover_loss" }, testContext(fetch, env));
    expect(hit.rows?.[0]).toMatchObject({ title: "Tree cover loss", downloadable: true });
    const miss = await runOperation(definition, "dataset", { dataset: "nope" }, testContext(fetch, env));
    expect(miss.rows).toEqual([]);
    expect(miss.provenance.basis).toBe("unavailable");
  });

  it("fails before the network without a key", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "datasets", {}, testContext(fetch, {}))).rejects.toThrow(/GFW_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
