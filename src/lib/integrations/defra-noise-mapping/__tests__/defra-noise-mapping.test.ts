// The capabilities fixture follows WMS 1.3.0 GetCapabilities structure with invented Round 4 layer names (the real names
// were not available); GetFeatureInfo bodies follow ArcGIS Server's JSON ({features:[{properties}]}) and text/plain
// ("Key = value") formats for a raster pixel value. No live call was made.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bandFor, definition, levelFromProperties, metricForLayer } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";

const roadCaps = readFileSync(path.join(__dirname, "fixtures", "road-capabilities.xml"), "utf8");
const railCaps = roadCaps.replace(/Road/g, "Rail");
const point = { latitude: 51.5074, longitude: -0.1278 };

function fetchFor() {
  return vi.fn(routedFetch([
    { match: /road-noise.*GetCapabilities/, body: roadCaps, headers: { "content-type": "text/xml" } },
    { match: /rail-noise.*GetCapabilities/, body: railCaps, headers: { "content-type": "text/xml" } },
    { match: /road-noise.*LAYERS=Road_Noise_Lden/, body: { type: "FeatureCollection", features: [{ type: "Feature", properties: { "Pixel Value": "62.3" } }] } },
    { match: /road-noise.*LAYERS=Road_Noise_Lnight/, body: "Pixel Value = 51.0\n", headers: { "content-type": "text/plain" } },
    { match: /road-noise.*LAYERS=Road_Noise_LAeq16h/, body: "", headers: { "content-type": "text/plain" } },
    { match: /rail-noise.*GetFeatureInfo/, body: { type: "FeatureCollection", features: [] } },
  ]));
}

