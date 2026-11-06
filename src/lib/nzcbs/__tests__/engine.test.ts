import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessBuilding, classifyBuilding, classifySectors, operationalEnergyLimit, operationalLimitYear, regionFor, reportingPeriods, resolveLimits } from "..";
import { loadNzcbsReference, listReferenceVersions, NzcbsReferenceError } from "../reference";
import type { BuildingProfile, OperationalInputs } from "../types";

/**
 * Scenario tests for the engine on the bundled Rev 1 tables. Buildings and
 * figures are invented; every limit they are compared with is the published
 * one, read from the tables and cross-checked in vectors.test.ts.
 */

const ref = loadNzcbsReference({}, "v1r1")!;

const office = (over: Partial<BuildingProfile> = {}): BuildingProfile => ({
  rpep: "2027-03-31",
  giaM2: 5000,
  niaM2: 4000,
  footprintM2: 1000,
  region: "C. South England",
  areas: [{ sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 4000, giaM2: 5000 }],
  ...over,
});

const grid = { generation: 0.2, transmissionAndDistribution: 0.02, wttGeneration: 0.05, wttTransmissionAndDistribution: 0.005, reference: "synthetic" };

describe("reporting periods and limit year", () => {
  it("derives the ORP and ERP from the RPEP", () => {
    const p = reportingPeriods({ rpep: "2027-03-31" });
    expect(p.orp).toEqual({ from: "2026-03-31", to: "2027-03-31" });
    expect(p.erp.from).toBe("2022-03-31");
    expect(p.orpStartYear).toBe(2026);
  });
  it("starts the ERP at a previous RPEP within five years and flags a gap", () => {
    const p = reportingPeriods({ rpep: "2027-03-31", previousRpep: "2025-09-30" });
    expect(p.erp.from).toBe("2025-09-30");
    expect(p.reasons.join(" ")).toMatch(/gap in claim validity/);
  });
  it("Existing Building one-go route with no retrofit uses 2025", () => {
    const profile = office();
    const y = operationalLimitYear(profile, "Existing Building", reportingPeriods(profile));
    expect(y.year).toBe(2025);
  });
  it("Existing Building one-go route uses the latest Retrofit Works commencement", () => {
    const profile = office({ works: [{ id: "R1", type: "Retrofit Works", commencementDate: "2028-05-01", completionDate: "2029-01-01" }] });
    expect(operationalLimitYear(profile, "Existing Building", reportingPeriods(profile)).year).toBe(2028);
  });
  it("stepped route uses the ORP start year", () => {
    const profile = office({ operationalRoute: "stepped", rpep: "2031-01-01" });
    expect(operationalLimitYear(profile, "Existing Building", reportingPeriods(profile)).year).toBe(2030);
  });
  it("New Building uses the New Works commencement, or 2025 if more recent", () => {
    const profile = office({ works: [{ id: "N1", type: "New Works", commencementDate: "2023-01-01" }], previouslyClassifiedNewBuilding: true });
    expect(operationalLimitYear(profile, "New Building", reportingPeriods(profile)).year).toBe(2025);
  });
});

