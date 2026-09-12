/**
 * S-07: natural-language site search.
 *
 * NOTE ON SCOPE. Listed in brief section 10, "Out of scope (later briefs)".
 * Built without a specification; assumptions in docs/site-intel/PLAN.md.
 *
 * THE RULE THAT DECIDES THE ARCHITECTURE. Brief section 0: "Deterministic
 * Python for every derived value. The local Ollama model may only write
 * narrative from flags that already exist. No site or client data goes to
 * DeepSeek or the Anthropic API."
 *
 * So the obvious implementation - hand the question and the data to a model and
 * let it answer - is not available, and would not be a good idea anyway. What is
 * available, and is what this does:
 *
 *   1. Parse the QUERY STRING into a structured filter. The query is the user's
 *      own words, not site or client data, so nothing sensitive is involved even
 *      where a model helps with the parsing.
 *   2. Execute that filter deterministically in SQL.
 *   3. Explain which clause matched each result.
 *
 * THE DANGEROUS FAILURE MODE, and the reason for `unparsed`. If someone asks
 * for "warehouses near a motorway" and the parser does not understand "near a
 * motorway", returning warehouses silently implies a filter that never ran. So
 * every span of the query is either consumed by a matcher or reported as
 * unparsed - the same principle as never reporting a bare "not found".
 */

import { normalisePostcode } from "./geo";

export type Comparison = "at_least" | "at_most" | "between" | "equals";

export interface NumericClause {
  comparison: Comparison;
  min: number | null;
  max: number | null;
  unit: string;
}

export interface ConstraintClause {
  dataset: string;
  /** True: must be present. False: must be absent. */
  present: boolean;
}

export interface SearchFilter {
  /** VOA description keywords, e.g. ["warehouse"]. Matched with OR. */
  useKeywords: string[];
  /** Full postcodes. */
  postcodes: string[];
  /** Postcode districts, e.g. "DN4". */
  postcodeDistricts: string[];
  /** Local planning authority name fragments. */
  localAuthorities: string[];
  floorArea: NumericClause | null;
  rateableValue: NumericClause | null;
  /** EPC bands that qualify, e.g. ["D","E","F","G"] for "EPC below C". */
  epcBands: string[];
  constraints: ConstraintClause[];
  /** Generation headroom at a nearby substation, in MVA. */
  gridHeadroomMva: NumericClause | null;
  /** True when the query asks for overseas-owned sites. */
  overseasOwned: boolean | null;
}

export interface ParsedQuery {
  filter: SearchFilter;
  /** Human-readable account of what was understood, one line per clause. */
  understood: string[];
  /**
   * Spans of the query no matcher claimed. Never empty-and-ignored: the caller
   * must show these, because a dropped clause silently widens the search.
   */
  unparsed: string[];
  /** True when nothing at all was understood. */
  empty: boolean;
}

export function emptyFilter(): SearchFilter {
  return {
    useKeywords: [],
    postcodes: [],
    postcodeDistricts: [],
    localAuthorities: [],
    floorArea: null,
    rateableValue: null,
    epcBands: [],
    constraints: [],
    gridHeadroomMva: null,
    overseasOwned: null,
  };
}

/* ------------------------------------------------------------- matchers --- */

const EPC_BANDS = ["A", "B", "C", "D", "E", "F", "G"];

/** VOA descriptions are the searchable text, so keywords map to those words. */
const USE_SYNONYMS: Record<string, string[]> = {
  warehouse: ["warehouse", "store", "distribution"],
  industrial: ["factory", "workshop", "industrial"],
  office: ["office"],
  shop: ["shop", "retail", "showroom"],
  restaurant: ["restaurant", "cafe"],
  hotel: ["hotel"],
  school: ["school", "college"],
  surgery: ["surgery", "clinic"],
};

/** Words that carry no filter meaning; their presence is not "unparsed". */
const FILLER = new Set([
  "find", "show", "me", "all", "any", "list", "get", "search", "for", "with",
  "and", "or", "the", "a", "an", "of", "in", "at", "on", "that", "which",
  "are", "is", "has", "have", "sites", "site", "buildings", "building",
  "properties", "property", "units", "unit", "please", "give",
]);

