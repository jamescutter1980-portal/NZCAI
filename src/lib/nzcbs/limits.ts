import { classifyBuilding, classifySectors, limitSectorFor, reportingPeriods, worksType, type Classified, type ReportingPeriods, type SectorClassification } from "./classify";
import {
  EQUATION_1B_MAX_NEW_SHARE,
  EQUATION_1B_MIN_NEW_SHARE,
  LIMIT_TABLE_FIRST_YEAR,
  RENEWABLES_MIN_CAPACITY_KWP_OTHER,
  RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY,
  REPORTABLE_CAT_B_SHARE,
  REUSED_SYSTEM_TARGET_REDUCTION,
  VERSION_1_PUBLICATION_DATE,
} from "./constants";
import { findLimit, otherLimit, renewablesTarget, type LimitResolution, type NzcbsReference } from "./reference";
import type { AreaBasis, BuildingProfile, BuildingType, FloorArea, LimitTable, RenewablesInput, WorksProgramme, WorksType } from "./types";

/**
 * Limit selection: which Annex A table, which year, and how the sector and
 * area weighting of 4.2.5.2 combines the published figures into the one limit
 * this building is compared with.
 */

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;
const yearOf = (iso: string) => Number(iso.slice(0, 4));

export interface LimitYear {
  year: number;
  section: string;
  rule: string;
}

export interface WeightedComponent {
  sector: string;
  subsector?: string;
  scope?: string;
  niaM2: number;
  share: number;
  resolution: LimitResolution;
}