describe("classification", () => {
  it("Table 4: 50% new NIA makes a New Building", () => {
    const profile = office({ areas: [{ sector: "Offices", subsector: "General", niaM2: 2000, newArea: true }, { sector: "Offices", subsector: "General", niaM2: 2000 }] });
    expect(classifyBuilding(profile).value).toBe("New Building");
  });
  it("4.2.2: 30% unclassifiable cannot claim; a minor sector is omitted; Mixed-Use is named", () => {
    const profile = office({ areas: [{ sector: "Offices", subsector: "General", niaM2: 3000 }, { sector: "Retail", subsector: "High St. Retail", niaM2: 300 }, { sector: null, niaM2: 700 }] });
    const c = classifySectors(profile);
    expect(c.canClaim).toBe(true);
    expect(c.omitted.map((s) => s.sector)).toEqual(["Retail"]);
    expect(c.classification).toBe("Offices");
    const bad = classifySectors(office({ areas: [{ sector: "Offices", niaM2: 2800 }, { sector: null, niaM2: 1200 }] }));
    expect(bad.canClaim).toBe(false);
    const mixed = classifySectors(office({ areas: [{ sector: "Offices", subsector: "General", niaM2: 2400 }, { sector: "Retail", subsector: "High St. Retail", niaM2: 1600 }] }));
    expect(mixed.classification).toBe("Mixed-Use");
  });
  it("Table 9: Additional Uses must belong to the sector and be submetered", () => {
    const c = classifySectors(office({ areas: [{ sector: "Hotels", niaM2: 3600 }, { sector: "Hotels", niaM2: 200, additionalUse: "Laundry", submetered: true }, { sector: "Hotels", niaM2: 200, additionalUse: "Laundry", submetered: false }] }));
    expect(c.additionalUses.map((u) => u.allowed)).toEqual([true, false]);
    const wrong = classifySectors(office({ areas: [{ sector: "Offices", subsector: "General", niaM2: 3800 }, { sector: "Offices", niaM2: 200, additionalUse: "Laundry", submetered: true }] }));
    expect(wrong.additionalUses[0].allowed).toBe(false);
    expect(wrong.additionalUses[0].reason).toMatch(/not a Table 9 Additional Use/);
  });
  it("Annex A3 region from county", () => {
    expect(regionFor({ nation: "England", county: "Kent" }).value).toBe("C. South England");
    expect(regionFor({ nation: "England", county: "Greater Manchester" }).value).toBe("B. Middle and North England, Northern Ireland, Wales");
    expect(regionFor({ nation: "Scotland" }).value).toBe("A. Scotland");
    expect(regionFor({}).value).toBeNull();
  });
});

