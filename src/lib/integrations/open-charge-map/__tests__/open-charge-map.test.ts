// Fixture mirrors the documented OCM /poi response (compact=true); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import poi from "./fixtures/poi.json";

const env = { OPEN_CHARGE_MAP_API_KEY: "ocm-key" };

describe("open-charge-map", () => {
  it("sends the key as X-API-Key, requests km, and maps sites nearest first", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(poi), { status: 200 }));
    const result = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.142, distance_km: 2 }, testContext(fetch, env));
    const [urlStr, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(urlStr);
    expect(url.origin + url.pathname).toBe("https://api.openchargemap.io/v3/poi");
    expect(url.searchParams.get("distanceunit")).toBe("km");
    expect(url.searchParams.get("countrycode")).toBe("GB");
    expect(url.searchParams.get("compact")).toBe("true");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("ocm-key");
    expect(result.rows?.map((r) => r.ocm_id)).toEqual([123457, 123456]);
    expect(result.rows?.[1]).toMatchObject({ name: "Example Car Park", operator: "Example Charging Ltd", max_kw: 150, connectors: 6, status: "Operational", distance_km: 0.62 });
    expect(result.rows?.[1].connector_types).toContain("CCS (Type 2)");
    expect(result.summary).toContain("2 charge point sites");
    expect(result.summary).toContain("1 with 50 kW or faster, 1 marked operational");
    expect(result.provenance).toMatchObject({ source: "open-charge-map", basis: "measured" });
  });

  it("returns an empty unavailable result when nothing is nearby", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("[]", { status: 200 }));
    const result = await runOperation(definition, "nearby", { latitude: 57.1, longitude: -4.2 }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "nearby", { latitude: 95, longitude: 0 }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "nearby", { latitude: 51.5, longitude: 0 }, testContext(fetch, {}))).rejects.toThrow(/OPEN_CHARGE_MAP_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
