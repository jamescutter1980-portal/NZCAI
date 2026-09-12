// Fixtures follow the interval-data and meter shapes used by open-source Openvolt clients (start_interval,
// consumption, consumption_units; customer/status/data_source); not captured from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import intervalData from "./fixtures/interval-data.json";
import meter from "./fixtures/meter.json";

const env = { OPENVOLT_API_KEY: "test-key" };

describe("openvolt", () => {
  it("builds the interval-data URL, sends x-api-key and normalises rows to kWh", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(intervalData), { status: 200 }));
    const result = await runOperation(definition, "interval_data", { meter_id: "6514167223e3d1424bf82742", granularity: "hh", start_date: "2026-08-01", end_date: "2026-08-01" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openvolt.com/v1/interval-data?meter_id=6514167223e3d1424bf82742&granularity=hh&start_date=2026-08-01T00%3A00%3A00Z&end_date=2026-08-02T00%3A00%3A00Z&type=consumption");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(result.rows?.[0]).toEqual({ interval_start: "2026-08-01T00:00:00.000Z", interval_end: null, kwh: 12.5, units: "kWh", meter_number: "1200012345678" });
    expect(result.rows?.[2].kwh).toBeNull();
    expect(result.summary).toContain("total 27.8 kWh");
    expect(result.provenance).toMatchObject({ source: "openvolt", basis: "measured", licence: "consent_based", consentRef: "openvolt-meter:6514167223e3d1424bf82742" });
  });

  it("maps a single meter and accepts several list envelopes", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(meter), { status: 200 }));
    const single = await runOperation(definition, "meter", { meter_id: "6514167223e3d1424bf82742" }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://api.openvolt.com/v1/meters/6514167223e3d1424bf82742");
    expect(single.rows?.[0]).toMatchObject({ meter_id: "6514167223e3d1424bf82742", customer: "Example Retail Ltd", postcode: "M1 1AE", status: "active" });
    for (const body of [[meter], { data: [meter] }, { meters: [meter] }]) {
      const list = await runOperation(definition, "list_meters", {}, testContext(vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 })), env));
      expect(list.rows).toHaveLength(1);
      expect(list.summary).toContain("1 active");
    }
  });

  it("returns an empty result when a meter is unknown", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ message: "Meter not found" }), { status: 404 }));
    const result = await runOperation(definition, "interval_data", { meter_id: "nope", granularity: "day", start_date: "2026-01-01", end_date: "2026-06-30" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("refuses to run without an API key and caps half-hourly ranges", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "list_meters", {}, testContext(fetch))).rejects.toThrow(/OPENVOLT_API_KEY/);
    await expect(runOperation(definition, "interval_data", { meter_id: "x", granularity: "hh", start_date: "2026-01-01", end_date: "2026-04-01" }, testContext(fetch, env))).rejects.toThrow(/maximum is 62 days/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
