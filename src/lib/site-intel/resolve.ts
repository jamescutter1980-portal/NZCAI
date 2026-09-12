/**
 * S-01 resolution chain. Brief section 3.1 - stop at the first confident match.
 *
 *   a  address/postcode -> UPRN via the address register       exact
 *   b  UPRN -> coordinates via OS Open UPRN                    inherits
 *   c  postcode only -> Code-Point Open centroid               approximate
 *   d  no match -> geocode, then candidate UPRNs within 25 m   probable
 *   e  user clicks the map -> nearest UPRN within 25 m         manual
 *
 * The hard rule, from the brief: persisted coordinates ALWAYS come from OS Open
 * UPRN, never from Google. A geocode is only ever used to find candidate UPRNs,
 * and its own coordinates are discarded. `assertNoGoogleCoordinates` enforces
 * that, and a test holds it.
 *
 * Every dependency is injected so the chain is testable with no network.
 */

import { distanceM, extractPostcode, normalisePostcode, type LatLon } from "./geo";
import { lineage } from "./sources";
import type { Candidate, MatchConfidence } from "./types";

/** Radius within which a geocode or map click may claim a UPRN. Brief 3.1 d/e. */
export const CANDIDATE_RADIUS_M = 25;

export interface UprnPoint {
  uprn: string;
  lat: number;
  lon: number;
  postcode: string | null;
}

export interface AddressMatch {
  uprn: string;
  address: string;
  postcode: string | null;
}

export interface UprnStore {
  byUprn(uprn: string): Promise<UprnPoint | null>;
  near(point: LatLon, radiusM: number, limit: number): Promise<UprnPoint[]>;
  byPostcode(postcode: string): Promise<UprnPoint[]>;
}

export interface PostcodeStore {
  centroid(postcode: string): Promise<LatLon | null>;
}

/** The EPC register. Absent until Task 0 lands; the chain degrades without it. */
export interface AddressRegister {
  lookup(address: string): Promise<AddressMatch[]>;
}

/** Google geocoding. Its coordinates are never persisted - candidates only. */
export interface Geocoder {
  geocode(address: string): Promise<LatLon | null>;
}

export interface ResolveDeps {
  uprns: UprnStore;
  postcodes: PostcodeStore;
  register?: AddressRegister;
  geocoder?: Geocoder;
}

export interface ResolveInput {
  address?: string;
  postcode?: string;
  uprn?: string;
  point?: LatLon;
}

export interface ResolveResult {
  candidates: Candidate[];
  /** Which step produced the result, for diagnostics and the UI. */
  step: "register" | "uprn" | "postcode" | "geocode" | "click" | "none";
  /** Why nothing was found, when candidates is empty. */
  reason?: string;
}

function toCandidate(
  point: UprnPoint,
  confidence: MatchConfidence,
  method: string,
  distance: number | null,
  address: string | null = null,
): Candidate {
  return {
    uprn: point.uprn,
    lat: point.lat,
    lon: point.lon,
    postcode: point.postcode,
    address,
    confidence,
    distanceM: distance === null ? null : Math.round(distance * 10) / 10,
    source: lineage({
      sourceId: "os-open-uprn",
      entityRef: point.uprn,
      method,
      tier: confidence === "exact" ? "T1" : confidence === "manual" ? "T3" : "T2",
    }),
  };
}

