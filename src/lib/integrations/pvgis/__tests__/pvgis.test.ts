// Fixtures follow the documented PVGIS 5.x JSON output (inputs / outputs.totals.fixed /
// outputs.monthly.fixed for PVcalc; outputs.monthly[] for MRcalc). Values are illustrative
// and were not produced by a live call.
import { describe, expect, it, vi } from "vitest";
import { compassFromPvgisAspect, definition, pvgisAspectFromCompass } from "..";
import { runOperation, testContext } from "../../testing";
import pvcalc from "./fixtures/pvcalc.json";
import mrcalc from "./fixtures/mrcalc.json";

describe("pvgis", () => {
  it("converts between compass bearings and PVGIS aspect", () => {
    expect(pvgisAspectFromCompass(180)).toBe(0);
    expect(pvgisAspectFromCompass(90)).toBe(-90);
    expect(pvgisAspectFromCompass(270)).toBe(90);
    expect(pvgisAspectFromCompass(0)).toBe(-180);
    expect(compassFromPvgisAspect(0)).toBe(180);
    expect(compassFromPvgisAspect(-90)).toBe(90);
    expect(compassFromPvgisAspect(90)).toBe(270);
  });

  it("builds the PVcalc URL on v5_3 and maps totals and monthly rows", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(pvcalc), { status: 200 }));
    const result = await runOperation(definition, "pv-yield", { latitude: 51.501, longitude: -0.142, peak_power_kwp: 4, tilt_deg: 35, azimuth_deg: 180, loss_pct: 14 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://re.jrc.ec.europa.eu/api/v5_3/PVcalc");
    expect(url.searchParams.get("peakpower")).toBe("4");
    expect(url.searchParams.get("aspect")).toBe("0");
    expect(url.searchParams.get("angle")).toBe("35");
    expect(url.searchParams.get("mountingplace")).toBe("building");
    expect(url.searchParams.get("outputformat")).toBe("json");
    expect(url.searchParams.get("optimalangles")).toBe("0");
    expect(result.rows).toHaveLength(12);
    expect(result.rows?.[0]).toEqual({ month: "Jan", energy_kwh: 112, energy_per_day_kwh: 3.6, in_plane_irradiation_kwh_m2: 34.7, sd_kwh: 21 });
    expect(result.summary).toContain("3612 kWh/yr");
    expect(result.summary).toContain("903 kWh/kWp");
    expect(result.summary).toContain("1148 kWh/m²/yr");
    expect(result.provenance).toMatchObject({ source: "pvgis", basis: "modelled", version: "PVGIS-SARAH3" });
    expect(result.warnings?.[0]).toMatch(/not a system design/);
  });

  it("sets the optimisation flags", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(pvcalc), { status: 200 }));
    await runOperation(definition, "pv-yield", { latitude: 51.5, longitude: -0.14, peak_power_kwp: 10, optimise: "both" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("optimalangles")).toBe("1");
  });

  it("averages MRcalc months across years", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(mrcalc), { status: 200 }));
    const result = await runOperation(definition, "monthly-irradiation", { latitude: 51.5, longitude: -0.14 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.pathname.endsWith("/MRcalc")).toBe(true);
    expect(url.searchParams.get("horirrad")).toBe("1");
    expect(url.searchParams.get("optrad")).toBe("1");
    expect(result.rows).toEqual([
      { month: "Jan", horizontal_kwh_m2: 23.5, optimal_tilt_kwh_m2: 36, air_temp_c: 5.2, years: 2 },
      { month: "Feb", horizontal_kwh_m2: 43.1, optimal_tilt_kwh_m2: 62, air_temp_c: 7.3, years: 2 },
    ]);
    expect(result.summary).toContain("2022-2023");
  });

  it("reports the optimal angles", async () => {
    const body = { ...pvcalc, inputs: { ...pvcalc.inputs, mounting_system: { fixed: { slope: { value: 38, optimal: true }, azimuth: { value: -3, optimal: true } } } } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await runOperation(definition, "optimal-tilt", { latitude: 51.5, longitude: -0.14 }, testContext(fetch));
    expect(result.rows?.[0]).toMatchObject({ optimal_tilt_deg: 38, optimal_orientation_compass_deg: 177, yield_kwh_per_kwp: 3612 });
  });

  it("returns an empty result for a point PVGIS rejects", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: "Location over the sea. Please, select another location" }), { status: 400 }));
    const result = await runOperation(definition, "pv-yield", { latitude: 50, longitude: -10, peak_power_kwp: 4 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.summary).toContain("over the sea");
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "pv-yield", { latitude: 51.5, longitude: -0.14 }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "pv-yield", { latitude: 51.5, longitude: -0.14, peak_power_kwp: -1 }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
