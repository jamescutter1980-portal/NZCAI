import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

// vTEST.csv is SYNTHETIC: 111.1, 99.9, 555.5 ... are invented numbers, not UK NZCBS limits.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });

describe("uk-nzcbs", () => {
  it("returns limits for a sector, including year-less rows, with unavailable rows kept distinct from 0", async () => {
    const res = await runOperation(definition, "limits", { sector: "office", year: 2025 }, ctx());
    expect(res.rows?.map((r) => r.metric)).toEqual(["operational_energy_eui", "embodied_upfront", "onsite_renewables"]);
    expect(res.rows?.[0]).toMatchObject({ limit_value: 111.1, unit: "kWh/m2/yr", availability: "available", notes: "SYNTHETIC value, GIA basis" });
    expect(res.rows?.[2]).toMatchObject({ limit_value: null, availability: "unavailable", year: null });
    expect(res.provenance.basis).toBe("measured");
    expect(res.provenance.version).toMatch(/^vTEST; file vTEST\.csv; modified /);
    expect(res.warnings?.[0]).toMatch(/not 0/);
  });

  it("filters by metric and year", async () => {
    const res = await runOperation(definition, "limits", { sector: "Office", metric: "energy_eui", year: 2030 }, ctx());
    expect(res.rows).toHaveLength(1);
    expect(res.rows?.[0]).toMatchObject({ year: 2030, limit_value: 99.9 });
  });

  it("reports unknown sectors and versions as unavailable", async () => {
    const res = await runOperation(definition, "limits", { sector: "Hospital" }, ctx());
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
    expect(res.summary).toContain("Office, Retail");
    const v = await runOperation(definition, "limits", { sector: "Office", version: "v99" }, ctx());
    expect(v.summary).toContain("v99.csv");
  });

  it("lists versions and validates before reading", async () => {
    const res = await runOperation(definition, "versions", {}, ctx());
    expect(res.rows?.[0]).toMatchObject({ version: "vTEST", rows: 5, sectors: "Office, Retail" });
    const fetch = vi.fn();
    await expect(runOperation(definition, "limits", { sector: "Office", year: 99 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
