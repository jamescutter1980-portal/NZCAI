// Fixture attribute names follow the DiGMapGB-50 user guide (LEX_D, RCS_D,
// RANK_D, MAX_TIME_D...). The WMS GetFeatureInfo JSON and OGC API responses
// were not captured live in this codebase.
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import info from "./fixtures/featureinfo-50k.json";
import bedrock from "./fixtures/ogc-bedrock.json";

describe("bgs-geology", () => {
  it("issues a WMS GetFeatureInfo for the 50k layers and maps bedrock and superficial rows", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(info), { status: 200 }));
    const result = await runOperation(definition, "geology-at-point", { latitude: 51.5, longitude: -0.12 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer");
    expect(url.searchParams.get("REQUEST")).toBe("GetFeatureInfo");
    expect(url.searchParams.get("QUERY_LAYERS")).toBe("BGS.50k.Bedrock,BGS.50k.Superficial.deposits");
    expect(url.searchParams.get("INFO_FORMAT")).toBe("application/json");
    expect(url.searchParams.get("CRS")).toBe("CRS:84");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ theme: "bedrock", unit: "LONDON CLAY FORMATION", lithology: "CLAY, SILT AND SAND", rank: "FORMATION", age: "YPRESIAN AGE", parent_units: "LONDON CLAY FORMATION > THAMES GROUP", scale: "1:50,000" });
    expect(result.rows?.[1]).toMatchObject({ theme: "superficial deposits", unit: "LANGLEY SILT MEMBER", age: "DEVENSIAN STAGE to HOLOCENE EPOCH" });
    expect(result.summary).toContain("Bedrock: LONDON CLAY FORMATION (CLAY, SILT AND SAND), YPRESIAN AGE");
    expect(result.provenance).toMatchObject({ basis: "modelled", licence: "restricted" });
  });

  it("falls back to text/plain when JSON is rejected and reports no superficial deposits", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("INFO_FORMAT=application%2Fjson")) return new Response("<ServiceExceptionReport><ServiceException>Parameter INFO_FORMAT contains unacceptable value</ServiceException></ServiceExceptionReport>", { status: 200 });
      return new Response("Layer 'BGS.50k.Bedrock'\n  Feature 1:\n    LEX_D = 'CHALK GROUP'\n    RCS_D = 'CHALK'\n", { status: 200 });
    });
    const result = await runOperation(definition, "geology-at-point", { latitude: 51.3, longitude: -0.5, includeInferredLayers: true }, testContext(fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1][0] as string).searchParams.get("QUERY_LAYERS")).toContain("BGS.50k.Artificial.ground");
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ theme: "bedrock", unit: "CHALK GROUP", lithology: "CHALK" });
    expect(result.summary).toContain("Superficial deposits: none mapped at this point");
  });

  it("queries the 625k OGC API with a bbox around the point", async () => {
    const fetch = vi.fn(routedFetch([{ match: "bgsgeology625kbedrock/items", body: bedrock }, { match: "bgsgeology625ksuperficial/items", body: { type: "FeatureCollection", features: [] } }]));
    const result = await runOperation(definition, "geology-625k", { latitude: 51.5, longitude: -0.12 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/collections/bgsgeology625kbedrock/items");
    expect(url.searchParams.get("bbox")).toBe("-0.120200,51.499800,-0.119800,51.500200");
    expect(url.searchParams.get("f")).toBe("json");
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]).toMatchObject({ theme: "bedrock", unit: "CLAY, SILT, SAND AND GRAVEL (THAMES GROUP)", age: "EOCENE", scale: "1:625,000" });
    expect(result.summary).toContain("superficial: none mapped");
  });

  it("returns unavailable on an empty response and validates before the network", async () => {
    const empty = await runOperation(definition, "geology-at-point", { latitude: 56, longitude: -3 }, testContext(vi.fn<FetchLike>(async () => new Response("", { status: 200 }))));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "geology-at-point", { latitude: 91, longitude: 0 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