/** Nearest-first UPRNs within the radius of a point. */
async function nearestUprns(
  deps: ResolveDeps,
  point: LatLon,
  confidence: MatchConfidence,
  method: string,
  limit = 10,
): Promise<Candidate[]> {
  const found = await deps.uprns.near(point, CANDIDATE_RADIUS_M, limit);
  return found
    .map((p) => ({ p, d: distanceM(point, { lat: p.lat, lon: p.lon }) }))
    .filter(({ d }) => d <= CANDIDATE_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .map(({ p, d }) => toCandidate(p, confidence, method, d));
}

export async function resolve(
  input: ResolveInput,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  // ---- step b: an explicit UPRN is already authoritative ------------------
  if (input.uprn) {
    const point = await deps.uprns.byUprn(input.uprn);
    if (point) {
      return {
        candidates: [toCandidate(point, "exact", "UPRN lookup in OS Open UPRN", null)],
        step: "uprn",
      };
    }
    return { candidates: [], step: "none", reason: `UPRN ${input.uprn} not in OS Open UPRN` };
  }

  // ---- step e: a map click ------------------------------------------------
  if (input.point) {
    const candidates = await nearestUprns(
      deps,
      input.point,
      "manual",
      `nearest OS Open UPRN within ${CANDIDATE_RADIUS_M} m of map click`,
    );
    return candidates.length
      ? { candidates, step: "click" }
      : {
          candidates: [],
          step: "none",
          reason: `No OS Open UPRN within ${CANDIDATE_RADIUS_M} m of that point`,
        };
  }

  const address = input.address?.trim();
  const postcode =
    normalisePostcode(input.postcode ?? "") ?? (address ? extractPostcode(address) : null);

  // ---- step a: the address register is the only route to `exact` ----------
  if (address && deps.register) {
    const matches = await deps.register.lookup(address);
    const resolved: Candidate[] = [];
    for (const match of matches) {
      const point = await deps.uprns.byUprn(match.uprn);
      // Coordinates come from OS Open UPRN even when the register supplied
      // the UPRN - the register is not a coordinate source.
      if (point) {
        resolved.push(
          toCandidate(point, "exact", "address register match, coordinates from OS Open UPRN", null, match.address),
        );
      }
    }
    if (resolved.length) return { candidates: resolved, step: "register" };
  }

  // ---- step d: geocode, then claim nearby UPRNs ---------------------------
  if (address && deps.geocoder) {
    const hint = await deps.geocoder.geocode(address);
    if (hint) {
      const candidates = await nearestUprns(
        deps,
        hint,
        "probable",
        `geocoded, then nearest OS Open UPRN within ${CANDIDATE_RADIUS_M} m`,
      );
      if (candidates.length) return { candidates, step: "geocode" };
    }
  }

  // ---- step c: postcode centroid, approximate, user must pin --------------
  if (postcode) {
    const inPostcode = await deps.uprns.byPostcode(postcode);
    if (inPostcode.length) {
      return {
        candidates: inPostcode.map((p) =>
          toCandidate(p, "approximate", "all OS Open UPRN points in postcode", null),
        ),
        step: "postcode",
      };
    }

    const centroid = await deps.postcodes.centroid(postcode);
    if (centroid) {
      // No UPRN: a centroid alone cannot identify a building, so it is offered
      // as a place to pin rather than as an answer.
      return {
        candidates: [
          {
            uprn: null,
            lat: centroid.lat,
            lon: centroid.lon,
            postcode,
            address: null,
            confidence: "approximate",
            distanceM: null,
            source: lineage({
              sourceId: "os-code-point-open",
              entityRef: postcode,
              method: "postcode centroid",
              tier: "T3",
            }),
          },
        ],
        step: "postcode",
      };
    }
  }

  return {
    candidates: [],
    step: "none",
    reason: address
      ? "No register match, no geocode, and no postcode centroid for that address"
      : "Provide an address, postcode, UPRN or map point",
  };
}

/**
 * Guard for the brief's hard rule. Throws if a candidate that is about to be
 * persisted carries coordinates from anything but OS Open UPRN.
 */
export function assertNoGoogleCoordinates(candidate: Candidate): void {
  const allowed = ["os-open-uprn", "os-code-point-open"];
  if (!allowed.includes(candidate.source.sourceId)) {
    throw new Error(
      `Refusing to persist coordinates from "${candidate.source.sourceId}". ` +
        "Stored coordinates must come from OS Open UPRN (or a Code-Point centroid " +
        "the user pins). See docs/site-intel/BRIEF.md section 3.1.",
    );
  }
}