export interface WeightedLimit {
  status: "limit" | "no_limit" | "not_assessable";
  value: number | null;
  unit: string;
  areaBasis: AreaBasis | "";
  table: LimitTable | null;
  year: number;
  method: "single" | "equation_1a" | "equation_1b" | "none";
  components: WeightedComponent[];
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* years                                                               */
/* ------------------------------------------------------------------ */

function latestCommencement(works: WorksProgramme[], type: WorksType): WorksProgramme | null {
  const matching = works.filter((w) => worksType(w).value === type).sort((a, b) => b.commencementDate.localeCompare(a.commencementDate));
  return matching[0] ?? null;
}

/** 5.2.7.1 limit dates. */
export function operationalLimitYear(profile: BuildingProfile, buildingType: BuildingType, periods: ReportingPeriods): LimitYear {
  const works = profile.works ?? [];
  if (buildingType === "New Building") {
    const nw = latestCommencement(works, "New Works");
    if (nw) {
      const y = Math.max(LIMIT_TABLE_FIRST_YEAR, yearOf(nw.commencementDate));
      return { year: y, section: "5.2.7.1", rule: `New Building: Date of Commencement of the New Works (${nw.commencementDate}), or 2025 if more recent.` };
    }
    return { year: LIMIT_TABLE_FIRST_YEAR, section: "5.2.7.1", rule: "New Building with no New Works commencement date recorded: 2025 is used. Record the commencement date to set the year correctly." };
  }
  const route = profile.operationalRoute ?? "one-go";
  if (route === "stepped") {
    return { year: periods.orpStartYear, section: "5.2.7.1", rule: `Existing Building, stepped route: the year the ORP starts (${periods.orp.from}). A Retrofit Plan is required (5.2.8).` };
  }
  const rw = latestCommencement(works, "Retrofit Works");
  if (rw && yearOf(rw.commencementDate) >= LIMIT_TABLE_FIRST_YEAR) {
    return { year: yearOf(rw.commencementDate), section: "5.2.7.1", rule: `Existing Building, one-go route: Date of Commencement of the most recent Retrofit Works (${rw.commencementDate}).` };
  }
  return { year: LIMIT_TABLE_FIRST_YEAR, section: "5.2.7.1", rule: "Existing Building, one-go route: no Retrofit Works have commenced since 2025, so 2025 is used." };
}

export function operationalTable(buildingType: BuildingType, route: BuildingProfile["operationalRoute"]): LimitTable {
  if (buildingType === "New Building") return "OE-1";
  return route === "stepped" ? "OE-3" : "OE-2";
}

/* ------------------------------------------------------------------ */
/* Equations 1a and 1b                                                 */
/* ------------------------------------------------------------------ */

interface AreaForLimit {
  area: FloorArea;
  sector: string;
  subsector?: string;
  scope?: string;
}

/** Areas that count towards the operational energy limit (4.2.5.2, 5.2.7.1). */
function areasForOperationalLimit(profile: BuildingProfile, classification: SectorClassification, notes: string[]): AreaForLimit[] {
  const omitted = new Set(classification.omitted.map((s) => s.sector));
  const out: AreaForLimit[] = [];
  for (const area of profile.areas) {
    if (area.sector === null) continue;
    if (omitted.has(area.sector) && !area.particularUse) continue;
    if (area.additionalUse && classification.additionalUses.find((u) => u.label === area.additionalUse && u.niaM2 === area.niaM2)?.allowed && !area.outOfHoursUse) {
      notes.push(`${area.additionalUse} (${area.niaM2} m2 NIA) is an Additional Use and is left out of the limit calculation (5.2.7.1).`);
      continue;
    }
    if (area.carPark) {
      notes.push(`Car park (${area.niaM2} m2) is left out of the limit calculation (5.2.7.1).`);
      continue;
    }
    const target = limitSectorFor(area);
    if (!target) continue;
    if (target.sector === "Data Centres") {
      notes.push(`Data Centre area (${area.niaM2} m2) is assessed on PUE and ignored by Equation 1a (5.2.7.1).`);
      continue;
    }
    out.push({ area, ...target });
  }
  return out;
}

function weightedAcross(ref: NzcbsReference, table: LimitTable, year: number, areas: AreaForLimit[], basis: AreaBasis | undefined, weightBy: "nia" | "gia"): WeightedLimit {
  const notes: string[] = [];
  const components: WeightedComponent[] = [];
  for (const a of areas) {
    const areaBasis = basis && a.sector === "Offices" ? basis : undefined;
    const resolution = findLimit(ref, { table, sector: a.sector, subsector: a.subsector, scope: a.scope, areaBasis, year });
    const weight = weightBy === "gia" ? (a.area.giaM2 ?? a.area.niaM2) : a.area.niaM2;
    components.push({ sector: a.sector, subsector: a.subsector, scope: a.scope, niaM2: weight, share: 0, resolution });
    if (weightBy === "gia" && a.area.giaM2 === undefined) notes.push(`${a.sector} ${a.subsector ?? ""}: no GIA recorded for the area, so its NIA is used as the Equation 1b weight.`);
  }
  const usable = components.filter((c) => c.resolution.status === "limit" && c.resolution.value !== null);
  const dropped = components.filter((c) => c.resolution.status !== "limit");
  for (const d of dropped) {
    notes.push(`${d.sector}${d.subsector ? ` / ${d.subsector}` : ""}: ${d.resolution.status === "no_limit" || d.resolution.status === "not_applicable" || d.resolution.status === "deferred" ? "no limit in the table, so the area is omitted from the weighting (4.2.5.2)" : d.resolution.notes.join(" ")}.`);
  }
  const blocking = dropped.filter((d) => d.resolution.status === "not_found" || d.resolution.status === "ambiguous" || d.resolution.status === "unavailable");
  if (usable.length === 0) {
    return { status: blocking.length ? "not_assessable" : "no_limit", value: null, unit: components[0]?.resolution.unit ?? "", areaBasis: basis ?? "GIA", table, year, method: "none", components, notes };
  }
  if (blocking.length) {
    return { status: "not_assessable", value: null, unit: usable[0].resolution.unit, areaBasis: basis ?? "GIA", table, year, method: "none", components, notes: [...notes, "A limit could not be resolved for every area with a limit, so no weighted limit is given."] };
  }
  const units = new Set(usable.map((u) => u.resolution.unit));
  if (units.size > 1) {
    return { status: "not_assessable", value: null, unit: [...units].join(" | "), areaBasis: "", table, year, method: "none", components, notes: [...notes, `The areas resolve to limits in different units (${[...units].join(", ")}); choose one area basis (Table 10).`] };
  }
  const total = usable.reduce((n, c) => n + c.niaM2, 0);
  let value = 0;
  for (const c of usable) {
    c.share = total > 0 ? round(c.niaM2 / total, 6) : 0;
    value += c.share * (c.resolution.value as number);
  }
  const unit = usable[0].resolution.unit;
  const areaBasis: AreaBasis | "" = /nia/i.test(unit) ? "NIA" : /gia/i.test(unit) ? "GIA" : "";
  if (usable.length === 1 && usable[0].share === 1) {
    return { status: "limit", value: round(value), unit, areaBasis, table, year, method: "single", components, notes: [...notes, ...usable[0].resolution.notes] };
  }
  notes.push(`Equation 1a: ${usable.map((c) => `${Math.round(c.share * 1000) / 10}% x ${c.resolution.value} (${c.sector}${c.subsector ? ` ${c.subsector}` : ""})`).join(" + ")} = ${round(value)} ${unit}.`);
  return { status: "limit", value: round(value), unit, areaBasis, table, year, method: "equation_1a", components, notes };
}

/**
 * The operational energy limit for the whole building (5.2.7.1 with
 * 4.2.5.2). Returns Equation 1b where 10% to 50% of NIA is New Area.
 */
export function operationalEnergyLimit(ref: NzcbsReference, profile: BuildingProfile, classification: SectorClassification, buildingType: BuildingType, limitYear: LimitYear): WeightedLimit {
  const notes: string[] = [];
  const areas = areasForOperationalLimit(profile, classification, notes);
  if (areas.length === 0) {
    return { status: "not_assessable", value: null, unit: "", areaBasis: "", table: null, year: limitYear.year, method: "none", components: [], notes: [...notes, "No floor area that takes an operational energy limit was supplied."] };
  }
  const basis = profile.areaBasis;
  const table = operationalTable(buildingType, profile.operationalRoute);
  const nia = classification.totalNiaM2;
  const newShare = nia > 0 ? profile.areas.filter((a) => a.newArea).reduce((n, a) => n + a.niaM2, 0) / nia : 0;

  if (buildingType === "Existing Building" && newShare >= EQUATION_1B_MIN_NEW_SHARE && newShare < EQUATION_1B_MAX_NEW_SHARE) {
    const newAreas = areas.filter((a) => a.area.newArea);
    const existingAreas = areas.filter((a) => !a.area.newArea);
    const nw = latestCommencement(profile.works ?? [], "New Works");
    const newYear = nw ? Math.max(LIMIT_TABLE_FIRST_YEAR, yearOf(nw.commencementDate)) : limitYear.year;
    const ln = weightedAcross(ref, "OE-1", newYear, newAreas, basis, "gia");
    const le = weightedAcross(ref, table, limitYear.year, existingAreas, basis, "gia");
    const all = [...ln.notes.map((n) => `New Areas: ${n}`), ...le.notes.map((n) => `Existing Areas: ${n}`)];
    if (ln.status !== "limit" || le.status !== "limit" || ln.unit !== le.unit) {
      return { status: "not_assessable", value: null, unit: ln.unit || le.unit, areaBasis: "", table, year: limitYear.year, method: "equation_1b", components: [...ln.components, ...le.components], notes: [...notes, ...all, "Equation 1b needs a limit for both the New Areas and the Existing Areas."] };
    }
    const giaNew = newAreas.reduce((n, a) => n + (a.area.giaM2 ?? a.area.niaM2), 0);
    const giaExisting = existingAreas.reduce((n, a) => n + (a.area.giaM2 ?? a.area.niaM2), 0);
    const pN = giaNew / (giaNew + giaExisting);
    const pE = 1 - pN;
    const value = round(pN * ln.value! + pE * le.value! + pN * (ln.value! - le.value!));
    notes.push(`Equation 1b: ${Math.round(pN * 1000) / 10}% New Area x ${ln.value} + ${Math.round(pE * 1000) / 10}% Existing Area x ${le.value} + ${Math.round(pN * 1000) / 10}% x (${ln.value} - ${le.value}) = ${value} ${ln.unit} (4.2.5.2). New Areas use Table OE-1 for ${newYear}; Existing Areas use Table ${table} for ${limitYear.year}.`);
    return { status: "limit", value, unit: ln.unit, areaBasis: ln.areaBasis, table, year: limitYear.year, method: "equation_1b", components: [...ln.components, ...le.components], notes: [...notes, ...all] };
  }

  const result = weightedAcross(ref, table, limitYear.year, areas, basis, "nia");
  return { ...result, notes: [...notes, ...result.notes] };
}

/* ------------------------------------------------------------------ */
/* embodied carbon                                                     */
/* ------------------------------------------------------------------ */

export interface EmbodiedLimitSelection extends WeightedLimit {
  worksId: string;
  worksType: WorksType;
  /** False for works that commenced before Version 1: assessed and reported, not compared (5.1.6). */
  compare: boolean;
  /** EC-3 only: which fit-out category limit applies (5.1.6.2). */
  reportableScope?: "Cat B" | "Cat A + Cat B";
}

/** 5.1.6: the upfront carbon limit for one programme of works. */
export function embodiedCarbonLimit(ref: NzcbsReference, profile: BuildingProfile, classification: SectorClassification, works: WorksProgramme): EmbodiedLimitSelection {
  const type = worksType(works).value;
  const year = yearOf(works.commencementDate);
  const compare = works.commencementDate >= VERSION_1_PUBLICATION_DATE;
  const notes: string[] = compare ? [] : [`Works commenced ${works.commencementDate}, before Version 1 of the Standard; the assessment is reported but not compared with a limit (5.1.6).`];
  const base = { worksId: works.id, worksType: type, compare, year, areaBasis: "GIA" as const };
  if (type === "Non-Reportable Works") {
    return { ...base, status: "no_limit", value: null, unit: "", table: null, method: "none", components: [], notes: [...notes, "Non-Reportable Works are outside the embodied carbon scope (5.1.2.1)."] };
  }
  const table: LimitTable = type === "New Works" ? "EC-1" : type === "Retrofit Works" ? "EC-2" : "EC-3";
  let scope = works.embodied?.scope;
  let reportableScope: EmbodiedLimitSelection["reportableScope"];
  if (table === "EC-3") {
    const catB = works.embodied?.upfrontCatBKgCo2e;
    const total = works.embodied?.upfrontKgCo2e;
    if (catB !== undefined && total && catB / total > REPORTABLE_CAT_B_SHARE) {
      reportableScope = "Cat B";
      notes.push(`Cat B works are ${Math.round((catB / total) * 100)}% of the upfront carbon, above 80%, so the Cat B limit applies and Shell and Core and Cat A are excluded from the compared scope (5.1.6.2).`);
    } else {
      reportableScope = "Cat A + Cat B";
      notes.push("The Cat A + Cat B limit applies (5.1.6.2).");
    }
    scope = reportableScope;
  }
  const omitted = new Set(classification.omitted.map((s) => s.sector));
  const areas: AreaForLimit[] = profile.areas
    .filter((a) => a.sector !== null && !omitted.has(a.sector))
    .map((a) => ({ area: a, sector: a.sector as string, subsector: a.subsector, scope: scope ?? a.scope }));
  if (areas.length === 0) {
    return { ...base, status: "not_assessable", value: null, unit: "", table, method: "none", components: [], notes: [...notes, "No classified floor area was supplied, so no embodied carbon limit can be selected."], reportableScope };
  }
  const weighted = weightedAcross(ref, table, year, areas, undefined, "nia");
  return { ...base, ...weighted, notes: [...notes, ...weighted.notes], reportableScope };
}

/** Table EC-5: the PV upfront carbon limit, with the proforma discrepancy carried as a note. */
export function pvUpfrontLimit(ref: NzcbsReference): { value: number | null; unit: string; notes: string[] } {
  const standard = otherLimit(ref, "pv_upfront_carbon");
  const proforma = otherLimit(ref, "pv_upfront_carbon_proforma");
  const notes = [standard?.note ?? ""].filter(Boolean);
  if (proforma && standard && proforma.value !== standard.value) {
    notes.push(`The submission proforma prints ${proforma.value} ${proforma.unit}; the Standard's text prints ${standard.value} ${standard.unit}. The Standard's figure is used; confirm with NZCBS Ltd before a submission relies on the margin between them.`);
  }
  return { value: standard?.value ?? null, unit: standard?.unit ?? "kgCO2e/kWp", notes };
}

/* ------------------------------------------------------------------ */
/* space heating                                                       */
/* ------------------------------------------------------------------ */

/** Table OE-4: New Buildings, Homes and Commercial Residential only (5.8.5). */
export function spaceHeatingLimit(ref: NzcbsReference, profile: BuildingProfile, classification: SectorClassification, buildingType: BuildingType): WeightedLimit {
  const notes: string[] = [];
  if (buildingType !== "New Building") {
    return { status: "no_limit", value: null, unit: "kWh/m2GIA/yr", areaBasis: "GIA", table: "OE-4", year: LIMIT_TABLE_FIRST_YEAR, method: "none", components: [], notes: ["Space heating limits apply to New Buildings only in this version (5.8.5.1)."] };
  }
  const nw = latestCommencement(profile.works ?? [], "New Works");
  const year = nw ? Math.max(LIMIT_TABLE_FIRST_YEAR, yearOf(nw.commencementDate)) : LIMIT_TABLE_FIRST_YEAR;
  const omitted = new Set(classification.omitted.map((s) => s.sector));
  const areas: AreaForLimit[] = profile.areas
    .filter((a) => (a.sector === "Homes" || a.sector === "Commercial Residential") && !omitted.has(a.sector))
    .map((a) => ({ area: a, sector: a.sector as string, subsector: a.subsector }));
  if (areas.length === 0) {
    return { status: "no_limit", value: null, unit: "kWh/m2GIA/yr", areaBasis: "GIA", table: "OE-4", year, method: "none", components: [], notes: ["No Homes or Commercial Residential floor area, so no space heating limit applies; delivered heating and cooling are still reported (5.8.5.1)."] };
  }
  const result = weightedAcross(ref, "OE-4", year, areas, undefined, "nia");
  return { ...result, notes: [...notes, ...result.notes, "Areas of sectors without a heating limit are excluded and must be submetered (5.8.3, 5.8.5.1)."] };
}

/* ------------------------------------------------------------------ */
/* renewables target                                                   */
/* ------------------------------------------------------------------ */

export interface RenewablesTargetSelection {
  /** Annex A3 figure before reductions. */
  baseTarget: number | null;
  /** Target after Equation 5 and the other 5.3.5.1 reductions. */
  target: number | null;
  unit: string;
  group: "all_other" | "single_family_homes_or_single_storey_storage" | null;
  /** False when the feasible system falls below the kWp floor. */
  applies: boolean;
  steps: string[];
  notes: string[];
}

export function renewablesTargetFor(
  ref: NzcbsReference,
  profile: BuildingProfile,
  classification: SectorClassification,
  input: RenewablesInput | undefined,
  operationalLimit: WeightedLimit | null,
): RenewablesTargetSelection {
  const notes: string[] = [];
  const steps: string[] = [];
  if (!profile.region) {
    return { baseTarget: null, target: null, unit: "kWh/m2FP/yr", group: null, applies: true, steps, notes: ["No Annex A3 region recorded for the building, so no target can be selected."] };
  }
  const singleFamily = classification.classification === "Homes" && classification.sectors[0]?.parts.every((p) => (p.subsector ?? "").toLowerCase().startsWith("single family"));
  const singleStoreyStorage = classification.classification === "Storage and Distribution" && !!profile.singleStorey;
  const group = singleFamily || singleStoreyStorage ? "single_family_homes_or_single_storey_storage" : "all_other";
  const row = renewablesTarget(ref, profile.region, group);
  if (!row) {
    return { baseTarget: null, target: null, unit: "kWh/m2FP/yr", group, applies: true, steps, notes: [`No Annex A3 target loaded for ${profile.region} / ${group}.`] };
  }
  let target = row.value;
  steps.push(`Annex A3 target for ${profile.region}, ${group === "all_other" ? "all other building types" : "Single Family Homes and single-storey Storage and Distribution"}: ${row.value} ${row.unit}.`);

  const footprint = profile.footprintM2;
  if (input?.constraints && input.constraints.reasons.length > 0) {
    if (!footprint || footprint <= 0) {
      notes.push("Equation 5 needs the building footprint; the constraint reduction was not applied.");
    } else {
      const ratio = Math.min(1, input.constraints.unconstrainedAreaM2 / footprint);
      target = round(target * ratio);
      steps.push(`Equation 5: ${row.value} x min(1, ${input.constraints.unconstrainedAreaM2} / ${footprint}) = ${target} (constraints: ${input.constraints.reasons.join(", ")}). Evidence of constrained and unconstrained areas must be submitted (5.3.5.1).`);
    }
  }
  if (input?.capAtElectricityLimit) {
    if (operationalLimit?.status === "limit" && operationalLimit.value !== null && footprint && profile.giaM2 > 0 && operationalLimit.areaBasis === "GIA") {
      const capKwh = operationalLimit.value * profile.giaM2;
      const targetKwh = target * footprint;
      if (capKwh < targetKwh) {
        target = round(capKwh / footprint);
        steps.push(`Reduced to the in-scope annual operational electricity limit: ${operationalLimit.value} kWh/m2GIA x ${profile.giaM2} m2 = ${round(capKwh)} kWh, or ${target} ${row.unit} over the footprint (5.3.5.1).`);
      } else {
        steps.push("The in-scope operational electricity limit is not lower than the target, so no reduction on that ground.");
      }
    } else {
      notes.push("The reduction to the in-scope electricity limit needs a GIA-basis operational energy limit, the GIA and the footprint.");
    }
  }
  if (input?.systems.length && input.systems.every((s) => s.reused)) {
    target = round(target * (1 - REUSED_SYSTEM_TARGET_REDUCTION));
    steps.push(`Reused systems: target reduced by ${REUSED_SYSTEM_TARGET_REDUCTION * 100}% to ${target} (5.3.5.1).`);
  } else if (input?.systems.some((s) => s.reused)) {
    notes.push("Some systems are reused and some are not; the 15% reduction is applied only where the generating systems are reused, so it was not applied.");
  }
  let applies = true;
  if (input?.feasibleCapacityKwp !== undefined) {
    const floor = singleFamily ? RENEWABLES_MIN_CAPACITY_KWP_SINGLE_FAMILY : RENEWABLES_MIN_CAPACITY_KWP_OTHER;
    if (input.feasibleCapacityKwp < floor) {
      applies = false;
      steps.push(`Feasible capacity ${input.feasibleCapacityKwp} kWp is below ${floor} kWp, so the target does not apply (5.3.5.1).`);
    }
  }
  return { baseTarget: row.value, target, unit: row.unit, group, applies, steps, notes };
}

/* ------------------------------------------------------------------ */
/* everything a building needs, resolved once                          */
/* ------------------------------------------------------------------ */

export interface LimitContext {
  reference: NzcbsReference;
  periods: ReportingPeriods;
  buildingType: Classified<BuildingType>;
  sectors: SectorClassification;
  operationalLimitYear: LimitYear;
  operationalEnergy: WeightedLimit;
  spaceHeating: WeightedLimit;
  embodied: EmbodiedLimitSelection[];
  pvUpfront: { value: number | null; unit: string; notes: string[] };
  renewables: RenewablesTargetSelection;
  gwpLimit: { value: number | null; unit: string; note: string };
}

export function resolveLimits(ref: NzcbsReference, profile: BuildingProfile, renewablesInput?: RenewablesInput): LimitContext {
  const periods = reportingPeriods(profile);
  const buildingType = classifyBuilding(profile);
  const sectors = classifySectors(profile);
  const operationalLimitYear = operationalLimitYear_(profile, buildingType.value, periods);
  const operationalEnergy = operationalEnergyLimit(ref, profile, sectors, buildingType.value, operationalLimitYear);
  const spaceHeating = spaceHeatingLimit(ref, profile, sectors, buildingType.value);
  const erp = periods.erp;
  const embodied = (profile.works ?? [])
    .filter((w) => !w.completionDate || (w.completionDate >= erp.from && w.completionDate <= erp.to))
    .map((w) => embodiedCarbonLimit(ref, profile, sectors, w));
  const gwp = otherLimit(ref, "refrigerant_gwp_limit");
  return {
    reference: ref,
    periods,
    buildingType,
    sectors,
    operationalLimitYear,
    operationalEnergy,
    spaceHeating,
    embodied,
    pvUpfront: pvUpfrontLimit(ref),
    renewables: renewablesTargetFor(ref, profile, sectors, renewablesInput, operationalEnergy),
    gwpLimit: { value: gwp?.value ?? null, unit: gwp?.unit ?? "kgCO2e/kg", note: gwp?.note ?? "" },
  };
}

const operationalLimitYear_ = operationalLimitYear;
