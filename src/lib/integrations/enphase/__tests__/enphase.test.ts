// Fixtures follow the v4 response shapes seen in open-source Enphase clients
// (systems list envelope, energy_lifetime daily Wh array); not from a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import systems from "./fixtures/systems.json";
import lifetime from "./fixtures/energy-lifetime.json";

const env = { ENPHASE_API_KEY: "en-key", ENPHASE_ACCESS_TOKEN: "en-token" };

describe("enphase", () => {
  it("sends key as a query param and the token as a Bearer header", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(systems), { status: 200 }));
    const result = await runOperation(definition, "systems", {}, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.enphaseenergy.com/api/v4/systems");
    expect(u.searchParams.get("key")).toBe("en-key");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer en-token");
    expect(result.rows?.[0]).toMatchObject({ system_id: 2345678, name: "Depot roof", status: "normal", size_kw: 24.5, postcode: "LS1 4AP", last_report_at: "2025-09-09T08:00:00.000Z" });
    expect(result.summary).toContain("1 system(s)");
  });

  it("maps daily production from the energy_lifetime Wh array", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(lifetime), { status: 200 }));
    const result = await runOperation(definition, "daily-production", { system_id: 2345678, start_date: "2025-06-01", end_date: "2025-06-03" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.pathname).toBe("/api/v4/systems/2345678/energy_lifetime");
    expect(u.searchParams.get("start_date")).toBe("2025-06-01");
    expect(u.searchParams.get("end_date")).toBe("2025-06-03");
    expect(result.rows).toEqual([
      { date: "2025-06-01", production_kwh: 98.5 },
      { date: "2025-06-02", production_kwh: null },
      { date: "2025-06-03", production_kwh: 102.3 },
    ]);
    expect(result.summary).toContain("201 kWh over 3 days");
    expect(result.summary).toContain("1 day(s) with no data");
    expect(result.provenance).toMatchObject({ source: "enphase", basis: "measured", licence: "consent_based" });
  });

  it("maps the summary", async () => {
    const body = { system_id: 2345678, current_power: 8120, energy_today: 41200, energy_lifetime: 61234000, summary_date: "2026-09-09", source: "microinverters", status: "normal", last_report_at: 1757404800, modules: 60, size_w: 24500 };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "system-summary", { system_id: 2345678 }, testContext(fetch, env));
    expect(result.rows?.[0]).toMatchObject({ current_power_kw: 8.12, energy_today_kwh: 41.2, energy_lifetime_kwh: 61234, modules: 60, size_kw: 24.5 });
  });

  it("maps production intervals", async () => {
    const body = { system_id: 2345678, granularity: "day", total_devices: 60, start_at: 1750464000, end_at: 1750550400, intervals: [{ end_at: 1750464900, devices_reporting: 60, powr: 0, enwh: 0 }, { end_at: 1750465800, devices_reporting: 60, powr: 4000, enwh: 1000 }] };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "production-intervals", { system_id: 2345678, date: "2025-06-21" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.searchParams.get("start_at")).toBe("1750464000");
    expect(u.searchParams.get("granularity")).toBe("day");
    expect(result.rows?.[1]).toMatchObject({ power_w: 4000, energy_wh: 1000 });
    expect(result.summary).toContain("1 kWh, peak 4000 W");
  });

  it("returns an empty result when no production values are returned", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ...lifetime, production: [] }), { status: 200 }));
    const result = await runOperation(definition, "daily-production", { system_id: 2345678, start_date: "2025-06-01", end_date: "2025-06-03" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "systems", {}, testContext(fetch, { ENPHASE_API_KEY: "k" }))).rejects.toThrow(/ENPHASE_ACCESS_TOKEN/);
    await expect(runOperation(definition, "daily-production", { system_id: 1, start_date: "2024-01-01", end_date: "2025-06-01" }, testContext(fetch, env))).rejects.toThrow(/366/);
    await expect(runOperation(definition, "production-intervals", { system_id: 1, date: "June 2025" }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on 401 so the UI can prompt for a token refresh", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"error\":\"invalid_token\"}", { status: 401 }));
    await expect(runOperation(definition, "systems", {}, testContext(fetch, env))).rejects.toMatchObject({ status: 401 });
  });
});
