// Fixtures follow the Linked Data API rendering used by environment.data.gov.uk
// (result.items / result.primaryTopic, {_value,_lang} literals) and the property
// lists in the published Elda configuration; not captured live here.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import list from "./fixtures/bathing-waters.json";
import sample from "./fixtures/latest-sample.json";
import compliance from "./fixtures/latest-compliance.json";

describe("ea-bathing-waters", () => {
  it("lists bathing waters in a district", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }));
    const result = await runOperation(definition, "by-district", { gssCode: "e07000043" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/doc/bathing-water.json");
    expect(url.searchParams.get("district.gssCode")).toBe("E07000043");
    expect(result.rows?.[0]).toMatchObject({ eubwid: "ukk4100-26400", name: "Croyde Bay", district: "North Devon", latest_sample_classification: "Excellent", latest_compliance_classification: "Excellent", risk_prediction: "normal", impacted_by_heavy_rain: "true", latitude: 51.1319 });
    expect(result.summary).toContain("1 designated bathing waters");
  });

  it("converts lat/long to OSGB36 for the nearest lookup", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }));
    await runOperation(definition, "nearest", { latitude: 51.501009, longitude: -0.141588, count: 3 }, testContext(fetch));
    const url = fetch.mock.calls[0][0] as string;
    const m = /nearest-bathing-water\/easting\/(\d+)\/northing\/(\d+)\.json\?_pageSize=3$/.exec(url);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]) - 529090)).toBeLessThanOrEqual(6);
    expect(Math.abs(Number(m![2]) - 179645)).toBeLessThanOrEqual(6);
  });

  it("combines latest sample and compliance records", async () => {
    const ctx = testContext(routedFetch([
      { match: "/in-season/bathing-water/ukk4100-26400/latest.json", body: sample },
      { match: "/compliance/bathing-water/ukk4100-26400/latest.json", body: compliance },
    ]));
    const result = await runOperation(definition, "latest", { eubwid: "UKK4100-26400" }, ctx);
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ record: "latest in-season sample", date: "2026-09-01T10:45:00", classification: "Excellent", e_coli_cfu_per_100ml: 20, intestinal_enterococci_cfu_per_100ml: 10 });
    expect(result.rows?.[1]).toMatchObject({ record: "latest annual classification", classification: "Excellent", sample_year: "2025" });
    expect(result.summary).toContain("classified Excellent (2025)");
  });

  it("handles 404s as unavailable and validates ids before the network", async () => {
    const result = await runOperation(definition, "latest", { eubwid: "ukc2102-03600" }, testContext(routedFetch([{ match: "latest.json", status: 404, body: { error: "not found" } }])));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "latest", { eubwid: "beach" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "by-district", { gssCode: "Devon" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
