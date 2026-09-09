// Fixtures follow the { data: [[...]], meta: [...] } shape documented in the SheffieldSolar/PV_Live-API client;
// values are illustrative, not captured from a live call.
import { describe, expect, it, vi } from "vitest";
import { dailyTotals, definition } from "..";
import { runOperation, testContext } from "../../testing";
import latest from "./fixtures/latest.json";
import range from "./fixtures/range.json";

describe("pv-live", () => {
  it("maps the meta array onto the latest national row", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(latest), { status: 200 }));
    const result = await runOperation(definition, "national_latest", {}, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.pvlive.uk/pvlive/api/v4/pes/0?extra_fields=installedcapacity_mwp%2Ccapacity_mwp");
    expect(result.rows?.[0]).toMatchObject({ period_end_gmt: "2026-09-09T11:30:00Z", generation_mw: 6543.2, installed_capacity_mwp: 18250, load_factor_pct: 36.6 });
    expect(result.provenance).toMatchObject({ source: "pv-live", basis: "estimated" });
  });

  it("chunks a range into 30-day windows, sorts ascending and de-duplicates", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(range), { status: 200 });
    });
    const result = await runOperation(definition, "national_range", { resolution: "half_hourly", from: "2026-08-01", to: "2026-08-31" }, testContext(fetch));
    expect(calls).toEqual([
      "https://api.pvlive.uk/pvlive/api/v4/pes/0?start=2026-08-01T00%3A00%3A00Z&end=2026-08-31T00%3A00%3A00Z&extra_fields=installedcapacity_mwp%2Ccapacity_mwp&period=30",
      "https://api.pvlive.uk/pvlive/api/v4/pes/0?start=2026-08-31T00%3A00%3A00Z&end=2026-09-01T00%3A00%3A00Z&extra_fields=installedcapacity_mwp%2Ccapacity_mwp&period=30",
    ]);
    expect(result.rows?.map((r) => r.period_end_gmt)).toEqual(["2026-09-01T12:00:00Z", "2026-09-01T12:30:00Z", "2026-09-01T13:00:00Z", "2026-09-02T00:00:00Z"]);
    expect(result.summary).toContain("peak 8000 MW");
  });

  it("builds daily totals with the midnight period assigned to the previous day", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(range), { status: 200 }));
    const result = await runOperation(definition, "national_range", { resolution: "daily", from: "2026-09-01", to: "2026-09-02" }, testContext(fetch));
    expect(result.rows).toEqual([{ date: "2026-09-01", generation_mwh: 10500, peak_mw: 8000, peak_period_end_gmt: "2026-09-01T13:00:00Z", periods: 4 }]);
    expect(dailyTotals([])).toEqual([]);
  });

  it("returns an empty result for a region with no data", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ data: [], meta: ["pes_id", "datetime_gmt", "generation_mw"] }), { status: 200 }));
    const result = await runOperation(definition, "regional_range", { entity: "pes", id: 12, from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toContain("/pes/12?start=2026-08-01T00%3A00%3A00Z&end=2026-08-03T00%3A00%3A00Z");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects over-long ranges and bad ids before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "national_range", { resolution: "half_hourly", from: "2026-01-01", to: "2026-03-01" }, testContext(fetch))).rejects.toThrow(/maximum is 31 days/);
    await expect(runOperation(definition, "national_range", { resolution: "daily", from: "2026-01-01", to: "2026-06-01" }, testContext(fetch))).rejects.toThrow(/maximum is 92 days/);
    await expect(runOperation(definition, "regional_range", { entity: "pes", id: "abc", from: "2026-01-01", to: "2026-01-02" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
