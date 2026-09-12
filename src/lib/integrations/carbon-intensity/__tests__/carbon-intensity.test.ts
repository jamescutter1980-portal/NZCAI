// Fixtures mirror the documented response shapes at https://carbon-intensity.github.io/api-definitions/
// and the batpred/open-source client captures; they were not taken from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, halfHourlyIntensitySeries } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import intensityNow from "./fixtures/intensity-now.json";
import intensityRange from "./fixtures/intensity-range.json";
import regionalPostcode from "./fixtures/regional-postcode.json";
import regionalFw48h from "./fixtures/regional-fw48h.json";
import generation from "./fixtures/generation.json";

describe("carbon-intensity", () => {
  it("returns the current national intensity with a measured basis when actual is present", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(intensityNow), { status: 200 }));
    const result = await runOperation(definition, "national_now", {}, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.carbonintensity.org.uk/intensity");
    expect(result.rows?.[0]).toMatchObject({ actual_gco2_kwh: 141, forecast_gco2_kwh: 148, index: "moderate" });
    expect(result.provenance).toMatchObject({ source: "carbon-intensity", basis: "measured" });
    expect(result.summary).toContain("141 gCO2/kWh");
  });

  it("chunks a history request into 14-day windows and flags missing actuals", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(intensityRange), { status: 200 });
    });
    const result = await runOperation(definition, "national_history", { from: "2026-08-01", to: "2026-08-31" }, testContext(fetch));
    expect(calls).toEqual([
      "https://api.carbonintensity.org.uk/intensity/2026-08-01T00%3A00Z/2026-08-14T23%3A59Z",
      "https://api.carbonintensity.org.uk/intensity/2026-08-15T00%3A00Z/2026-08-28T23%3A59Z",
      "https://api.carbonintensity.org.uk/intensity/2026-08-29T00%3A00Z/2026-08-31T23%3A59Z",
    ]);
    expect(result.rows).toHaveLength(9);
    expect(result.warnings?.some((w) => w.includes("no outturn yet"))).toBe(true);
  });

  it("rejects a range over 31 days before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "national_history", { from: "2026-01-01", to: "2026-03-01" }, testContext(fetch))).rejects.toThrow(/maximum is 31 days/);
    await expect(runOperation(definition, "national_history", { from: "2026-01-01", to: "bad" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only the outward code for a regional lookup and flattens the generation mix", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(regionalPostcode), { status: 200 }));
    const result = await runOperation(definition, "regional_now", { postcode: "bs16 1qy" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.carbonintensity.org.uk/regional/postcode/BS16");
    expect(result.rows?.[0]).toMatchObject({ region: "South West England", forecast_gco2_kwh: 162, wind_pct: 21.3, gas_pct: 32.9, solar_pct: 0 });
    expect(result.provenance.basis).toBe("modelled");
  });

  it("builds the fw48h URL from the fixed clock and handles the bare-object regional shape", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(regionalFw48h), { status: 200 }));
    const result = await runOperation(definition, "regional_forecast_48h", { postcode: "BS16 1QY" }, testContext(fetch, {}, new Date("2026-09-09T12:17:00Z")));
    expect(fetch.mock.calls[0][0]).toBe("https://api.carbonintensity.org.uk/regional/intensity/2026-09-09T12%3A00Z/fw48h/postcode/BS16");
    expect(result.rows).toHaveLength(2);
    expect(result.summary).toContain("90 gCO2/kWh (lowest");
  });

  it("returns an empty regional result without throwing", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await runOperation(definition, "regional_now", { postcode: "ZZ1 1ZZ" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("summarises the generation mix with renewable and low-carbon shares", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(generation), { status: 200 }));
    const result = await runOperation(definition, "generation_mix_now", {}, testContext(fetch));
    expect(result.rows).toHaveLength(9);
    expect(result.summary).toContain("42.1% renewable");
    expect(result.summary).toContain("56.5% low carbon");
  });

  it("exposes a half-hourly series helper that joins to meter data", async () => {
    const fetch = routedFetch([
      { match: "/regional/intensity/", body: regionalFw48h },
      { match: "/intensity/", body: intensityRange },
    ]);
    const national = await halfHourlyIntensitySeries(testContext(fetch), "2026-09-01", "2026-09-01");
    expect(national[0]).toEqual({ from: "2026-09-01T00:00Z", to: "2026-09-01T00:30Z", gco2_per_kwh: 118, basis: "measured" });
    expect(national[2]).toMatchObject({ gco2_per_kwh: 130, basis: "modelled" });
    const regional = await halfHourlyIntensitySeries(testContext(fetch), "2026-09-09", "2026-09-09", "BS16 1QY");
    expect(regional[1]).toMatchObject({ gco2_per_kwh: 90, basis: "modelled", region: "South West England" });
  });
});
