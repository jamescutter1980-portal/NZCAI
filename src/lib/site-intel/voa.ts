/**
 * S-06: VOA floor area and use class.
 *
 * NOTE ON SCOPE. The brief lists S-06 under section 10, "Out of scope (later
 * briefs)", in one line. Built without a specification; assumptions recorded in
 * docs/site-intel/PLAN.md.
 *
 * Three facts about VOA data decide the design, and each one is a place where a
 * careless implementation would produce a confident wrong answer.
 *
 * 1. THERE IS NO FREE UPRN LINKAGE. The published rating list carries VOA's own
 *    UARN and a property address, not a UPRN. The UPRN-to-VOA cross reference
 *    lives in OS AddressBase Premium, which is a paid product. So, exactly as
 *    with ownership in S-04, the free route is to match on address - and every
 *    result is therefore inferred, tier T3.
 *
 * 2. A FLOOR AREA IS MEANINGLESS WITHOUT ITS BASIS. Survey lines are measured on
 *    GIA, NIA, GEA or EFA depending on the class of property. These are not
 *    interchangeable: NIA excludes circulation and plant, GEA includes external
 *    wall thickness. An energy intensity in kWh/m² changes materially depending
 *    on which one you divide by, so the basis travels with the number and is
 *    never silently dropped.
 *
 * 3. THE VOA DESCRIPTION IS NOT A PLANNING USE CLASS. "WAREHOUSE AND PREMISES"
 *    is a valuation description, produced for rating purposes under its own
 *    scheme of primary description and SCat codes. Planning Use Classes come
 *    from the Use Classes Order and the site's planning history. Mapping one to
 *    the other is an inference, and this module labels it as one.
 */

import { normalisePostcode } from "./geo";
import {
  addressScore,
  addressTokens,
  numberConflict,
  ADDRESS_MATCH_THRESHOLD,
} from "./address-match";
import { lineage } from "./sources";
import type { SourceRecord } from "./types";
import type { AreaBasis } from "./area-basis";

// Measurement bases live in their own module so the client can import the
// labels without pulling this file's YAML-reading dependencies into the bundle.
export { AREA_BASIS_LABEL, type AreaBasis } from "./area-basis";

export interface SurveyLine {
  /** e.g. "Ground Floor Store", "First Floor Offices". */
  description: string | null;
  areaM2: number | null;
  basis: AreaBasis;
  pricePerM2: number | null;
  value: number | null;
}

export interface VoaAssessment {
  /** VOA's own identifier. Not a UPRN. */
  uarn: string;
  billingAuthorityCode: string | null;
  billingAuthorityReference: string | null;
  /** Valuation description, e.g. "WAREHOUSE AND PREMISES". Not a use class. */
  primaryDescription: string | null;
  /** VOA Special Category code. */
  scatCode: string | null;
  propertyAddress: string | null;
  postcode: string | null;
  rateableValue: number | null;
  effectiveDate: string | null;
  listYear: number | null;
  surveyLines: SurveyLine[];
}

/* ----------------------------------------------------------- floor area --- */

export interface AreaTotal {
  basis: AreaBasis;
  areaM2: number;
  lineCount: number;
}

/**
 * Totals the survey lines per basis, keeping them separate.
 *
 * Summing GIA and NIA lines into one number would be arithmetic on
 * incompatible quantities. Where a property genuinely mixes bases that is a
 * finding - reported as `mixed_basis` - not something to average away.
 */
export function totalAreaByBasis(assessment: VoaAssessment): AreaTotal[] {
  const totals = new Map<AreaBasis, AreaTotal>();
  for (const line of assessment.surveyLines) {
    if (line.areaM2 === null || !Number.isFinite(line.areaM2)) continue;
    const current = totals.get(line.basis) ?? { basis: line.basis, areaM2: 0, lineCount: 0 };
    current.areaM2 += line.areaM2;
    current.lineCount += 1;
    totals.set(line.basis, current);
  }
  return [...totals.values()]
    .map((t) => ({ ...t, areaM2: Math.round(t.areaM2 * 100) / 100 }))
    .sort((a, b) => b.areaM2 - a.areaM2);
}

/** Where an assessment states a single basis, the headline total for it. */
export function headlineArea(assessment: VoaAssessment): AreaTotal | null {
  const totals = totalAreaByBasis(assessment);
  if (!totals.length) return null;
  // Prefer a stated basis over "unknown" even if the unknown total is larger.
  const stated = totals.filter((t) => t.basis !== "unknown");
  return stated.length ? stated[0] : totals[0];
}

/* ------------------------------------------------- floor area comparison --- */

export interface AreaEstimate {
  areaM2: number;
  basis: AreaBasis;
  /** Where the figure came from, in words. */
  source: string;
  /** Lineage tier of the underlying figure. */
  tier: SourceRecord["tier"];
}

