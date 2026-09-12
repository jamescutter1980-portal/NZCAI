// Fixtures follow the {"forecasts": [{period_end, period, ...}]} shape shown in the
// official Python SDK documentation; not produced by a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import radiation from "./fixtures/radiation-forecast.json";
import rooftop from "./fixtures/rooftop-forecast.json";

const env = { SOLCAST_API_KEY: "sc-key" };

describe("solcast", () => {
  it("sends a Bearer token and builds the radiation forecast URL", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(radiation), { status: 200 }));
    const result = await runOperation(definition, "irradiance-forecast", { latitude: 51.501, longitude: -0.142, hours: 2 }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.solcast.com.au/data/forecast/radiation_and_weather");
    expect(u.searchParams.get("output_parameters")).toBe("ghi,dni,dhi,air_temp");
    expect(u.searchParams.get("hours")).toBe("2");
    expect(u.searchParams.get("period")).toBe("PT30M");
    expect(u.searchParams.get("format")).toBe("json");
    expect(u.searchParams.has("api_key")).toBe(false);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sc-key");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[2]).toEqual({ period_end: "2026-09-09T06:30:00.0000000Z", ghi_w_m2: 480, dni_w_m2: 700, dhi_w_m2: 110, air_temp_c: 17 });
    expect(result.summary).toContain("0.3 kWh/m²");
    expect(result.summary).toContain("peak GHI 480");
    expect(result.provenance).toMatchObject({ source: "solcast", basis: "modelled", licence: "commercial" });
  });

  it("builds the rooftop PV forecast and totals the energy", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(rooftop), { status: 200 }));
    const result = await runOperation(definition, "rooftop-pv-forecast", { latitude: 51.501, longitude: -0.142, capacity_kw: 10, tilt_deg: 30, azimuth_deg: 180 }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.pathname).toBe("/data/forecast/rooftop_pv_power");
    expect(u.searchParams.get("capacity")).toBe("10");
    expect(u.searchParams.get("tilt")).toBe("30");
    expect(u.searchParams.get("azimuth")).toBe("180");
    expect(u.searchParams.get("loss_factor")).toBe("0.9");
    expect(result.rows?.[2]).toEqual({ period_end: "2026-09-09T06:30:00.0000000Z", pv_power_kw: 4.8 });
    expect(result.summary).toContain("3 kWh");
    expect(result.summary).toContain("4.8 kW");
  });

  it("reads estimated actuals from the live endpoint", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ estimated_actuals: radiation.forecasts }), { status: 200 }));
    const result = await runOperation(definition, "live-irradiance", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env));
    expect((fetch.mock.calls[0][0] as string).includes("/data/live/radiation_and_weather?")).toBe(true);
    expect(result.rows).toHaveLength(3);
  });

  it("returns an empty result when no forecasts come back", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ forecasts: [] }), { status: 200 }));
    const result = await runOperation(definition, "irradiance-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("surfaces quota and auth failures as HTTP errors", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"response_status\":{\"message\":\"Too many requests\"}}", { status: 429 }));
    await expect(runOperation(definition, "irradiance-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env))).rejects.toMatchObject({ status: 429 });
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "rooftop-pv-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "irradiance-forecast", { latitude: 51.501, longitude: -0.142, hours: 500 }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "irradiance-forecast", { latitude: 51.501, longitude: -0.142 }, testContext(fetch, {}))).rejects.toThrow(/SOLCAST_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
