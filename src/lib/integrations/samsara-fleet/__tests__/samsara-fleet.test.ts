// Fixture mirrors the Samsara OpenAPI schema for GET /fleet/reports/vehicles/fuel-energy; not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import fuelEnergy from "./fixtures/fuel-energy.json";

const env = { SAMSARA_API_TOKEN: "samsara-token" };

describe("samsara-fleet", () => {
  it("lists vehicles with a Bearer token", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: [{ id: "1", name: "Van 12", licensePlate: "AB12 CDE", make: "Ford", model: "Transit", year: "2021", tags: [{ name: "Depot A" }] }], pagination: { hasNextPage: true } }), { status: 200 }));
    const result = await runOperation(definition, "vehicles", { limit: 50 }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.samsara.com/fleet/vehicles?limit=50");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer samsara-token");
    expect(result.rows?.[0]).toMatchObject({ name: "Van 12", plate: "AB12 CDE", tags: "Depot A" });
    expect(result.summary).toContain("more pages");
  });

  it("requests the fuel-energy report with startDate/endDate and converts units", async () => {
    const fetch = routedFetch([{ match: "/fleet/reports/vehicles/fuel-energy", body: fuelEnergy }]);
    const result = await runOperation(definition, "fuel_energy", { start_date: "2026-01-01", end_date: "2026-03-31", vehicle_ids: "281474976710655, 281474976710656" }, testContext(fetch, env));
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ vehicle: "Van 12", distance_km: 1384, fuel_litres: 162.77, litres_per_100km: 11.76, idle_hours: 1.2, samsara_est_co2_kg: 422.7 });
    expect(result.rows?.[1]).toMatchObject({ energy_type: "electric", energy_kwh: 73.2, fuel_litres: null });
    expect(result.summary).toContain("1,896 km, 163 litres of fuel, 73 kWh");
    expect(result.provenance).toMatchObject({ source: "samsara-fleet", basis: "measured", licence: "consent_based" });
  });

  it("builds the query with the documented parameter names", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: { vehicleReports: [] } }), { status: 200 }));
    const result = await runOperation(definition, "fuel_energy", { start_date: "2026-01-01", end_date: "2026-01-31", energy_type: "fuel" }, testContext(fetch, { ...env, SAMSARA_API_BASE: "https://api.eu.samsara.com" }));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin).toBe("https://api.eu.samsara.com");
    expect(url.searchParams.get("startDate")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("endDate")).toBe("2026-01-31T00:00:00Z");
    expect(url.searchParams.get("energyType")).toBe("fuel");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "fuel_energy", { start_date: "2025-01-01", end_date: "2026-06-01" }, testContext(fetch, env))).rejects.toThrow(/maximum is 366 days/);
    await expect(runOperation(definition, "vehicles", {}, testContext(fetch, {}))).rejects.toThrow(/SAMSARA_API_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
