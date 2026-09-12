// Fixtures follow the documented GeoJSON FeatureCollection shape with
// features[0].properties.timeSeries[]; field names come from open-source clients
// of the site-specific API rather than a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import hourly from "./fixtures/hourly.json";
import daily from "./fixtures/daily.json";

const env = { MET_OFFICE_DATAHUB_API_KEY: "wdh-key" };

describe("met-office-datahub", () => {
  it("sends the key in the apikey header and builds the hourly URL", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(hourly), { status: 200 }));
    const result = await runOperation(definition, "hourly-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly");
    expect(u.searchParams.get("latitude")).toBe("51.501");
    expect(u.searchParams.get("includeLocationName")).toBe("true");
    expect(u.searchParams.has("apikey")).toBe(false);
    expect((init.headers as Record<string, string>).apikey).toBe("wdh-key");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ time: "2026-09-09T12:00Z", temp_c: 19.4, precip_prob_pct: 5, wind_speed_10m: 3.2, uv_index: 4 });
    expect(result.summary).toContain("Westminster");
    expect(result.summary).toContain("0.4 mm");
    expect(result.provenance).toMatchObject({ source: "met-office-datahub", basis: "modelled", version: "2026-09-09T06:00Z" });
  });

  it("maps the daily forecast", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(daily), { status: 200 }));
    const result = await runOperation(definition, "daily-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env));
    expect((fetch.mock.calls[0][0] as string).includes("/point/daily?")).toBe(true);
    expect(result.rows?.[0]).toMatchObject({ date: "2026-09-09", day_max_c: 21.3, night_min_c: 12.0, day_precip_prob_pct: 10, max_uv_index: 5 });
    expect(result.summary).toContain("21.3 °C");
    expect(result.summary).toContain("10.4 °C");
  });

  it("returns an empty result when no timeSeries comes back", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 }));
    const result = await runOperation(definition, "daily-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("throws on an auth failure with the upstream status", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"message\":\"Forbidden\"}", { status: 403 }));
    await expect(runOperation(definition, "hourly-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env))).rejects.toMatchObject({ status: 403 });
  });

  it("fails before the network when the key is missing or params are invalid", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "hourly-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, {}))).rejects.toThrow(/MET_OFFICE_DATAHUB_API_KEY/);
    await expect(runOperation(definition, "hourly-forecast", { latitude: "north", longitude: -0.142 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
