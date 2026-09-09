// Fixtures follow the ArcGIS FeatureServer query response shape ({features:[{attributes}]}); layer attribute names are
// candidates from open-source usage and were not checked against the live services.
import { describe, expect, it, vi } from "vitest";
import { definition, featureToHit, LAYERS } from "..";
import { runOperation, testContext } from "../../testing";

const sssi = { features: [{ attributes: { OBJECTID: 1, SSSI_NAME: "Example Meadows", REFERENCE: "1001234", STATUS: "Notified", NOTIFYDATE: 631152000000, Shape__Area: 1234567 }, geometry: null }] };
const phi = { features: [{ attributes: { OBJECTID: 9, Main_Habit: "Lowland meadows", Confidence: "High" } }, { attributes: { OBJECTID: 10, Main_Habit: "Deciduous woodland", Confidence: "Medium" } }] };
const empty = { features: [] };
const arcgisError = { error: { code: 400, message: "Invalid URL", details: [] } };

function fetchFor(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const service = url.match(/rest\/services\/([^/]+)\/FeatureServer/)?.[1] ?? "";
    const body = overrides[service] ?? (service === "SSSI_England" ? sssi : service === "Priority_Habitats_Inventory_England" ? phi : empty);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("natural-england", () => {
  it("queries every layer with a point-distance query and lists hits by designation", async () => {
    const fetch = fetchFor();
    const result = await runOperation(definition, "designations_near", { latitude: 51.501, longitude: -0.142, distance_m: 2000 }, testContext(fetch));
    expect(fetch).toHaveBeenCalledTimes(LAYERS.length);
    const first = new URL(fetch.mock.calls[0][0] as string);
    expect(first.pathname).toMatch(/\/JJzESW51TqeY9uat\/arcgis\/rest\/services\/[A-Za-z_]+\/FeatureServer\/0\/query$/);
    expect(first.searchParams.get("geometry")).toBe("-0.142,51.501");
    expect(first.searchParams.get("inSR")).toBe("4326");
    expect(first.searchParams.get("distance")).toBe("2000");
    expect(first.searchParams.get("units")).toBe("esriSRUnit_Meter");
    expect(first.searchParams.get("returnGeometry")).toBe("false");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ designation: "Site of Special Scientific Interest", name: "Example Meadows", reference: "1001234", status: "Notified", notified: "1990-01-01", area_ha: 123.46 });
    expect(result.rows?.[1]).toMatchObject({ designation: "Priority habitat", name: "Deciduous woodland" });
    expect(result.summary).toContain("1 Site of Special Scientific Interest, 2 Priority habitat");
    expect(result.warnings?.[0]).toMatch(/Biodiversity Net Gain/);
    expect(result.provenance).toMatchObject({ source: "natural-england", basis: "measured", licence: "OGL" });
  });

  it("uses the env base override and filters to statutory layers", async () => {
    const fetch = fetchFor();
    const result = await runOperation(definition, "designations_near", { latitude: 51.501, longitude: -0.142, layers: "statutory" }, testContext(fetch, { NATURAL_ENGLAND_ARCGIS_BASE: "https://example.test/arcgis/rest/services/" }));
    expect(fetch.mock.calls.every((c) => String(c[0]).startsWith("https://example.test/arcgis/rest/services/"))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(LAYERS.filter((l) => l.kind === "statutory").length);
    expect(result.rows).toHaveLength(1);
  });

  it("reports a failing layer as a warning and an all-empty result as unavailable", async () => {
    const fetch = fetchFor({ SSSI_England: arcgisError, Priority_Habitats_Inventory_England: empty });
    const result = await runOperation(definition, "designations_near", { latitude: 51.501, longitude: -0.142 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.warnings?.some((w) => w.includes("SSSI_England") && w.includes("ArcGIS error 400"))).toBe(true);
  });

  it("maps a bare feature and validates before the network", async () => {
    expect(featureToHit(LAYERS[1], { SAC_NAME: "Example Bog", SAC_CODE: "UK0012345" })).toMatchObject({ designation: "Special Area of Conservation", name: "Example Bog", reference: "UK0012345", area_ha: null });
    const fetch = vi.fn();
    await expect(runOperation(definition, "designations_near", { latitude: 51.5, longitude: -0.1, distance_m: 50000 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
