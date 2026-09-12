import { describe, expect, it, vi } from "vitest";
import { definition, DEFAULT_DATA_VERSION } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import search from "./fixtures/search.json";
import estimate from "./fixtures/estimate.json";
import spend from "./fixtures/spend.json";
const jsonFetch = (body: unknown, status = 200) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

// Fixtures follow the documented Climatiq response shapes (API reference and
// public client code); they are not live captures and every number is synthetic.
const env = { CLIMATIQ_API_KEY: "test-key" };

describe("climatiq", () => {
  it("searches with the key as a Bearer token and the default data version, mapping provenance fields into rows", async () => {
    const fetch = jsonFetch(search, 200);
    const res = await runOperation(definition, "search", { query: "residual mix", year: 2025, source: "AIB" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.climatiq.io/data/v1/search");
    expect(u.searchParams.get("query")).toBe("residual mix");
    expect(u.searchParams.get("data_version")).toBe(DEFAULT_DATA_VERSION);
    expect(u.searchParams.get("region")).toBe("GB");
    expect(u.searchParams.get("year")).toBe("2025");
    expect(u.searchParams.get("source")).toBe("AIB");
    expect(u.searchParams.get("results_per_page")).toBe("25");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(res.rows?.[0]).toMatchObject({ activity_id: "electricity-supply_grid-source_residual_mix", factor: 1.111, source: "AIB", region: "GB", year: 2025, factor_id: "00000000-1111-2222-3333-444444444444", data_version: DEFAULT_DATA_VERSION });
    expect(res.provenance).toMatchObject({ source: "climatiq", basis: "measured", version: DEFAULT_DATA_VERSION, licence: "commercial" });
  });

  it("honours CLIMATIQ_DATA_VERSION and a per-call override", async () => {
    const fetch = jsonFetch(search, 200);
    await runOperation(definition, "search", { query: "x" }, testContext(fetch, { ...env, CLIMATIQ_DATA_VERSION: "^30" }));
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("data_version")).toBe("^30");
    await runOperation(definition, "search", { query: "x", data_version: "36" }, testContext(fetch, { ...env, CLIMATIQ_DATA_VERSION: "^30" }));
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("data_version")).toBe("36");
  });

  it("posts an estimate with typed parameters and records the factor in provenance", async () => {
    const fetch = jsonFetch(estimate, 200);
    const res = await runOperation(definition, "estimate", { activity_id: "electricity-supply_grid-source_residual_mix", parameter_type: "energy", quantity: "1000", unit: "kWh", year: 2025 }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.climatiq.io/data/v1/estimate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      emission_factor: { activity_id: "electricity-supply_grid-source_residual_mix", data_version: DEFAULT_DATA_VERSION, region: "GB", year: 2025 },
      parameters: { energy: 1000, energy_unit: "kWh" },
    });
    expect(res.rows?.[0]).toMatchObject({ co2e_kg: 1111, activity_value: 1000, activity_unit: "kWh", source: "AIB", region: "GB", year: 2025, factor_id: "00000000-1111-2222-3333-444444444444", co2: 1100 });
    expect(res.provenance.basis).toBe("estimated");
    expect(res.provenance.version).toContain("factor 00000000-1111-2222-3333-444444444444 (AIB GB 2025)");
    expect(res.warnings?.[0]).toBe("info: Synthetic notice");
  });

  it("builds a money parameter set for spend-type activity factors", async () => {
    const fetch = jsonFetch(estimate, 200);
    await runOperation(definition, "estimate", { activity_id: "x", parameter_type: "money", quantity: 50, unit: "gbp", region: "" }, testContext(fetch, env));
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.parameters).toEqual({ money: 50, money_unit: "gbp" });
    expect(body.emission_factor.region).toBe("GB"); // blank region falls back to the GB default
  });

  it("posts a procurement spend request by classification code and by activity id", async () => {
    const fetch = routedFetch([{ match: "/procurement/v1/spend", body: spend }]);
    const spy = vi.fn(fetch);
    const res = await runOperation(definition, "spend", { classification_type: "nace2", code: "41.20", money: 100, money_unit: "GBP", spend_year: 2025, spend_region: "gb", tax_margin: 0.2 }, testContext(spy, env));
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ activity: { classification_code: "41.20", classification_type: "nace2" }, money: 100, money_unit: "gbp", spend_year: 2025, spend_region: "GB", tax_margin: 0.2 });
    expect(res.rows?.[0]).toMatchObject({ co2e: 2.222, source: "EXIOBASE", region: "GB", year: 2019, inflation_applied: 1.05, data_quality_flags: "notable_methodological_variance" });
    expect(res.provenance.basis).toBe("estimated");
    await runOperation(definition, "spend", { classification_type: "activity_id", code: "construction-type_construction_work", money: 1, money_unit: "eur", spend_year: 2024, spend_region: "DE" }, testContext(spy, env));
    expect(JSON.parse((spy.mock.calls[1][1] as RequestInit).body as string).activity).toEqual({ activity_id: "construction-type_construction_work" });
  });

  it("throws on auth failure and validates before any network call", async () => {
    const fetch = jsonFetch({ error: "Unauthorized" }, 401);
    await expect(runOperation(definition, "search", { query: "x" }, testContext(fetch, env))).rejects.toMatchObject({ status: 401 });
    const noCall = vi.fn();
    await expect(runOperation(definition, "estimate", { activity_id: "x", parameter_type: "volume", quantity: 1, unit: "l" }, testContext(noCall, env))).rejects.toThrow();
    await expect(runOperation(definition, "search", { query: "x", results_per_page: 500 }, testContext(noCall, env))).rejects.toThrow();
    await expect(runOperation(definition, "search", { query: "x" }, testContext(noCall, {}))).rejects.toThrow(/CLIMATIQ_API_KEY/);
    expect(noCall).not.toHaveBeenCalled();
  });
});
