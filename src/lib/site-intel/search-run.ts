/**
 * S-07 execution. Deterministic SQL, no model anywhere near the data.
 *
 * The corpus is the VOA rating list, because it is the only loaded dataset that
 * gives a universe of buildings with a description, a postcode, a floor area
 * and a rateable value. Everything else joins onto it:
 *
 *   floor area      voa_survey_line, summed per basis
 *   EPC band        epc_certificate, by postcode
 *   overseas owner  corporate_title where dataset = 'ocod', by postcode
 *   grid headroom   postcode_centroid -> substation within a radius
 *
 * TWO THINGS THIS REPORTS RATHER THAN HIDES.
 *
 * `notApplied` carries clauses that parsed but could not be executed. A
 * constraint filter is the clearest case: constraints are computed per site
 * against planning.data at request time, not stored for a corpus, so "no
 * conservation area" cannot narrow a list of thousands. Running the search
 * without it and saying nothing would imply a filter that never ran - the same
 * failure the parser's `unparsed` guards against, one layer down.
 *
 * Joins are at POSTCODE precision, not building precision. An EPC band or an
 * overseas owner matched this way means "somewhere in this postcode", which is
 * a lead, not a fact about the building. Every result says so.
 */

import { query } from "@/lib/db";
import type { SearchFilter } from "./search";
import type { NotApplied } from "./search-describe";

export type { NotApplied };
export { describeRun } from "./search-describe";

export interface SearchResult {
  uarn: string;
  description: string | null;
  address: string | null;
  postcode: string | null;
  floorAreaM2: number | null;
  areaBasis: string | null;
  rateableValue: number | null;
  /** Best EPC band found in the same postcode. Postcode-level, not per building. */
  epcBand: string | null;
  overseasOwnerInPostcode: boolean;
  /** Best generation headroom within the grid radius, MVA. */
  gridHeadroomMva: number | null;
  /** Which clauses this row satisfied. */
  matched: string[];
}

export interface SearchRun {
  results: SearchResult[];
  applied: string[];
  notApplied: NotApplied[];
  /** Precision caveats that apply to every row. */
  caveats: string[];
  total: number;
}

/** Radius for "near a substation", in metres. */
export const GRID_RADIUS_M = 5_000;

export const SEARCH_LIMIT = 100;

