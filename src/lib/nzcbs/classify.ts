import {
  ADDITIONAL_USES_BY_SECTOR,
  ADDITIONAL_USE_NIA_SHARE_LIMIT,
  ERP_YEARS,
  MINOR_SECTOR_NIA_SHARE,
  NEW_BUILDING_NIA_SHARE,
  PARTICULAR_USE_LIMIT_SECTOR,
  REPORTABLE_WORKS_VALUE_GBP,
  RETROFIT_ENVELOPE_SHARE,
  SOUTH_ENGLAND_COUNTIES,
  UNCLASSIFIABLE_NIA_SHARE_LIMIT,
} from "./constants";
import { SECTORS, type BuildingProfile, type BuildingType, type FloorArea, type Region, type Sector, type WorksFacts, type WorksProgramme, type WorksType } from "./types";

/**
 * Section 4 classification: building type (Table 4), works type (Table 5),
 * sectors and subsectors (4.2.2), the reporting periods (4.2.4) and the
 * Annex A3 region. Every function is pure and returns its reasoning, because
 * the classification is itself a submission item (4.2.7).
 */

export interface Classified<T> {
  value: T;
  section: string;
  reasons: string[];
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

/* ------------------------------------------------------------------ */
/* reporting periods                                                   */
/* ------------------------------------------------------------------ */

export interface ReportingPeriods {
  rpep: string;
  /** Operational Reporting Period, inclusive start and exclusive end. */
  orp: { from: string; to: string };
  /** Embodied Reporting Period, inclusive start and exclusive end. */
  erp: { from: string; to: string };
  /** 5.2.7.1 stepped route: the ORP start year sets the limit year. */
  orpStartYear: number;
  reasons: string[];
}

function shiftIso(date: string, years: number, months = 0): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years, d.getUTCMonth() + months, d.getUTCDate());
  return d.toISOString().slice(0, 10);
}

/** 4.2.4: ORP is the year before the RPEP; ERP is five years before it or since the previous RPEP if sooner. */
export function reportingPeriods(profile: Pick<BuildingProfile, "rpep" | "previousRpep">): ReportingPeriods {
  const orpFrom = shiftIso(profile.rpep, -1);
  const fiveYears = shiftIso(profile.rpep, -ERP_YEARS);
  const reasons = [`ORP runs from ${orpFrom} to the RPEP ${profile.rpep} (4.2.4.2).`];
  let erpFrom = fiveYears;
  if (profile.previousRpep && profile.previousRpep > fiveYears) {
    erpFrom = profile.previousRpep;
    reasons.push(`ERP starts at the previous RPEP ${profile.previousRpep}, which is within five years (4.2.4.2).`);
  } else {
    reasons.push(`ERP starts five years before the RPEP, ${fiveYears} (4.2.4.2).`);
  }
  if (profile.previousRpep && shiftIso(profile.previousRpep, 1) < profile.rpep) {
    reasons.push(`The RPEP is more than twelve months after the previous RPEP ${profile.previousRpep}, so there is a gap in claim validity that must be communicated (4.2.4.1 note 2, 7.2).`);
  }
  return { rpep: profile.rpep, orp: { from: orpFrom, to: profile.rpep }, erp: { from: erpFrom, to: profile.rpep }, orpStartYear: Number(orpFrom.slice(0, 4)), reasons };
}

/* ------------------------------------------------------------------ */
/* works and building type                                             */
/* ------------------------------------------------------------------ */

/** Table 5. */
export function classifyWorks(facts: WorksFacts | undefined): Classified<WorksType> {
  const f = facts ?? {};
  if ((f.newNiaShare ?? 0) >= NEW_BUILDING_NIA_SHARE) {
    return { value: "New Works", section: "4.2.1 Table 5", reasons: [`${pct(f.newNiaShare!)} of NIA is new, at or above the ${pct(NEW_BUILDING_NIA_SHARE)} test.`] };
  }
  if (f.singleStoreyAllNewAboveSlab) {
    return { value: "New Works", section: "4.2.1 Table 5", reasons: ["Single-storey building with every element above the ground floor slab new."] };
  }
  if ((f.thermalEnvelopeShareReplaced ?? 0) >= RETROFIT_ENVELOPE_SHARE) {
    return { value: "Retrofit Works", section: "4.2.1 Table 5", reasons: [`${pct(f.thermalEnvelopeShareReplaced!)} of the original thermal envelope is new, upgraded or replaced (test: ${pct(RETROFIT_ENVELOPE_SHARE)}).`] };
  }
  if ((f.glazedAreaShareReplaced ?? 0) >= RETROFIT_ENVELOPE_SHARE) {
    return { value: "Retrofit Works", section: "4.2.1 Table 5", reasons: [`${pct(f.glazedAreaShareReplaced!)} of the original glazed area is new, upgraded or replaced (test: ${pct(RETROFIT_ENVELOPE_SHARE)}).`] };
  }
  if (f.firstFitOut) {
    return { value: "Non-Reportable Works", section: "4.2.1 Table 5 note c", reasons: ["First fit-out belongs to the New or Retrofit Works that preceded it and is not Reportable Works on its own."] };
  }
  const reportable: string[] = [];
  if ((f.valueGbp ?? 0) >= REPORTABLE_WORKS_VALUE_GBP) reportable.push(`works value £${f.valueGbp!.toLocaleString("en-GB")} is at or above £${REPORTABLE_WORKS_VALUE_GBP.toLocaleString("en-GB")}`);
  if (f.newOrReplacedHvacPlant) reportable.push("new or replacement heating, cooling or ventilation plant");
  if (f.replacedLightingSystems) reportable.push("replacement of lighting systems");
  if (reportable.length) return { value: "Reportable Works", section: "4.2.1 Table 5", reasons: reportable };
  return { value: "Non-Reportable Works", section: "4.2.1 Table 5", reasons: ["None of the New, Retrofit or Reportable Works tests is met."] };
}

