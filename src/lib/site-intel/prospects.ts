/**
 * S-08: the MEES prospect list.
 *
 * S-05 screens one building. This runs the same screening across the loaded
 * certificates and groups the results. It re-uses `screenMees` rather than
 * re-implementing the thresholds, so there is exactly one place where the
 * policy lives and one place to change when the legislation moves.
 *
 * THE CORPUS IS THE EPC REGISTER, NOT THE VOA LIST. S-07 searches VOA and
 * attaches an EPC band by postcode, which is honest there because the band is
 * a lead attached to a search result. Here the band IS the finding and the row
 * names a building, so a postcode-matched band would put a specific address on
 * a list of poorly-rated stock because a neighbour is poorly rated. The
 * certificate already carries the address, the floor area, the fuel and the
 * band in one record, so no cross-source linkage is needed for the claim the
 * list actually makes. VOA use class and rateable value are optional
 * enrichment at address-match quality, and are labelled as such.
 *
 * THERE IS NO PROSPECT SCORE. A single number blending band, area, fuel and
 * expiry would rank buildings by a weighting nobody chose and no source
 * supports, and it would be read as a measurement. Instead the rows are put in
 * named cohorts whose criteria are stated, and ordered by explicit columns.
 *
 * ONE ROW PER BUILDING, NOT PER CERTIFICATE. The register holds every
 * certificate ever lodged, so a building re-assessed from F in 2015 to B in
 * 2024 has two. Listing both would put it in the below-minimum cohort AND the
 * meets-target cohort, inflate every count, and send someone to an owner about
 * a band that was superseded years ago. Only the most recent certificate per
 * building is screened; the rest are counted and set aside, and the count is
 * reported rather than quietly dropped.
 *
 * COVERAGE IS THE LOADED CACHE, NOT THE COUNTRY. `epc_certificate` is filled
 * per postcode by lookups and by the bulk loader. "Three F-rated buildings in
 * DN4" means three among the certificates held, which is a different statement
 * from three in DN4. Every result carries the coverage it was drawn from.
 */

import { query } from "@/lib/db";
import type { EpcCertificate } from "./epc";
import { loadMeesRules, screenMees, type MeesScreening, type MeesStateKey } from "./mees";
import { certificateAge, classifyFuel, type Band } from "./performance";

/* --------------------------------------------------------------- cohorts --- */

export type Cohort =
  | "below_minimum"
  | "expired"
  | "at_risk_2031"
  | "area_unclear"
  | "no_further_target"
  | "meets_target"
  | "unscreenable";

export interface CohortSpec {
  key: Cohort;
  label: string;
  /** The criteria, in words. Shown with the cohort so a row is never bare. */
  criteria: string;
  /** Why it is a prospect. Commercial framing, no legal claim. */
  why: string;
}

/**
 * Ordered by urgency of the underlying position, which is not the same as
 * commercial value and is not a ranking of the buildings.
 */
export const COHORTS: readonly CohortSpec[] = [
  {
    key: "below_minimum",
    label: "Below the minimum band",
    criteria: "Band F or G on the most recent valid non-domestic certificate.",
    why:
      "Would breach the minimum standard if let on a qualifying lease, unless an exemption is " +
      "registered. Exemption status is not held here, so this is a prompt to check.",
  },
  {
    key: "expired",
    label: "Certificate expired",
    criteria: "More than ten years since lodgement.",
    why:
      "No valid certificate, so a letting needs a new assessment. A re-assessment is also the " +
      "moment improvement measures can be modelled before re-lodging.",
  },
  {
    key: "at_risk_2031",
    label: "Inside the proposed 2031 horizon",
    criteria: "Band C, D or E, floor area clearly above 1,000 m².",
    why:
      "The proposed EPC B standard for 2031 would reach these, subject to secondary legislation. " +
      "Improvement pathways take years to design and fund.",
  },
  {
    key: "area_unclear",
    label: "Regime cannot be determined",
    criteria: "Band C, D or E, floor area unknown or within 10% of the 1,000 m² threshold.",
    why:
      "Cannot be placed in or out of the 2031 horizon without a measured gross internal area of " +
      "the demise. A measurement resolves it.",
  },
  {
    key: "no_further_target",
    label: "Meets the minimum, no further target",
    criteria: "Band C, D or E, floor area clearly at or below 1,000 m².",
    why: "No EPC C or B target is currently proposed at this size. Included for completeness.",
  },
  {
    key: "meets_target",
    label: "Meets the proposed 2031 target",
    criteria:
      "Band A+, A or B on a valid certificate — at or above both the minimum in force and the " +
      "band proposed for 2031, at any floor area.",
    why:
      "Nothing outstanding on the standards screened here. Still worth a look on expiry: a " +
      "re-assessment can land in a different band.",
  },
  {
    key: "unscreenable",
    label: "Could not be screened",
    criteria: "No readable band on the certificate.",
    why: "Not a finding about the building — a gap in what the register published.",
  },
] as const;

