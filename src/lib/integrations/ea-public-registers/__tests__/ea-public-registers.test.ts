// Fixture shapes follow the published OpenAPI document for the public register
// API (registrationNumber, holder.name, register.label, site.siteAddress, distance);
// not captured live here.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import search from "./fixtures/search.json";
import carriers from "./fixtures/waste-carriers.json";

describe("ea-public-registers", () => {
  it("converts lat/long to easting/northing and searches all registers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(search), { status: 200 }));
    const result = await runOperation(definition, "near-point", { latitude: 51.501009, longitude: -0.141588, dist: 1 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/public-register/api/search.json");
    expect(Math.abs(Number(url.searchParams.get("easting")) - 529090)).toBeLessThanOrEqual(6);
    expect(Math.abs(Number(url.searchParams.get("northing")) - 179645)).toBeLessThanOrEqual(6);
    expect(url.searchParams.get("dist")).toBe("1");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ registration_number: "EPR-AB1234CD", holder: "Example Recycling Ltd", registration_type: "Permit", postcode: "SW1A 1AA", easting: 529150, distance_km: 0.08, local_authority: "Westminster" });
    expect(result.rows?.[1]).toMatchObject({ holder: "Thames Water Utilities Ltd", register: "Environmental Permitting Regulations – Discharge Consents" });
    expect(result.summary).toContain("2 registrations within 1 km");
    expect(result.warnings?.some((w) => w.includes("OSGB36"))).toBe(true);
  });

  it("uses a single register route with given easting/northing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const result = await runOperation(definition, "near-point", { easting: 623719, northing: 309247, dist: 5, register: "waste-operations" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/public-register/waste-operations/registration.json");
    expect(url.searchParams.get("easting")).toBe("623719");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("looks up waste carriers by name", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(carriers), { status: 200 }));
    const result = await runOperation(definition, "waste-carrier", { name: "Example Skips" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/public-register/waste-carriers-brokers/registration.json");
    expect(url.searchParams.get("name-search")).toBe("Example Skips");
    expect(result.rows?.[0]).toMatchObject({ registration_number: "CBDU123456", holder: "Example Skips Limited", trading_name: "Example Skips", tier: "Upper", expiry_date: "2027-05-01" });
    expect(result.summary).toContain("1 upper tier");
  });

  it("rejects a point search with no coordinates and a short name before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "near-point", { dist: 1 }, testContext(fetch))).rejects.toThrow(/latitude and longitude/);
    await expect(runOperation(definition, "waste-carrier", { name: "ab" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "near-point", { latitude: 200, longitude: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    void routedFetch;
  });
});
