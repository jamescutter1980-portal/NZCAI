// Fixtures mirror the response shape documented in the Open-Meteo OpenAPI specs
// (openapi/forecast.yml and openapi/historical-weather.yml); no live call was made.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import archiveDaily from "./fixtures/archive-daily.json";
import forecastDaily from "./fixtures/forecast-daily.json";

describe("open-meteo", () => {
  it("fetches daily history from the free archive host and computes degree days", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(archiveDaily), { status: 200 }));
    const result = await runOperation(definition, "daily-history", { latitude: 51.5, longitude: -0.12, start_date: "2025-01-01", end_date: "2025-01-03" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.host).toBe("archive-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/archive");
    expect(url.searchParams.get("daily")).toContain("temperature_2m_mean");
    expect(url.searchParams.get("timezone")).toBe("Europe/London");
    expect(url.searchParams.has("apikey")).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ date: "2025-01-01", temp_mean_c: 5.5, hdd: 10, cdd: 0 });
    expect(result.rows?.[1]).toMatchObject({ hdd: 5, cdd: 0 });
    expect(result.rows?.[2]).toMatchObject({ hdd: null, cdd: null });
    expect(result.summary).toContain("15 heating degree days");
    expect(result.summary).toContain("base 15.5");
    expect(result.provenance).toMatchObject({ source: "open-meteo", basis: "modelled" });
    expect(result.warnings?.join(" ")).toContain("1 day(s) had no mean temperature");
  });

  it("honours custom base temperatures", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(archiveDaily), { status: 200 }));
    const result = await runOperation(definition, "daily-history", { latitude: 51.5, longitude: -0.12, start_date: "2025-01-01", end_date: "2025-01-03", hdd_base: 18, cdd_base: 8 }, testContext(fetch));
    expect(result.rows?.[0]).toMatchObject({ hdd: 12.5, cdd: 0 });
    expect(result.rows?.[1]).toMatchObject({ hdd: 7.5, cdd: 2.5 });
  });

  it("switches to the customer hosts and adds apikey when a key is set", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(forecastDaily), { status: 200 }));
    await runOperation(definition, "forecast", { latitude: 51.5, longitude: -0.12 }, testContext(fetch, { OPEN_METEO_API_KEY: "abc123" }));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.host).toBe("customer-api.open-meteo.com");
    expect(url.searchParams.get("apikey")).toBe("abc123");
    expect(url.searchParams.get("forecast_days")).toBe("7");
  });

  it("maps the daily forecast rows", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(forecastDaily), { status: 200 }));
    const result = await runOperation(definition, "forecast", { latitude: 51.5, longitude: -0.12, days: 2 }, testContext(fetch));
    expect(result.rows).toEqual([
      { date: "2026-09-09", temp_max_c: 21.4, temp_min_c: 12.1, temp_mean_c: 16.7, precipitation_mm: 0.3 },
      { date: "2026-09-10", temp_max_c: 19.8, temp_min_c: 11.6, temp_mean_c: 15.5, precipitation_mm: 2.1 },
    ]);
    expect(result.summary).toContain("21.4 °C");
    expect(result.provenance.basis).toBe("modelled");
  });

  it("returns an empty result when the archive has no days", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...archiveDaily, daily: { time: [] } }), { status: 200 }));
    const result = await runOperation(definition, "daily-history", { latitude: 51.5, longitude: -0.12, start_date: "2025-01-01", end_date: "2025-01-03" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects a reversed or over-long range before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "daily-history", { latitude: 51.5, longitude: -0.12, start_date: "2025-02-01", end_date: "2025-01-01" }, testContext(fetch))).rejects.toThrow(/after/);
    await expect(runOperation(definition, "hourly-history", { latitude: 51.5, longitude: -0.12, start_date: "2025-01-01", end_date: "2025-03-01" }, testContext(fetch))).rejects.toThrow(/limited/);
    await expect(runOperation(definition, "forecast", { latitude: 95, longitude: -0.12 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps hourly history rows with the unit-labelled wind column", async () => {
    const body = { ...forecastDaily, daily: undefined, daily_units: undefined };
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "hourly-history", { latitude: 51.5, longitude: -0.12, start_date: "2026-09-09", end_date: "2026-09-09" }, testContext(fetch));
    expect(result.columns).toContain("wind_speed_kmh");
    expect(result.rows?.[0]).toMatchObject({ time: "2026-09-09T00:00", temp_c: 14.2, wind_speed_kmh: 9.4 });
  });
});
