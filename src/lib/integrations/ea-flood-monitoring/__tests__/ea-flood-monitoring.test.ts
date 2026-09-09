// Fixtures mirror the documented response shapes in
// https://environment.data.gov.uk/flood-monitoring/doc/reference (and public
// client code); they were not captured from a live call in this codebase.
import { describe, expect, it, vi } from "vitest";
import { definition, parseMeasureId } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import floods from "./fixtures/floods.json";
import stations from "./fixtures/stations-full.json";
import latest from "./fixtures/readings-latest.json";

const EMPTY = { "@context": "x", meta: {}, items: [] };

describe("ea-flood-monitoring", () => {
  it("queries warnings near a point and labels severity", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(floods), { status: 200 }));
    const result = await runOperation(definition, "warnings", { latitude: 50.95, longitude: -0.51, dist: 10 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/flood-monitoring/id/floods");
    expect(url.searchParams.get("lat")).toBe("50.95");
    expect(url.searchParams.get("long")).toBe("-0.51");
    expect(url.searchParams.get("dist")).toBe("10");
    expect(url.searchParams.get("min-severity")).toBe("3");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ severity_level: 2, severity: "Flood Warning", meaning: "flooding is expected, immediate action required", county: "West Sussex", flood_area_id: "065FWF3ARUN1" });
    expect(result.summary).toContain("1 Flood Warning, 1 Flood Alert");
    expect(result.provenance).toMatchObject({ source: "ea-flood-monitoring", basis: "measured", licence: "OGL" });
    expect(result.warnings?.join(" ")).toMatch(/Live warnings/);
  });

  it("returns an empty, unavailable result when nothing is in force", async () => {
    const result = await runOperation(definition, "warnings", { latitude: 52, longitude: -1 }, testContext(routedFetch([{ match: "id/floods", body: EMPTY }])));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toMatch(/No flood warnings/);
  });

  it("lists rainfall gauges with latest totals from a full station view", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(stations), { status: 200 }));
    const result = await runOperation(definition, "rainfall", { latitude: 51.87, longitude: -1.74, dist: 15 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("parameter")).toBe("rainfall");
    expect(url.searchParams.get("_view")).toBe("full");
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ station_reference: "1029TH", parameter: "Rainfall", latest_value: 0.2, unit: "mm", latest_time: "2026-09-09T11:15:00Z" });
    expect(result.rows?.[0].distance_km).toBeLessThan(1);
  });

  it("requests tide gauges by station type", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(stations), { status: 200 }));
    await runOperation(definition, "tide-gauges", { latitude: 51.87, longitude: -1.74 }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("type")).toBe("TideGauge");
  });

  it("maps station rows with typical range and status", async () => {
    const result = await runOperation(definition, "stations", { latitude: 51.87, longitude: -1.74, parameter: "level" }, testContext(routedFetch([{ match: "id/stations", body: stations }])));
    expect(result.rows?.[0]).toMatchObject({ station_reference: "1029TH", label: "Bourton Dickler", river_name: "River Dikler", status: "statusActive", typical_range_low: 0.1, typical_range_high: 0.6, parameters: "Water Level; Rainfall" });
  });

  it("parses latest readings and measure ids", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(latest), { status: 200 }));
    const result = await runOperation(definition, "latest-readings", { stationReference: "1029TH" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://environment.data.gov.uk/flood-monitoring/id/stations/1029TH/readings?latest");
    expect(result.rows?.[0]).toMatchObject({ value: 0.112, parameter: "level", qualifier: "downstage", unit: "mASD" });
    expect(parseMeasureId("1029TH-rainfall-tipping_bucket_raingauge-t-15_min-mm")).toMatchObject({ station: "1029TH", parameter: "rainfall", unit: "mm" });
  });

  it("builds a sorted since query", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(latest), { status: 200 }));
    await runOperation(definition, "readings-since", { stationReference: "1029TH", since: "2026-09-01T00:00:00Z", parameter: "level" }, testContext(fetch));
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain("/id/stations/1029TH/readings?");
    expect(url).toContain("since=2026-09-01T00%3A00%3A00Z");
    expect(url).toContain("parameter=level");
    expect(url.endsWith("&_sorted")).toBe(true);
  });

  it("reports a missing station without throwing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 404, message: "Not found" }), { status: 404 }));
    const result = await runOperation(definition, "station", { stationReference: "NOPE" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects an out-of-range latitude before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "warnings", { latitude: 95, longitude: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