describe("limit selection", () => {
  it("single-sector Existing office: OE-2 2025 General whole building, 105 kWh/m2GIA", () => {
    const ctx = resolveLimits(ref, office());
    expect(ctx.operationalEnergy).toMatchObject({ status: "limit", value: 105, unit: "kWh/m2GIA/yr", table: "OE-2", year: 2025, method: "single" });
  });
  it("NIA basis for offices picks the NIA column", () => {
    const ctx = resolveLimits(ref, office({ areaBasis: "NIA" }));
    expect(ctx.operationalEnergy).toMatchObject({ value: 131, unit: "kWh/m2NIA/yr", areaBasis: "NIA" });
  });
  it("Equation 1a across Offices and a High Street shop in a New Building", () => {
    const profile = office({ previouslyClassifiedNewBuilding: true, areas: [{ sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 2400 }, { sector: "Retail", subsector: "High St. Retail", niaM2: 1600 }] });
    const ctx = resolveLimits(ref, profile);
    // OE-1 2025: Offices 90, High St. Retail 80 -> 0.6 x 90 + 0.4 x 80 = 86
    expect(ctx.operationalEnergy).toMatchObject({ status: "limit", value: 86, method: "equation_1a", table: "OE-1" });
  });
  it("Equation 1a omits Additional Uses, Data Centre areas and sectors without a limit", () => {
    const profile = office({ previouslyClassifiedNewBuilding: true, areas: [{ sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 2400 }, { sector: "Data Centres", subsector: "Low Utilisation", niaM2: 800 }, { sector: "Offices", subsector: "General", niaM2: 800, additionalUse: "Laundry", submetered: true }] });
    const ctx = resolveLimits(ref, profile);
    expect(ctx.operationalEnergy.value).toBe(90);
    expect(ctx.operationalEnergy.notes.join(" ")).toMatch(/Data Centre area/);
  });
  it("Equation 1b for an Existing Building with 30% New Area", () => {
    const profile = office({
      areas: [
        { sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 1200, giaM2: 1500, newArea: true },
        { sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 2800, giaM2: 3500 },
      ],
      works: [{ id: "N1", type: "New Works", commencementDate: "2025-06-01", completionDate: "2026-06-01" }],
    });
    const ctx = resolveLimits(ref, profile);
    // LN = OE-1 2025 = 90; LE = OE-2 2025 = 105; 0.3 x 90 + 0.7 x 105 + 0.3 x (90 - 105) = 96
    expect(ctx.operationalEnergy).toMatchObject({ status: "limit", value: 96, method: "equation_1b" });
  });
  it("Table 12 reclassifies a gym for limit-setting without changing the building's classification", () => {
    const profile = office({ previouslyClassifiedNewBuilding: true, areas: [{ sector: "Offices", subsector: "General", scope: "Whole building", niaM2: 3200 }, { sector: "Offices", niaM2: 800, particularUse: "gym" }] });
    const ctx = resolveLimits(ref, profile);
    expect(ctx.sectors.classification).toBe("Offices");
    expect(ctx.operationalEnergy.method).toBe("equation_1a");
    expect(ctx.operationalEnergy.components.map((c) => c.sector)).toEqual(["Offices", "Sport and Leisure"]);
  });
  it("embodied: EC-2 for Retrofit Works after Version 1; reported only before", () => {
    const profile = office({ works: [{ id: "R1", type: "Retrofit Works", commencementDate: "2026-09-01", completionDate: "2027-01-15", embodied: { upfrontKgCo2e: 1_000_000, giaM2: 5000 } }, { id: "R0", type: "Retrofit Works", commencementDate: "2025-01-01", completionDate: "2025-12-01", embodied: { upfrontKgCo2e: 500_000, giaM2: 5000 } }] });
    const ctx = resolveLimits(ref, profile);
    const r1 = ctx.embodied.find((e) => e.worksId === "R1")!;
    expect(r1).toMatchObject({ compare: true, table: "EC-2", year: 2026, status: "limit" });
    expect(ctx.embodied.find((e) => e.worksId === "R0")!.compare).toBe(false);
  });
  it("renewables target: South England office 45, halved by Equation 5, not below the kWp floor", () => {
    const ctx = resolveLimits(ref, office(), { systems: [], constraints: { unconstrainedAreaM2: 500, reasons: ["overshadowed_roofs"] } });
    expect(ctx.renewables).toMatchObject({ baseTarget: 45, target: 22.5, applies: true });
    const floor = resolveLimits(ref, office(), { systems: [], feasibleCapacityKwp: 3 });
    expect(floor.renewables.applies).toBe(false);
  });
  it("single-storey storage takes the higher target", () => {
    const ctx = resolveLimits(ref, office({ singleStorey: true, areas: [{ sector: "Storage and Distribution", subsector: "Unconditioned Storage", scope: "Whole building", niaM2: 4000 }] }));
    expect(ctx.renewables.baseTarget).toBe(75);
  });
  it("space heating limit only for New Building Homes", () => {
    const flats = office({ previouslyClassifiedNewBuilding: true, areas: [{ sector: "Homes", subsector: "Flats", niaM2: 4000 }] });
    expect(resolveLimits(ref, flats).spaceHeating).toMatchObject({ status: "limit", value: 15 });
    expect(resolveLimits(ref, office()).spaceHeating.status).toBe("no_limit");
  });
  it("reports an ambiguous office with no subsector instead of guessing", () => {
    const ctx = resolveLimits(ref, office({ areas: [{ sector: "Offices", niaM2: 4000 }] }));
    expect(ctx.operationalEnergy.status).toBe("not_assessable");
    expect(ctx.operationalEnergy.notes.join(" ")).toMatch(/more than one limit fits/);
  });
  it("operationalEnergyLimit is pure on its inputs", () => {
    const profile = office();
    const periods = reportingPeriods(profile);
    const w = operationalEnergyLimit(ref, profile, classifySectors(profile), "Existing Building", operationalLimitYear(profile, "Existing Building", periods));
    expect(w.value).toBe(105);
  });
});