const COHORT_BY_STATE: Record<MeesStateKey, Cohort> = {
  below_minimum: "below_minimum",
  certificate_expired: "expired",
  meets_minimum_below_2031_target: "at_risk_2031",
  area_indeterminate: "area_unclear",
  meets_minimum_no_further_target: "no_further_target",
  meets_2031_target: "meets_target",
  no_certificate_coverage_complete: "unscreenable",
  no_certificate_coverage_unknown: "unscreenable",
  not_supported_operational: "unscreenable",
  not_supported_domestic: "unscreenable",
};

export function cohortSpec(key: Cohort): CohortSpec {
  const spec = COHORTS.find((c) => c.key === key);
  if (!spec) throw new Error(`unknown cohort "${key}"`);
  return spec;
}

/* ----------------------------------------------------------------- rows --- */

export interface Prospect {
  lmkKey: string;
  address: string;
  postcode: string | null;
  /** Present only where the register supplied one. */
  uprn: string | null;
  cohort: Cohort;
  band: Band | null;
  score: number | null;
  floorAreaM2: number | null;
  mainFuel: string | null;
  /** True for natural gas and LPG: PV will not move the band. */
  gasOrLpg: boolean;
  lodgementDate: string | null;
  expiresOn: string | null;
  /** Negative once expired. */
  daysRemaining: number | null;
  bandsToMinimum: number | null;
  scorePointsToMinimum: number | null;
  bandsToTarget: number | null;
  scorePointsToTarget: number | null;
  /**
   * Always true. Carried per row, not only in a header, because a row that is
   * copied out of the list still has to say what it does not know.
   */
  exemptionStatusUnknown: boolean;
  /** The state's own sentence, so a row read alone still reads correctly. */
  finding: string;
  flagKeys: string[];
}

/* -------------------------------------------------------------- coverage --- */

export interface Coverage {
  /** Non-domestic certificates held, before any filter. */
  certificates: number;
  postcodes: number;
  districts: number;
  oldestRetrieved: string | null;
  newestRetrieved: string | null;
  /** Districts represented, capped for display. */
  sampleDistricts: string[];
  /**
   * Certificates set aside as superseded by a later one for the same building.
   * Reported because it is a fact about the list, not a detail of the query.
   */
  supersededSetAside: number;
  /** How the same building was recognised across certificates. */
  identityBasis: string;
  /** Always true while the corpus is a lookup cache plus bulk loads. */
  isPartial: boolean;
  statement: string;
}

/* --------------------------------------------------------------- summary --- */

export interface BandCount {
  band: Band | "none";
  count: number;
}

export interface ProspectSummary {
  total: number;
  byCohort: { cohort: Cohort; label: string; count: number }[];
  byBand: BandCount[];
  gasOrLpg: number;
  expiringWithinWindow: number;
  /** Share at or above each level, as percentages of rows with a band. */
  atOrAboveEPct: number | null;
  atOrAboveCPct: number | null;
  atOrAboveBPct: number | null;
  benchmark: {
    name: string;
    citation: string;
    atOrAboveEPct: number;
    atOrAboveCPct: number;
    atOrAboveBPct: number;
    caution: string;
  };
}

