import { MINIMUM_OCCUPANCY_RATE } from "../constants";
import { aspectResult, compare, reported, requirement, round } from "../findings";
import { findLimit } from "../reference";
import type { LimitContext } from "../limits";
import type { AspectResult, BuildingProfile, EnergySupply, Finding, GridFactors, OccupancyInput, OperationalEnergyInput } from "../types";

/**
 * 5.2 Operational energy: the in-scope energy total, the EUI against the
 * building's limit, the operational carbon on the Standard's basis, the
 * data centre PUE, the sector reporting metrics and the occupancy test.
 */

export interface EnergyBreakdown {
  /** Energy within the 5.2.1.2 scope and compared with the limit. */
  inScopeKwh: number;
  /** Energy within scope but netted out for the limit comparison: Additional Uses (5.2.7.1). */
  additionalUseKwh: number;
  /** Data Centre energy, assessed on PUE (5.2.7.1). */
  dataCentreKwh: number;
  /** Energy outside the assessment scope (5.2.1.2) or omitted car parks (5.2.7.1). */
  excludedKwh: number;
  byKind: Record<string, number>;
  /** kgCO2e on the 5.2.3 basis, null where any in-scope supply lacks a factor. */
  carbonKgCo2e: number | null;
  carbonLines: { kind: string; fuel?: string; kwh: number; factor: number | null; kgCo2e: number | null; reference?: string }[];
  measurement: string[];
}

/** 5.2.3.4: the four lines summed. */
export function gridFactor(g: GridFactors | undefined): number | null {
  if (!g) return null;
  return round(g.generation + g.transmissionAndDistribution + g.wttGeneration + g.wttTransmissionAndDistribution, 6);
}

export function energyBreakdown(input: OperationalEnergyInput): EnergyBreakdown {
  const grid = gridFactor(input.gridFactors);
  const byKind: Record<string, number> = {};
  const lines: EnergyBreakdown["carbonLines"] = [];
  let inScope = 0;
  let additional = 0;
  let dataCentre = 0;
  let excluded = 0;
  let carbon: number | null = 0;
  const measurement = new Set<string>();
  for (const s of input.supplies) {
    if (s.excluded) {
      excluded += s.kwh;
      continue;
    }
    byKind[s.kind] = (byKind[s.kind] ?? 0) + s.kwh;
    if (s.additionalUse) additional += s.kwh;
    else if (s.dataCentre) dataCentre += s.kwh;
    else inScope += s.kwh;
    const factor = factorFor(s, grid);
    const kg = factor === null ? null : round(s.kwh * factor);
    lines.push({ kind: s.kind, fuel: s.fuel, kwh: s.kwh, factor, kgCo2e: kg, reference: s.factorReference ?? (s.kind === "grid_electricity" || s.kind === "chp_electricity" ? input.gridFactors?.reference : undefined) });
    if (kg === null) carbon = null;
    else if (carbon !== null) carbon += kg;
    if (s.measurement) measurement.add(`${s.kind}: ${s.measurement.replace(/_/g, " ")}`);
  }
  return { inScopeKwh: round(inScope), additionalUseKwh: round(additional), dataCentreKwh: round(dataCentre), excludedKwh: round(excluded), byKind, carbonKgCo2e: carbon === null ? null : round(carbon), carbonLines: lines, measurement: [...measurement] };
}

function factorFor(s: EnergySupply, grid: number | null): number | null {
  switch (s.kind) {
    case "grid_electricity":
    case "chp_electricity":
      // 5.2.3.4 and 5.2.3.7: CHP electricity takes the grid factor.
      return s.factorKgCo2ePerKwh ?? grid;
    case "onsite_renewable_electricity_used":
    case "onsite_renewable_heat":
      // 5.2.3.5: zero for renewable energy generated and used on site.
      return 0;
    default:
      return s.factorKgCo2ePerKwh ?? null;
  }
}

/** Equation 4. */
export function occupancyRate(o: OccupancyInput): { rate: number | null; reason: string } {
  const at = o.totalGiaM2 - o.unoccupiableGiaM2;
  if (at <= 0) return { rate: null, reason: "Total occupiable area (Ag - Au) is not positive, so no occupancy rate can be calculated (Equation 4)." };
  const rate = round(o.occupiedGiaM2 / at, 4);
  return { rate, reason: `Equation 4: ${o.occupiedGiaM2} / (${o.totalGiaM2} - ${o.unoccupiableGiaM2}) = ${Math.round(rate * 1000) / 10}%.` };
}

/** GIA used to normalise the EUI: Additional Uses (unless out of hours) and submetered internal car parks are taken out (5.2.7.1). */
export function euiDenominatorGia(profile: BuildingProfile, ctx: LimitContext): { giaM2: number; notes: string[] } {
  const notes: string[] = [];
  let gia = profile.giaM2;
  for (const a of profile.areas) {
    const allowedAdditional = a.additionalUse && ctx.sectors.additionalUses.find((u) => u.label === a.additionalUse && u.niaM2 === a.niaM2)?.allowed;
    if (allowedAdditional && !a.outOfHoursUse) {
      const g = a.giaM2 ?? a.niaM2;
      gia -= g;
      notes.push(`${a.additionalUse}: ${g} m2 removed from the EUI floor area (5.2.7.1${a.giaM2 === undefined ? "; NIA used as no GIA was recorded" : ""}).`);
    }
    if (a.carPark) {
      const g = a.giaM2 ?? a.niaM2;
      gia -= g;
      notes.push(`Internal car park: ${g} m2 removed from the EUI floor area (5.2.7.1).`);
    }
  }
  return { giaM2: round(gia), notes };
}