describe("assessBuilding", () => {
  const inputs: OperationalInputs = {
    energy: {
      supplies: [
        { kind: "grid_electricity", kwh: 400_000, measurement: "meter_readings" },
        { kind: "onsite_renewable_electricity_used", kwh: 50_000, measurement: "meter_readings" },
        { kind: "natural_gas", kwh: 60_000, factorKgCo2ePerKwh: 0.21, measurement: "meter_readings" },
        { kind: "grid_electricity", kwh: 20_000, excluded: "car_park_submetered" },
      ],
      gridFactors: grid,
      occupancy: { totalGiaM2: 5000, unoccupiableGiaM2: 500, occupiedGiaM2: 4000 },
    },
    renewables: { systems: [{ technology: "photovoltaics", capacityKw: 60, generatedKwh: 55_000, exportedKwh: 5_000 }] },
    fossilFuels: { systems: [{ description: "Gas boilers", fuel: "natural_gas" }] },
    refrigerants: { systems: [{ id: "VRF-1", systemType: "VRF", refrigerant: "R-410A", gwp: 2088, chargeKg: 20, addedKg: 0, installDate: "2024-01-01", exception: "installed_before_v1_no_works" }] },
    demand: { giaM2: 5000, resolutionMinutes: 30, intervalKwh: Array.from({ length: 17_520 }, (_, i) => 10 + (i % 48 < 20 ? 30 : 0)) },
    water: { sources: [{ source: "network", m3: 3000, supplyFactorKgCo2ePerM3: 0.15 }], treatmentFactorKgCo2ePerM3: 0.27 },
  };

  it("assesses an existing office against the Rev 1 tables with the Standard's carbon basis", () => {
    const a = assessBuilding(ref, office(), inputs);
    expect(a.buildingType).toBe("Existing Building");
    expect(a.classification).toBe("Offices");
    expect(a.limitYear).toBe(2025);
    const oe = a.aspects.find((x) => x.aspect === "operational_energy")!;
    const eui = oe.findings.find((f) => f.id === "oe.eui")!;
    // (400,000 + 50,000 + 60,000) / 5,000 = 102 against 105: within the limit. Export and the car park are out.
    expect(eui).toMatchObject({ status: "pass", value: 102, limit: 105, unit: "kWh/m2GIA/yr" });
    const carbon = oe.findings.find((f) => f.id === "oe.carbon_intensity")!;
    // 400,000 x 0.275 + 0 + 60,000 x 0.21 = 110,000 + 12,600 = 122,600 over 5,000 m2
    expect(carbon.value).toBe(24.52);
    expect(oe.findings.find((f) => f.id === "oe.occupancy")!.status).toBe("pass");
  });

  it("fails fossil fuel free when gas is used without an allowable case, and passes with one", () => {
    const a = assessBuilding(ref, office(), inputs);
    const ff = a.aspects.find((x) => x.aspect === "fossil_fuel_free")!;
    expect(ff.status).toBe("fail");
    const withException = assessBuilding(ref, office(), { ...inputs, fossilFuels: { systems: [{ description: "Standby generator", fuel: "oil", exception: "emergency_and_life_safety" }, { description: "Gas boilers", fuel: "natural_gas", exception: "excluded_from_operational_scope" }] } });
    expect(withException.aspects.find((x) => x.aspect === "fossil_fuel_free")!.status).toBe("pass");
  });

  it("catches a gas supply in the energy data that the fossil fuel review does not declare", () => {
    const a = assessBuilding(ref, office(), { ...inputs, fossilFuels: { systems: [] } });
    const ff = a.aspects.find((x) => x.aspect === "fossil_fuel_free")!;
    expect(ff.findings.some((f) => f.id === "ff.supply.natural_gas" && f.status === "fail")).toBe(true);
  });

  it("renewables: 55,000 kWh over 1,000 m2 footprint meets the South England target of 45", () => {
    const a = assessBuilding(ref, office(), inputs);
    const re = a.aspects.find((x) => x.aspect === "onsite_renewables")!;
    expect(re.findings.find((f) => f.id === "re.target")).toMatchObject({ status: "pass", value: 55, limit: 45 });
    expect(re.findings.find((f) => f.id === "re.used")!.value).toBe(50_000);
  });

  it("refrigerants: the pre-Version-1 exception holds for an RPEP before 2030, leak detection is required, leakage reported above 3,000 kgCO2e", () => {
    const a = assessBuilding(ref, office(), inputs);
    const rf = a.aspects.find((x) => x.aspect === "refrigerants")!;
    expect(rf.findings.find((f) => f.id === "rf.gwp.VRF-1")!.status).toBe("pass");
    expect(rf.findings.find((f) => f.id === "rf.leak_detection.VRF-1")!.status).toBe("not_assessable");
    expect(rf.findings.find((f) => f.id === "rf.charge")!.value).toBe(41_760);
    expect(rf.findings.find((f) => f.id === "rf.leakage_kyoto")!.value).toBe(0);
    const later = assessBuilding(ref, office({ rpep: "2030-06-30" }), inputs);
    expect(later.aspects.find((x) => x.aspect === "refrigerants")!.findings.find((f) => f.id === "rf.gwp.VRF-1")!.status).toBe("fail");
  });

  it("demand management reports the Table 16 metrics for a building over 500 m2", () => {
    const a = assessBuilding(ref, office(), inputs);
    const dm = a.aspects.find((x) => x.aspect === "electricity_demand_management")!;
    expect(dm.findings.find((f) => f.id === "dm.top_ten")!.value).toBe(80);
    expect(dm.findings.find((f) => f.id === "dm.p1")!.value).toBe(20);
  });

  it("water is reporting only, with carbon from supply and treatment", () => {
    const a = assessBuilding(ref, office(), inputs);
    const wa = a.aspects.find((x) => x.aspect === "operational_water")!;
    expect(wa.status).toBe("reported");
    // 3000 x 0.15 + 3000 x 0.27 = 1260 over 5000 m2
    expect(wa.findings.find((f) => f.id === "wa.carbon_per_gia")!.value).toBe(0.252);
  });

  it("says what is missing rather than passing when no inputs are given", () => {
    const a = assessBuilding(ref, office());
    expect(a.status).toBe("not_assessable");
    // Only the classification requirements pass; no pass-fail metric does.
    expect(a.aspects.flatMap((x) => x.findings).filter((f) => f.kind === "pass_fail" && f.status === "pass")).toHaveLength(0);
    const oe = a.aspects.find((x) => x.aspect === "operational_energy")!;
    expect(oe.findings.find((f) => f.id === "oe.eui")).toMatchObject({ status: "not_assessable", limit: 105 });
    expect(a.disclaimer).toMatch(/targeting verification to the UK Net Zero Carbon Buildings Standard/);
    expect(a.permittedStatement).toBe("targeting verification to the UK Net Zero Carbon Buildings Standard");
  });

  it("Data Centre PUE against OE-1", () => {
    const dc = office({ previouslyClassifiedNewBuilding: true, intendedToBeOccupied: false, areas: [{ sector: "Data Centres", subsector: "Low Utilisation", niaM2: 4000 }] });
    const a = assessBuilding(ref, dc, { energy: { supplies: [{ kind: "grid_electricity", kwh: 1_500_000, dataCentre: true }], gridFactors: grid, itEnergyKwh: 1_000_000, occupancy: { totalGiaM2: 5000, unoccupiableGiaM2: 0, occupiedGiaM2: 0, operationalOnFirstDay: true } } });
    const pue = a.aspects.find((x) => x.aspect === "operational_energy")!.findings.find((f) => f.id === "oe.pue")!;
    expect(pue).toMatchObject({ status: "fail", value: 1.5, limit: 1.4 });
  });

  it("embodied carbon compares imported upfront figures with EC-2 and EC-5", () => {
    const profile = office({ works: [{ id: "R1", type: "Retrofit Works", commencementDate: "2026-09-01", completionDate: "2027-01-15", embodied: { upfrontKgCo2e: 2_000_000, giaM2: 5000, pvKwp: 60, pvUpfrontKgCo2e: 54_000 } }] });
    const a = assessBuilding(ref, profile);
    const ec = a.aspects.find((x) => x.aspect === "embodied_carbon")!;
    const up = ec.findings.find((f) => f.id === "ec.R1.upfront")!;
    // EC-2 2026 Offices whole building
    expect(up.limit).toBe(ref.limits.find((l) => l.table === "EC-2" && l.sector === "Offices" && l.subsector === "General" && l.scope === "Whole building" && l.year === 2026)!.value);
    expect(up.value).toBe(400);
    const pv = ec.findings.find((f) => f.id === "ec.R1.pv")!;
    expect(pv).toMatchObject({ status: "pass", value: 900, limit: 1000 });
    expect(pv.reason).toMatch(/proforma prints 750/);
  });

  it("district network: an existing fossil network needs a plan and is compared with Equation 6a", () => {
    const a = assessBuilding(ref, office(), {
      districtNetworks: { gridFactorKgCo2ePerKwh: 0.275, networks: [{ name: "Town heat", service: "heating", existing: true, meteredKwh: 50_000, systemDeliveredKwh: 1_000_000, generationInputKwh: 1_200_000, distributionInputKwh: 60_000, generationKgCo2e: 200_000, distributionKgCo2e: 10_000, suppliesFossilHeat: true }] },
    });
    const dh = a.aspects.find((x) => x.aspect === "district_networks")!;
    const cc = dh.findings.find((f) => f.id === "dh.town_heat.carbon_content")!;
    expect(cc.status).toBe("fail");
    expect(cc.value).toBe(0.21);
    expect(dh.findings.find((f) => f.id === "dh.town_heat.fossil_plan")!.status).toBe("not_assessable");
  });

  it("offsets: eligible retired credits within five years cover the in-scope total", () => {
    const a = assessBuilding(ref, office(), { offsets: { inScopeEmissionsKgCo2e: 120_000, credits: [{ scheme: "ICVCM", vintageYear: 2024, tonnesCo2e: 120, retired: true, registryReference: "VCS-1" }, { scheme: "other", vintageYear: 2024, tonnesCo2e: 50, retired: true }] } });
    const of = a.aspects.find((x) => x.aspect === "carbon_offsetting")!;
    expect(of.findings.find((f) => f.id === "of.quantity")!.status).toBe("pass");
    expect(of.findings.filter((f) => f.id.startsWith("of.credit")).map((f) => f.status)).toEqual(["pass", "fail"]);
  });
});

describe("reference integrity", () => {
  it("refuses an edited table", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nzcbs-ref-"));
    const v = path.join(dir, "uk-nzcbs", "v9test");
    const src = ref.dir;
    mkdirSync(v, { recursive: true });
    for (const f of ["limits.csv", "renewables_targets.csv", "other_limits.csv", "reduction_curves.csv", "menus.csv", "manifest.json"]) copyFileSync(path.join(src, f), path.join(v, f));
    writeFileSync(path.join(v, "limits.csv"), readFileSync(path.join(v, "limits.csv"), "utf8").replace(",805,", ",999,"));
    const env = { REFERENCE_DATA_DIR: dir };
    expect(listReferenceVersions(env).map((x) => x.version)).toEqual(["v9test", "v1r1"]);
    expect(() => loadNzcbsReference(env, "v9test")).toThrow(NzcbsReferenceError);
  });
});
