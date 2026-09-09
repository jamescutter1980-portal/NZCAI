// Fixtures: the GeoJSON property names (id, name, uri, water-body-type) and the
// classifications.csv columns come from published analyses of the public files,
// not from a live call in this codebase.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classificationRows, definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import waterBody from "./fixtures/water-body.geojson.json";

const csv = readFileSync(new URL("./fixtures/classifications.csv", import.meta.url), "utf8");

describe("ea-catchment-data", () => {
  it("fetches a water body GeoJSON by id", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(waterBody), { status: 200 }));
    const result = await runOperation(definition, "water-body", { waterBodyId: "GB108044009890" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://environment.data.gov.uk/catchment-planning/WaterBody/GB108044009890.geojson");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ water_body_id: "GB108044009890", name: "Devils Brook", water_body_type: "River", geometry_type: "MultiPolygon" });
    expect(result.links?.[0].url).toContain("/WaterBody/GB108044009890");
    expect(result.provenance.basis).toBe("measured");
  });

  it("parses catchment classifications, keeping only the latest year per water body", async () => {
    const fetch = vi.fn(async () => new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }));
    const result = await runOperation(definition, "catchment-classifications", { catchmentId: 3367 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://environment.data.gov.uk/catchment-planning/OperationalCatchment/3367/classifications.csv");
    expect(result.rows).toHaveLength(4);
    expect(result.rows?.some((r) => r.year === "2016")).toBe(false);
    expect(result.rows?.some((r) => r.classification_item === "Phosphate")).toBe(false);
    expect(result.summary).toContain("2 water bodies");
    expect(result.summary).toContain("1 Moderate");
    expect(classificationRows(csv, { waterBodyId: "GB108044009900" })).toHaveLength(1);
  });

  it("treats an HTML body as an upstream error and a 404 as not found", async () => {
    await expect(runOperation(definition, "catchment-classifications", { catchmentId: 1 }, testContext(routedFetch([{ match: "classifications.csv", body: "<!DOCTYPE html><html></html>", headers: { "content-type": "text/html" } }])))).rejects.toThrow(/HTML/);
    const nf = await runOperation(definition, "water-body", { waterBodyId: "GB999999999999" }, testContext(routedFetch([{ match: ".geojson", status: 404, body: { error: "not found" } }])));
    expect(nf.rows).toEqual([]);
    expect(nf.provenance.basis).toBe("unavailable");
  });

  it("rejects a malformed water body id before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "water-body", { waterBodyId: "nope" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const links = await runOperation(definition, "links", {}, testContext(fetch));
    expect(links.links?.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
