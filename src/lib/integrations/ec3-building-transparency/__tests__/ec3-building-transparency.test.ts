import { describe, expect, it, vi } from "vitest";
import { buildMaterialFilter, definition, parseQuantity } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import materials from "./fixtures/materials.json";
import epd from "./fixtures/epd.json";
const jsonFetch = (body: unknown, status = 200) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

// Fixtures follow EC3 response shapes seen in public client code (bare arrays,
// "value unit" strings); not live captures, and every value is synthetic.
const env = { EC3_API_TOKEN: "ec3-token" };

describe("ec3-building-transparency", () => {
  it("parses string quantities", () => {
    expect(parseQuantity("1.111 kgCO2e")).toEqual({ value: 1.111, unit: "kgCO2e" });
    expect(parseQuantity("2400 kg / m3")).toEqual({ value: 2400, unit: "kg / m3" });
    expect(parseQuantity(5)).toEqual({ value: 5, unit: null });
    expect(parseQuantity(null)).toBeNull();
    expect(parseQuantity("n/a")).toBeNull();
  });

  it("builds the EC3 material filter string", () => {
    const mf = buildMaterialFilter("ReadyMix", "GB", "2026-09-09");
    expect(mf).toBe('!EC3 search("ReadyMix") WHERE\n  jurisdiction: IN("GB") AND\n  epd__date_validity_ends: > "2026-09-09" AND\n  epd_types: IN("Product EPDs")\n!pragma eMF("2.0/1"), lcia("EF 3.0")');
    expect(buildMaterialFilter("Insulation", undefined, "2026-01-01")).not.toContain("jurisdiction");
  });

  it("searches with the Bearer token and an mf filter, mapping rows with units preserved", async () => {
    const fetch = jsonFetch(materials, 200);
    const res = await runOperation(definition, "search", { category: "ReadyMix", name: "C32" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://buildingtransparency.org/api/materials");
    expect(u.searchParams.get("mf")).toContain('!EC3 search("ReadyMix") WHERE');
    expect(u.searchParams.get("mf")).toContain('jurisdiction: IN("GB")');
    expect(u.searchParams.get("mf")).toContain('epd__date_validity_ends: > "2026-09-09"'); // fixed test clock
    expect(u.searchParams.get("name__like")).toBe("C32");
    expect(u.searchParams.get("page_size")).toBe("25");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ec3-token");
    expect(res.rows?.[0]).toMatchObject({ id: "ec3syn001", gwp: 1.111, gwp_unit: "kgCO2e", gwp_raw: "1.111 kgCO2e", declared_unit: "1 m3", gwp_per_kg: 0.000463, category: "Ready Mix", manufacturer: "Synthetic Concrete Ltd", plant_or_group: "Synthetic Plant", jurisdiction: "GB", date_validity_ends: "2028-12-31", epd_link: "https://buildingtransparency.org/ec3/epds/ec3syn001" });
    expect(res.rows?.[1]).toMatchObject({ id: "ec3syn002", gwp: null, gwp_raw: null, jurisdiction: "IE" });
    expect(res.provenance).toMatchObject({ source: "ec3-building-transparency", basis: "measured" });
  });

  it("searches by name only with plain query filters when no category is given", async () => {
    const fetch = jsonFetch("[]", 200);
    const res = await runOperation(definition, "search", { name: "gypsum", jurisdiction: "US" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0]);
    expect(u.searchParams.get("mf")).toBeNull();
    expect(u.searchParams.get("jurisdiction")).toBe("US");
    expect(u.searchParams.get("name__like")).toBe("gypsum");
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
  });

  it("reads an EPD, flags expiry against the clock and reports 404 as unavailable", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/epds/ec3syn001", body: epd }, { match: "/epds/", status: 404, body: "{}" }]));
    const res = await runOperation(definition, "epd", { id: "ec3syn001" }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://buildingtransparency.org/api/epds/ec3syn001");
    expect(res.rows?.[0]).toMatchObject({ gwp: 1.111, declared_unit: "1 m3", program_operator: "Synthetic Programme Operator", pcr: "Synthetic PCR for concrete", date_of_issue: "2023-01-01" });
    expect(res.warnings?.[0]).toBe("EPD validity ended 2025-12-31.");
    expect(res.provenance).toMatchObject({ basis: "measured", version: "ec3syn001" });
    expect(res.links?.[0].url).toBe("https://buildingtransparency.org/ec3/epds/ec3syn001");
    const missing = await runOperation(definition, "epd", { id: "ec3nothing" }, testContext(fetch, env));
    expect(missing.rows).toEqual([]);
    expect(missing.provenance.basis).toBe("unavailable");
  });

  it("validates before fetching and surfaces auth errors", async () => {
    const noCall = vi.fn();
    await expect(runOperation(definition, "search", {}, testContext(noCall, env))).rejects.toThrow(/category or a name/);
    await expect(runOperation(definition, "epd", { id: "bad id!" }, testContext(noCall, env))).rejects.toThrow();
    await expect(runOperation(definition, "search", { category: "ReadyMix" }, testContext(noCall, {}))).rejects.toThrow(/EC3_API_TOKEN/);
    expect(noCall).not.toHaveBeenCalled();
    const denied = jsonFetch("{}", 401);
    await expect(runOperation(definition, "search", { category: "ReadyMix" }, testContext(denied, env))).rejects.toMatchObject({ status: 401 });
  });
});
