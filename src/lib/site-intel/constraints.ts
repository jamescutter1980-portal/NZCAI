/**
 * S-02: planning and environmental constraint screening.
 *
 * Two queries per run against planning.data.gov.uk:
 *   1. the site geometry, intersecting          -> `present`
 *   2. a buffered box around it (default 50 m)  -> `proximity`
 *
 * Rules that shape the whole module:
 *   - England only. Welsh and Scottish sites return `not_supported` with a
 *     reason, never a misleading empty result (phase 2: DataMapWales,
 *     SpatialData.gov.scot).
 *   - Never a bare "not found". Where coverage cannot be confirmed the state is
 *     `not_found_coverage_unknown`. planning.data does not publish a
 *     per-dataset, per-LPA coverage guarantee we can rely on, so
 *     `not_found_coverage_complete` is currently unreachable - see PLAN.md.
 *   - Wording comes from constraint_rules.yaml. This file produces states and
 *     rule keys only.
 */

import { bufferBounds, toWkt } from "./geo";
import { entitiesByGeometry, type FetchLike, type PlanningEntity } from "./planning-data";
import { queryGeometry } from "./profile";
import { getRule, renderWording, ruleDatasets } from "./rules";
import { lineage } from "./sources";
import type { ResultState, SiteProfile, SourceRecord } from "./types";

/** Brief section 4.1. Configurable; reported alongside every proximity hit. */
export const DEFAULT_BUFFER_M = 50;

/** Polite pause between calls to planning.data. */
export const REQUEST_DELAY_MS = 250;

/** Beyond this many buildings, use bulk downloads rather than the API. */
export const BULK_THRESHOLD = 50;

export interface ConstraintEntity {
  reference: string | null;
  name: string | null;
  entryDate: string | null;
  /**
   * The published extent that produced this flag.
   *
   * Carried so the map can draw the actual polygon rather than a marker at the
   * site. Null where the source published none, which is itself worth knowing:
   * a constraint with no geometry cannot be shown, and a map that silently
   * omits it looks like a map with nothing there.
   */
  geometry: GeoJSON.Geometry | null;
}

export interface Constraint {
  dataset: string;
  label: string;
  state: ResultState;
  /** User-facing wording from the rules YAML. Null where there is nothing to say. */
  message: string | null;
  check: string | null;
  feeds: string[];
  entities: ConstraintEntity[];
  source: SourceRecord | null;
  /** Set when the rule's wording has not been signed off. */
  wordingUnapproved: boolean;
}

export interface ConstraintScreening {
  constraints: Constraint[];
  bufferM: number;
  /** Whether the screen ran against the footprint or the title extent. */
  basis: string | null;
  flags: string[];
  /** Populated when the whole screen could not run. */
  unsupportedReason?: string;
  /**
   * The geometry screened against, and the envelope the proximity pass used.
   *
   * The envelope is a BOUNDING BOX around the site geometry, not a true
   * buffer, so its corners reach further than `bufferM`. Returning it lets the
   * map draw the area actually searched instead of leaving the reader to
   * assume a neat circle.
   */
  searchArea: {
    site: GeoJSON.Geometry | null;
    envelope: GeoJSON.Geometry | null;
    /** True while the envelope is a bounding box rather than a real buffer. */
    envelopeIsBoundingBox: boolean;
  };
}

