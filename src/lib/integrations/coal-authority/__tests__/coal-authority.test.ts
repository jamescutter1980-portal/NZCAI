// Capabilities fixtures use the layer titles the Coal Authority describes for
// these WMS services; the exact Name values and GetFeatureInfo attributes are
// not published, hence the discovery step. Not captured live here.
import { readFileSync } from "node:fs";
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

const capReporting = readFileSync(new URL("./fixtures/capabilities-reporting.xml", import.meta.url), "utf8");
const capRisk = readFileSync(new URL("./fixtures/capabilities-risk.xml", import.meta.url), "utf8");

function fakeFetch(opts: { inReporting: boolean; risk: boolean }) {
  return vi.fn(async (url: string) => {
    if (url.includes("GetCapabilities")) {
      if (url.includes("reporting_areas")) return new Response(capReporting, { status: 200 });
      if (url.includes("specific_risk")) return new Response(capRisk, { status: 200 });
      return new Response("<ServiceExceptionReport><ServiceException>Service unavailable</ServiceException></ServiceExceptionReport>", { status: 200 });
    }
    if (url.includes("reporting_areas")) {
      return new Response(opts.inReporting ? JSON.stringify({ features: [{ layerName: "0", properties: { OBJECTID: 1, NAME: "Coal Mining Reporting Area" } }] }) : "", { status: 200 });
    }
    if (url.includes("specific_risk")) {
      return new Response(opts.risk ? "Layer '0'\n  Feature 1:\n    TYPE = 'Development High Risk Area'\n    AREA_HA = '12.5'\n" : "", { status: 200 });
    }
    return new Response("", { status: 200 });
  });
}

describe("coal-authority", () => {
  it("discovers layers from GetCapabilities, queries them and flags a reporting area with a high risk feature", async () => {
    const fetch = fakeFetch({ inReporting: true, risk: true });
    const result = await runOperation(definition, "risk-at-point", { latitude: 53.48, longitude: -1.47, includePlanning: false }, testContext(fetch));
    const urls = fetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain("https://map.bgs.ac.uk/arcgis/services/CoalAuthority/coalauthority_coal_mining_reporting_areas/MapServer/WMSServer?");
    expect(urls[0]).toContain("REQUEST=GetCapabilities");
    const riskInfo = urls.find((u) => u.includes("specific_risk") && u.includes("GetFeatureInfo"))!;
    expect(new URL(riskInfo).searchParams.get("QUERY_LAYERS")).toBe("0,1,2");
    expect(urls.some((u) => u.includes("planning_policy"))).toBe(false);
    expect(result.rows?.find((r) => String(r.service).startsWith("Coal mining reporting"))).toMatchObject({ hit: true, layer: "Coal Mining Reporting Area" });
    expect(result.rows?.find((r) => r.layer === "Development High Risk Area")).toMatchObject({ hit: true, feature: "Development High Risk Area" });
    expect(result.rows?.find((r) => r.layer === "Mine Gas Sites")).toMatchObject({ hit: false });
    expect(result.rows?.find((r) => String(r.service).startsWith("Mine entries"))?.status).toBe("error");
    expect(result.summary).toMatch(/^Within the coal mining reporting area: a CON29M coal mining report is advisable\. 1 recorded feature/);
    expect(result.warnings?.[0]).toMatch(/not that mining risk exists/);
    expect(result.provenance.basis).toBe("modelled");
  });

  it("reports outside the reporting area when nothing hits", async () => {
    const result = await runOperation(definition, "risk-at-point", { latitude: 51.5, longitude: -0.12 }, testContext(fakeFetch({ inReporting: false, risk: false }), { COAL_AUTHORITY_WMS_BASE: "https://example.org/CoalAuthority/" }));
    expect(result.summary).toMatch(/^Outside the coal mining reporting area/);
    expect(result.rows?.filter((r) => r.hit === true)).toHaveLength(0);
  });

  it("throws when every service fails and validates before the network", async () => {
    const down = vi.fn<FetchLike>(async () => new Response("<ServiceExceptionReport><ServiceException>down</ServiceException></ServiceExceptionReport>", { status: 200 }));
    await expect(runOperation(definition, "risk-at-point", { latitude: 53, longitude: -1 }, testContext(down))).rejects.toThrow(/Every Coal Authority WMS failed/);
    const fetch = vi.fn();
    await expect(runOperation(definition, "risk-at-point", { latitude: 53 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
