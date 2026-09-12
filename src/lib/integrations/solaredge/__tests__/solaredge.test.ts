// Fixtures follow the response envelopes in the SolarEdge Monitoring API guide
// (sites.site[], energy.values[], energyDetails.meters[], overview); not from a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import sitesList from "./fixtures/sites-list.json";
import energyDetails from "./fixtures/energy-details.json";

const env = { SOLAREDGE_API_KEY: "se-key" };

describe("solaredge", () => {
  it("lists sites with api_key in the query", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(sitesList), { status: 200 }));
    const result = await runOperation(definition, "sites", {}, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://monitoringapi.solaredge.com/sites/list");
    expect(u.searchParams.get("api_key")).toBe("se-key");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ site_id: 1234567, name: "Unit 4 Warehouse", peak_power_kwp: 49.5, postcode: "RG2 0AA" });
    expect(result.summary).toContain("61.5 kWp");
    expect(result.provenance).toMatchObject({ source: "solaredge", licence: "consent_based" });
  });

  it("converts daily energy from Wh to kWh and flags gaps", async () => {
    const body = { energy: { timeUnit: "DAY", unit: "Wh", values: [{ date: "2025-01-01 00:00:00", value: 12500 }, { date: "2025-01-02 00:00:00", value: null }] } };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "daily-energy", { site_id: 1234567, start_date: "2025-01-01", end_date: "2025-01-02" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.pathname).toBe("/site/1234567/energy");
    expect(u.searchParams.get("timeUnit")).toBe("DAY");
    expect(u.searchParams.get("startDate")).toBe("2025-01-01");
    expect(result.rows).toEqual([{ date: "2025-01-01", energy_kwh: 12.5 }, { date: "2025-01-02", energy_kwh: null }]);
    expect(result.summary).toContain("1 day(s) without a reading");
    expect(result.provenance.basis).toBe("measured");
  });

  it("pivots energy details into one row per interval", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(energyDetails), { status: 200 }));
    const result = await runOperation(definition, "energy-details", { site_id: 1234567, start_date: "2025-06-01", end_date: "2025-06-02", time_unit: "DAY" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.pathname).toBe("/site/1234567/energyDetails");
    expect(u.searchParams.get("meters")).toBe("PRODUCTION,CONSUMPTION,FEEDIN,PURCHASED");
    expect(u.searchParams.get("startTime")).toBe("2025-06-01 00:00:00");
    expect(u.searchParams.get("endTime")).toBe("2025-06-02 23:59:59");
    expect(result.rows).toEqual([
      { time: "2025-06-01 00:00:00", production_kwh: 210.5, consumption_kwh: 300, export_kwh: 50, import_kwh: 139.5 },
      { time: "2025-06-02 00:00:00", production_kwh: 180.25, consumption_kwh: 290, export_kwh: null, import_kwh: 150 },
    ]);
    expect(result.summary).toContain("production 391 kWh");
    expect(result.warnings).toBeUndefined();
  });

  it("maps the overview", async () => {
    const body = { overview: { lastUpdateTime: "2026-09-08 17:02:11", lifeTimeData: { energy: 152340000 }, lastYearData: { energy: 41000000 }, lastMonthData: { energy: 5200000 }, lastDayData: { energy: 210000 }, currentPower: { power: 4321.5 }, measuredBy: "INVERTER" } };
    const fetch = routedFetch([{ match: "/site/1234567/overview", body }]);
    const result = await runOperation(definition, "site-overview", { site_id: 1234567 }, testContext(fetch, env));
    expect(result.rows?.[0]).toMatchObject({ lifetime_kwh: 152340, last_month_kwh: 5200, current_power_kw: 4.322 });
  });

  it("returns an empty result for a site with no values", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ energyDetails: { timeUnit: "DAY", unit: "Wh", meters: [] } }), { status: 200 }));
    const result = await runOperation(definition, "energy-details", { site_id: 1, start_date: "2025-06-01", end_date: "2025-06-02" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("enforces the one-month limit for sub-daily detail before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "energy-details", { site_id: 1, start_date: "2025-01-01", end_date: "2025-03-01", time_unit: "QUARTER_OF_AN_HOUR" }, testContext(fetch, env))).rejects.toThrow(/31 days/);
    await expect(runOperation(definition, "daily-energy", { site_id: 1, start_date: "2024-01-01", end_date: "2025-06-01" }, testContext(fetch, env))).rejects.toThrow(/366 days/);
    await expect(runOperation(definition, "site-overview", { site_id: "abc" }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "sites", {}, testContext(fetch, {}))).rejects.toThrow(/SOLAREDGE_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on 403 from the API", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"String\":\"Invalid token\"}", { status: 403 }));
    await expect(runOperation(definition, "sites", {}, testContext(fetch, env))).rejects.toMatchObject({ status: 403 });
  });
});
