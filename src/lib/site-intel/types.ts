/**
 * Site Intelligence models (S-01).
 *
 * These are the "minimal compatible SourceRecord and tier enum" the brief asks
 * for where the Watershed-lift work (W-03 tiers, W-23 lineage) does not yet
 * exist. Keep the shapes stable so they can be merged rather than rewritten.
 *
 * Two rules from the brief drive the design:
 *   - every value carries lineage (source, licence, dates, method, tier);
 *   - nothing-found must say whether coverage was complete. There is no bare
 *     "not found", because "we checked and there is none" and "we could not
 *     check" are different answers and only one of them is safe to act on.
 */

/** Data-quality tier. W-03 tiers take precedence if/when they land. */
export type Tier =
  | "T1" // register or authoritative exact match
  | "T2" // open-data spatial match
  | "T3" // inferred (nearest, approximate)
  | "T4" // user override
  | "stale"; // past its TTL

export const TIER_LABEL: Record<Tier, string> = {
  T1: "Authoritative match",
  T2: "Open-data spatial match",
  T3: "Inferred",
  T4: "User override",
  stale: "Stale",
};

/** How confident we are that this is the right building. */
export type MatchConfidence =
  | "exact" // address and UPRN agree from a register
  | "probable" // geocoded to a candidate UPRN; user must confirm
  | "approximate" // postcode centroid only; user must pin
  | "manual" // user clicked the map
  | "none"; // nothing resolved

/** Confidences that require a human to confirm before the profile is trusted. */
export const NEEDS_CONFIRMATION: readonly MatchConfidence[] = [
  "probable",
  "approximate",
  "manual",
] as const;

export function needsConfirmation(confidence: MatchConfidence): boolean {
  return NEEDS_CONFIRMATION.includes(confidence);
}

/** Provenance for a single value or layer. Brief section 6. */
export interface SourceRecord {
  sourceId: string;
  dataset: string;
  entityRef: string | null;
  licence: string;
  attribution: string;
  /** When we fetched it. */
  retrievedAt: string;
  /** When the publisher last updated it, where they say. */
  sourceUpdated: string | null;
  /** How the value was derived, e.g. "point-in-polygon", "nearest within 25 m". */
  method: string;
  tier: Tier;
}

/**
 * Per-dataset outcome. The brief forbids a plain "not found": a result where
 * nothing was found must say whether coverage was complete.
 */
export type ResultState =
  | "present"
  | "proximity"
  | "not_found_coverage_complete"
  | "not_found_coverage_unknown"
  | "not_supported"
  | "source_error";

export interface TitleExtent {
  /** GeoJSON geometry as returned by the source. */
  geometry: GeoJSON.Geometry;
  areaM2: number | null;
  sourceRef: string;
}

export type FootprintMethod =
  | "uprn_contained" // polygon containing the UPRN point
  | "title_intersect" // largest polygon intersecting the title extent
  | "user_drawn"
  | "unavailable";

export interface Footprint {
  geometry: GeoJSON.Geometry | null;
  areaM2: number | null;
  method: FootprintMethod;
}

/**
 * What the source published, kept when a user redraws over it.
 *
 * Brief §3.2: "Store that as an override tier and keep the original." Keeping
 * it is the point — an override that destroys the published polygon cannot be
 * undone, and the original's provenance is what makes the override reviewable.
 * A second redraw replaces the drawing, never this.
 */
export interface FootprintOriginal {
  geometry: GeoJSON.Geometry | null;
  areaM2: number | null;
  method: FootprintMethod;
  /** When the first override was applied. */
  overriddenAt: string;
}

/** Brief section 3.3. */
export interface SiteProfile {
  uprn: string | null;
  lat: number | null;
  lon: number | null;
  postcode: string | null;
  /**
   * Street address, where a register supplied one. This is what lifts the
   * ownership (S-04) and VOA (S-06) matches out of postcode-only.
   */
  address: string | null;
  /** E / W / S / NI, as an ISO-ish single letter. Drives S-02 support. */
  country: string | null;
  lpaCode: string | null;
  lpaName: string | null;
  titleExtents: TitleExtent[];
  footprint: Footprint;
  /** Present only once a user has redrawn. Null means the footprint is source data. */
  footprintOriginal: FootprintOriginal | null;
  matchConfidence: MatchConfidence;
  userConfirmed: boolean;
  /** Screening flags, e.g. multi_title, footprint_inferred. */
  flags: string[];
  /** Per-dataset outcome, so "nothing found" is never ambiguous. */
  states: Record<string, ResultState>;
  sources: SourceRecord[];
}

export function emptyProfile(): SiteProfile {
  return {
    uprn: null,
    lat: null,
    lon: null,
    postcode: null,
    address: null,
    country: null,
    lpaCode: null,
    lpaName: null,
    titleExtents: [],
    footprint: { geometry: null, areaM2: null, method: "unavailable" },
    footprintOriginal: null,
    matchConfidence: "none",
    userConfirmed: false,
    flags: [],
    states: {},
    sources: [],
  };
}

/** A resolution candidate, before the user has confirmed which building. */
export interface Candidate {
  uprn: string | null;
  lat: number;
  lon: number;
  postcode: string | null;
  /** Single-line address where a source provides one. */
  address: string | null;
  confidence: MatchConfidence;
  /** Metres from the query point, where the step is distance-based. */
  distanceM: number | null;
  source: SourceRecord;
}
