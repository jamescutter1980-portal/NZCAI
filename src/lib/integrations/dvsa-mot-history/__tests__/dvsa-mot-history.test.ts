// Fixture mirrors the documented MOT History API v1 vehicle response; not from a live call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { annualMileage, clearTokenCache, definition, odometerReadings } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import vehicle from "./fixtures/vehicle.json";

const env = {
  DVSA_MOT_CLIENT_ID: "client-id",
  DVSA_MOT_CLIENT_SECRET: "secret",
  DVSA_MOT_API_KEY: "api-key",
  DVSA_MOT_TOKEN_URL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
};

function fetchFor(calls: { url: string; init?: RequestInit }[]) {
  const routed = routedFetch([
    { match: "login.microsoftonline.com", body: { access_token: "tok-1", expires_in: 3600, token_type: "Bearer" } },
    { match: "/vehicles/registration/AB12CDE", body: vehicle },
    { match: "/vehicles/registration/ZZ99ZZZ", status: 404, body: { errorMessage: "No MOT Tests found" } },
  ]);
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return routed(url, init);
  };
}

beforeEach(() => clearTokenCache());

describe("dvsa-mot-history", () => {
  it("obtains a client-credentials token, sends Bearer plus X-API-Key, and caches the token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ctx = testContext(fetchFor(calls), env);
    const result = await runOperation(definition, "history", { registration: "ab12 cde" }, ctx);
    expect(calls[0].url).toBe(env.DVSA_MOT_TOKEN_URL);
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://tapi.dvsa.gov.uk/.default");
    expect(calls[1].url).toBe("https://history.mot.api.gov.uk/v1/trade/vehicles/registration/AB12CDE");
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-1");
    expect(headers["x-api-key"]).toBe("api-key");
    expect(result.rows).toHaveLength(5);
    expect(result.rows?.[0]).toMatchObject({ result: "PASSED", odometer: "101200", defects: 1 });
    expect(result.rows?.[3]).toMatchObject({ result: "FAILED", dangerous_defects: 1 });
    expect(result.summary).toContain("101,200 miles");

    await runOperation(definition, "history", { registration: "AB12CDE" }, ctx);
    expect(calls.filter((c) => c.url === env.DVSA_MOT_TOKEN_URL)).toHaveLength(1);
  });

  it("estimates annual mileage from consecutive readings, skipping NO_ODOMETER and same-day retests", () => {
    const readings = odometerReadings(vehicle.motTests as never);
    expect(readings.map((r) => r.miles)).toEqual([48210, 66500, 66510, 101200]);
    const est = annualMileage(readings);
    expect(est).toHaveLength(2);
    expect(est[0]).toMatchObject({ from: "2022-06-10", to: "2023-06-12", miles: 18290 });
    expect(est[0].miles_per_year).toBeGreaterThan(18000);
    expect(est[1]).toMatchObject({ from: "2023-06-13", to: "2025-06-09", miles: 34690 });
  });

  it("runs the mileage operation with an estimated basis and business/private warning", async () => {
    const result = await runOperation(definition, "mileage", { registration: "AB12CDE" }, testContext(fetchFor([]), env));
    expect(result.provenance.basis).toBe("estimated");
    expect(result.summary).toContain("latest odometer 101,200 miles on 2025-06-09");
    expect(result.warnings?.[0]).toMatch(/business from private/);
  });

  it("returns an empty unavailable result for a 404 and fails before the network without credentials", async () => {
    const result = await runOperation(definition, "history", { registration: "ZZ99ZZZ" }, testContext(fetchFor([]), env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "history", { registration: "AB12CDE" }, testContext(fetch, { DVSA_MOT_CLIENT_ID: "x" }))).rejects.toThrow(/DVSA_MOT_CLIENT_SECRET/);
    await expect(runOperation(definition, "history", { registration: "?" }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
