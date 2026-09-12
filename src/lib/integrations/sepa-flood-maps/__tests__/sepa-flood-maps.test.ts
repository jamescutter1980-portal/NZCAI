// Fixtures mirror ArcGIS REST query responses; the SEPA layer attribute names
// are not documented publicly, so the connector reports any attributes it finds.
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition, LAYERS } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import hit from "./fixtures/river-medium-hit.json";

const EMPTY = { features: [] };

describe("sepa-flood-maps", () => {
  it("queries all twelve layers and separates present-day and future scenarios", async () => {
    const fetch = vi.fn(routedFetch([
      { match: "Flood_Maps/MapServer/1/query", body: hit },
      { match: "Flood_Maps/MapServer/2/query", body: hit },
      { match: "Flood_Maps/MapServer/9/query", body: hit },
      { match: "Flood_Maps/MapServer/", body: EMPTY },
    ]));
    const result = await runOperation(definition, "risk-at-point", { latitude: 55.95, longitude: -3.19 }, testContext(fetch));
    expect(fetch.mock.calls).toHaveLength(12);
    expect(fetch.mock.calls[0][0]).toContain("https://map.sepa.org.uk/server/rest/services/Open/Flood_Maps/MapServer/0/query");
    expect(result.rows).toHaveLength(12);
    expect(result.rows?.find((r) => String(r.layer_url).endsWith("/1"))).toMatchObject({ hit: true, risk_band: "Medium", scenario: "present day" });
    expect(result.rows?.find((r) => String(r.layer_url).endsWith("/9"))).toMatchObject({ hit: true, scenario: "future (climate change)" });
    expect(result.rows?.find((r) => String(r.layer_url).endsWith("/0"))).toMatchObject({ hit: false });
    expect(result.summary).toMatch(/^3 of 12 SEPA flood map layers include the point \(within the medium-likelihood extent/);
    expect(result.summary).toContain("Future (climate change):");
    expect(result.provenance).toMatchObject({ basis: "modelled", territory: "Scotland" });
  });

  it("uses the env base override and reports a clean miss", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(EMPTY), { status: 200 }));
    const result = await runOperation(definition, "risk-at-point", { latitude: 57, longitude: -4, distance: 20 }, testContext(fetch, { SEPA_FLOOD_ARCGIS_BASE: "https://example.org/Open/" }));
    expect((fetch.mock.calls[0][0] as string).startsWith("https://example.org/Open/Flood_Maps/MapServer/0/query")).toBe(true);
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("distance")).toBe("20");
    expect(result.rows?.every((r) => r.hit === false)).toBe(true);
    expect(result.summary).toMatch(/^0 of 12/);
  });

  it("throws when the service is down and validates input first", async () => {
    await expect(runOperation(definition, "risk-at-point", { latitude: 56, longitude: -3 }, testContext(vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: { code: 500, message: "boom" } }), { status: 200 }))))).rejects.toThrow(/SEPA flood map service failed/);
    const fetch = vi.fn();
    await expect(runOperation(definition, "risk-at-point", { latitude: 56 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(LAYERS.present).toHaveLength(9);
  });
});