export function worksType(w: WorksProgramme): Classified<WorksType> {
  if (w.type) return { value: w.type, section: "4.2.1 Table 5", reasons: ["Works type as declared."] };
  return classifyWorks(w.facts);
}

/** Table 4. */
export function classifyBuilding(profile: BuildingProfile): Classified<BuildingType> {
  if (profile.previouslyClassifiedNewBuilding) {
    return { value: "New Building", section: "4.2.1 Table 4", reasons: ["Previously defined as a New Building in a submission under this Standard."] };
  }
  const nia = profile.niaM2 > 0 ? profile.niaM2 : profile.areas.reduce((n, a) => n + a.niaM2, 0);
  const newNia = profile.areas.filter((a) => a.newArea).reduce((n, a) => n + a.niaM2, 0);
  const share = nia > 0 ? newNia / nia : 0;
  if (share >= NEW_BUILDING_NIA_SHARE) {
    return { value: "New Building", section: "4.2.1 Table 4", reasons: [`${pct(share)} of NIA is New Area (3.1.4.10), at or above the ${pct(NEW_BUILDING_NIA_SHARE)} test.`] };
  }
  for (const w of profile.works ?? []) {
    if (w.facts?.singleStoreyAllNewAboveSlab) {
      return { value: "New Building", section: "4.2.1 Table 4", reasons: [`Works ${w.id}: single-storey with every element above the ground floor slab new.`] };
    }
  }
  return { value: "Existing Building", section: "4.2.1 Table 4", reasons: [`${pct(share)} of NIA is New Area, below the ${pct(NEW_BUILDING_NIA_SHARE)} test, and no other Table 4 criterion applies.`] };
}

/* ------------------------------------------------------------------ */
/* sectors                                                             */
/* ------------------------------------------------------------------ */

export interface SectorShare {
  sector: Sector;
  niaM2: number;
  share: number;
  /** Subsectors and scopes present, with their NIA, for Equation 1a. */
  parts: { subsector?: string; scope?: string; niaM2: number; newArea: boolean; particularUse?: string }[];
}

export interface SectorClassification {
  /** "Mixed-Use" or the single sector. */
  classification: Sector | "Mixed-Use";
  sectors: SectorShare[];
  /** Sectors present but omitted from classification and limit-setting under the 10% rule. */
  omitted: SectorShare[];
  unclassifiableShare: number;
  /** 4.2.2 step 1: at or above 30% unclassifiable, the building cannot claim conformity. */
  canClaim: boolean;
  additionalUses: { label: string; niaM2: number; submetered: boolean; sector: Sector | null; allowed: boolean; reason: string }[];
  additionalUseShare: number;
  totalNiaM2: number;
  reasons: string[];
}