/** Square feet to square metres. */
const SQFT_TO_M2 = 0.092903;

interface Span {
  start: number;
  end: number;
}

/** Tracks which parts of the query a matcher has claimed. */
class Consumed {
  private spans: Span[] = [];

  claim(match: RegExpExecArray): void {
    this.spans.push({ start: match.index, end: match.index + match[0].length });
  }

  claimAt(start: number, length: number): void {
    this.spans.push({ start, end: start + length });
  }

  /** Words in the original text that no matcher claimed. */
  leftovers(text: string): string[] {
    const covered = new Array<boolean>(text.length).fill(false);
    for (const { start, end } of this.spans) {
      for (let i = start; i < end && i < covered.length; i += 1) covered[i] = true;
    }

    const out: string[] = [];
    let current = "";
    for (let i = 0; i < text.length; i += 1) {
      if (covered[i]) {
        if (current.trim()) out.push(current.trim());
        current = "";
      } else {
        current += text[i];
      }
    }
    if (current.trim()) out.push(current.trim());

    return out
      .flatMap((chunk) => chunk.split(/[,;]+/))
      .map((chunk) =>
        chunk
          .split(/\s+/)
          .filter((w) => w && !FILLER.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")))
          .join(" ")
          .trim(),
      )
      .filter((chunk) => chunk.length > 1);
  }
}

function toM2(value: number, unit: string): number {
  return /(sq\s?ft|sqft|ft2|square feet)/i.test(unit) ? Math.round(value * SQFT_TO_M2) : value;
}

/** "1,500", "1.5k", "250k", "1.2m" -> a number. */
function magnitude(raw: string): number {
  const cleaned = raw.replace(/[,\s£]/g, "").toLowerCase();
  const match = /^([\d.]+)([km])?$/.exec(cleaned);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return Number.NaN;
  if (match[2] === "k") return value * 1_000;
  if (match[2] === "m") return value * 1_000_000;
  return value;
}

/* ---------------------------------------------------------------- parse --- */

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim();
  const filter = emptyFilter();
  const understood: string[] = [];
  const consumed = new Consumed();

  if (!text) {
    return { filter, understood, unparsed: [], empty: true };
  }

  /* -- postcodes and districts -------------------------------------------- */
  const postcodeRe = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/gi;
  for (let m = postcodeRe.exec(text); m; m = postcodeRe.exec(text)) {
    const normalised = normalisePostcode(`${m[1]}${m[2]}`);
    if (normalised) {
      filter.postcodes.push(normalised);
      understood.push(`Postcode ${normalised}`);
      consumed.claim(m);
    }
  }