export function assessOperationalEnergy(profile: BuildingProfile, ctx: LimitContext, input: OperationalEnergyInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input) {
    findings.push(compare({ id: "oe.eui", section: "5.2.7.1", metric: "Energy use intensity", value: null, limit: ctx.operationalEnergy.value, unit: ctx.operationalEnergy.unit, reason: "", missingValue: "No operational energy data was supplied for the ORP." }));
    return aspectResult("operational_energy", "5.2", "Operational energy", findings, warnings);
  }
  const b = energyBreakdown(input);
  const limit = ctx.operationalEnergy;
  const basisNia = limit.areaBasis === "NIA";
  const denominator = basisNia ? { giaM2: profile.niaM2, notes: ["NIA basis chosen for the Offices limit (Table 10)."] } : euiDenominatorGia(profile, ctx);
  warnings.push(...denominator.notes, ...limit.notes);
  const area = denominator.giaM2;
  const eui = area > 0 && b.inScopeKwh > 0 ? round(b.inScopeKwh / area) : null;
  const unit = basisNia ? "kWh/m2NIA/yr" : "kWh/m2GIA/yr";

  findings.push(
    compare({
      id: "oe.eui",
      section: "5.2.7.1",
      metric: "Energy use intensity",
      value: eui,
      limit: limit.status === "limit" ? limit.value : null,
      unit,
      reason: `In-scope energy ${b.inScopeKwh} kWh over ${area} m2 ${basisNia ? "NIA" : "GIA"} against the Table ${limit.table} limit for ${limit.year}${limit.method === "equation_1a" ? " (Equation 1a)" : limit.method === "equation_1b" ? " (Equation 1b)" : ""}.`,
      basis: "Measured: all supplies in the 5.2.1.2 scope including on-site renewable energy used on site; exported electricity, excluded uses and Additional Uses netted out (5.2.7.1).",
      missingValue: area <= 0 ? "No floor area to normalise against." : "No in-scope energy for the ORP.",
      missingLimit: limit.status === "no_limit" ? "The Standard sets no operational energy limit for this sector in this table." : `No limit could be selected: ${limit.notes.join(" ")}`,
    }),
  );
  if (b.additionalUseKwh > 0) {
    findings.push(reported({ id: "oe.additional_uses", section: "5.2.1.3", metric: "Additional Uses energy", value: b.additionalUseKwh, unit: "kWh/yr", reason: "Assessed and reported separately; not required to meet the limit." }));
  }
  if (b.excludedKwh > 0) {
    findings.push(reported({ id: "oe.excluded", section: "5.2.1.2", metric: "Energy excluded from the assessment", value: b.excludedKwh, unit: "kWh/yr", reason: "Industrial process, external works, or submetered car park energy; must be stated in the submission (5.2.6)." }));
  }
  findings.push(reported({ id: "oe.total", section: "5.2.6", metric: "Total energy use", value: b.inScopeKwh + b.additionalUseKwh + b.dataCentreKwh, unit: "kWh/yr", reason: `By supply: ${Object.entries(b.byKind).map(([k, v]) => `${k.replace(/_/g, " ")} ${round(v)}`).join("; ")}.`, basis: b.measurement.join("; ") || undefined }));

  // Reporting metric: operational carbon intensity on the Standard's basis.
  const carbonIntensity = b.carbonKgCo2e !== null && area > 0 ? round(b.carbonKgCo2e / area) : null;
  findings.push(
    reported({
      id: "oe.carbon_intensity",
      section: "5.2.3",
      metric: "Annual operational carbon emissions intensity",
      value: carbonIntensity,
      unit: basisNia ? "kgCO2e/m2NIA/yr" : "kgCO2e/m2GIA/yr",
      reason: b.carbonKgCo2e === null ? "An emission factor is missing for at least one in-scope supply, so no total is given. Grid electricity needs all four 5.2.3.4 lines (generation, T&D, WTT generation, WTT T&D)." : `${b.carbonKgCo2e} kgCO2e over ${area} m2. This is the Standard's basis (generation + T&D + WTT), broader than GHG Protocol Scope 2 location-based reporting; do not conflate the two.`,
      basis: input.gridFactors?.reference,
    }),
  );
  if (input.gridFactors === undefined && input.supplies.some((s) => s.kind === "grid_electricity" && s.factorKgCo2ePerKwh === undefined)) {
    warnings.push("Grid electricity carbon needs the four DESNZ lines in 5.2.3.4; supplier or REGO-based factors are not permitted for grid electricity.");
  }

  // Data centres: PUE (Table 10, 5.2.7.1).
  const dcAreas = profile.areas.filter((a) => a.sector === "Data Centres");
  if (dcAreas.length > 0 || b.dataCentreKwh > 0) {
    const subsector = dcAreas[0]?.subsector;
    const pueLimit = findLimit(ctx.reference, { table: limit.table ?? "OE-1", sector: "Data Centres", subsector, year: ctx.operationalLimitYear.year });
    const totalDc = b.dataCentreKwh > 0 ? b.dataCentreKwh : dcAreas.length === profile.areas.length ? b.inScopeKwh : 0;
    const pue = input.itEnergyKwh && input.itEnergyKwh > 0 && totalDc > 0 ? round(totalDc / input.itEnergyKwh) : null;
    findings.push(
      compare({
        id: "oe.pue",
        section: "5.2.7.1",
        metric: "Power Usage Effectiveness",
        value: pue,
        limit: pueLimit.status === "limit" ? pueLimit.value : null,
        unit: "PUE",
        reason: `Total Data Centre energy ${totalDc} kWh over IT energy ${input.itEnergyKwh ?? "unknown"} kWh, against Table ${limit.table ?? "OE-1"} ${pueLimit.year}${subsector ? ` (${subsector})` : ""}.`,
        missingValue: "PUE needs the Data Centre's total energy and its IT equipment energy, each submetered (5.2.3.1).",
        missingLimit: pueLimit.notes.join(" ") || "No PUE limit found.",
      }),
    );
  }

  // Sector reporting metrics (Table 10).
  const classification = ctx.sectors.classification;
  if (classification === "Hotels") {
    findings.push(reported({ id: "oe.per_conditioned_area", section: "5.2.2", metric: "Energy use per m2 conditioned area", value: input.conditionedAreaM2 ? round(b.inScopeKwh / input.conditionedAreaM2) : null, unit: "kWh/m2CA/yr", reason: input.conditionedAreaM2 ? "" : "Conditioned area not supplied." }));
    findings.push(reported({ id: "oe.per_bedroom", section: "5.2.2", metric: "Energy use per bedroom", value: input.bedrooms ? round(b.inScopeKwh / input.bedrooms) : null, unit: "kWh/bedroom/yr", reason: input.bedrooms ? "" : "Number of bedrooms not supplied." }));
  }
  if (profile.areas.some((a) => a.sector === "Retail" && (a.subsector ?? "").toLowerCase().startsWith("landlord"))) {
    findings.push(reported({ id: "oe.per_common_parts", section: "5.2.2", metric: "Energy use per m2 common parts area", value: input.commonPartsAreaM2 ? round(b.inScopeKwh / input.commonPartsAreaM2) : null, unit: "kWh/m2CPA/yr", reason: input.commonPartsAreaM2 ? "" : "Common parts area not supplied." }));
  }
  if (classification === "Healthcare" && ctx.buildingType.value === "New Building") {
    warnings.push("New Healthcare buildings comply with the NHS Net Zero Building Standard, with domestic hot water and unregulated loads mandatory in scope (5.2.7.1).");
  }

  // Occupancy (5.2.5).
  const intended = profile.intendedToBeOccupied ?? true;
  if (!intended) {
    findings.push(requirement({ id: "oe.occupancy", section: "5.2.5.1", metric: "Operational on the first day of the ORP", met: input.occupancy?.operationalOnFirstDay ?? null, reason: input.occupancy?.operationalOnFirstDay === undefined ? "Not recorded whether the building was operational on the first day of the ORP." : input.occupancy.operationalOnFirstDay ? "Building not intended to be occupied and operational on day one." : "Building not intended to be occupied but not operational on day one." }));
  } else if (!input.occupancy) {
    findings.push(requirement({ id: "oe.occupancy", section: "5.2.5.1", metric: "Occupancy rate at least 80% on the first day of the ORP", met: null, reason: "No occupancy calculation (Equation 4) was supplied: floor areas, occupiable area, separately occupied spaces and unoccupiable areas are submission items (5.2.6)." }));
  } else {
    const o = occupancyRate(input.occupancy);
    findings.push(requirement({ id: "oe.occupancy", section: "5.2.5.1", metric: "Occupancy rate at least 80% on the first day of the ORP", met: o.rate === null ? null : o.rate >= MINIMUM_OCCUPANCY_RATE, reason: `${o.reason} Minimum ${MINIMUM_OCCUPANCY_RATE * 100}%. "Used by people" cannot rest on a lease alone.` }));
  }

  if (ctx.buildingType.value === "Existing Building" && (profile.operationalRoute ?? "one-go") === "stepped") {
    findings.push(requirement({ id: "oe.retrofit_plan", section: "5.2.8", metric: "Retrofit Plan submitted for the stepped route", met: null, reason: "The stepped route requires a PAS 2035 or PAS 2038 Retrofit Plan showing the Table OE-3 limits will be met at future dates. The portal records it as an attachment; it cannot produce it." }));
  }

  return aspectResult("operational_energy", "5.2", "Operational energy", findings, warnings);
}
