// Fixtures follow the documented shapes at
// https://environment.data.gov.uk/hydrology/doc/reference; not captured live here.
import { describe, expect, it, vi } from "vitest";
import { definition, summariseDaily } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import stations from "./fixtures/stations.json";
import readings from "./fixtures/readings.json";

describe("ea-hydrology", () => {
  it("finds stations near a point filtered by observed property", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(stations), { status: 200 }));
    const result = await runOperation(definition, "stations", { latitude: 51.41, longitude: -0.31, dist: 5, observedProperty: "waterFlow" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/hydrology/id/stations.json");
    expect(url.searchParams.get("observedProperty")).toBe("waterFlow");
    expect(url.searchParams.get("dist")).toBe("5");
    expect(result.rows?.[0]).toMatchObject({ station_id: "e8d4c4b1-2b8e-4b0f-9c3b-0f0f6d4e1a11", label: "Kingston", station_reference: "3400TH", observed_properties: "waterFlow; waterLevel", status: "Active" });
    expect(result.provenance.basis).toBe("measured");
  });

  it("summarises readings by day with quality flags and inclusive date params", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(readings), { status: 200 }));
    const result = await runOperation(definition, "readings", { measureId: "x-flow-m-86400-m3s-qualified", from: "2026-01-01", to: "2026-01-31" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/hydrology/id/measures/x-flow-m-86400-m3s-qualified/readings.json");
    expect(url.searchParams.get("mineq-date")).toBe("2026-01-01");
    expect(url.searchParams.get("maxeq-date")).toBe("2026-01-31");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ date: "2026-01-01", min: 120.5, mean: 120.5, qualities: "Good" });
    expect(result.rows?.[2]).toMatchObject({ date: "2026-01-03", mean: null, qualities: "Missing" });
    expect(result.summary).toContain("quality-controlled");
    expect(result.warnings).toEqual([]);
  });

  it("warns on unchecked series and rejects reversed or over-long ranges", async () => {
    const ctx = testContext(routedFetch([{ match: "readings.json", body: readings }]));
    const r = await runOperation(definition, "readings", { measureId: "x-flow-i-900-m3s", from: "2026-01-01", to: "2026-01-02" }, ctx);
    expect(r.warnings?.[0]).toMatch(/unchecked/);
    await expect(runOperation(definition, "readings", { measureId: "x", from: "2026-02-01", to: "2026-01-01" }, ctx)).rejects.toThrow(/on or after/);
    await expect(runOperation(definition, "readings", { measureId: "x", from: "2024-01-01", to: "2026-01-01" }, ctx)).rejects.toThrow(/366/);
  });

  it("handles an empty station list and validates dates before the network", async () => {
    const empty = await runOperation(definition, "stations", { latitude: 55, longitude: -3 }, testContext(routedFetch([{ match: "stations", body: { items: [] } }])));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "readings", { measureId: "x", from: "01/01/2026", to: "2026-01-31" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(summariseDaily([])).toEqual([]);
  });
});