export interface AreaComparison {
  estimates: AreaEstimate[];
  /** Largest relative gap between any two estimates, 0-1. Null if fewer than two. */
  spread: number | null;
  flags: string[];
  note: string | null;
}

/**
 * The brief (section 7) asks for a `floor_area_check` when footprint x storeys
 * differs from the EPC floor area by more than 25%. VOA adds a third figure, so
 * this generalises: every estimate is kept, with its basis, and divergence is
 * reported rather than resolved.
 *
 * Picking one silently would be the wrong move. Energy intensity, CRREM
 * pathways and NZCBS targets are all per m², so the choice of denominator is a
 * judgement for the assessor, made visibly.
 */
export const AREA_DIVERGENCE_THRESHOLD = 0.25;

export function compareAreas(estimates: AreaEstimate[]): AreaComparison {
  const usable = estimates.filter((e) => Number.isFinite(e.areaM2) && e.areaM2 > 0);
  const flags: string[] = [];

  if (usable.length < 2) {
    return {
      estimates: usable,
      spread: null,
      flags: usable.length ? [] : ["no_floor_area"],
      note: usable.length
        ? "Only one floor area is available, so it cannot be cross-checked."
        : "No floor area is available for this site from any source.",
    };
  }

  const values = usable.map((e) => e.areaM2);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Number(((max - min) / max).toFixed(4));

  if (spread > AREA_DIVERGENCE_THRESHOLD) flags.push("floor_area_check");

  const bases = new Set(usable.map((e) => e.basis).filter((b) => b !== "unknown"));
  if (bases.size > 1) flags.push("mixed_basis");

  const note = flags.includes("floor_area_check")
    ? `Floor areas differ by ${Math.round(spread * 100)}%. ` +
      (flags.includes("mixed_basis")
        ? "They are also measured on different bases, which explains part of the gap but not necessarily all of it. "
        : "") +
      "Choose the basis deliberately before calculating anything per m²."
    : bases.size > 1
      ? "Floor areas agree closely but are measured on different bases; confirm which one the calculation needs."
      : null;

  return { estimates: usable, spread, flags, note };
}

/* ------------------------------------------------------------ use class --- */

export interface UseClassInference {
  /** The VOA description the inference was made from. */
  from: string;
  /** Likely planning use class, e.g. "B8". Null where no confident mapping. */
  useClass: string | null;
  label: string | null;
  /** Always true. A valuation description is not a planning determination. */
  inferred: true;
  note: string;
}

const USE_CLASS_NOTE =
  "Inferred from the VOA valuation description, which is produced for rating " +
  "purposes and is not a planning Use Class. The actual use class follows from " +
  "the Use Classes Order and this site's planning history. Confirm before relying on it.";

/**
 * Maps a VOA description to a likely use class.
 *
 * Deliberately conservative: patterns only fire on unambiguous descriptions, and
 * anything else returns null rather than a guess. Ordering matters - more
 * specific patterns are tested first.
 */
const USE_CLASS_PATTERNS: { pattern: RegExp; useClass: string; label: string }[] = [
  { pattern: /\bWAREHOUSE\b|\bSTORE\s?(AND|&)\s?PREMISES\b|\bDISTRIBUTION\b/, useClass: "B8", label: "Storage or distribution" },
  { pattern: /\bFACTORY\b|\bWORKSHOP\b|\bINDUSTRIAL\b/, useClass: "B2", label: "General industrial" },
  { pattern: /\bOFFICE/, useClass: "E(g)(i)", label: "Office" },
  { pattern: /\bSHOP\b|\bRETAIL\b|\bSHOWROOM\b/, useClass: "E(a)", label: "Retail" },
  { pattern: /\bRESTAURANT\b|\bCAFE\b/, useClass: "E(b)", label: "Food and drink" },
  { pattern: /\bSURGERY\b|\bCLINIC\b|\bHEALTH CENTRE\b/, useClass: "E(e)", label: "Medical or health services" },
  { pattern: /\bGYM\b|\bSPORTS\b|\bLEISURE CENTRE\b/, useClass: "E(d)", label: "Indoor sport or recreation" },
  { pattern: /\bSCHOOL\b|\bCOLLEGE\b|\bUNIVERSITY\b/, useClass: "F1", label: "Learning and non-residential institutions" },
  { pattern: /\bHOTEL\b/, useClass: "C1", label: "Hotel" },
  { pattern: /\bPUBLIC HOUSE\b|\bWINE BAR\b|\bBAR\b/, useClass: "Sui generis", label: "Drinking establishment" },
];

