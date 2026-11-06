import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

/**
 * The integration reads the bundled Rev 1 tables (reference/uk-nzcbs/v1r1).
 * Every figure asserted here is a published Annex A value, cross-checked in
 * src/lib/nzcbs/__tests__/vectors.test.ts against the Standard's text.
 */
const ctx = () => testContext(vi.fn(), {});

describe("uk-nzcbs", () => {
  it("returns the OE-2 2025 Offices limit from the bundled tables", async () => {
    const res = await runOperation(definition, "limits", { table: "OE-2", sector: "Offices", subsector: "General", scope: "Whole building", year: 2025 }, ctx());
    expect(res.rows).toHaveLength(1);
    expect(res.rows?.[0]).toMatchObject({ table: "OE-2", sector: "Offices", subsector: "General", value: 105, unit: "kWh/m2GIA/yr", status: "limit" });
    expect(res.provenance.basis).toBe("measured");
    expect(res.provenance.version).toMatch(/^v1r1 \(UK Net Zero Carbon Buildings Standard, Version 1, Rev 1/);
    expect(res.summary).toContain("105 kWh/m2GIA/yr");
  });

  it("keeps no-limit rows distinct from zero and clamps the year", async () => {
    const res = await runOperation(definition, "limits", { table: "OE-4", sector: "Offices", subsector: "General", scope: "Whole building", year: 2019 }, ctx());
    expect(res.rows?.[0]).toMatchObject({ status: "no_limit", value: null, year: 2025 });
    expect(res.provenance.basis).toBe("not_applicable");
    expect(res.summary).toMatch(/no limit/);
  });

  it("reports an ambiguous query instead of guessing", async () => {
    const res = await runOperation(definition, "limits", { table: "OE-1", sector: "Offices", year: 2025 }, ctx());
    expect(res.rows!.length).toBeGreaterThan(1);
    expect(res.provenance.basis).toBe("unavailable");
    expect(res.summary).toMatch(/ambiguous/);
  });

  it("lists renewables targets and the other limits, including the PV discrepancy", async () => {
    const res = await runOperation(definition, "renewables_targets", {}, ctx());
    expect(res.rows?.find((r) => String(r.key).includes("C. South England, all other"))).toMatchObject({ value: 45 });
    expect(res.rows?.find((r) => r.key === "refrigerant_gwp_limit")).toMatchObject({ value: 677 });
    expect(res.rows?.find((r) => r.key === "pv_upfront_carbon")).toMatchObject({ value: 1000 });
    expect(res.rows?.find((r) => r.key === "pv_upfront_carbon_proforma")).toMatchObject({ value: 750 });
  });

  it("lists versions and reports an unknown version", async () => {
    const res = await runOperation(definition, "versions", {}, ctx());
    expect(res.rows?.[0]).toMatchObject({ version: "v1r1", source: "bundled", sectors: expect.stringContaining("Offices") });
    const v = await runOperation(definition, "limits", { table: "OE-2", sector: "Offices", year: 2025, version: "v99" }, ctx());
    expect(v.summary).toContain("v99 is not loaded");
    expect(v.provenance.basis).toBe("unavailable");
  });

  it("validates parameters before reading and never calls the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "limits", { table: "OE-2", sector: "Offices", year: 99 }, testContext(fetch, {}))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const health = await definition.healthCheck!(ctx());
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/checksums verified/);
  });
});
