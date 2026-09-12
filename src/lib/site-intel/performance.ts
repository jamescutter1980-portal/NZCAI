/**
 * S-05: building performance derived from an EPC.
 *
 * A leaf module - no database, no filesystem, no network - so the UI and the
 * screening layer read the same arithmetic. All user-facing MEES wording lives
 * in `mees_rules.yaml` and is loaded by `mees.ts`; nothing here states a legal
 * conclusion.
 *
 * THREE DISTINCTIONS THIS MODULE EXISTS TO KEEP.
 *
 * 1. An asset rating is not an operational rating. A Display Energy
 *    Certificate reports how a building actually performed; a non-domestic EPC
 *    reports how the modelled building should perform. MEES uses the asset
 *    rating. Reading a DEC's band as an EPC band would be wrong in the
 *    direction that matters, so `ratingKind` separates them and the screening
 *    layer refuses DECs rather than banding them.
 *
 * 2. A band and a score are two statements, and they can disagree. Where the
 *    register publishes both, a disagreement is reported, never resolved -
 *    same rule as the floor-area divergence in S-06.
 *
 * 3. An expired certificate is not a missing one, and a missing one is not a
 *    register that failed to answer. Three different facts, three different
 *    next actions.
 */

import type { EpcCertificate, EpcRegister } from "./epc";

/* ---------------------------------------------------------------- bands --- */

export type Band = "A+" | "A" | "B" | "C" | "D" | "E" | "F" | "G";

/** Best to worst. Index is the comparison order. */
export const BANDS: readonly Band[] = ["A+", "A", "B", "C", "D", "E", "F", "G"] as const;

/**
 * Non-domestic band boundaries on the BER score (SBEM / NCM).
 *
 * The score is the Building Emission Rate as a percentage of the notional
 * building's Target Emission Rate: 100 means it matches the notional building,
 * lower is better. A net exporter can score at or below zero, which is why A+
 * has no lower bound.
 *
 * Source: DESNZ / MHCLG non-domestic EPC band table, as recorded in the Focus
 * Green MEES policy reference. Not derived, not interpolated.
 */
export const BAND_MAX_SCORE: Readonly<Record<Band, number | null>> = {
  "A+": 25,
  A: 50,
  B: 75,
  C: 100,
  D: 125,
  E: 150,
  F: 175,
  G: null, // 176 and above
};

/** The band a non-domestic BER score falls in. */
export function bandForScore(score: number): Band {
  for (const band of BANDS) {
    const max = BAND_MAX_SCORE[band];
    if (max === null || score <= max) return band;
  }
  return "G";
}

/** Normalises a register's band string. Returns null if it is not a band. */
export function parseBand(raw: string | null): Band | null {
  if (!raw) return null;
  const text = raw.trim().toUpperCase().replace(/\s+/g, "");
  return (BANDS as readonly string[]).includes(text) ? (text as Band) : null;
}

/** Negative when `a` is better than `b`. */
export function compareBands(a: Band, b: Band): number {
  return BANDS.indexOf(a) - BANDS.indexOf(b);
}

export function isAtLeast(band: Band, target: Band): boolean {
  return compareBands(band, target) <= 0;
}

/** Whole bands between two ratings, e.g. D to B is 2. Never negative. */
export function bandGap(from: Band, to: Band): number {
  return Math.max(0, compareBands(from, to));
}

/**
 * BER points between a score and the top of a target band.
 *
 * The honest unit for "how far off is it" - a band gap of 1 can be two points
 * or forty-nine. Null when the target band has no upper bound.
 */
export function scoreGap(score: number, target: Band): number | null {
  const max = BAND_MAX_SCORE[target];
  if (max === null) return null;
  return Math.max(0, score - max);
}

/* -------------------------------------------------------- rating source --- */

export type RatingKind =
  | "asset" // non-domestic EPC: modelled. What MEES uses.
  | "domestic" // domestic EPC: different regulations entirely.
  | "operational"; // DEC: measured. Not a MEES input.

export function ratingKind(register: EpcRegister): RatingKind {
  if (register === "non-domestic") return "asset";
  if (register === "display") return "operational";
  return "domestic";
}

/* -------------------------------------------------------------- validity --- */

/** Non-domestic EPCs are valid for ten years from lodgement. */
export const EPC_VALIDITY_YEARS = 10;

export type Validity = "valid" | "expired" | "unknown";

export interface CertificateAge {
  validity: Validity;
  /** ISO date, or null when no lodgement date was published. */
  expiresOn: string | null;
  /** Negative once expired. Null when unknown. */
  daysRemaining: number | null;
}

