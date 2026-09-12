/**
 * S-02 map layers: how constraints are grouped and coloured.
 *
 * PRESENTATIONAL ONLY. This decides what a polygon looks like and which toggle
 * it sits under. It states nothing about planning law, which is why it is here
 * in TypeScript and not in `constraint_rules.yaml` — the YAML holds the
 * user-facing wording James signs off, and padding it with colour choices would
 * blur what the sign-off covers.
 *
 * A leaf module: no imports, no I/O, so the map component can use it without
 * pulling the rules loader and `node:fs` into the browser bundle. Same reason
 * `area-basis.ts` and `search-describe.ts` exist.
 *
 * Every dataset with a rule must appear here. A test enforces it, because a new
 * constraint falling silently into "other" would be drawn in a colour that
 * means nothing.
 */

export type ConstraintCategory =
  | "heritage"
  | "designated"
  | "ecology"
  | "flood"
  | "other";

export interface CategorySpec {
  key: ConstraintCategory;
  label: string;
  /** Fill and line colour. Chosen to stay distinguishable in both themes. */
  color: string;
}

export const CATEGORIES: readonly CategorySpec[] = [
  { key: "heritage", label: "Heritage", color: "#8A5A2B" },
  { key: "designated", label: "Designated land", color: "#1C6647" },
  { key: "ecology", label: "Ecology", color: "#3D7A3D" },
  { key: "flood", label: "Flood", color: "#1B4DD1" },
  { key: "other", label: "Other", color: "#6B5B95" },
] as const;

const BY_DATASET: Record<string, ConstraintCategory> = {
  "conservation-area": "heritage",
  "listed-building": "heritage",
  "listed-building-outline": "heritage",
  "locally-listed-building": "heritage",
  "heritage-at-risk": "heritage",
  "scheduled-monument": "heritage",
  "park-and-garden": "heritage",
  "world-heritage-site": "heritage",
  "world-heritage-site-buffer-zone": "heritage",

  "area-of-outstanding-natural-beauty": "designated",
  "national-park": "designated",
  "green-belt": "designated",
  "article-4-direction-area": "designated",

  "site-of-special-scientific-interest": "ecology",
  "special-area-of-conservation": "ecology",
  "special-protection-area": "ecology",
  "ramsar-site": "ecology",
  "ancient-woodland": "ecology",
  "tree-preservation-zone": "ecology",

  "flood-risk-zone": "flood",

  "air-quality-management-area": "other",
};

export function categoryOf(dataset: string): ConstraintCategory {
  return BY_DATASET[dataset] ?? "other";
}

/** True when the dataset has an explicit category rather than falling back. */
export function hasCategory(dataset: string): boolean {
  return dataset in BY_DATASET;
}

export function categorySpec(key: ConstraintCategory): CategorySpec {
  const spec = CATEGORIES.find((c) => c.key === key);
  if (!spec) throw new Error(`unknown constraint category "${key}"`);
  return spec;
}

export function colorOf(dataset: string): string {
  return categorySpec(categoryOf(dataset)).color;
}

/* ------------------------------------------------------------- coverage --- */

/**
 * What the map is and is not showing.
 *
 * This exists because a map is the most dangerous surface for brief §0 rule 4.
 * A list that shows nothing prompts "did it look?"; a map that draws nothing
 * just looks like open country. So the layers are always accompanied by a
 * count of what was screened, what was found, and — loudly — what could not be
 * checked at all.
 */
export interface LayerCoverage {
  drawnPresent: number;
  drawnProximity: number;
  /** Flagged, but the source published no geometry to draw. */
  flaggedWithoutGeometry: number;
  checkedNothingFound: number;
  couldNotCheck: number;
  notSupported: number;
  /** Datasets behind `couldNotCheck`, so the gap can be named. */
  couldNotCheckDatasets: string[];
  statement: string;
}

export interface CoverageInput {
  dataset: string;
  state: string;
  label: string;
  entityGeometryCount: number;
  entityCount: number;
}

export function summariseCoverage(rows: CoverageInput[]): LayerCoverage {
  let drawnPresent = 0;
  let drawnProximity = 0;
  let flaggedWithoutGeometry = 0;
  let checkedNothingFound = 0;
  let couldNotCheck = 0;
  let notSupported = 0;
  const couldNotCheckDatasets: string[] = [];

  for (const row of rows) {
    switch (row.state) {
      case "present":
      case "proximity": {
        if (row.entityGeometryCount > 0) {
          if (row.state === "present") drawnPresent++;
          else drawnProximity++;
        }
        // A flag whose source published no extent cannot be drawn. Counted
        // separately so the map never implies it does not exist.
        if (row.entityCount > row.entityGeometryCount) flaggedWithoutGeometry++;
        break;
      }
      case "not_found_coverage_complete":
        checkedNothingFound++;
        break;
      case "not_supported":
        notSupported++;
        break;
      default:
        // not_found_coverage_unknown and source_error both mean "we did not
        // establish an answer", and both are gaps rather than absences.
        couldNotCheck++;
        couldNotCheckDatasets.push(row.label);
    }
  }

  const parts: string[] = [];
  if (drawnPresent || drawnProximity) {
    parts.push(
      `${drawnPresent} drawn on the site` +
        (drawnProximity ? `, ${drawnProximity} nearby` : ""),
    );
  }
  if (flaggedWithoutGeometry) {
    parts.push(`${flaggedWithoutGeometry} flagged but published no extent to draw`);
  }
  if (checkedNothingFound) parts.push(`${checkedNothingFound} checked and clear`);
  if (notSupported) parts.push(`${notSupported} not covered here`);

  const statement =
    (parts.length ? parts.join(" · ") : "Nothing screened yet") +
    (couldNotCheck
      ? ` — ${couldNotCheck} COULD NOT BE CHECKED, so an empty map is not an all-clear.`
      : ".");

  return {
    drawnPresent,
    drawnProximity,
    flaggedWithoutGeometry,
    checkedNothingFound,
    couldNotCheck,
    notSupported,
    couldNotCheckDatasets,
    statement,
  };
}
