// Fixtures mirror the Insights OpenAPI schemas (ActualGenerationBySettlementPeriod, AgptSummaryData,
// IndodRow, SystemPriceResponse, MarketIndexResponse); they were not captured from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";
import perType from "./fixtures/per-type.json";
import dayTotal from "./fixtures/day-total.json";
import indod from "./fixtures/indod.json";
import systemPrices from "./fixtures/system-prices.json";
import marketIndex from "./fixtures/market-index.json";

describe("elexon-insights", () => {
  it("pivots generation by fuel into a wide table with renewable and low-carbon shares", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(perType), { status: 200 }));
    const result = await runOperation(definition, "generation_by_fuel", { from: "2026-09-01", to: "2026-09-01" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://data.elexon.co.uk/bmrs/api/v1/generation/actual/per-type?from=2026-09-01T00%3A00Z&to=2026-09-02T00%3A00Z&format=json");
    expect(result.columns).toContain("wind_offshore");
    expect(result.rows?.[0]).toMatchObject({ settlement_period: 1, fossil_gas: 8000, wind_offshore: 5000, total_mw: 20000, renewable_pct: 40, low_carbon_pct: 60 });
    expect(result.rows?.[1]).toMatchObject({ renewable_pct: 50, low_carbon_pct: 70 });
    expect(result.summary).toContain("45% ");
    expect(result.provenance).toMatchObject({ source: "elexon-insights", basis: "measured" });
  });

  it("caps generation ranges at 7 days before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "generation_by_fuel", { from: "2026-09-01", to: "2026-09-10" }, testContext(fetch))).rejects.toThrow(/maximum is 7 days/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the bare-array day-total shape", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(dayTotal), { status: 200 }));
    const result = await runOperation(definition, "generation_day_total", {}, testContext(fetch));
    expect(result.rows).toHaveLength(4);
    expect(result.summary).toContain("42.3% renewable");
    expect(result.summary).toContain("Fossil Gas");
  });

  it("returns daily demand sorted by date with GWh totals", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(indod), { status: 200 }));
    const result = await runOperation(definition, "demand_outturn", { resolution: "daily", from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://data.elexon.co.uk/bmrs/api/v1/demand/outturn/daily?settlementDateFrom=2026-08-01&settlementDateTo=2026-08-02&format=json");
    expect(result.rows?.map((r) => r.settlement_date)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(result.summary).toContain("total 1005 GWh");
  });

  it("uses the half-hourly endpoint and rejects more than 7 days for it", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await runOperation(definition, "demand_outturn", { resolution: "half_hourly", from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toContain("/demand/outturn?settlementDateFrom=2026-08-01");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    await expect(runOperation(definition, "demand_outturn", { resolution: "half_hourly", from: "2026-08-01", to: "2026-08-20" }, testContext(vi.fn()))).rejects.toThrow();
  });

  it("orders system prices by settlement period and summarises the range", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(systemPrices), { status: 200 }));
    const result = await runOperation(definition, "system_prices", { settlement_date: "2026-09-01" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://data.elexon.co.uk/bmrs/api/v1/balancing/settlement/system-prices/2026-09-01?format=json");
    expect(result.rows?.map((r) => r.settlement_period)).toEqual([1, 2]);
    expect(result.summary).toContain("range £80 to £95.5/MWh");
  });

  it("filters market index by provider and computes a volume-weighted average", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(marketIndex), { status: 200 }));
    const result = await runOperation(definition, "market_index_prices", { from: "2026-09-01", to: "2026-09-01", provider: "APXMIDP" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toContain("dataProviders=APXMIDP");
    expect(result.summary).toContain("£85/MWh");
    const both = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(marketIndex), { status: 200 }));
    await runOperation(definition, "market_index_prices", { from: "2026-09-01", to: "2026-09-01", provider: "both" }, testContext(both));
    expect(both.mock.calls[0][0]).not.toContain("dataProviders");
  });
});
