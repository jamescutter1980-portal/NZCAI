// The identify fixture follows the ArcGIS MapServer identify response ({results:[{layerId, layerName, attributes}]}) with the
// CLASS_MAX and Description attributes read by an open-source consumer of the BGS GeoIndex radon service; the class-to-band
// mapping is inferred from the published legend order. No live call was made.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { attributesToRow, definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import identify from "./fixtures/identify.json";

describe("ukradon", () => {
  it("runs an identify against the BGS GeoIndex radon MapServer and maps the class", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(identify), { status: 200 }));
    const result = await runOperation(definition, "radon_class_at_point", { latitude: 50.37, longitude: -4.14 }, testContext(fetch));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.origin + u.pathname).toBe("https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/radon/MapServer/identify");
    expect(u.searchParams.get("geometry")).toBe("-4.14,50.37");
    expect(u.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(u.searchParams.get("sr")).toBe("4326");
    expect(u.searchParams.get("layers")).toBe("all");
    expect(u.searchParams.get("mapExtent")).toBe("-4.16000,50.35000,-4.12000,50.39000");
    expect(u.searchParams.get("f")).toBe("json");
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ class_max: 3, band: "3-5% of homes above the Action Level", radon_affected_area: true, layer: "Radon Indicative Atlas" });
    expect(String(result.rows?.[0].new_build_protection)).toMatch(/^Basic radon protection/);
    expect(result.summary).toContain("class 3");
    expect(result.summary).toContain("Radon Affected Area");
    expect(result.provenance).toMatchObject({ source: "ukradon", basis: "modelled", licence: "OGL" });
    expect(result.warnings?.[0]).toMatch(/Indicative/);
  });

  it("uses UKRADON_ARCGIS_URL with a standard point query when set", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/FeatureServer/0/query", body: { features: [{ attributes: { CLASS: 5, Description: "10-30%" } }] } }]));
    const result = await runOperation(definition, "radon_class_at_point", { latitude: 52.1, longitude: -1.3 }, testContext(fetch, { UKRADON_ARCGIS_URL: "https://services.arcgis.com/abc/arcgis/rest/services/Radon_Indicative_Atlas/FeatureServer/0/" }));
    const u = new URL(fetch.mock.calls[0][0] as string);
    expect(u.pathname).toBe("/abc/arcgis/rest/services/Radon_Indicative_Atlas/FeatureServer/0/query");
    expect(u.searchParams.get("geometry")).toBe("-1.3,52.1");
    expect(u.searchParams.get("inSR")).toBe("4326");
    expect(u.searchParams.has("distance")).toBe(false);
    expect(result.rows?.[0]).toMatchObject({ class_max: 5, radon_affected_area: true });
    expect(String(result.rows?.[0].new_build_protection)).toMatch(/^Full radon protection/);
  });

  it("infers the class from a band description and treats class 1 as not affected", () => {
    expect(attributesToRow({ Description: "Less than 1% of homes" }, null)).toMatchObject({ class_max: 1, radon_affected_area: false });
    expect(attributesToRow({ Description: "10 - 30 % of homes above the Action Level" }, null)).toMatchObject({ class_max: 5 });
    expect(attributesToRow({ CLASS_MAX: "6" }, "x")).toMatchObject({ class_max: 6, band: "More than 30% of homes above the Action Level" });
    expect(attributesToRow({ Foo: "bar" }, null)).toMatchObject({ class_max: null, band: null });
  });

  it("returns unavailable when identify has no results and validates before the network", async () => {
    const empty = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const result = await runOperation(definition, "radon_class_at_point", { latitude: 55, longitude: -8.9 }, testContext(empty));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "radon_class_at_point", { latitude: 100, longitude: -4 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces ArcGIS-level errors", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: { code: 500, message: "Unable to complete operation." } }), { status: 200 }));
    await expect(runOperation(definition, "radon_class_at_point", { latitude: 50, longitude: -4 }, testContext(fetch))).rejects.toThrow(/ArcGIS error 500/);
  });
});