/** 4.2.2 steps 1 to 4, with Table 9 Additional Uses checked. */
export function classifySectors(profile: BuildingProfile): SectorClassification {
  const reasons: string[] = [];
  const total = profile.areas.reduce((n, a) => n + a.niaM2, 0);
  const totalNia = total > 0 ? total : profile.niaM2;
  const unclassifiable = profile.areas.filter((a) => a.sector === null).reduce((n, a) => n + a.niaM2, 0);
  const unclassifiableShare = totalNia > 0 ? unclassifiable / totalNia : 0;
  const canClaim = unclassifiableShare < UNCLASSIFIABLE_NIA_SHARE_LIMIT;
  if (!canClaim) reasons.push(`${pct(unclassifiableShare)} of NIA is unclassifiable, at or above ${pct(UNCLASSIFIABLE_NIA_SHARE_LIMIT)}, so the building cannot claim conformity (4.2.2 step 1).`);

  const bySector = new Map<Sector, SectorShare>();
  for (const a of profile.areas) {
    if (a.sector === null) continue;
    if (!SECTORS.includes(a.sector)) throw new Error(`"${a.sector}" is not a Table 6 sector.`);
    const entry = bySector.get(a.sector) ?? { sector: a.sector, niaM2: 0, share: 0, parts: [] };
    entry.niaM2 += a.niaM2;
    entry.parts.push({ subsector: a.subsector, scope: a.scope, niaM2: a.niaM2, newArea: !!a.newArea, particularUse: a.particularUse });
    bySector.set(a.sector, entry);
  }
  const all = [...bySector.values()].map((s) => ({ ...s, share: totalNia > 0 ? round(s.niaM2 / totalNia) : 0 })).sort((a, b) => b.niaM2 - a.niaM2);
  const omit = profile.omitMinorSectors ?? true;
  const omitted = omit && all.length > 1 ? all.filter((s) => s.share < MINOR_SECTOR_NIA_SHARE) : [];
  const kept = all.filter((s) => !omitted.includes(s));
  if (omitted.length) reasons.push(`Omitted from classification and limit-setting as under ${pct(MINOR_SECTOR_NIA_SHARE)} of NIA (4.2.2 step 3): ${omitted.map((s) => `${s.sector} ${pct(s.share)}`).join(", ")}. Their energy is still assessed against the limits.`);

  const classification: Sector | "Mixed-Use" = kept.length === 1 ? kept[0].sector : "Mixed-Use";
  if (kept.length === 0) reasons.push("No classifiable floor area was supplied.");
  else if (classification === "Mixed-Use") reasons.push(`Mixed-Use: ${kept.map((s) => `${s.sector} ${pct(s.share)}`).join(", ")} (4.2.2 step 4).`);
  else reasons.push(`Single sector: ${classification} (4.2.2 step 4).`);

  const additionalUses = profile.areas
    .filter((a) => a.additionalUse)
    .map((a) => {
      const permitted = a.sector ? (ADDITIONAL_USES_BY_SECTOR[a.sector] ?? []) : [];
      const listed = permitted.some((p) => p.toLowerCase() === a.additionalUse!.toLowerCase());
      let reason = "";
      if (!a.sector) reason = "Additional Uses are defined per sector (Table 9); an unclassifiable area cannot claim one.";
      else if (!listed) reason = `"${a.additionalUse}" is not a Table 9 Additional Use for ${a.sector}. Permitted: ${permitted.join("; ") || "none"}.`;
      else if (!a.submetered) reason = "Additional Uses must be submetered to be exempt from the limits (5.2.1.3).";
      return { label: a.additionalUse!, niaM2: a.niaM2, submetered: !!a.submetered, sector: a.sector, allowed: reason === "", reason: reason || "Table 9 Additional Use, submetered." };
    });
  const additionalUseNia = additionalUses.filter((u) => u.allowed).reduce((n, u) => n + u.niaM2, 0);
  const additionalUseShare = totalNia > 0 ? round(additionalUseNia / totalNia) : 0;
  if (additionalUseShare > ADDITIONAL_USE_NIA_SHARE_LIMIT) {
    reasons.push(`Additional Uses cover ${pct(additionalUseShare)} of NIA, above the ${pct(ADDITIONAL_USE_NIA_SHARE_LIMIT)} cap (5.2.1.3); the excess cannot be exempted from the limits.`);
  }

  return { classification, sectors: kept, omitted, unclassifiableShare: round(unclassifiableShare), canClaim, additionalUses, additionalUseShare, totalNiaM2: totalNia, reasons };
}

/** Table 12: the sector and subsector whose limit a particular use takes when setting the EUI limit. */
export function limitSectorFor(area: FloorArea): { sector: string; subsector?: string; scope?: string } | null {
  if (area.particularUse) {
    const mapped = PARTICULAR_USE_LIMIT_SECTOR[area.particularUse];
    if (mapped) return { sector: mapped.sector, subsector: mapped.subsector };
  }
  if (!area.sector) return null;
  return { sector: area.sector, subsector: area.subsector, scope: area.scope };
}

/* ------------------------------------------------------------------ */
/* region                                                              */
/* ------------------------------------------------------------------ */

/** Annex A3: region from a county name (England) or a nation. */
export function regionFor(input: { nation?: "England" | "Scotland" | "Wales" | "Northern Ireland"; county?: string }): Classified<Region | null> {
  if (input.nation === "Scotland") return { value: "A. Scotland", section: "Annex A3", reasons: ["Scotland."] };
  if (input.nation === "Wales" || input.nation === "Northern Ireland") {
    return { value: "B. Middle and North England, Northern Ireland, Wales", section: "Annex A3", reasons: [`${input.nation}.`] };
  }
  if (input.county) {
    const c = input.county.trim().toLowerCase();
    const south = SOUTH_ENGLAND_COUNTIES.some((x) => x.toLowerCase() === c);
    if (south) return { value: "C. South England", section: "Annex A3", reasons: [`${input.county} is in the Annex A3 list of South England counties.`] };
    if (input.nation === "England") return { value: "B. Middle and North England, Northern Ireland, Wales", section: "Annex A3", reasons: [`${input.county} is not in the Annex A3 list of South England counties.`] };
  }
  return { value: null, section: "Annex A3", reasons: ["Region needs the nation, and for England the county, to be known."] };
}

function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}