export interface ProspectFilter {
  cohorts?: Cohort[];
  /** Outward codes, e.g. ["DN4"]. */
  districts?: string[];
  postcodes?: string[];
  bands?: Band[];
  minAreaM2?: number;
  maxAreaM2?: number;
  /** Only gas and LPG heated buildings when true; only others when false. */
  gasOrLpg?: boolean;
  limit?: number;
}

export interface ProspectList {
  prospects: Prospect[];
  summary: ProspectSummary;
  coverage: Coverage;
  cohorts: CohortSpec[];
  /** The standing MEES caveats, from the screening. */
  caveats: string[];
  /** Rule keys still awaiting sign-off. */
  wordingUnapproved: string[];
  /** Filters that were asked for but could not be applied. */
  notApplied: { clause: string; reason: string }[];
  truncated: boolean;
}

export const PROSPECT_LIMIT = 500;

/* --------------------------------------------------------------- the run --- */

function rowToCertificate(r: Record<string, unknown>): EpcCertificate {
  const date = (v: unknown): string | null =>
    v ? new Date(v as string).toISOString().slice(0, 10) : null;
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  return {
    lmkKey: String(r.lmk_key),
    register: "non-domestic",
    address: (r.address as string) ?? "",
    postcode: (r.postcode as string) ?? null,
    uprn: (r.uprn as string) ?? null,
    uprnSource: (r.uprn_source as EpcCertificate["uprnSource"]) ?? "unknown",
    rating: (r.rating as string) ?? null,
    assetRating: num(r.asset_rating),
    floorAreaM2: num(r.floor_area_m2),
    inspectionDate: date(r.inspection_date),
    lodgementDate: date(r.lodgement_date),
    propertyType: (r.property_type as string) ?? null,
    buildingReference: (r.building_reference as string) ?? null,
    mainFuel: (r.main_fuel as string) ?? null,
    buildingEmissions: num(r.building_emissions),
    targetEmissions: num(r.target_emissions),
    standardEmissions: num(r.standard_emissions),
    primaryEnergy: num(r.primary_energy),
    transactionType: (r.transaction_type as string) ?? null,
  };
}

function toProspect(
  certificate: EpcCertificate,
  screening: MeesScreening,
  now: Date,
): Prospect {
  const age = certificateAge(certificate, now);
  const fuel = classifyFuel(certificate.mainFuel);

  return {
    lmkKey: certificate.lmkKey,
    address: certificate.address,
    postcode: certificate.postcode,
    uprn: certificate.uprn,
    cohort: COHORT_BY_STATE[screening.state],
    band: screening.band,
    score: screening.score,
    floorAreaM2: screening.areaM2,
    mainFuel: certificate.mainFuel,
    gasOrLpg: fuel === "gas",
    lodgementDate: certificate.lodgementDate,
    expiresOn: age.expiresOn,
    daysRemaining: age.daysRemaining,
    bandsToMinimum: screening.bandsToMinimum,
    scorePointsToMinimum: screening.scorePointsToMinimum,
    bandsToTarget: screening.bandsToTarget,
    scorePointsToTarget: screening.scorePointsToTarget,
    exemptionStatusUnknown: true,
    finding: screening.finding,
    flagKeys: screening.flags.map((f) => f.key),
  };
}

/**
 * Builds the prospect list over the loaded non-domestic certificates.
 *
 * Cohort membership is decided by `screenMees`, not by SQL, so a policy change
 * lands in one file. That means the cohort filter is applied after screening
 * rather than in the query - correctness over a scan we can afford at this
 * corpus size, and the cost is stated in `truncated` when the cap is hit.
 */
