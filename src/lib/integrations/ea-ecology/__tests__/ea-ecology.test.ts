// Fixtures are illustrative: the Ecology and Fish Data API response shape could
// not be confirmed from documentation reachable in this environment, so the
// connector matches field names loosely and this test exercises that matching.
import { describe, expect, it, vi } from "vitest";
import { definition, listOf } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import sites from "./fixtures/sites.json";
import surveys from "./fixtures/surveys.json";

describe("ea-ecology", () => {
  it("queries sites near a point and sorts by distance", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(sites), { status: 200 }));
    const result = await runOperation(definition, "sites", { latitude: 51.414, longitude: -0.186, radius: 5 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/ecology/api/v1/sites");
    expect(url.searchParams.get("lat")).toBe("51.414");
    expect(url.searchParams.get("lon")).toBe("-0.186");
    expect(url.searchParams.get("radius")).toBe("5");
    expect(result.rows?.[0]).toMatchObject({ site_id: "43378", site_name: "RIVER WANDLE AT MERTON ABBEY", survey_type: "Macroinvertebrate", water_body: "Wandle", easting: 526200 });
    expect(result.rows?.[0].distance_km).toBeLessThan(0.2);
    expect(result.rows?.[1].site_id).toBe("12001");
  });

  it("lists surveys newest first", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(surveys), { status: 200 }));
    const result = await runOperation(definition, "surveys", { siteId: "43378" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("site_id")).toBe("43378");
    expect(result.rows?.[0]).toMatchObject({ survey_id: "BIO-2025-0001", survey_date: "2025-05-14", survey_method: "3-minute kick sample", observations: 34 });
    expect(result.summary).toContain("2 surveys");
  });

  it("handles empty and 404 responses, and validates before the network", async () => {
    const empty = await runOperation(definition, "sites", { latitude: 55, longitude: -3 }, testContext(routedFetch([{ match: "/sites", body: { data: [] } }])));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    const nf = await runOperation(definition, "surveys", { siteId: "x" }, testContext(routedFetch([{ match: "/surveys", status: 404, body: { message: "not found" } }])));
    expect(nf.rows).toEqual([]);
    const fetch = vi.fn();
    await expect(runOperation(definition, "sites", { latitude: 51, longitude: -200 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(listOf({ results: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
});
