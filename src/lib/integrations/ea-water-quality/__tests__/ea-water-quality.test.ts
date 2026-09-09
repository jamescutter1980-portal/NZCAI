// Fixture shapes follow the Water Quality Archive reference and its CSV exports
// (sample.sampleDateTime, determinand.label, resultQualifier.notation); not captured live here.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import points from "./fixtures/sampling-points.json";
import measurements from "./fixtures/measurements.json";

describe("ea-water-quality", () => {
  it("finds sampling points near a point", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(points), { status: 200 }));
    const result = await runOperation(definition, "sampling-points", { latitude: 51.04, longitude: -2.84, dist: 3 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/water-quality/id/sampling-point.json");
    expect(url.searchParams.get("long")).toBe("-2.84");
    expect(result.rows?.[0]).toMatchObject({ notation: "SW-60250424", type: "FRESHWATER - RIVERS", status: "open", area: "Wessex", easting: 341559 });
    expect(result.rows?.[0].distance_km).toBeLessThan(1);
  });

  it("lists measurements newest first with qualifiers and units", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(measurements), { status: 200 }));
    const result = await runOperation(definition, "measurements", { samplingPoint: "SW-60250424", startDate: "2026-01-01", endDate: "2026-02-01", determinand: "0117" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/water-quality/data/measurement.json");
    expect(url.searchParams.get("samplingPoint")).toBe("SW-60250424");
    expect(url.searchParams.get("startDate")).toBe("2026-01-01");
    expect(url.searchParams.get("determinand")).toBe("0117");
    expect(url.searchParams.get("_sort")).toBe("-sample.sampleDateTime");
    expect(result.rows?.[0]).toMatchObject({ determinand: "Nitrate as N", determinand_code: "0117", result: 5.43, unit: "mg/l", qualifier: null, material: "RIVER / RUNNING SURFACE WATER" });
    expect(result.rows?.[1]).toMatchObject({ determinand: "Endrin", qualifier: "<", result: 0.0001 });
    expect(result.summary).toContain("Nitrate as N");
  });

  it("returns unavailable for an empty window and validates the date format", async () => {
    const result = await runOperation(definition, "measurements", { samplingPoint: "X" }, testContext(routedFetch([{ match: "measurement.json", body: { items: [] } }])));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "measurements", { samplingPoint: "X", startDate: "yesterday" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