export interface ConstraintDeps {
  fetchImpl?: FetchLike;
  bufferM?: number;
  /** Overrides the dataset list. Defaults to everything with wording. */
  datasets?: string[];
  /** Injected so tests do not sleep. */
  delay?: (ms: number) => Promise<void>;
  flood?: FloodCheck;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Countries planning.data covers. Anything else is not_supported. */
const SUPPORTED_COUNTRIES = ["E"];

function emptyConstraint(dataset: string, state: ResultState, bufferM: number): Constraint {
  const rule = getRule(dataset);
  return {
    dataset,
    label: rule?.label ?? dataset,
    state,
    message: null,
    check: rule ? renderWording(rule.check, bufferM) : null,
    feeds: rule?.feeds ?? [],
    entities: [],
    source: null,
    wordingUnapproved: rule ? !rule.approved : false,
  };
}

function toConstraintEntity(entity: PlanningEntity): ConstraintEntity {
  return {
    reference: entity.reference,
    name: entity.name,
    entryDate: entity.entryDate,
    geometry: entity.geometry,
  };
}

/**
 * Groups a flat entity list by dataset. planning.data returns one collection
 * for a multi-dataset query, so a dataset with no features is simply absent -
 * which is why the caller starts from the full requested list, not this map.
 */
function byDataset(entities: PlanningEntity[]): Map<string, PlanningEntity[]> {
  const grouped = new Map<string, PlanningEntity[]>();
  for (const entity of entities) {
    const list = grouped.get(entity.dataset) ?? [];
    list.push(entity);
    grouped.set(entity.dataset, list);
  }
  return grouped;
}

export async function screenConstraints(
  profile: SiteProfile,
  deps: ConstraintDeps = {},
): Promise<ConstraintScreening> {
  const bufferM = deps.bufferM ?? DEFAULT_BUFFER_M;
  const datasets = deps.datasets ?? ruleDatasets();
  const wait = deps.delay ?? sleep;
  const flags: string[] = [];

  // ---- England-only gate --------------------------------------------------
  if (profile.country && !SUPPORTED_COUNTRIES.includes(profile.country)) {
    const where = { W: "Wales", S: "Scotland", N: "Northern Ireland" }[profile.country] ?? "this country";
    return {
      constraints: datasets.map((d) => emptyConstraint(d, "not_supported", bufferM)),
      bufferM,
      basis: null,
      flags: ["country_not_supported"],
      searchArea: { site: null, envelope: null, envelopeIsBoundingBox: true },
      unsupportedReason:
        `Constraint screening covers England only. This site is in ${where}; ` +
        "DataMapWales and SpatialData.gov.scot are a later phase.",
    };
  }

  // ---- geometry to screen against ----------------------------------------
  const geometry = queryGeometry(profile);
  if (!geometry) {
    return {
      constraints: datasets.map((d) => emptyConstraint(d, "not_found_coverage_unknown", bufferM)),
      bufferM,
      basis: null,
      flags: ["no_query_geometry"],
      searchArea: { site: null, envelope: null, envelopeIsBoundingBox: true },
      unsupportedReason:
        profile.titleExtents.length > 1
          ? "Several title extents cover this point and no footprint is available, so there is no single geometry to screen. Confirm the building first."
          : "No footprint or title extent is available for this site, so there is nothing to screen against.",
    };
  }

  const results = new Map<string, Constraint>();
  for (const dataset of datasets) {
    results.set(dataset, emptyConstraint(dataset, "not_found_coverage_unknown", bufferM));
  }

  // ---- pass 1: intersecting the site -> present ---------------------------
  try {
    const present = await entitiesByGeometry(
      { wkt: geometry.wkt, relation: "intersects", datasets, limit: 250 },
      deps.fetchImpl,
    );
    for (const [dataset, entities] of byDataset(present)) {
      const rule = getRule(dataset);
      results.set(dataset, {
        ...emptyConstraint(dataset, "present", bufferM),
        message: rule ? renderWording(rule.present, bufferM) : null,
        entities: entities.map(toConstraintEntity),
        source: lineage({
          sourceId: "planning-data-constraints",
          entityRef: dataset,
          method: `intersects ${geometry.basis}`,
          tier: "T2",
          sourceUpdated: entities[0]?.entryDate ?? null,
        }),
      });
    }
  } catch (err) {
    for (const dataset of datasets) {
      results.set(dataset, emptyConstraint(dataset, "source_error", bufferM));
    }
    flags.push("constraint_source_error");
    return {
      constraints: [...results.values()],
      bufferM,
      basis: geometry.basis,
      flags,
      searchArea: {
        site: geometry.geometry,
        envelope: bufferBounds(geometry.geometry, bufferM),
        envelopeIsBoundingBox: true,
      },
      unsupportedReason: err instanceof Error ? err.message : String(err),
    };
  }

  await wait(REQUEST_DELAY_MS);

  // ---- pass 2: within the buffer -> proximity -----------------------------
  // Only for datasets not already present; a hit on the site itself outranks
  // a hit nearby, and re-reporting it as proximity would be noise.
  const outstanding = datasets.filter((d) => results.get(d)?.state !== "present");
  const buffered = bufferBounds(geometry.geometry, bufferM);

  if (outstanding.length && buffered) {
    try {
      const near = await entitiesByGeometry(
        { wkt: toWkt(buffered), relation: "intersects", datasets: outstanding, limit: 250 },
        deps.fetchImpl,
      );
      for (const [dataset, entities] of byDataset(near)) {
        // Guard on write as well as on request: if the source returns a dataset
        // we already found ON the site, downgrading it to "nearby" would
        // understate a real constraint. Never let pass 2 overwrite a present.
        if (results.get(dataset)?.state === "present") continue;

        const rule = getRule(dataset);
        results.set(dataset, {
          ...emptyConstraint(dataset, "proximity", bufferM),
          message: rule ? renderWording(rule.proximity, bufferM) : null,
          entities: entities.map(toConstraintEntity),
          source: lineage({
            sourceId: "planning-data-constraints",
            entityRef: dataset,
            method: `within ${bufferM} m of ${geometry.basis} (bounding-box buffer)`,
            tier: "T3",
            sourceUpdated: entities[0]?.entryDate ?? null,
          }),
        });
      }
    } catch {
      // The proximity pass is an enhancement. Losing it leaves the `present`
      // results intact; mark the rest coverage-unknown rather than erroring out.
      flags.push("proximity_pass_failed");
    }
  }

  // ---- flood cross-check --------------------------------------------------
  if (deps.flood) {
    const floodConstraint = results.get("flood-risk-zone");
    if (floodConstraint) {
      const cross = await crossCheckFlood(floodConstraint, geometry.wkt, deps.flood);
      results.set("flood-risk-zone", cross.constraint);
      if (cross.conflict) flags.push("source_conflict");
    }
  }

  return {
    constraints: [...results.values()],
    bufferM,
    basis: geometry.basis,
    flags,
    searchArea: {
      site: geometry.geometry,
      envelope: buffered,
      envelopeIsBoundingBox: true,
    },
  };
}

/* ---------------------------------------------------------------- flood --- */

export interface FloodCheck {
  /** True/false if the EA answered, null if it could not be reached. */
  inFloodZone(wkt: string): Promise<boolean | null>;
}

/**
 * The Environment Agency Flood Map for Planning is the authoritative source for
 * flood zones; planning.data carries a copy. Where the two disagree the brief
 * requires both to be shown and `source_conflict` raised, rather than silently
 * picking one.
 */
export async function crossCheckFlood(
  constraint: Constraint,
  wkt: string,
  flood: FloodCheck,
): Promise<{ constraint: Constraint; conflict: boolean }> {
  const ea = await flood.inFloodZone(wkt);
  if (ea === null) {
    return {
      constraint: {
        ...constraint,
        message: constraint.message
          ? `${constraint.message} The Environment Agency map could not be reached to confirm this.`
          : "The Environment Agency flood map could not be reached, so flood risk is unconfirmed.",
      },
      conflict: false,
    };
  }

  const planningSaysYes = constraint.state === "present";
  if (ea === planningSaysYes) {
    return {
      constraint: {
        ...constraint,
        message: constraint.message
          ? `${constraint.message} Confirmed against the Environment Agency Flood Map for Planning.`
          : constraint.message,
      },
      conflict: false,
    };
  }

  // Disagreement: report both, take neither as settled.
  const detail = ea
    ? "The Environment Agency Flood Map for Planning places this site in a flood zone, but planning.data.gov.uk does not."
    : "planning.data.gov.uk places this site in a flood zone, but the Environment Agency Flood Map for Planning does not.";

  return {
    constraint: {
      ...constraint,
      state: "present",
      message: `Sources disagree. ${detail} Treat flood risk as unresolved until checked.`,
      check:
        "Resolve directly against the Environment Agency Flood Map for Planning before relying on either result.",
    },
    conflict: true,
  };
}

/* ----------------------------------------------------------- narrative --- */

/**
 * Guard for the brief's section 7 rule: generated narrative may only describe
 * flags that exist, and may not assert an absence the data does not support.
 *
 * Returns the problems found. An empty array means the text is consistent with
 * the screening; a test holds this and fails the build if narrative claims an
 * all-clear that was never established.
 */
export function checkNarrative(text: string, screening: ConstraintScreening): string[] {
  const problems: string[] = [];
  const lower = text.toLowerCase();

  const confirmedAbsence = (dataset: string): boolean =>
    screening.constraints.find((c) => c.dataset === dataset)?.state ===
    "not_found_coverage_complete";

  const anyUnconfirmed = screening.constraints.some(
    (c) => c.state === "not_found_coverage_unknown" || c.state === "source_error",
  );

  if (/\bno constraints\b|\bno planning constraints\b|\bunconstrained\b/.test(lower) && anyUnconfirmed) {
    problems.push(
      'Text claims "no constraints" while at least one dataset is coverage-unknown or errored.',
    );
  }

  if (/\bno flood risk\b|\bnot at risk of flooding\b|\bflood.free\b/.test(lower) && !confirmedAbsence("flood-risk-zone")) {
    problems.push(
      'Text denies flood risk without a confirmed-complete result for flood-risk-zone.',
    );
  }

  if (/\bgrid capacity (is )?available\b|\bno grid constraint\b/.test(lower)) {
    problems.push(
      'Text asserts grid capacity is available; grid outputs are indicative only and never a connection offer.',
    );
  }

  // Anything described as present must actually be present or proximity.
  for (const constraint of screening.constraints) {
    const named = lower.includes(constraint.label.toLowerCase());
    const found = constraint.state === "present" || constraint.state === "proximity";
    if (named && !found && constraint.state !== "not_supported") {
      problems.push(`Text mentions "${constraint.label}" but its state is ${constraint.state}.`);
    }
  }

  return problems;
}

/** Constraints relevant to one NZC AI workstream, for the section 7 hooks. */
export function constraintsFeeding(
  screening: ConstraintScreening,
  workstream: string,
): Constraint[] {
  return screening.constraints.filter(
    (c) => c.feeds.includes(workstream) && (c.state === "present" || c.state === "proximity"),
  );
}