  // A district is an outward code on its own - only counted where it is not
  // part of a full postcode already claimed above.
  const districtRe = /\b([A-Z]{1,2}\d[A-Z\d]?)\b(?!\s*\d[A-Z]{2})/gi;
  for (let m = districtRe.exec(text); m; m = districtRe.exec(text)) {
    const district = m[1].toUpperCase();
    // Reject things that are plainly not districts, like "B8" as a use class.
    if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(district) && !filter.postcodes.some((p) => p.startsWith(district))) {
      filter.postcodeDistricts.push(district);
      understood.push(`Postcode district ${district}`);
      consumed.claim(m);
    }
  }

  /* -- floor area ---------------------------------------------------------- */
  const areaRe =
    /\b(over|above|more than|at least|under|below|less than|at most|between)\s+([\d.,]+k?m?)\s*(?:(?:and|-|to)\s*([\d.,]+k?m?)\s*)?(sq\s?m|sqm|m2|m²|square metres?|sq\s?ft|sqft|ft2|square feet)\b/gi;
  for (let m = areaRe.exec(text); m; m = areaRe.exec(text)) {
    const [, word, first, second, unit] = m;
    const a = toM2(magnitude(first), unit);
    const b = second ? toM2(magnitude(second), unit) : null;
    if (!Number.isFinite(a)) continue;

    if (/between/i.test(word) && b !== null) {
      filter.floorArea = { comparison: "between", min: Math.min(a, b), max: Math.max(a, b), unit: "m²" };
      understood.push(`Floor area between ${Math.min(a, b)} and ${Math.max(a, b)} m²`);
    } else if (/over|above|more than|at least/i.test(word)) {
      filter.floorArea = { comparison: "at_least", min: a, max: null, unit: "m²" };
      understood.push(`Floor area at least ${a} m²`);
    } else {
      filter.floorArea = { comparison: "at_most", min: null, max: a, unit: "m²" };
      understood.push(`Floor area at most ${a} m²`);
    }
    consumed.claim(m);
  }

  /* -- rateable value ------------------------------------------------------ */
  const rvRe =
    /\b(?:rateable value|rv)\s*(over|above|more than|at least|under|below|less than|at most)?\s*£?\s*([\d.,]+[km]?)/gi;
  for (let m = rvRe.exec(text); m; m = rvRe.exec(text)) {
    const value = magnitude(m[2]);
    if (!Number.isFinite(value)) continue;
    const atMost = /under|below|less than|at most/i.test(m[1] ?? "");
    filter.rateableValue = atMost
      ? { comparison: "at_most", min: null, max: value, unit: "£" }
      : { comparison: "at_least", min: value, max: null, unit: "£" };
    understood.push(`Rateable value ${atMost ? "at most" : "at least"} £${value.toLocaleString()}`);
    consumed.claim(m);
  }

  /* -- EPC band ------------------------------------------------------------ */
  // One pattern rather than an alternation: a leading qualifier ("below C") and
  // a trailing one ("E or worse") are both optional, and an alternation would
  // have matched the bare band first and never reached the trailing branch.
  const epcRe =
    /\bepc\s*(?:band\s*)?(below|worse than|above|better than|of|rated)?\s*([A-G])\b(\s*or\s+(?:worse|better))?/gi;
  for (let m = epcRe.exec(text); m; m = epcRe.exec(text)) {
    const band = (m[2] ?? "").toUpperCase();
    const index = EPC_BANDS.indexOf(band);
    if (index === -1) continue;

    const leading = (m[1] ?? "").toLowerCase();
    const trailing = (m[3] ?? "").toLowerCase();

    if (trailing.includes("worse")) {
      // Inclusive of the named band.
      filter.epcBands = EPC_BANDS.slice(index);
      understood.push(`EPC ${band} or worse`);
    } else if (trailing.includes("better")) {
      filter.epcBands = EPC_BANDS.slice(0, index + 1);
      understood.push(`EPC ${band} or better`);
    } else if (/below|worse/.test(leading)) {
      // Exclusive of the named band.
      filter.epcBands = EPC_BANDS.slice(index + 1);
      understood.push(`EPC worse than ${band}`);
    } else if (/above|better/.test(leading)) {
      filter.epcBands = EPC_BANDS.slice(0, index);
      understood.push(`EPC better than ${band}`);
    } else {
      filter.epcBands = [band];
      understood.push(`EPC ${band}`);
    }
    consumed.claim(m);
  }

  /* -- constraints --------------------------------------------------------- */
  const CONSTRAINT_WORDS: { pattern: RegExp; dataset: string; label: string }[] = [
    { pattern: /conservation area/i, dataset: "conservation-area", label: "conservation area" },
    { pattern: /listed building|listed/i, dataset: "listed-building", label: "listed building" },
    { pattern: /green belt/i, dataset: "green-belt", label: "Green Belt" },
    { pattern: /flood (?:risk )?zone|flood risk|flooding/i, dataset: "flood-risk-zone", label: "flood risk zone" },
    { pattern: /article 4/i, dataset: "article-4-direction-area", label: "Article 4 direction" },
    { pattern: /sssi|site of special scientific interest/i, dataset: "site-of-special-scientific-interest", label: "SSSI" },
    { pattern: /ancient woodland/i, dataset: "ancient-woodland", label: "ancient woodland" },
    { pattern: /national park/i, dataset: "national-park", label: "National Park" },
    { pattern: /aonb|national landscape/i, dataset: "area-of-outstanding-natural-beauty", label: "National Landscape" },
    { pattern: /air quality/i, dataset: "air-quality-management-area", label: "air quality management area" },
    { pattern: /tree preservation|tpo/i, dataset: "tree-preservation-zone", label: "tree preservation zone" },
  ];

  for (const { pattern, dataset, label } of CONSTRAINT_WORDS) {
    const re = new RegExp(
      `((?:not|no|without|outside|excluding)\\s+(?:in\\s+|the\\s+|a\\s+)*)?(?:in\\s+|within\\s+|the\\s+|a\\s+)*(${pattern.source})`,
      "i",
    );
    const m = re.exec(text);
    if (!m) continue;
    const negated = !!m[1];
    filter.constraints.push({ dataset, present: !negated });
    understood.push(negated ? `Not in a ${label}` : `In a ${label}`);
    consumed.claimAt(m.index, m[0].length);
  }

  /* -- grid headroom ------------------------------------------------------- */
  const gridRe =
    /\b(?:grid|substation|generation)\s*(?:headroom|capacity)?\s*(?:of\s*)?(over|above|at least|more than)?\s*([\d.,]+)\s*(mva|mw)\b/gi;
  for (let m = gridRe.exec(text); m; m = gridRe.exec(text)) {
    const value = magnitude(m[2]);
    if (!Number.isFinite(value)) continue;
    filter.gridHeadroomMva = { comparison: "at_least", min: value, max: null, unit: "MVA" };
    understood.push(`Nearby substation with at least ${value} MVA generation headroom`);
    consumed.claim(m);
  }

  /* -- ownership ----------------------------------------------------------- */
  const overseasRe = /\b(overseas|foreign|offshore)[\s-]*(owned|ownership|company|companies)?\b/i;
  const overseas = overseasRe.exec(text);
  if (overseas) {
    filter.overseasOwned = true;
    understood.push("Overseas-owned");
    consumed.claimAt(overseas.index, overseas[0].length);
  }

  /* -- use keywords -------------------------------------------------------- */
  for (const [canonical, synonyms] of Object.entries(USE_SYNONYMS)) {
    for (const synonym of synonyms) {
      const re = new RegExp(`\\b${synonym}(?:s|es)?\\b`, "i");
      const m = re.exec(text);
      if (!m) continue;
      if (!filter.useKeywords.includes(canonical)) {
        filter.useKeywords.push(canonical);
        understood.push(`Use: ${canonical}`);
      }
      consumed.claimAt(m.index, m[0].length);
      break;
    }
  }

  /* -- local authority ----------------------------------------------------- */
  const laRe = /\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b(?!\s*\d)/g;
  for (let m = laRe.exec(text); m; m = laRe.exec(text)) {
    const name = m[1].trim();
    // Skip anything a constraint or use matcher already understood.
    if (understood.some((u) => u.toLowerCase().includes(name.toLowerCase()))) continue;
    filter.localAuthorities.push(name);
    understood.push(`Local authority like "${name}"`);
    consumed.claim(m);
  }

  const unparsed = consumed.leftovers(text);

  return {
    filter,
    understood,
    unparsed,
    empty: understood.length === 0,
  };
}

/** True when the filter would return everything, which is rarely intended. */
export function isUnbounded(filter: SearchFilter): boolean {
  return (
    filter.useKeywords.length === 0 &&
    filter.postcodes.length === 0 &&
    filter.postcodeDistricts.length === 0 &&
    filter.localAuthorities.length === 0 &&
    filter.floorArea === null &&
    filter.rateableValue === null &&
    filter.epcBands.length === 0 &&
    filter.constraints.length === 0 &&
    filter.gridHeadroomMva === null &&
    filter.overseasOwned === null
  );
}

/**
 * The sentence to show above results. Always states what was NOT understood,
 * because an unshown dropped clause silently widens the search.
 */
export function describeQuery(parsed: ParsedQuery): string {
  if (parsed.empty) {
    return "Nothing in that query was understood, so no search was run.";
  }
  const base = `Searching for: ${parsed.understood.join("; ")}.`;
  if (!parsed.unparsed.length) return base;
  return (
    `${base} These parts were NOT understood and have been ignored: ` +
    `${parsed.unparsed.map((u) => `"${u}"`).join(", ")}. ` +
    "Results are therefore wider than the question asked."
  );
}
