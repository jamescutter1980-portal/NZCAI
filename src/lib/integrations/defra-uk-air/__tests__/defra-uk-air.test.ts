// Fixtures follow the 52North SOS REST shapes as used by open-source UK-AIR
// clients ([lat, lon, elev] coordinates, EIONET phenomenon ids, -99 missing sentinel).
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition, latLonOf, splitLabel } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import stations from "./fixtures/stations.json";
import timeseries from "./fixtures/timeseries.json";
import getdata from "./fixtures/getdata.json";

describe("defra-uk-air", () => {
  it("filters the station list by distance locally", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(stations), { status: 200 }));
    const result = await runOperation(definition, "stations-near", { latitude: 51.5, longitude: -0.14, radius: 10 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://uk-air.defra.gov.uk/sos-ukair/api/v1/stations");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ station_id: "1001", site: "London Marylebone Road", pollutant_label: "Nitrogen dioxide (air)", latitude: 51.52253, longitude: -0.15461 });
    expect(result.rows?.[0].distance_km).toBeLessThan(3);
    expect(result.summary).toContain("1 monitoring sites (2 station/pollutant entries)");
  });

  it("lists time series with pollutant from the EIONET id and unit", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(timeseries), { status: 200 }));
    const result = await runOperation(definition, "timeseries", { stationId: "1001" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/sos-ukair/api/v1/timeseries");
    expect(url.searchParams.get("station")).toBe("1001");
    expect(url.searchParams.get("expanded")).toBe("true");
    expect(result.rows?.[0]).toMatchObject({ timeseries_id: "5551", pollutant: "NO2", unit: "ug.m-3", site: "London Marylebone Road", last_value: 38.6, last_value_time: "2025-09-09T11:00:00.000Z" });
  });

  it("fetches recent data with a P7D/now timespan and drops -99 values", async () => {
    const ctx = testContext(routedFetch([
      { match: "/timeseries/5551/getData", body: getdata },
      { match: "/timeseries/5551", body: timeseries[0] },
    ]));
    const result = await runOperation(definition, "recent-data", { timeseriesId: "5551" }, ctx);
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[1].value).toBeNull();
    expect(result.summary).toContain("2 valid of 3 values for NO2 over 7 days: mean 38, min 30.1, max 45.9 ug.m-3");
    expect(result.provenance.basis).toBe("measured");
  });

  it("builds the timespan from the days parameter and handles empty data", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/getData", body: { values: [] } }, { match: "/timeseries/", status: 404, body: { message: "not found" } }]));
    const result = await runOperation(definition, "recent-data", { timeseriesId: "9", days: 3 }, testContext(fetch));
    const dataCall = fetch.mock.calls.map((c) => c[0] as string).find((u) => u.includes("getData"))!;
    expect(new URL(dataCall).searchParams.get("timespan")).toBe("P3D/now");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates before the network and exposes helpers", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "recent-data", { timeseriesId: "1", days: 90 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(latLonOf([-0.15, 51.5, 10])).toEqual({ lat: 51.5, lon: -0.15 });
    expect(splitLabel("Camden Kerbside-Nitrogen dioxide (air)")).toEqual({ site: "Camden Kerbside", pollutant: "Nitrogen dioxide (air)" });
    const links = await runOperation(definition, "links", {}, testContext(fetch));
    expect(links.links?.length).toBeGreaterThan(2);
  });
});
