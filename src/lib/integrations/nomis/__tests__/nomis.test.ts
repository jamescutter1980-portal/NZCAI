// Fixtures follow the Nomis SDMX-JSON (def.sdmx.json) and .data.json shapes as parsed by
// open-source wrappers (ouseful-datasupply/nomisweb, traffordDataLab pipelines); not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, parseDimensionLines } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import ts061 from "./fixtures/ts061-data.json";

const defs = {
  structure: {
    keyfamilies: {
      keyfamily: [
        {
          id: "NM_2078_1",
          agencyid: "NOMIS",
          name: { value: "TS061 - Method used to travel to work" },
          annotations: { annotation: [{ annotationtitle: "MetadataText0", annotationtext: "Census 2021 estimates by method of travel to work." }, { annotationtitle: "contenttype/sources", annotationtext: "census_2021_ts" }] },
          components: { dimension: [{ codelist: "CL_2078_1_GEOGRAPHY", conceptref: "GEOGRAPHY" }, { codelist: "CL_2078_1_C2021_TTWMETH_12", conceptref: "C2021_TTWMETH_12" }] },
        },
      ],
    },
  },
};
const geog = { structure: { codelists: { codelist: [{ id: "CL_2078_1_GEOGRAPHY", code: [{ value: "645922841", description: { value: "Bolton" }, annotations: { annotation: [{ annotationtitle: "GeogCode", annotationtext: "E08000001" }] } }, { value: "645922842", description: { value: "Bury" } }] }] } } };

describe("nomis", () => {
  it("searches datasets with the name:* wildcard", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(defs), { status: 200 }));
    const result = await runOperation(definition, "search_datasets", { term: "travel to work" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://www.nomisweb.co.uk/api/v01/dataset/def.sdmx.json?search=name%3A*travel*to*work*");
    expect(result.rows?.[0]).toMatchObject({ dataset_id: "NM_2078_1", dimensions: "GEOGRAPHY, C2021_TTWMETH_12", source: "census_2021_ts" });
  });

  it("lists geography codes for a TYPE and filters by name", async () => {
    const fetch = routedFetch([{ match: "/geography/TYPE150.def.sdmx.json", body: geog }]);
    const result = await runOperation(definition, "geography_codes", { dataset_id: "NM_2078_1", type: "type150", search: "bolton" }, testContext(fetch));
    expect(result.rows).toEqual([{ nomis_code: "645922841", name: "Bolton", gss_code: "E08000001" }]);
  });

  it("fetches TS061 and pairs counts with percentages per mode", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(ts061), { status: 200 }));
    const result = await runOperation(definition, "travel_to_work", { geography: "645922841" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/v01/dataset/NM_2078_1.data.json");
    expect(url.searchParams.get("c2021_ttwmeth_12")).toBe("0...11");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[1]).toMatchObject({ mode: "Work mainly at or from home", count: 37500, percent: 30 });
    expect(result.summary).toContain("30% mainly working from home");
    expect(result.provenance).toMatchObject({ source: "nomis", basis: "measured", licence: "OGL" });
  });

  it("passes dimension lines through to the generic data call and returns empty for no obs", async () => {
    expect(parseDimensionLines("sex=7\n item = 1\ngeography=999")).toEqual({ sex: "7", item: "1", geography: "999" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ obs: [] }), { status: 200 }));
    const result = await runOperation(definition, "data", { dataset_id: "NM_1_1", geography: "2092957697", dimensions: "sex=7\ngeography=1" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("sex")).toBe("7");
    expect(url.searchParams.get("geography")).toBe("2092957697");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects a missing geography before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "travel_to_work", {}, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
