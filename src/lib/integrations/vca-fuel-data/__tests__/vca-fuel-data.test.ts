import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { definition, parseVca } from "..";
import { runOperation, testContext } from "../../testing";

// Fixture files under fixtures/reference/vca-fuel-data/ are SYNTHETIC: the
// manufacturers (ZETAMOTORS, OMEGA CARS), models and every figure are invented.
// 2024.csv follows the WLTP-era Euro_6_latest header and 2011.csv the
// NEDC-era header, both as seen in open-source copies of the VCA downloads;
// no file was downloaded from the VCA here.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });
const file = (name: string) => ({ name, path: "/dev/null", modifiedAt: "2026-08-01T00:00:00.000Z", sizeBytes: 1 });

describe("vca-fuel-data", () => {
  it("parses both header generations and rejects a file without the core columns", () => {
    const nedc = parseVca("Manufacturer,Model,Description,Transmission,Engine Capacity,Fuel Type,Metric Combined,Imperial Combined,CO2 g/km,Euro Standard\nX,Y,Z,M5,1000,Petrol,5.5,51.4,128,5\n", 2011, file("2011.csv"));
    expect(nedc.scheme).toBe("NEDC");
    expect(nedc.rows[0]).toMatchObject({ manufacturer: "X", co2_g_km: 128, co2_reporting_g_km: 128, combined_l_100km: 5.5, combined_mpg: 51.4, euro_standard: "5", test_scheme: "NEDC" });
    expect(() => parseVca("Make,Type\nA,B\n", 2020, file("2020.csv"))).toThrow(/header|missing columns/);
  });

  it("searches by make across loaded years, newest first, mapping WLTP and NEDC rows", async () => {
    const res = await runOperation(definition, "search", { make: "zetamotors" }, ctx());
    expect(res.rows?.map((r) => [r.year, r.description])).toEqual([
      [2024, "1.8 Hybrid 140bhp"],
      [2024, "2.0 Plug-in 220bhp"],
      [2024, "Long Range 77kWh"],
      [2011, '1.6 Petrol with 16" wheels'],
      [2011, "1.6 Diesel"],
    ]);
    expect(res.rows?.[0]).toMatchObject({ fuel_type: "Petrol Hybrid", powertrain: "Hybrid Electric Vehicle (HEV)", euro_standard: "Euro 6d", test_scheme: "WLTP", co2_g_km: 107, co2_reporting_g_km: 107, combined_l_100km: 4.7, combined_mpg: 60.1, engine_cc: 1798, engine_power_ps: 140, nox_mg_km: 10, noise_db: 66, date_of_change: "01 March 2024" });
    expect(res.rows?.[3]).toMatchObject({ test_scheme: "NEDC", co2_g_km: 146, combined_l_100km: 6.3, combined_mpg: 44.8, euro_standard: "5", model: "Zeta 300, Model Year 2011" });
    expect(res.summary).toContain("5 variant(s)");
    expect(res.summary).toContain("WLTP/NEDC");
    expect(res.provenance).toMatchObject({ source: "vca-fuel-data", basis: "measured", licence: "OGL" });
    expect(res.provenance.version).toMatch(/^2024; file 2024\.csv; modified .*\| 2011; file 2011\.csv/);
  });

  it("uses the weighted CO2 for plug-in hybrids and Wh/km for battery-electric rows", async () => {
    const phev = await runOperation(definition, "search", { make: "ZetaMotors", model: "plug-in", year: 2024 }, ctx());
    expect(phev.rows).toHaveLength(1);
    expect(phev.rows?.[0]).toMatchObject({ co2_g_km: 159, co2_weighted_g_km: 27, co2_reporting_g_km: 27, combined_l_100km: 1.2, electric_range_km: 88 });
    expect(phev.warnings?.some((w) => /plug-in hybrids/.test(w))).toBe(true);
    const ev = await runOperation(definition, "search", { make: "zeta", fuel_type: "electricity" }, ctx());
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows?.[0]).toMatchObject({ co2_g_km: 0, electric_wh_km: 152, electric_miles_kwh: 4.1, electric_range_km: 520, euro_standard: "" });
  });

  it("filters by model words and fuel type, and returns unavailable for no match or a missing year", async () => {
    const diesel = await runOperation(definition, "search", { make: "omega", fuel_type: "diesel" }, ctx());
    expect(diesel.rows?.map((r) => r.model)).toEqual(["Omega Van"]);
    expect(diesel.rows?.[0]).toMatchObject({ transmission: "M6", co2_g_km: 165, euro_standard: "Euro 6d-TEMP" });
    const none = await runOperation(definition, "search", { make: "nobody" }, ctx());
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
    const missing = await runOperation(definition, "search", { make: "zeta", year: 2019 }, ctx());
    expect(missing.rows).toEqual([]);
    expect(missing.summary).toContain("2019.csv");
    const empty = await runOperation(definition, "search", { make: "zeta" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(empty.provenance.basis).toBe("unavailable");
  });

  it("caps rows at the limit and lists loaded files with the scheme detected", async () => {
    const capped = await runOperation(definition, "search", { make: "zeta", limit: 2 }, ctx());
    expect(capped.rows).toHaveLength(2);
    expect(capped.warnings?.some((w) => /5 rows matched; showing the first 2/.test(w))).toBe(true);
    const files = await runOperation(definition, "files", {}, ctx());
    expect(files.rows?.map((r) => [r.year, r.rows, r.test_scheme, r.manufacturers])).toEqual([
      [2024, 4, "WLTP", 2],
      [2011, 2, "NEDC", 1],
    ]);
  });

  it("returns links without the network and validates before reading files", async () => {
    const fetch = vi.fn();
    const res = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(res.links?.some((l) => l.url.includes("carfueldata.vehicle-certification-agency.gov.uk/downloads"))).toBe(true);
    await expect(runOperation(definition, "search", { model: "x" }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "search", { make: "x", year: 1990 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "search", { make: "x", limit: 500 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(definition.status).toBe("built_unverified");
  });
});
