/**
 * Address matching, shared by S-04 (ownership) and S-06 (VOA).
 *
 * Both face the same problem: the authoritative identifier linkage is behind a
 * paywall - the National Polygon Service for title numbers, AddressBase Premium
 * for the UPRN-to-VOA cross reference - so the free route in both cases is to
 * match a resolved site against a dataset's free-text property address.
 *
 * Deterministic and dependency-free, so the same pair always scores the same.
 */

/** Abbreviations HMLR and OS spell inconsistently. Expanded before comparison. */
const ABBREVIATIONS: Record<string, string> = {
  ST: "STREET", RD: "ROAD", AVE: "AVENUE", AV: "AVENUE", LN: "LANE",
  DR: "DRIVE", CL: "CLOSE", CT: "COURT", CRES: "CRESCENT", GDNS: "GARDENS",
  PL: "PLACE", SQ: "SQUARE", TER: "TERRACE", PK: "PARK", IND: "INDUSTRIAL",
  EST: "ESTATE", BLDG: "BUILDING", BLDGS: "BUILDINGS", HSE: "HOUSE",
  "N": "NORTH", "S": "SOUTH", "E": "EAST", "W": "WEST",
};

/** Words that carry no discriminating power in a UK address. */
const NOISE = new Set([
  "THE", "AND", "OF", "AT", "IN", "ON", "LAND", "PROPERTY", "BEING",
  "PART", "ALL", "UNIT", "UNITS",
]);

/**
 * Normalises an address to a comparable token set: uppercase, punctuation
 * stripped, abbreviations expanded, noise words dropped. Deterministic, so the
 * same pair always scores the same.
 */
export function addressTokens(address: string | null | undefined): Set<string> {
  if (!address) return new Set();
  const tokens = address
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .filter((t) => !NOISE.has(t));
  return new Set(tokens);
}

/**
 * Containment-weighted overlap, 0-1.
 *
 * Plain Jaccard punishes a title whose address is much longer than the site's
 * ("Unit 3 Carr Hill Industrial Estate Doncaster" vs "Unit 3 Carr Hill"), which
 * is exactly the common case. Containment of the shorter set in the longer one
 * reflects the question actually being asked: is this site part of that title?
 */
export function addressScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared += 1;
  const containment = shared / small.size;
  const jaccard = shared / (a.size + b.size - shared);
  // Lean on containment but keep some pressure towards genuine similarity.
  return Number((containment * 0.7 + jaccard * 0.3).toFixed(4));
}

/** Above this, the address is treated as agreeing. Tuned conservatively. */
export const ADDRESS_MATCH_THRESHOLD = 0.55;

/** A building number present in one address and contradicted in the other. */
export function numberConflict(site: Set<string>, title: Set<string>): boolean {
  const numbers = (s: Set<string>) => [...s].filter((t) => /^\d+[A-Z]?$/.test(t));
  const siteNumbers = numbers(site);
  const titleNumbers = numbers(title);
  if (!siteNumbers.length || !titleNumbers.length) return false;
  return !siteNumbers.some((n) => titleNumbers.includes(n));
}