describe("defra-noise-mapping", () => {
  it("discovers metric layers from GetCapabilities and reads a level per source and metric", async () => {
    const fetch = fetchFor();
    const result = await runOperation(definition, "noise_at_point", point, testContext(fetch));
    const caps = new URL(fetch.mock.calls[0][0] as string);
    expect(caps.origin + caps.pathname).toBe("https://environment.data.gov.uk/spatialdata/road-noise-all-metrics-england-round-4/wms");
    expect(caps.searchParams.get("REQUEST")).toBe("GetCapabilities");
    const info = fetch.mock.calls.map((c) => new URL(String(c[0]))).find((u) => u.searchParams.get("REQUEST") === "GetFeatureInfo")!;
    expect(info.searchParams.get("VERSION")).toBe("1.3.0");
    expect(info.searchParams.get("CRS")).toBe("CRS:84");
    expect(info.searchParams.get("QUERY_LAYERS")).toBe("Road_Noise_Lden_England_Round_4");
    expect(info.searchParams.get("INFO_FORMAT")).toBe("application/json");
    expect(result.rows).toEqual([
      { source: "rail", metric: "Lden", level_db: null, band: "Below 40 dB cutoff or not mapped", layer: "Rail_Noise_Lden_England_Round_4", field: null },
      { source: "rail", metric: "Lnight", level_db: null, band: "Below 35 dB cutoff or not mapped", layer: "Rail_Noise_Lnight_England_Round_4", field: null },
      { source: "rail", metric: "LAeq16h", level_db: null, band: "Below 40 dB cutoff or not mapped", layer: "Rail_Noise_LAeq16h_England_Round_4", field: null },
      { source: "road", metric: "Lden", level_db: 62.3, band: "60.0-64.9 dB", layer: "Road_Noise_Lden_England_Round_4", field: "Pixel Value" },
      { source: "road", metric: "Lnight", level_db: 51, band: "50.0-54.9 dB", layer: "Road_Noise_Lnight_England_Round_4", field: "Pixel Value" },
      { source: "road", metric: "LAeq16h", level_db: null, band: "Below 40 dB cutoff or not mapped", layer: "Road_Noise_LAeq16h_England_Round_4", field: null },
    ]);
    expect(result.summary).toContain("road: Lden 62.3 dB (60.0-64.9 dB), Lnight 51 dB");
    expect(result.summary).toContain("rail: Lden below cutoff");
    expect(result.summary).toContain("exceed WHO guideline thresholds");
    expect(result.provenance).toMatchObject({ source: "defra-noise-mapping", basis: "modelled", licence: "OGL" });
    expect(result.warnings?.[0]).toMatch(/BS 7445/);
  });

  it("filters by metric and source and uses WMS overrides", async () => {
    const fetch = fetchFor();
    const result = await runOperation(definition, "noise_at_point", { ...point, metric: "Lden", source: "road" }, testContext(fetch, { DEFRA_NOISE_WMS_ROAD: "https://example.test/road-noise/wms" }));
    expect(fetch.mock.calls.every((c) => String(c[0]).startsWith("https://example.test/road-noise/wms?"))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ source: "road", metric: "Lden", level_db: 62.3 });
  });

  it("switches to ArcGIS REST point queries when DEFRA_NOISE_ARCGIS_LAYERS is set", async () => {
    const fetch = vi.fn(routedFetch([
      { match: "/RoadNoiseLdenRound4/MapServer/0/query", body: { features: [{ attributes: { NoiseClass: "65.0-69.9" } }] } },
      { match: "/Rail/FeatureServer/3/query", body: { features: [] } },
    ]));
    const env = { DEFRA_NOISE_ARCGIS_LAYERS: "road|Lden|RoadNoiseLdenRound4/MapServer/0;rail|Lnight|https://other.test/Rail/FeatureServer/3" };
    const result = await runOperation(definition, "noise_at_point", point, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://environment.data.gov.uk/arcgis/rest/services/DEFRA/RoadNoiseLdenRound4/MapServer/0/query");
    expect(u.searchParams.get("geometry")).toBe("-0.1278,51.5074");
    expect(u.searchParams.get("inSR")).toBe("4326");
    expect(result.rows).toEqual([
      { source: "rail", metric: "Lnight", level_db: null, band: "Below 35 dB cutoff or not mapped", layer: "https://other.test/Rail/FeatureServer/3", field: null },
      { source: "road", metric: "Lden", level_db: 65, band: "65.0-69.9", layer: "https://environment.data.gov.uk/arcgis/rest/services/DEFRA/RoadNoiseLdenRound4/MapServer/0", field: "NoiseClass" },
    ]);
    expect(result.warnings?.some((w) => w.includes("operator-supplied ArcGIS REST"))).toBe(true);
  });

  it("returns unavailable when no layer matches and validates before the network", async () => {
    const fetch = vi.fn(routedFetch([{ match: "GetCapabilities", body: "<WMS_Capabilities><Capability><Layer><Name>Legend</Name></Layer></Capability></WMS_Capabilities>", headers: { "content-type": "text/xml" } }]));
    const result = await runOperation(definition, "noise_at_point", point, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.warnings?.some((w) => w.includes("no queryable WMS layer"))).toBe(true);
    const none = vi.fn();
    await expect(runOperation(definition, "noise_at_point", { latitude: 51, longitude: -0.1, metric: "Lmax" }, testContext(none))).rejects.toThrow();
    expect(none).not.toHaveBeenCalled();
  });

  it("classifies layers, bands and pixel values", () => {
    expect(metricForLayer("Road_Noise_Lden_England_Round_4", "")).toBe("Lden");
    expect(metricForLayer("rail_lnight", "Rail LNight")).toBe("Lnight");
    expect(metricForLayer("Road_LAeq_16h", "")).toBe("LAeq16h");
    expect(metricForLayer("Legend", "Legend")).toBeNull();
    expect(bandFor(74.9, "Lden")).toBe("70.0-74.9 dB");
    expect(bandFor(75, "Lden")).toBe("75 dB and above");
    expect(bandFor(70, "Lnight")).toBe("70 dB and above");
    expect(bandFor(null, "Lnight")).toBe("Below 35 dB cutoff or not mapped");
    expect(levelFromProperties({ GRAY_INDEX: 58.5 })).toEqual({ value: 58.5, field: "GRAY_INDEX" });
    expect(levelFromProperties({ "Pixel Value": "NoData" })).toEqual({ value: null, field: null });
    expect(levelFromProperties({ NoiseClass: "55.0-59.9" })).toEqual({ value: 55, field: "NoiseClass" });
  });
});