export async function buildProspectList(
  filter: ProspectFilter = {},
  now: Date = new Date(),
): Promise<ProspectList> {
  const rules = loadMeesRules();
  const limit = filter.limit ?? PROSPECT_LIMIT;
  const notApplied: { clause: string; reason: string }[] = [];

  /* -- coverage, computed before any filter ------------------------------- */
  const [cov] = await query<Record<string, unknown>>(
    `SELECT count(*)::int AS certificates,
            count(DISTINCT postcode)::int AS postcodes,
            count(DISTINCT split_part(postcode, ' ', 1))::int AS districts,
            min(retrieved_at) AS oldest,
            max(retrieved_at) AS newest
       FROM epc_certificate
      WHERE register = 'non-domestic'`,
  );
  const districtRows = await query<{ district: string }>(
    `SELECT DISTINCT split_part(postcode, ' ', 1) AS district
       FROM epc_certificate
      WHERE register = 'non-domestic' AND postcode IS NOT NULL
      ORDER BY 1 LIMIT 25`,
  );

  const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

  /* -- the query: cheap filters only -------------------------------------- */
  const where: string[] = ["register = 'non-domestic'"];
  const values: unknown[] = [];
  const param = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filter.postcodes?.length) {
    where.push(`postcode = ANY(${param(filter.postcodes)}::text[])`);
  }
  if (filter.districts?.length) {
    where.push(`split_part(postcode, ' ', 1) = ANY(${param(filter.districts)}::text[])`);
  }
  if (filter.bands?.length) {
    where.push(`upper(replace(rating, ' ', '')) = ANY(${param(filter.bands)}::text[])`);
  }
  if (filter.minAreaM2 !== undefined) where.push(`floor_area_m2 >= ${param(filter.minAreaM2)}`);
  if (filter.maxAreaM2 !== undefined) where.push(`floor_area_m2 <= ${param(filter.maxAreaM2)}`);

  /*
   * The building key, best identifier first. A UPRN is the register's own link
   * to the address base; the building reference is its internal one; the
   * address is the fallback and the weakest, so two spellings of one address
   * would still produce two rows. That is the safe direction to fail - a
   * duplicate is visible, a wrongly merged pair is not.
   */
  const BUILDING_KEY =
    `COALESCE(uprn, building_reference, lower(coalesce(address,'')) || '|' || coalesce(postcode,''))`;

  const rows = await query<Record<string, unknown>>(
    `SELECT DISTINCT ON (${BUILDING_KEY})
            lmk_key, register, address, postcode, uprn, uprn_source, rating,
            asset_rating, floor_area_m2, inspection_date, lodgement_date,
            property_type, building_reference, main_fuel, building_emissions,
            target_emissions, standard_emissions, primary_energy, transaction_type
       FROM epc_certificate
      WHERE ${where.join(" AND ")}
      ORDER BY ${BUILDING_KEY},
               lodgement_date DESC NULLS LAST,
               inspection_date DESC NULLS LAST,
               lmk_key
      LIMIT ${param(limit * 4)}`,
    values,
  );

  // Counted over the same filter, so the number means "set aside from THIS
  // list" rather than "exist somewhere in the table".
  const [dupes] = await query<{ superseded: string }>(
    `SELECT (count(*) - count(DISTINCT ${BUILDING_KEY}))::text AS superseded
       FROM epc_certificate
      WHERE ${where.join(" AND ")}`,
    values.slice(0, values.length - 1),
  );
  const supersededSetAside = Number(dupes?.superseded ?? 0);

  const coverage: Coverage = {
    certificates: Number(cov?.certificates ?? 0),
    postcodes: Number(cov?.postcodes ?? 0),
    districts: Number(cov?.districts ?? 0),
    oldestRetrieved: iso(cov?.oldest),
    newestRetrieved: iso(cov?.newest),
    sampleDistricts: districtRows.map((r) => r.district).filter(Boolean),
    supersededSetAside,
    identityBasis: "UPRN where present, then the register's building reference, then address and postcode",
    isPartial: true,
    statement:
      `This list covers the ${Number(cov?.certificates ?? 0).toLocaleString()} non-domestic certificates ` +
      `currently loaded, across ${Number(cov?.districts ?? 0)} postcode district(s). That is what has been ` +
      `fetched or bulk-loaded, not the national register: a count here is a count of what is held, never ` +
      `a count of what exists.` +
      (supersededSetAside > 0
        ? ` ${supersededSetAside.toLocaleString()} older certificate(s) were set aside as superseded by a ` +
          `later assessment of the same building, so each building appears once, at its most recent band.`
        : ""),
  };

  /* -- screen, then cohort ------------------------------------------------ */
  const screened = rows.map((r) => {
    const certificate = rowToCertificate(r);
    const screening = screenMees(certificate, { now });
    return { certificate, screening, prospect: toProspect(certificate, screening, now) };
  });

  let kept = screened;
  if (filter.cohorts?.length) {
    const wanted = new Set(filter.cohorts);
    kept = kept.filter((s) => wanted.has(s.prospect.cohort));
  }
  if (filter.gasOrLpg !== undefined) {
    kept = kept.filter((s) => s.prospect.gasOrLpg === filter.gasOrLpg);
  }

  // Ordering: by the cohort's urgency, then by how far below the standard the
  // building is, then by size. Explicit columns, never a blended score.
  const order = new Map(COHORTS.map((c, i) => [c.key, i]));
  kept.sort((a, b) => {
    const byCohort = (order.get(a.prospect.cohort) ?? 99) - (order.get(b.prospect.cohort) ?? 99);
    if (byCohort !== 0) return byCohort;
    const gap = (b.prospect.scorePointsToTarget ?? -1) - (a.prospect.scorePointsToTarget ?? -1);
    if (gap !== 0) return gap;
    return (b.prospect.floorAreaM2 ?? 0) - (a.prospect.floorAreaM2 ?? 0);
  });

  const truncated = kept.length > limit;
  const prospects = kept.slice(0, limit).map((s) => s.prospect);

  if (truncated) {
    notApplied.push({
      clause: `Showing ${limit} of ${kept.length} matches`,
      reason: "Narrow by postcode district, band or cohort to see the rest.",
    });
  }

  /* -- summary, over the kept set ----------------------------------------- */
  const bandOrder: (Band | "none")[] = ["A+", "A", "B", "C", "D", "E", "F", "G", "none"];
  const bandCounts = new Map<Band | "none", number>();
  for (const p of prospects) {
    const key = p.band ?? "none";
    bandCounts.set(key, (bandCounts.get(key) ?? 0) + 1);
  }

  const withBand = prospects.filter((p) => p.band !== null).length;
  const atOrAbove = (target: Band): number | null => {
    if (!withBand) return null;
    const idx = bandOrder.indexOf(target);
    const n = prospects.filter(
      (p) => p.band !== null && bandOrder.indexOf(p.band) <= idx,
    ).length;
    return Math.round((n / withBand) * 10000) / 100;
  };

  const b = rules.benchmark;
  const summary: ProspectSummary = {
    total: prospects.length,
    byCohort: COHORTS.map((c) => ({
      cohort: c.key,
      label: c.label,
      count: prospects.filter((p) => p.cohort === c.key).length,
    })),
    byBand: bandOrder
      .filter((band) => bandCounts.has(band))
      .map((band) => ({ band, count: bandCounts.get(band) as number })),
    gasOrLpg: prospects.filter((p) => p.gasOrLpg).length,
    expiringWithinWindow: prospects.filter((p) => p.flagKeys.includes("expiring_soon")).length,
    atOrAboveEPct: atOrAbove("E"),
    atOrAboveCPct: atOrAbove("C"),
    atOrAboveBPct: atOrAbove("B"),
    benchmark: {
      name: b.name,
      citation: b.citation,
      atOrAboveEPct: b.at_or_above_e_pct,
      atOrAboveCPct: b.at_or_above_c_pct,
      atOrAboveBPct: b.at_or_above_b_pct,
      caution: b.caution.replace(/\s+/g, " ").trim(),
    },
  };

  // The standing caveats come from a screening rather than being restated, so
  // they cannot drift from what S-05 says.
  const caveats = screenMees(null).caveats;

  const { unapprovedMeesRules } = await import("./mees");

  return {
    prospects,
    summary,
    coverage,
    cohorts: [...COHORTS],
    caveats,
    wordingUnapproved: unapprovedMeesRules(),
    notApplied,
    truncated,
  };
}
