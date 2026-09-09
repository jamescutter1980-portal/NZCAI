// Fixture follows the BuildingInsights schema from Google's REST reference and the
// TypeScript types in googlemaps-samples/js-solar-potential; values are illustrative.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import insights from "./fixtures/building-insights.json";

const env = { GOOGLE_MAPS_API_KEY: "g-key" };

describe("google-solar", () => {
  it("puts the key in the query string and maps segments and configs", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(insights), { status: 200 }));
    const result = await runOperation(definition, "building-insights", { latitude: 51.5007, longitude: -0.1246, required_quality: "MEDIUM", max_configs: 2 }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://solar.googleapis.com/v1/buildingInsights:findClosest");
    expect(u.searchParams.get("location.latitude")).toBe("51.5007");
    expect(u.searchParams.get("location.longitude")).toBe("-0.1246");
    expect(u.searchParams.get("requiredQuality")).toBe("MEDIUM");
    expect(u.searchParams.get("key")).toBe("g-key");
    expect(result.rows).toHaveLength(4);
    expect(result.rows?.[0]).toEqual({ row_type: "segment", index: 0, pitch_deg: 32.1, azimuth_deg: 181.5, area_m2: 140.3, sunshine_median_h_yr: 1050, panels_count: null, yearly_energy_dc_kwh: null });
    expect(result.rows?.[2]).toMatchObject({ row_type: "config", panels_count: 4, yearly_energy_dc_kwh: 1610 });
    expect(result.summary).toContain("SW1A 0AA");
    expect(result.summary).toContain("120 panels (48 kWp");
    expect(result.summary).toContain("38451 kWh DC/yr");
    expect(result.provenance).toMatchObject({ source: "google-solar", basis: "modelled", version: "2023-06-14" });
    expect(result.warnings?.some((w) => w.includes("429 kg CO2/MWh"))).toBe(true);
  });

  it("treats NOT_FOUND as an empty result", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }), { status: 404 }));
    const result = await runOperation(definition, "building-insights", { latitude: 57.2, longitude: -4.5 }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toContain("Requested entity was not found");
  });

  it("throws on a 403 (bad or missing key on the server side)", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: { code: 403, message: "The request is missing a valid API key.", status: "PERMISSION_DENIED" } }), { status: 403 }));
    await expect(runOperation(definition, "building-insights", { latitude: 51.5, longitude: -0.12 }, testContext(fetch, env))).rejects.toMatchObject({ status: 403 });
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "building-insights", { latitude: 51.5, longitude: -0.12 }, testContext(fetch, {}))).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
    await expect(runOperation(definition, "building-insights", { latitude: 51.5, longitude: -0.12, required_quality: "ULTRA" }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("health check reports the upstream status without a key", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"error\":{\"code\":403}}", { status: 403 }));
    const health = await definition.healthCheck!(testContext(fetch, {}));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("403 expected");
  });
});
