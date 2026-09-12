// Fixtures follow the shapes used by the pyglowmarkt client and Glowmarkt API documentation: POST /auth -> {valid, token, exp},
// GET /virtualentity -> [{veId, name, postalCode, resources?}], GET /virtualentity/{id}/resources -> {resources:[...]},
// GET /resource/{id}/readings -> {data:[[epochSeconds, value]], units}. No live call was made.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { DEFAULT_APPLICATION_ID, definition, epochToIso, getToken, resetTokenCache } from "..";
import { runOperation, testContext } from "../../testing";
import virtualEntities from "./fixtures/virtual-entities.json";

const env = { GLOWMARKT_USERNAME: "occupier@example.com", GLOWMARKT_PASSWORD: "secret" };
const NOW = new Date("2026-09-09T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const auth = { valid: true, token: "tok-123", exp: NOW_S + 3600, userId: "u1" };

function glowFetch(readings: (url: URL) => unknown = () => ({ data: [], units: "kWh" })) {
  return vi.fn<FetchLike>(async (input, init) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/auth")) return new Response(JSON.stringify(init?.method === "POST" ? auth : { valid: false }), { status: 200 });
    if (u.pathname.endsWith("/virtualentity")) return new Response(JSON.stringify(virtualEntities), { status: 200 });
    if (/\/virtualentity\/[^/]+\/resources$/.test(u.pathname)) return new Response(JSON.stringify({ resources: [{ resourceId: "r-3", name: "electricity consumption", classifier: "electricity.consumption", baseUnit: "kWh" }] }), { status: 200 });
    if (/\/resource\/[^/]+\/readings$/.test(u.pathname)) return new Response(JSON.stringify(readings(u)), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("hildebrand-glowmarkt", () => {
  beforeEach(() => resetTokenCache());

  it("authenticates with applicationId and JSON credentials, then sends token + applicationId headers", async () => {
    const fetch = glowFetch();
    const result = await runOperation(definition, "virtual_entities", {}, testContext(fetch, env, NOW));
    const [authUrl, authInit] = fetch.mock.calls[0];
    expect(authUrl).toBe("https://api.glowmarkt.com/api/v0-1/auth");
    expect(authInit?.method).toBe("POST");
    expect((authInit?.headers as Record<string, string>).applicationId).toBe(DEFAULT_APPLICATION_ID);
    expect(JSON.parse(String(authInit?.body))).toEqual({ username: "occupier@example.com", password: "secret" });
    const [veUrl, veInit] = fetch.mock.calls[1];
    expect(veUrl).toBe("https://api.glowmarkt.com/api/v0-1/virtualentity");
    expect((veInit?.headers as Record<string, string>).token).toBe("tok-123");
    expect((veInit?.headers as Record<string, string>).applicationId).toBe(DEFAULT_APPLICATION_ID);
    expect(fetch.mock.calls[2][0]).toBe("https://api.glowmarkt.com/api/v0-1/virtualentity/6c2e0e2a-2222-4c5c-8a4c-0d3f1b2a9b02/resources");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ ve_name: "DCC Smart Meters", postcode: "RG2 0AA", resource_id: "8f0a7d2e-aaaa-4b0b-9c1d-000000000001", classifier: "electricity.consumption", base_unit: "kWh" });
    expect(result.rows?.[2]).toMatchObject({ ve_name: "Second Home", resource_id: "r-3" });
    expect(result.summary).toContain("2 virtual entities with 3 resource(s)");
    expect(result.provenance).toMatchObject({ source: "hildebrand-glowmarkt", licence: "consent_based", basis: "client_declared" });
  });

  it("caches the token until exp and re-authenticates when expired or for another application id", async () => {
    const fetch = glowFetch();
    const ctx = testContext(fetch, env, NOW);
    expect(await getToken(ctx)).toBe("tok-123");
    expect(await getToken(ctx)).toBe("tok-123");
    expect(fetch).toHaveBeenCalledTimes(1);
    await getToken(testContext(fetch, { ...env, GLOWMARKT_APPLICATION_ID: "org-app" }, NOW));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1][1]?.headers as Record<string, string>).applicationId).toBe("org-app");
    await getToken(testContext(fetch, env, new Date(NOW.getTime() + 3600_000)));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("chunks half-hourly readings to 10-day requests and maps epoch seconds to ISO", async () => {
    const fetch = glowFetch((u) => {
      const from = u.searchParams.get("from")!;
      const start = Date.parse(from + "Z") / 1000;
      return { status: "OK", name: "electricity consumption", classifier: "electricity.consumption", units: "kWh", data: [[start, 0.25], [start + 1800, null], [start + 3600, 0.5]] };
    });
    const result = await runOperation(definition, "readings", { resource_id: "res-1", from: "2026-08-01", to: "2026-08-12", period: "PT30M" }, testContext(fetch, env, NOW));
    const readingCalls = fetch.mock.calls.filter((c) => String(c[0]).includes("/readings")).map((c) => new URL(String(c[0])));
    expect(readingCalls).toHaveLength(2);
    expect(readingCalls[0].pathname).toBe("/api/v0-1/resource/res-1/readings");
    expect(readingCalls[0].searchParams.get("from")).toBe("2026-08-01T00:00:00");
    expect(readingCalls[0].searchParams.get("to")).toBe("2026-08-10T23:59:59");
    expect(readingCalls[1].searchParams.get("from")).toBe("2026-08-11T00:00:00");
    expect(readingCalls[1].searchParams.get("to")).toBe("2026-08-12T23:59:59");
    expect(readingCalls[0].searchParams.get("period")).toBe("PT30M");
    expect(readingCalls[0].searchParams.get("function")).toBe("sum");
    expect(readingCalls[0].searchParams.get("offset")).toBe("0");
    expect(readingCalls[0].searchParams.get("nulls")).toBe("1");
    expect((fetch.mock.calls[1][1]?.headers as Record<string, string>).token).toBe("tok-123");
    expect(result.columns).toEqual(["interval_start", "kwh", "unit"]);
    expect(result.rows).toHaveLength(6);
    expect(result.rows?.[0]).toEqual({ interval_start: "2026-08-01T00:00:00Z", kwh: 0.25, unit: "kWh" });
    expect(result.rows?.[1]).toEqual({ interval_start: "2026-08-01T00:30:00Z", kwh: null, unit: "kWh" });
    expect(result.rows?.[3]).toEqual({ interval_start: "2026-08-11T00:00:00Z", kwh: 0.25, unit: "kWh" });
    expect(result.summary).toContain("1.5 kWh over 6 PT30M interval(s)");
    expect(result.summary).toContain("2 interval(s) with no data");
    expect(result.summary).toContain("2 API requests");
    expect(result.provenance.basis).toBe("measured");
    expect(epochToIso(1788912000)).toBe("2026-09-09T00:00:00Z");
  });

  it("returns an empty result when there are no readings", async () => {
    const fetch = glowFetch();
    const result = await runOperation(definition, "readings", { resource_id: "res-1", from: "2026-08-01", to: "2026-08-02", period: "P1D" }, testContext(fetch, env, NOW));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates ranges and credentials before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "readings", { resource_id: "r", from: "2026-08-10", to: "2026-08-01" }, testContext(fetch, env, NOW))).rejects.toThrow(/before/);
    await expect(runOperation(definition, "readings", { resource_id: "r", from: "2026-01-01", to: "2026-06-30", period: "PT30M" }, testContext(fetch, env, NOW))).rejects.toThrow(/maximum is 100 days/);
    await expect(runOperation(definition, "readings", { resource_id: "r", from: "2026-08-01", to: "2026-08-02", period: "P1W" }, testContext(fetch, env, NOW))).rejects.toThrow();
    await expect(runOperation(definition, "virtual_entities", {}, testContext(fetch, {}, NOW))).rejects.toThrow(/GLOWMARKT_USERNAME/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly on bad credentials", async () => {
    const denied = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ valid: false, error: "Invalid credentials" }), { status: 401 }));
    await expect(runOperation(definition, "virtual_entities", {}, testContext(denied, env, NOW))).rejects.toMatchObject({ status: 401 });
    const invalid = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ valid: false }), { status: 200 }));
    await expect(runOperation(definition, "virtual_entities", {}, testContext(invalid, env, NOW))).rejects.toThrow(/authentication failed/);
    expect((await definition.healthCheck!(testContext(invalid, env, NOW))).ok).toBe(false);
    expect((await definition.healthCheck!(testContext(glowFetch(), env, NOW))).ok).toBe(true);
  });
});