export function certificateAge(
  certificate: EpcCertificate,
  now: Date = new Date(),
): CertificateAge {
  // Validity runs from lodgement. Inspection is only a fallback for a
  // certificate that predates the register's lodgement column, and it can only
  // make the certificate look older, never newer.
  const basis = certificate.lodgementDate ?? certificate.inspectionDate;
  if (!basis) return { validity: "unknown", expiresOn: null, daysRemaining: null };

  const lodged = new Date(`${basis}T00:00:00Z`);
  if (Number.isNaN(lodged.getTime())) {
    return { validity: "unknown", expiresOn: null, daysRemaining: null };
  }

  const expiry = new Date(lodged);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + EPC_VALIDITY_YEARS);

  const msPerDay = 86_400_000;
  const daysRemaining = Math.floor((expiry.getTime() - now.getTime()) / msPerDay);

  return {
    validity: daysRemaining >= 0 ? "valid" : "expired",
    expiresOn: expiry.toISOString().slice(0, 10),
    daysRemaining,
  };
}

/* ------------------------------------------------------------------ fuel --- */

export type FuelClass =
  | "gas" // natural gas or LPG: CO2 the rating cannot escape via PV
  | "electric" // grid electricity, heat pump, electric resistance
  | "oil"
  | "district_heat"
  | "biomass"
  | "other"
  | "unknown";

/**
 * Classifies the register's free-text fuel string.
 *
 * Order matters. "Electricity displaced by..." style strings and dual-fuel
 * descriptions mention more than one fuel, and for screening purposes the
 * carbon-bearing heating fuel is the one that decides the rating, so it wins.
 */
export function classifyFuel(raw: string | null): FuelClass {
  if (!raw) return "unknown";
  const text = raw.toLowerCase();

  if (/\blpg\b|liquid petroleum|propane|butane/.test(text)) return "gas";
  if (/natural gas|\bgas\b|mains gas/.test(text)) return "gas";
  if (/oil|kerosene|gas oil/.test(text)) return "oil";
  if (/district|community heat|heat network/.test(text)) return "district_heat";
  if (/biomass|wood|pellet|chip/.test(text)) return "biomass";
  if (/electric|heat pump|ashp|gshp/.test(text)) return "electric";
  return "other";
}

/**
 * Whether rooftop PV can move this building's rating materially.
 *
 * The rating is a CO2 rate. PV displaces purchased electricity, so on a
 * gas-heated building it does not touch the emissions that set the band. This
 * is a screening input for the band question ONLY - it says nothing about
 * whether the roof is a good PV site, which is a different question with a
 * different answer.
 */
export function pvCanMoveRating(fuel: FuelClass): boolean {
  return fuel === "electric" || fuel === "district_heat";
}

/* ------------------------------------------------------------ the rating --- */

export interface RatingReading {
  kind: RatingKind;
  /** The band the register published, where it published one. */
  publishedBand: Band | null;
  /** The band implied by the score, non-domestic only. */
  derivedBand: Band | null;
  /** The band to screen on: published where present, else derived. */
  band: Band | null;
  score: number | null;
  /**
   * Set when the published band and the score disagree. Reported, never
   * resolved - the register is the publisher of both and we are not the
   * authority on which is right.
   */
  disagreement: string | null;
}

export function readRating(certificate: EpcCertificate): RatingReading {
  const kind = ratingKind(certificate.register);
  const publishedBand = parseBand(certificate.rating);
  const score = certificate.assetRating;

  // Deriving a band from a score is only defined for the non-domestic scale.
  const derivedBand = kind === "asset" && score !== null ? bandForScore(score) : null;

  let disagreement: string | null = null;
  if (publishedBand && derivedBand && publishedBand !== derivedBand) {
    disagreement =
      `The register published band ${publishedBand} but its score of ${score} falls in band ` +
      `${derivedBand}. Both come from the same certificate; this needs checking against the ` +
      `lodged EPC rather than resolving here.`;
  }

  return {
    kind,
    publishedBand,
    derivedBand,
    band: publishedBand ?? derivedBand,
    score,
    disagreement,
  };
}

/* --------------------------------------------------------- energy intensity --- */

export interface Intensity {
  /** kWh/m²/yr as published. */
  primaryEnergyKwhM2: number | null;
  /** kgCO2/m²/yr as published. */
  emissionsKgCo2M2: number | null;
  /**
   * BER as a percentage of the notional building's TER. Only computed when the
   * register published both, because the ratio is the whole meaning.
   */
  againstNotionalPct: number | null;
}

export function intensity(certificate: EpcCertificate): Intensity {
  const { buildingEmissions, targetEmissions } = certificate;
  const ratio =
    buildingEmissions !== null && targetEmissions !== null && targetEmissions > 0
      ? Math.round((buildingEmissions / targetEmissions) * 1000) / 10
      : null;

  return {
    primaryEnergyKwhM2: certificate.primaryEnergy,
    emissionsKgCo2M2: buildingEmissions,
    againstNotionalPct: ratio,
  };
}
