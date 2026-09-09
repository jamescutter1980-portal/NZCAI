// Fixtures follow the shapes documented by open-source GivEnergy clients (paginated
// {data, links, meta} envelope; period-keyed energy-flows object); not from a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition, normaliseFlows } from "..";
import { runOperation, testContext } from "../../testing";
import devices from "./fixtures/communication-devices.json";
import flows from "./fixtures/energy-flows.json";

const env = { GIVENERGY_API_TOKEN: "ge-token" };

describe("givenergy", () => {
  it("lists inverters with a Bearer token", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(devices), { status: 200 }));
    const result = await runOperation(definition, "inverters", {}, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.givenergy.cloud/v1/communication-device");
    expect(u.searchParams.get("page")).toBe("1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ge-token");
    expect(result.rows?.[0]).toMatchObject({ dongle_serial: "WF2345G678", inverter_serial: "CE2345G123", model: "Gen 2 Hybrid 5.0kW", status: "NORMAL", battery_count: 2, battery_kwh: 9.5 });
    expect(result.provenance).toMatchObject({ source: "givenergy", licence: "consent_based" });
  });

  it("posts the energy-flows body and normalises the period-keyed response", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(flows), { status: 200 }));
    const result = await runOperation(definition, "energy-flows", { serial: "CE2345G123", start_date: "2025-06-01", end_date: "2025-06-02", grouping: "daily" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.givenergy.cloud/v1/inverter/CE2345G123/energy-flows");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ start_time: "2025-06-01", end_time: "2025-06-02", grouping: 1, types: [0, 1, 2, 3, 4, 5, 6] });
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ start_time: "2025-06-01 00:00", pv_to_home_kwh: 6.4, battery_to_grid_kwh: 0.2, generation_kwh: 14.7, import_kwh: 3.5, export_kwh: 3.4, consumption_kwh: 13.2 });
    expect(result.summary).toContain("generation 24.7 kWh");
    expect(result.provenance.basis).toBe("measured");
  });

  it("normalises the per-type series shape too", () => {
    const rows = normaliseFlows([
      { type: 0, data: [{ timestamp: "2025-06-01T00:00:00Z", value: 1.5 }] },
      { type: 3, data: [{ timestamp: "2025-06-01T00:00:00Z", value: 0.5 }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pv_to_home_kwh: 1.5, grid_to_home_kwh: 0.5, pv_to_battery_kwh: null, consumption_kwh: 2, generation_kwh: 1.5 });
  });

  it("uses grouping 0 for half-hourly", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const result = await runOperation(definition, "energy-flows", { serial: "CE2345G123", start_date: "2025-06-01", end_date: "2025-06-02", grouping: "half_hourly" }, testContext(fetch, env));
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).grouping).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("maps the latest system snapshot", async () => {
    const body = { data: { time: "2026-09-09T11:58:02Z", solar: { power: 3210, arrays: [] }, grid: { voltage: 241.2, current: 4.1, power: -800, frequency: 49.98 }, battery: { percent: 87, power: 1500, temperature: 24.5 }, inverter: { temperature: 38 }, consumption: 910 } };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "latest-system-data", { serial: "CE2345G123" }, testContext(fetch, env));
    expect((fetch.mock.calls[0][0] as string).endsWith("/inverter/CE2345G123/system-data/latest")).toBe(true);
    expect(result.rows?.[0]).toMatchObject({ solar_power_w: 3210, battery_percent: 87, consumption_w: 910, grid_frequency_hz: 49.98 });
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "energy-flows", { serial: "CE2345G123", start_date: "2025-06-01", end_date: "2025-06-30", grouping: "half_hourly" }, testContext(fetch, env))).rejects.toThrow(/7 days/);
    await expect(runOperation(definition, "energy-flows", { serial: "CE2345G123", start_date: "2025-06-01", end_date: "2025-06-02" }, testContext(fetch, {}))).rejects.toThrow(/GIVENERGY_API_TOKEN/);
    await expect(runOperation(definition, "latest-system-data", {}, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on 401", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{\"message\":\"Unauthenticated.\"}", { status: 401 }));
    await expect(runOperation(definition, "inverters", {}, testContext(fetch, env))).rejects.toMatchObject({ status: 401 });
  });
});