export async function runSearch(
  filter: SearchFilter,
  limit = SEARCH_LIMIT,
): Promise<SearchRun> {
  const where: string[] = [];
  const values: unknown[] = [];
  const applied: string[] = [];
  const notApplied: NotApplied[] = [];
  const caveats: string[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  /* -- use ---------------------------------------------------------------- */
  if (filter.useKeywords.length) {
    const { USE_SQL_PATTERNS } = await import("./search-use");
    const patterns = filter.useKeywords.flatMap((k) => USE_SQL_PATTERNS[k] ?? []);
    if (patterns.length) {
      where.push(`a.primary_description ~* ${param(patterns.join("|"))}`);
      applied.push(`Use: ${filter.useKeywords.join(", ")}`);
    } else {
      notApplied.push({
        clause: `Use: ${filter.useKeywords.join(", ")}`,
        reason: "No VOA description pattern is mapped for that use.",
      });
    }
  }

  /* -- location ----------------------------------------------------------- */
  if (filter.postcodes.length) {
    where.push(`a.postcode = ANY(${param(filter.postcodes)}::text[])`);
    applied.push(`Postcode ${filter.postcodes.join(", ")}`);
  }
  if (filter.postcodeDistricts.length) {
    // The district is the outward code, i.e. everything before the space.
    where.push(`split_part(a.postcode, ' ', 1) = ANY(${param(filter.postcodeDistricts)}::text[])`);
    applied.push(`Postcode district ${filter.postcodeDistricts.join(", ")}`);
  }
  if (filter.localAuthorities.length) {
    notApplied.push({
      clause: `Local authority: ${filter.localAuthorities.join(", ")}`,
      reason:
        "The VOA rating list carries a district name but it is not reconciled to a planning authority, " +
        "so filtering on it would be unreliable. Narrow by postcode district instead.",
    });
  }

  /* -- rateable value ----------------------------------------------------- */
  if (filter.rateableValue) {
    const rv = filter.rateableValue;
    if (rv.min !== null) where.push(`a.rateable_value >= ${param(rv.min)}`);
    if (rv.max !== null) where.push(`a.rateable_value <= ${param(rv.max)}`);
    applied.push(
      `Rateable value ${rv.min !== null ? `>= £${rv.min.toLocaleString()}` : `<= £${(rv.max ?? 0).toLocaleString()}`}`,
    );
  }

  /* -- floor area --------------------------------------------------------- */
  // Summed per basis, then the largest stated-basis total taken, mirroring
  // headlineArea() in voa.ts - bases are never added together.
  let areaHaving = "";
  if (filter.floorArea) {
    const fa = filter.floorArea;
    const clauses: string[] = [];
    if (fa.min !== null) clauses.push(`area.area_m2 >= ${param(fa.min)}`);
    if (fa.max !== null) clauses.push(`area.area_m2 <= ${param(fa.max)}`);
    areaHaving = clauses.join(" AND ");
    applied.push(
      `Floor area ${fa.comparison === "between"
        ? `${fa.min}–${fa.max} m²`
        : fa.min !== null ? `>= ${fa.min} m²` : `<= ${fa.max} m²`}`,
    );
    caveats.push(
      "Floor area is the largest stated-basis total from the VOA survey lines. Bases (GIA, NIA, GEA, EFA) are not interchangeable.",
    );
  }

  /* -- EPC ----------------------------------------------------------------- */
  let epcClause = "";
  if (filter.epcBands.length) {
    epcClause = `EXISTS (
      SELECT 1 FROM epc_certificate e
       WHERE e.postcode = a.postcode AND e.rating = ANY(${param(filter.epcBands)}::text[])
    )`;
    where.push(epcClause);
    applied.push(`EPC band in ${filter.epcBands.join(", ")}`);
    caveats.push(
      "EPC bands are matched at postcode level, not to the individual building — treat as a lead.",
    );
  }

  /* -- overseas ownership -------------------------------------------------- */
  if (filter.overseasOwned === true) {
    where.push(`EXISTS (
      SELECT 1 FROM corporate_title t
       WHERE t.postcode = a.postcode AND t.dataset = 'ocod'
    )`);
    applied.push("Overseas-owned title in the postcode");
    caveats.push(
      "Overseas ownership is matched at postcode level against OCOD, not to the individual title — a lead to verify.",
    );
  }

  /* -- grid ---------------------------------------------------------------- */
  let gridSelect = "NULL::numeric";
  if (filter.gridHeadroomMva?.min != null) {
    const headroom = param(filter.gridHeadroomMva.min);
    const radiusDeg = param(GRID_RADIUS_M / 111_320);
    gridSelect = `(
      SELECT max(s.generation_headroom_mva)
        FROM postcode_centroid pc
        JOIN substation s
          ON s.lat BETWEEN pc.lat - ${radiusDeg} AND pc.lat + ${radiusDeg}
         AND s.lng BETWEEN pc.lng - ${radiusDeg} AND pc.lng + ${radiusDeg}
       WHERE pc.postcode = a.postcode
    )`;
    where.push(`${gridSelect} >= ${headroom}`);
    applied.push(`Substation within ~${GRID_RADIUS_M / 1000} km with >= ${filter.gridHeadroomMva.min} MVA headroom`);
    caveats.push(
      `Grid proximity is measured from the postcode centroid within a ${GRID_RADIUS_M / 1000} km box, not from the building.`,
    );
  }

  /* -- constraints: cannot be executed over a corpus ----------------------- */
  for (const constraint of filter.constraints) {
    notApplied.push({
      clause: `${constraint.present ? "In" : "Not in"} ${constraint.dataset.replace(/-/g, " ")}`,
      reason:
        "Constraints are screened per site against planning.data at request time and are not stored for a whole corpus, " +
        "so they cannot narrow a list. Open a specific site to screen it.",
    });
  }

  const limitParam = param(limit);

  const sql = `
    WITH area AS (
      SELECT l.uarn,
             -- Largest total among stated bases; falls back to unknown only
             -- when no basis was published.
             COALESCE(
               max(CASE WHEN l.basis <> 'unknown' THEN totals.total END),
               max(totals.total)
             ) AS area_m2,
             (array_agg(l.basis ORDER BY totals.total DESC))[1] AS basis
        FROM voa_survey_line l
        JOIN LATERAL (
          SELECT sum(l2.area_m2) AS total
            FROM voa_survey_line l2
           WHERE l2.uarn = l.uarn AND l2.basis = l.basis
        ) totals ON true
       GROUP BY l.uarn
    )
    SELECT a.uarn, a.primary_description, a.property_address, a.postcode,
           a.rateable_value, area.area_m2, area.basis,
           (SELECT e.rating FROM epc_certificate e
             WHERE e.postcode = a.postcode AND e.rating IS NOT NULL
             ORDER BY e.inspection_date DESC NULLS LAST LIMIT 1) AS epc_band,
           EXISTS (SELECT 1 FROM corporate_title t
                    WHERE t.postcode = a.postcode AND t.dataset = 'ocod') AS overseas,
           ${gridSelect} AS grid_headroom
      FROM voa_assessment a
      LEFT JOIN area ON area.uarn = a.uarn
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ${areaHaving ? `${where.length ? "AND" : "WHERE"} ${areaHaving}` : ""}
     ORDER BY a.rateable_value DESC NULLS LAST, a.uarn
     LIMIT ${limitParam}
  `;

  const rows = await query<Record<string, unknown>>(sql, values);

  const results: SearchResult[] = rows.map((r) => ({
    uarn: String(r.uarn),
    description: (r.primary_description as string) ?? null,
    address: (r.property_address as string) ?? null,
    postcode: (r.postcode as string) ?? null,
    floorAreaM2: r.area_m2 === null ? null : Number(r.area_m2),
    areaBasis: (r.basis as string) ?? null,
    rateableValue: r.rateable_value === null ? null : Number(r.rateable_value),
    epcBand: (r.epc_band as string) ?? null,
    overseasOwnerInPostcode: r.overseas === true,
    gridHeadroomMva: r.grid_headroom === null ? null : Number(r.grid_headroom),
    matched: applied,
  }));

  return { results, applied, notApplied, caveats: [...new Set(caveats)], total: results.length };
}
