// Fixtures mirror ArcGIS REST query responses; attribute names for historic
// landfill (site_name, specified_waste) and SPZ (SPZ) follow published layer
// descriptions. Service names marked unconfirmed in index.ts are guesses.
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition, SERVICES } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import landfill from "./fixtures/landfill-hit.json";
import spz from "./fixtures/spz-hit.json";

const EMPTY = { features: [] };
const BASE = "https://environment.data.gov.uk/arcgis/rest/services/EA";

describe("ea-environmental-constraints", () => {
  it("scans confirmed layers and reports hits, misses and guessed-service errors", async () => {
    const fetch = vi.fn(routedFetch([
      { match: `${BASE}/HistoricLandfill/MapServer/0/query`, body: landfill },
      { match: `${BASE}/SourceProtectionZonesMerged/MapServer/0/query`, body: spz },
      { match: `${BASE}/DrinkingWaterSafeguardsGroundwater/FeatureServer?f=json`, body: { layers: [{ id: 0, name: "Safeguard Zones Groundwater" }] } },
      { match: `${BASE}/DrinkingWaterSafeguardsGroundwater/FeatureServer/0/query`, body: EMPTY },
      { match: `${BASE}/HistoricFloodMap/MapServer/0/query`, body: EMPTY },
      { match: `${BASE}/FloodWarningAreas/MapServer/0/query`, body: EMPTY },
      { match: `${BASE}/SpatialFloodDefencesIncStandardisedAttributes/MapServer/0/query`, body: EMPTY },
      { match: /Aquifer|Groundwater(Flooding)|Erosion|RecordedFlood/, body: { error: { code: 500, message: "Service not found" } } },
    ]));
    const result = await runOperation(definition, "constraints-at-point", { latitude: 51.5, longitude: -0.12 }, testContext(fetch));
    const landfillCall = fetch.mock.calls.map((c) => c[0] as string).find((u) => u.includes("HistoricLandfill/MapServer/0/query"))!;
    expect(new URL(landfillCall).searchParams.get("distance")).toBe("250");
    expect(new URL(landfillCall).searchParams.get("units")).toBe("esriSRUnit_Meter");
    const spzCall = fetch.mock.calls.map((c) => c[0] as string).find((u) => u.includes("SourceProtectionZonesMerged"))!;
    expect(new URL(spzCall).searchParams.get("distance")).toBeNull();
    expect(result.rows?.find((r) => r.layer_group === "Historic landfill site")).toMatchObject({ hit: true, risk_band: "Old Brickworks Tip", scenario: "historic", confirmed_service: true });
    expect(result.rows?.find((r) => r.layer_group === "Groundwater source protection zone")).toMatchObject({ hit: true, risk_band: "Zone II - Outer Protection Zone" });
    expect(result.rows?.find((r) => r.layer_group === "Flood warning area")).toMatchObject({ hit: false, status: "no feature" });
    const errors = result.rows?.filter((r) => r.status === "error") ?? [];
    expect(errors.length).toBe(5);
    expect(errors.every((r) => r.confirmed_service === false)).toBe(true);
    expect(result.summary).toMatch(/^2 of 6 constraint layers intersect the point/);
    expect(result.summary).toContain("Historic: Historic landfill site: Old Brickworks Tip");
    expect(result.provenance.basis).toBe("modelled");
    expect(result.warnings?.[0]).toMatch(/not proof that land is uncontaminated/);
  });

  it("applies a global distance and skips unconfirmed services when asked", async () => {
    const fetch = vi.fn(routedFetch([
      { match: "FeatureServer?f=json", body: { layers: [] } },
      { match: "/query", body: EMPTY },
    ]));
    const result = await runOperation(definition, "constraints-at-point", { latitude: 52, longitude: -1, distance: 50, includeUnconfirmed: false }, testContext(fetch, { EA_ARCGIS_BASE: "https://example.org/EA" }));
    const urls = fetch.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u.startsWith("https://example.org/EA/"))).toBe(true);
    expect(urls.some((u) => /Aquifer|Erosion/.test(u))).toBe(false);
    expect(urls.filter((u) => u.includes("/query")).every((u) => new URL(u).searchParams.get("distance") === "50")).toBe(true);
    expect(result.rows?.find((r) => String(r.layer_group).startsWith("Drinking water safeguard"))?.status).toBe("skipped");
    expect(result.summary).toContain("within 50 m");
  });

  it("throws when nothing can be queried and validates input first", async () => {
    await expect(runOperation(definition, "constraints-at-point", { latitude: 52, longitude: -1 }, testContext(vi.fn<FetchLike>(async () => new Response("down", { status: 503 }))))).rejects.toThrow(/Every EA constraint service failed/);
    const fetch = vi.fn();
    await expect(runOperation(definition, "constraints-at-point", { latitude: 52 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(SERVICES.filter((s) => s.confirmed).map((s) => s.id)).toContain("historic_landfill");
  });
});
