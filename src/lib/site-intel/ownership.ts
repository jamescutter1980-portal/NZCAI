/**
 * S-04: corporate ownership.
 *
 * NOTE ON SCOPE. The brief in docs/site-intel/BRIEF.md lists S-04 under
 * section 10, "Out of scope (later briefs)", so this module is built without a
 * specification. The assumptions it makes are recorded in docs/site-intel/PLAN.md
 * and should be checked against the real S-04 brief when it arrives.
 *
 * THE STRUCTURAL PROBLEM, which shapes everything below.
 *
 * The obvious join - building -> polygon -> title number -> owner - is not
 * available on open data. HM Land Registry's INSPIRE index polygons carry a
 * Land Registry-INSPIRE ID, NOT a title number; the title number linkage lives
 * in the chargeable National Polygon Service. CCOD and OCOD, meanwhile, are
 * keyed BY title number. So there is no free path from a polygon to an owner.
 *
 * What is available is the reverse: CCOD and OCOD each carry the property
 * address and postcode as free text. Matching a resolved site's address against
 * those gives a PROBABLE title and therefore a probable owner. That is what
 * this module does, and why every result is tier T3 - inferred - and described
 * as a candidate rather than an answer. It is a lead to verify, never proof of
 * ownership.
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

// Re-exported so existing callers keep importing from here.
export { addressScore, addressTokens, ADDRESS_MATCH_THRESHOLD } from "./address-match";

/** How the candidate was matched. Nothing here is ever authoritative. */
export type OwnershipMatchQuality =
  | "postcode_and_address" // postcode matches and the address tokens agree
  | "postcode_only" // postcode matches, address does not - several titles likely
  | "none";

export interface Proprietor {
  name: string;
  companyNumber: string | null;
  category: string | null;
  address: string | null;
  /** OCOD only. */
  countryIncorporated: string | null;
}

export interface CorporateTitle {
  titleNumber: string;
  tenure: string | null;
  propertyAddress: string | null;
  postcode: string | null;
  district: string | null;
  county: string | null;
  region: string | null;
  /** True where one title covers many addresses - weakens any address match. */
  multipleAddress: boolean;
  pricePaid: number | null;
  proprietors: Proprietor[];
  dateProprietorAdded: string | null;
  /** "ccod" (UK companies) or "ocod" (overseas companies). */
  dataset: "ccod" | "ocod";
}

export interface OwnershipCandidate {
  title: CorporateTitle;
  quality: OwnershipMatchQuality;
  /** 0-1. Token agreement between the site address and the title's address. */
  score: number;
  reasons: string[];
  source: SourceRecord;
}

export interface OwnershipResult {
  candidates: OwnershipCandidate[];
  /** True when no title number linkage exists, i.e. always without NPS. */
  inferredFromAddress: boolean;
  searchedPostcode: string | null;
  flags: string[];
  note: string;
}

export interface MatchInput {
  /** The resolved site's address, if any. */
  address: string | null;
  postcode: string | null;
}

/**
 * Ranks candidate titles against a site. Titles are expected to have been
 * pre-filtered by postcode; the postcode is re-checked here so a caller passing
 * a wider set still gets correct quality labels.
 */
export function matchTitles(site: MatchInput, titles: CorporateTitle[]): OwnershipCandidate[] {
  const sitePostcode = site.postcode ? normalisePostcode(site.postcode) : null;
  const siteTokens = addressTokens(site.address);

  const candidates: OwnershipCandidate[] = [];

  for (const title of titles) {
    const titlePostcode = title.postcode ? normalisePostcode(title.postcode) : null;
    const postcodeMatches = !!sitePostcode && sitePostcode === titlePostcode;
    if (!postcodeMatches) continue;

    const titleTokens = addressTokens(title.propertyAddress);
    const score = addressScore(siteTokens, titleTokens);
    const reasons: string[] = [`Postcode ${sitePostcode} matches`];

    let quality: OwnershipMatchQuality = "postcode_only";

    if (siteTokens.size && score >= ADDRESS_MATCH_THRESHOLD && !numberConflict(siteTokens, titleTokens)) {
      quality = "postcode_and_address";
      reasons.push(`Address tokens agree (${Math.round(score * 100)}%)`);
    } else if (!siteTokens.size) {
      reasons.push("No site address to compare, so the postcode is all that matched");
    } else if (numberConflict(siteTokens, titleTokens)) {
      reasons.push("Building numbers disagree");
    } else {
      reasons.push(`Address tokens agree only weakly (${Math.round(score * 100)}%)`);
    }

    if (title.multipleAddress) {
      reasons.push("This title covers several addresses, so the match is weaker");
    }

    candidates.push({
      title,
      quality,
      score,
      reasons,
      source: lineage({
        sourceId: title.dataset === "ocod" ? "hmlr-ocod" : "hmlr-ccod",
        entityRef: title.titleNumber,
        method: `matched on postcode${quality === "postcode_and_address" ? " and address" : " only"}`,
        // Always inferred: there is no title-number linkage without the
        // National Polygon Service.
        tier: "T3",
        sourceUpdated: title.dateProprietorAdded,
      }),
    });
  }

  return candidates.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality === "postcode_and_address" ? -1 : 1;
    return b.score - a.score;
  });
}

const NO_TITLE_LINKAGE_NOTE =
  "Ownership is inferred by matching this site's address against HM Land Registry " +
  "corporate ownership data. Open polygon data carries no title number, so this is " +
  "a lead to verify, not proof of ownership. Confirm against the title register " +
  "before relying on it.";

export function buildOwnershipResult(
  site: MatchInput,
  titles: CorporateTitle[],
): OwnershipResult {
  const searchedPostcode = site.postcode ? normalisePostcode(site.postcode) : null;
  const candidates = matchTitles(site, titles);
  const flags: string[] = [];

  if (!searchedPostcode) flags.push("no_postcode");
  if (candidates.length > 1) flags.push("multiple_title_candidates");
  if (candidates.length && candidates.every((c) => c.quality === "postcode_only")) {
    flags.push("postcode_only_match");
  }
  if (candidates.some((c) => c.title.dataset === "ocod")) flags.push("overseas_proprietor");

  return {
    candidates,
    inferredFromAddress: true,
    searchedPostcode,
    flags,
    note: NO_TITLE_LINKAGE_NOTE,
  };
}

/** Distinct proprietors across the candidates, best match first. */
export function distinctProprietors(result: OwnershipResult): Proprietor[] {
  const seen = new Map<string, Proprietor>();
  for (const candidate of result.candidates) {
    for (const proprietor of candidate.title.proprietors) {
      const key = (proprietor.companyNumber ?? proprietor.name).toUpperCase();
      if (!seen.has(key)) seen.set(key, proprietor);
    }
  }
  return [...seen.values()];
}
