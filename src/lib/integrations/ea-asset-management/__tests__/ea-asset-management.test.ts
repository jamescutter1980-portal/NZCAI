// Fixture items were taken from a recorded response of /asset-management/id/asset.json
// (public test cassette); the spatial filter parameters follow the platform convention.
import { describe, expect, it, vi } from "vitest";
import { conditionVsTarget, definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import assets from "./fixtures/assets.json";

describe("ea-asset-management", () => {
  it("queries assets near a point and maps condition fields", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(assets), { status: 200 }));
    const result = await runOperation(definition, "assets-near", { latitude: 51.44, longitude: -2.56, dist: 1 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/asset-management/id/asset.json");
    expect(url.searchParams.get("lat")).toBe("51.44");
    expect(url.searchParams.get("dist")).toBe("1");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ asset_id: "224221", asset_type: "Structure", asset_sub_type: "Debris Screen", primary_purpose: "flood risk management", protection_type: "fluvial", target_condition: "Fair", actual_condition: "Good", condition_vs_target: "meets target", last_inspection_date: "2024-08-09", watercourse: "Brislington Brook", ea_area: "Wessex", maintenance_tasks: "maintain-structures" });
    expect(result.rows?.[1]).toMatchObject({ asset_type: "Defence", asset_length_m: 365.78, bank: "left", condition_vs_target: "below target" });
    expect(result.summary).toContain("1 below their target condition");
    expect(result.provenance).toMatchObject({ basis: "measured", licence: "OGL" });
  });

  it("returns unavailable when nothing is nearby", async () => {
    const result = await runOperation(definition, "assets-near", { latitude: 54, longitude: -1 }, testContext(routedFetch([{ match: "asset.json", body: { meta: {}, items: [] } }])));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates input before the network and compares grades", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "assets-near", { latitude: "abc", longitude: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(conditionVsTarget("Very Poor", "Fair")).toBe("below target");
    expect(conditionVsTarget("Unknown", "Fair")).toBeNull();
  });
});
