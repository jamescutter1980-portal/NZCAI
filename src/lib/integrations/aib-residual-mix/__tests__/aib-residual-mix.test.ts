import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

// The fixture residual-mix.csv is SYNTHETIC: 1.111, 2.222 and 3.333 gCO2/kWh are
// invented values, and the publication names say so. Only the column layout is real.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });

describe("aib-residual-mix", () => {
  it("returns the latest year for a country by default and the publication in provenance", async () => {
    const res = await runOperation(definition, "residual_mix", { country_code: "gb" }, ctx());
    expect(res.rows?.[0]).toMatchObject({ data_year: 2025, country_code: "GB", residual_mix_gco2_per_kwh: 1.111, direct_co2_only: true });
    expect(res.provenance.basis).toBe("measured");
    expect(res.provenance.version).toContain("SYNTHETIC TEST PUBLICATION 2025 (2026-05-28)");
    expect(res.provenance.version).toContain("file residual-mix.csv");
    expect(res.warnings?.some((w) => w.includes("contractual instrument"))).toBe(true);
    expect(res.links?.[0].url).toBe("https://example.invalid/aib-2025");
  });

  it("selects a specific data year", async () => {
    const res = await runOperation(definition, "residual_mix", { country_code: "GB", data_year: 2024 }, ctx());
    expect(res.rows?.[0]).toMatchObject({ data_year: 2024, residual_mix_gco2_per_kwh: 2.222 });
  });

  it("treats a blank value as unavailable, not 0, and a missing country as not found", async () => {
    const blank = await runOperation(definition, "residual_mix", { country_code: "XX" }, ctx());
    expect(blank.rows?.[0]).toMatchObject({ country: "Nowhere, Land", residual_mix_gco2_per_kwh: null, availability: "unavailable" });
    expect(blank.provenance.basis).toBe("unavailable");
    const none = await runOperation(definition, "residual_mix", { country_code: "FR" }, ctx());
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
  });

  it("lists rows newest first with an optional country filter", async () => {
    const res = await runOperation(definition, "list", {}, ctx());
    expect(res.rows).toHaveLength(4);
    expect(res.rows?.[0].data_year).toBe(2025);
    const gb = await runOperation(definition, "list", { country_code: "GB" }, ctx());
    expect(gb.rows?.map((r) => r.data_year)).toEqual([2025, 2024]);
  });

  it("handles a missing file without throwing", async () => {
    const res = await runOperation(definition, "residual_mix", { country_code: "GB" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(res.rows).toEqual([]);
    expect(res.summary).toContain("residual-mix.csv");
  });

  it("rejects missing params before reading files and never fetches", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "residual_mix", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    const links = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(links.links?.[0].url).toBe("https://www.aib-net.org/facts/european-residual-mix");
    expect(fetch).not.toHaveBeenCalled();
  });
});
