// Fixtures mirror ArcGIS REST `query?f=json` and `MapServer?f=json` shapes with
// attribute names from published EA layer descriptions (prob_4band, type/layer);
// service names were confirmed from public references where noted in index.ts.
import { describe, expect, it, vi } from "vitest";
import { definition, SERVICES } from "..";
import { digest, parseOverrides } from "../arcgis-scan";
import { routedFetch, runOperation, testContext } from "../../testing";
import fz3 from "./fixtures/fz3-hit.json";
import rofrs from "./fixtures/rofrs-hit.json";
import rofswService from "./fixtures/rofsw-service.json";

const EMPTY = { features: [] };

function fetchFor(base: string) {
  return routedFetch([
    { match: `${base}/FloodMapForPlanningRiversAndSeaFloodZone3/MapServer/0/query`, body: fz3 },
    { match: `${base}/FloodMapForPlanningRiversAndSeaFloodZone2/MapServer/0/query`, body: fz3 },
    { match: `${base}/RiskOfFloodingFromRiversAndSea/MapServer/0/query`, body: rofrs },
    { match: `${base}/RiskOfFloodingFromSurfaceWater/MapServer?f=json`, body: rofswService },
    { match: `${base}/RiskOfFloodingFromSurfaceWater/MapServer/1/query`, body: EMPTY },
    { match: `${base}/RiskOfFloodingFromSurfaceWater/MapServer/2/query`, body: { features: [{ attributes: { OBJECTID: 1, risk: "Medium" } }] } },
    { match: `${base}/RiskOfFloodingFromSurfaceWater/MapServer/3/query`, body: { features: [{ attributes: { OBJECTID: 2, risk: "Low" } }] } },
    { match: `${base}/RiskOfFloodingFromReservoirsMaximumFloodExtent/MapServer/0/query`, body: EMPTY },
    { match: `${base}/FloodMapForPlanningRiversandSeaAreasBenefitingfromFloodDefences/MapServer/0/query`, body: EMPTY },
    { match: "ClimateChange/MapServer?f=json", body: { error: { code: 500, message: "Service not found" } } },
  ]);
}

describe("ea-long-term-flood-risk", () => {
  it("queries every layer at the point and reports one row per layer with scenario", async () => {
    const base = "https://environment.data.gov.uk/arcgis/rest/services/EA";
    const fetch = vi.fn(fetchFor(base));
    const result = await runOperation(definition, "risk-at-point", { latitude: 51.5, longitude: -0.12, distance: 0 }, testContext(fetch));
    const first = new URL(fetch.mock.calls[0][0] as string);
    expect(first.pathname).toBe("/arcgis/rest/services/EA/FloodMapForPlanningRiversAndSeaFloodZone3/MapServer/0/query");
    expect(first.searchParams.get("geometry")).toBe("-0.12,51.5");
    expect(first.searchParams.get("inSR")).toBe("4326");
    expect(first.searchParams.get("returnGeometry")).toBe("false");
    const byLayer = Object.fromEntries((result.rows ?? []).map((r) => [`${r.layer_group}|${r.layer}`, r]));
    expect(result.rows?.find((r) => r.layer === "Flood Zone 3")).toMatchObject({ hit: true, risk_band: "Fluvial Models", scenario: "present day", confirmed_service: true });
    expect(result.rows?.find((r) => r.layer === "Risk of Flooding from Rivers and Sea")).toMatchObject({ hit: true, risk_band: "Low" });
    expect(result.rows?.find((r) => r.layer === "1 percent annual chance (Medium)")).toMatchObject({ hit: true, risk_band: "Medium" });
    expect(result.rows?.find((r) => r.layer === "3.3 percent annual chance (High)")).toMatchObject({ hit: false, status: "no feature" });
    expect(result.rows?.filter((r) => r.status === "error")).toHaveLength(2);
    expect(result.rows?.filter((r) => r.status === "error").every((r) => r.confirmed_service === false && r.scenario === "future (climate change)")).toBe(true);
    expect(Object.keys(byLayer).length).toBe(result.rows?.length);
    expect(result.summary).toMatch(/^Flood Zone 3\./);
    expect(result.summary).toContain("Present day:");
    expect(result.summary).toContain("2 layer(s) could not be queried");
    expect(result.provenance.basis).toBe("modelled");
    expect(result.warnings?.some((w) => /not a site-specific flood risk assessment/.test(w))).toBe(true);
  });

  it("derives Flood Zone 1 when zones 2 and 3 miss, and honours env base and service overrides", async () => {
    const base = "https://example.org/server/rest/services/EA";
    const fetch = vi.fn(routedFetch([
      { match: `${base}/FloodMapForPlanningRiversAndSeaFloodZone3/MapServer/0/query`, body: EMPTY },
      { match: `${base}/FloodMapForPlanningRiversAndSeaFloodZone2/MapServer/0/query`, body: EMPTY },
      { match: `${base}/RiskOfFloodingFromRiversAndSea/MapServer/0/query`, body: EMPTY },
      { match: `${base}/FloodMapForPlanningRiversandSeaAreasBenefitingfromFloodDefences/MapServer/0/query`, body: EMPTY },
      { match: `${base}/RiskOfFloodingFromReservoirsMaximumFloodExtent/MapServer/0/query`, body: EMPTY },
      { match: `${base}/MyRoFSW/MapServer?f=json`, body: { layers: [{ id: 0, name: "Extent" }] } },
      { match: `${base}/MyRoFSW/MapServer/0/query`, body: EMPTY },
    ]));
    const ctx = testContext(fetch, { EA_FLOOD_ARCGIS_BASE: base, EA_FLOOD_ARCGIS_SERVICES: JSON.stringify({ rofsw: "MyRoFSW/MapServer" }) });
    const result = await runOperation(definition, "risk-at-point", { latitude: 52, longitude: -1, includeUnconfirmed: false }, ctx);
    expect(result.summary).toMatch(/^Flood Zone 1/);
    expect(result.rows?.every((r) => r.status === "no feature")).toBe(true);
    expect(fetch.mock.calls.some((c) => (c[0] as string).includes("MyRoFSW/MapServer/0/query"))).toBe(true);
    expect(fetch.mock.calls.some((c) => (c[0] as string).includes("ClimateChange"))).toBe(false);
  });

  it("throws when every service fails so the UI can show the upstream status", async () => {
    const fetch = vi.fn(async () => new Response("gateway", { status: 502 }));
    await expect(runOperation(definition, "risk-at-point", { latitude: 52, longitude: -1 }, testContext(fetch))).rejects.toThrow(/Every EA flood service failed/);
  });

  it("validates coordinates before the network and exposes helpers", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "risk-at-point", { latitude: "x", longitude: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(parseOverrides("not json")).toEqual({});
    expect(parseOverrides('{"fz3":"A/MapServer","n":1}')).toEqual({ fz3: "A/MapServer" });
    expect(SERVICES.filter((s) => s.confirmed).length).toBeGreaterThanOrEqual(5);
    expect(digest([])).toBe("");
  });
});
