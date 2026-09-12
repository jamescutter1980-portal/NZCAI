import { describe, expect, it, vi } from "vitest";
import { testContext } from "../../testing";
import { parseCapabilitiesLayers, parseFeatureInfo, wmsFeatureInfo, wmsFeatureInfoUrl, wmsServiceException } from "../wms";

describe("wms helper", () => {
  it("builds a 1.3.0 GetFeatureInfo URL centred on the point in CRS:84", () => {
    const url = new URL(wmsFeatureInfoUrl("https://example.org/WMSServer", { layers: ["A", "B"], latitude: 51.5, longitude: -0.1 }));
    expect(url.searchParams.get("REQUEST")).toBe("GetFeatureInfo");
    expect(url.searchParams.get("VERSION")).toBe("1.3.0");
    expect(url.searchParams.get("CRS")).toBe("CRS:84");
    expect(url.searchParams.get("QUERY_LAYERS")).toBe("A,B");
    expect(url.searchParams.get("I")).toBe("50");
    expect(url.searchParams.get("J")).toBe("50");
    const bbox = url.searchParams.get("BBOX")!.split(",").map(Number);
    expect(bbox[0]).toBeLessThan(-0.1);
    expect(bbox[2]).toBeGreaterThan(-0.1);
    expect((bbox[0] + bbox[2]) / 2).toBeCloseTo(-0.1, 6);
    expect((bbox[1] + bbox[3]) / 2).toBeCloseTo(51.5, 6);
  });

  it("parses GeoJSON, ArcGIS text/plain and HTML tables", () => {
    expect(parseFeatureInfo('{"type":"FeatureCollection","features":[{"properties":{"LEX_D":"LONDON CLAY"}}]}').features[0].properties).toEqual({ LEX_D: "LONDON CLAY" });
    const text = "GetFeatureInfo results:\n\nLayer 'BGS.50k.Bedrock'\n  Feature 1:\n    LEX_D = 'LONDON CLAY FORMATION'\n    RCS_D = 'CLAY, SILT AND SAND'\n";
    const t = parseFeatureInfo(text);
    expect(t.format).toBe("text");
    expect(t.features[0]).toEqual({ layer: "BGS.50k.Bedrock", properties: { LEX_D: "LONDON CLAY FORMATION", RCS_D: "CLAY, SILT AND SAND" } });
    const html = "<html><body><table><tr><th>LEX_D</th><th>RCS_D</th></tr><tr><td>LONDON CLAY</td><td>CLAY</td></tr></table></body></html>";
    expect(parseFeatureInfo(html).features[0].properties).toEqual({ LEX_D: "LONDON CLAY", RCS_D: "CLAY" });
    expect(parseFeatureInfo("").format).toBe("empty");
  });

  it("falls back through INFO_FORMATs on a ServiceException", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("INFO_FORMAT=application%2Fjson")) {
        return new Response('<?xml version="1.0"?><ServiceExceptionReport><ServiceException>Parameter INFO_FORMAT contains unacceptable value</ServiceException></ServiceExceptionReport>', { status: 200 });
      }
      return new Response("Layer 'X'\n Feature 1:\n  A = '1'\n", { status: 200 });
    });
    const res = await wmsFeatureInfo(testContext(fetch), "https://example.org/WMSServer", { layers: ["X"], latitude: 51, longitude: -1 });
    expect(calls).toHaveLength(2);
    expect(res.infoFormat).toBe("text/plain");
    expect(res.features[0].properties).toEqual({ A: "1" });
    expect(wmsServiceException("<ServiceException>boom</ServiceException>")).toBe("boom");
  });

  it("lists named layers from GetCapabilities", () => {
    const xml = `<WMS_Capabilities><Capability><Layer><Title>Root</Title><Layer queryable="1"><Name>0</Name><Title>Coal Mining Reporting Area</Title></Layer><Layer queryable="0"><Name>1</Name><Title>Other</Title></Layer></Layer></Capability></WMS_Capabilities>`;
    expect(parseCapabilitiesLayers(xml)).toEqual([
      { name: "0", title: "Coal Mining Reporting Area", queryable: true },
      { name: "1", title: "Other", queryable: false },
    ]);
  });
});