export function inferUseClass(description: string | null | undefined): UseClassInference | null {
  if (!description?.trim()) return null;
  const text = description.toUpperCase();

  for (const { pattern, useClass, label } of USE_CLASS_PATTERNS) {
    if (pattern.test(text)) {
      return { from: description, useClass, label, inferred: true, note: USE_CLASS_NOTE };
    }
  }

  return {
    from: description,
    useClass: null,
    label: null,
    inferred: true,
    note:
      "No confident use-class mapping for this VOA description. " +
      "Determine the use class from the planning history.",
  };
}

/* ------------------------------------------------------------- matching --- */

export type VoaMatchQuality = "postcode_and_address" | "postcode_only";

export interface VoaCandidate {
  assessment: VoaAssessment;
  quality: VoaMatchQuality;
  score: number;
  reasons: string[];
  source: SourceRecord;
}

export interface VoaResult {
  candidates: VoaCandidate[];
  /** Always true: there is no free UPRN-to-UARN linkage. */
  inferredFromAddress: boolean;
  searchedPostcode: string | null;
  flags: string[];
  note: string;
}

const NO_UPRN_LINKAGE_NOTE =
  "Matched by address against the VOA rating list. The published list carries " +
  "VOA's own UARN rather than a UPRN - the cross reference is in OS AddressBase " +
  "Premium, a paid product - so this is a probable match to verify, not a " +
  "confirmed assessment for this building.";

export interface VoaMatchInput {
  address: string | null;
  postcode: string | null;
}

export function matchAssessments(
  site: VoaMatchInput,
  assessments: VoaAssessment[],
): VoaCandidate[] {
  const sitePostcode = site.postcode ? normalisePostcode(site.postcode) : null;
  const siteTokens = addressTokens(site.address);
  const candidates: VoaCandidate[] = [];

  for (const assessment of assessments) {
    const assessmentPostcode = assessment.postcode
      ? normalisePostcode(assessment.postcode)
      : null;
    if (!sitePostcode || sitePostcode !== assessmentPostcode) continue;

    const tokens = addressTokens(assessment.propertyAddress);
    const score = addressScore(siteTokens, tokens);
    const reasons: string[] = [`Postcode ${sitePostcode} matches`];
    let quality: VoaMatchQuality = "postcode_only";

    if (siteTokens.size && score >= ADDRESS_MATCH_THRESHOLD && !numberConflict(siteTokens, tokens)) {
      quality = "postcode_and_address";
      reasons.push(`Address tokens agree (${Math.round(score * 100)}%)`);
    } else if (!siteTokens.size) {
      reasons.push("No site address to compare, so the postcode is all that matched");
    } else if (numberConflict(siteTokens, tokens)) {
      reasons.push("Building numbers disagree");
    } else {
      reasons.push(`Address tokens agree only weakly (${Math.round(score * 100)}%)`);
    }

    if (!assessment.surveyLines.length) {
      reasons.push("No survey lines, so no floor area is available for this assessment");
    }

    candidates.push({
      assessment,
      quality,
      score,
      reasons,
      source: lineage({
        sourceId: "voa-rating-list",
        entityRef: assessment.uarn,
        method: `matched on postcode${quality === "postcode_and_address" ? " and address" : " only"}`,
        tier: "T3",
        sourceUpdated: assessment.effectiveDate,
      }),
    });
  }

  return candidates.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality === "postcode_and_address" ? -1 : 1;
    return b.score - a.score;
  });
}

export function buildVoaResult(
  site: VoaMatchInput,
  assessments: VoaAssessment[],
): VoaResult {
  const searchedPostcode = site.postcode ? normalisePostcode(site.postcode) : null;
  const candidates = matchAssessments(site, assessments);
  const flags: string[] = [];

  if (!searchedPostcode) flags.push("no_postcode");
  if (candidates.length > 1) flags.push("multiple_assessment_candidates");
  if (candidates.length && candidates.every((c) => c.quality === "postcode_only")) {
    flags.push("postcode_only_match");
  }
  if (candidates.length && candidates.every((c) => !c.assessment.surveyLines.length)) {
    flags.push("no_survey_lines");
  }

  return {
    candidates,
    inferredFromAddress: true,
    searchedPostcode,
    flags,
    note: NO_UPRN_LINKAGE_NOTE,
  };
}

/** VOA floor areas from the best candidate, as comparison estimates. */
export function voaAreaEstimates(result: VoaResult): AreaEstimate[] {
  const best = result.candidates[0];
  if (!best) return [];
  return totalAreaByBasis(best.assessment).map((total) => ({
    areaM2: total.areaM2,
    basis: total.basis,
    source: `VOA rating list, UARN ${best.assessment.uarn} (${total.lineCount} survey ${total.lineCount === 1 ? "line" : "lines"})`,
    tier: "T3" as const,
  }));
}
