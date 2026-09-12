/**
 * Builds a SiteProfile from a resolved candidate (brief section 3.2 / 3.3).
 *
 * Every lookup records a ResultState rather than a bare boolean, because
 * "we checked and there is none" and "we could not check" are different
 * answers and only one of them is safe to act on. title-boundary in
 * particular is published as incomplete, so an empty result there is
 * `not_found_coverage_unknown` - never "this land has no title".
 */

import { areaM2, pointInPolygon, toWkt, type LatLon } from "./geo";
import { entitiesByPoint, type FetchLike, type PlanningEntity } from "./planning-data";
import { lineage } from "./sources";
import { assertNoGoogleCoordinates } from "./resolve";
import {
  emptyProfile,
  needsConfirmation,
  type Candidate,
  type Footprint,
  type ResultState,
  type SiteProfile,
  type TitleExtent,
} from "./types";

export const DATASETS = {
  title: "title-boundary",
  lpa: "local-planning-authority",
  lad: "local-authority-district",
} as const;

/** OS OpenMap Local building polygons. Served without PostGIS - see stores.ts. */
export interface FootprintStore {
  /** Building polygon containing the point, if any. */
  containing(point: LatLon): Promise<GeoJSON.Geometry | null>;
  /** Largest building polygon intersecting a geometry, if any. */
  largestIntersecting(geometry: GeoJSON.Geometry): Promise<GeoJSON.Geometry | null>;
}

export interface ProfileDeps {
  fetchImpl?: FetchLike;
  footprints?: FootprintStore;
}

/**
 * GSS codes carry the country in their first letter: E England, W Wales,
 * S Scotland, N Northern Ireland. Authoritative where we have a code.
 */
export function countryFromGss(code: string | null | undefined): string | null {
  if (!code) return null;
  const letter = code.trim().charAt(0).toUpperCase();
  return ["E", "W", "S", "N"].includes(letter) ? letter : null;
}

/**
 * Postcode areas that sit wholly within one country. Deliberately excludes
 * areas that straddle a border (CH, SY, LD, NP, TD, DG...), which is why this
 * is a fallback marked T3 and never overrides a GSS code.
 */
const UNAMBIGUOUS_POSTCODE_AREAS: Record<string, string> = {
  AB: "S", DD: "S", EH: "S", FK: "S", G: "S", HS: "S", IV: "S",
  KA: "S", KW: "S", KY: "S", ML: "S", PA: "S", PH: "S", ZE: "S",
  CF: "W", SA: "W", LL: "W",
  BT: "N",
};

export function countryFromPostcode(postcode: string | null): string | null {
  if (!postcode) return null;
  const area = /^([A-Z]{1,2})/.exec(postcode.toUpperCase())?.[1];
  return area ? UNAMBIGUOUS_POSTCODE_AREAS[area] ?? null : null;
}

async function safeQuery(
  run: () => Promise<PlanningEntity[]>,
): Promise<{ entities: PlanningEntity[]; state: ResultState; error?: string }> {
  try {
    const entities = await run();
    return { entities, state: entities.length ? "present" : "not_found_coverage_unknown" };
  } catch (err) {
    return {
      entities: [],
      state: "source_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function toTitleExtent(entity: PlanningEntity): TitleExtent | null {
  if (!entity.geometry) return null;
  return {
    geometry: entity.geometry,
    areaM2: areaM2(entity.geometry),
    sourceRef: entity.reference ?? String(entity.entity),
  };
}

/** Derives the footprint, preferring containment over inference. */
async function deriveFootprint(
  point: LatLon,
  titles: TitleExtent[],
  store: FootprintStore | undefined,
): Promise<{ footprint: Footprint; flag: string | null }> {
  if (!store) {
    return {
      footprint: { geometry: null, areaM2: null, method: "unavailable" },
      flag: null,
    };
  }

  const contained = await store.containing(point);
  if (contained) {
    return {
      footprint: { geometry: contained, areaM2: areaM2(contained), method: "uprn_contained" },
      flag: null,
    };
  }

  // No polygon contains the UPRN: fall back to the largest building touching
  // the title extent, and flag that the footprint was inferred rather than matched.
  for (const title of titles) {
    const largest = await store.largestIntersecting(title.geometry);
    if (largest) {
      return {
        footprint: {
          geometry: largest,
          areaM2: areaM2(largest),
          method: "title_intersect",
        },
        flag: "footprint_inferred",
      };
    }
  }

  return { footprint: { geometry: null, areaM2: null, method: "unavailable" }, flag: null };
}

export async function buildProfile(
  candidate: Candidate,
  deps: ProfileDeps = {},
): Promise<SiteProfile> {
  assertNoGoogleCoordinates(candidate);

  const profile = emptyProfile();
  const point: LatLon = { lat: candidate.lat, lon: candidate.lon };

  profile.uprn = candidate.uprn;
  profile.lat = candidate.lat;
  profile.lon = candidate.lon;
  profile.postcode = candidate.postcode;
  profile.address = candidate.address;
  profile.matchConfidence = candidate.confidence;
  profile.userConfirmed = false;
  profile.sources.push(candidate.source);

  if (needsConfirmation(candidate.confidence)) profile.flags.push("needs_confirmation");
  if (!candidate.uprn) profile.flags.push("no_uprn");

  // ---- title extents ------------------------------------------------------
  const titles = await safeQuery(() =>
    entitiesByPoint(
      { lat: point.lat, lon: point.lon, datasets: [DATASETS.title], limit: 25 },
      deps.fetchImpl,
    ),
  );
  profile.states[DATASETS.title] = titles.state;
  profile.titleExtents = titles.entities
    .map(toTitleExtent)
    .filter((t): t is TitleExtent => t !== null);

  if (profile.titleExtents.length > 1) profile.flags.push("multi_title");
  for (const entity of titles.entities) {
    profile.sources.push(
      lineage({
        sourceId: "planning-data-title-boundary",
        entityRef: entity.reference ?? String(entity.entity),
        method: "point-in-polygon",
        tier: "T2",
        sourceUpdated: entity.entryDate,
      }),
    );
  }

  // ---- local planning authority ------------------------------------------
  const lpa = await safeQuery(() =>
    entitiesByPoint(
      { lat: point.lat, lon: point.lon, datasets: [DATASETS.lpa, DATASETS.lad], limit: 10 },
      deps.fetchImpl,
    ),
  );
  profile.states[DATASETS.lpa] = lpa.state;

  const lpaEntity =
    lpa.entities.find((e) => e.dataset === DATASETS.lpa) ?? lpa.entities[0] ?? null;
  if (lpaEntity) {
    profile.lpaCode = lpaEntity.reference;
    profile.lpaName = lpaEntity.name;
    profile.sources.push(
      lineage({
        sourceId: "planning-data-lpa",
        entityRef: lpaEntity.reference ?? String(lpaEntity.entity),
        method: "point-in-polygon",
        tier: "T2",
        sourceUpdated: lpaEntity.entryDate,
      }),
    );
  }

  // ---- country ------------------------------------------------------------
  const ladEntity = lpa.entities.find((e) => e.dataset === DATASETS.lad);
  const fromGss = countryFromGss(ladEntity?.reference ?? lpaEntity?.reference);
  if (fromGss) {
    profile.country = fromGss;
  } else {
    const inferred = countryFromPostcode(candidate.postcode);
    if (inferred) {
      profile.country = inferred;
      profile.flags.push("country_inferred_from_postcode");
    }
  }

  // ---- footprint ----------------------------------------------------------
  const { footprint, flag } = await deriveFootprint(point, profile.titleExtents, deps.footprints);
  profile.footprint = footprint;
  if (flag) profile.flags.push(flag);
  if (footprint.geometry) {
    profile.sources.push(
      lineage({
        sourceId: "os-openmap-local",
        entityRef: null,
        method:
          footprint.method === "uprn_contained"
            ? "building polygon containing the UPRN"
            : "largest building polygon intersecting the title extent",
        tier: footprint.method === "uprn_contained" ? "T2" : "T3",
      }),
    );
  }

  return profile;
}

/**
 * Applies a user override - a confirmed pin or a redrawn footprint. The
 * original is not discarded; the override is added as a T4 source alongside it.
 */
export function applyOverride(
  profile: SiteProfile,
  override: {
    confirmed?: boolean;
    footprint?: GeoJSON.Geometry;
    point?: LatLon;
    /** Discards a user drawing and restores what the source published. */
    revertFootprint?: boolean;
  },
): SiteProfile {
  const next: SiteProfile = {
    ...profile,
    flags: [...profile.flags],
    sources: [...profile.sources],
  };

  if (override.point) {
    next.lat = override.point.lat;
    next.lon = override.point.lon;
    next.matchConfidence = "manual";
    next.sources.push(
      lineage({
        sourceId: "os-open-uprn",
        entityRef: next.uprn,
        method: "user moved the pin",
        tier: "T4",
      }),
    );
  }

  if (override.footprint) {
    /*
     * Capture the original ONCE, on the first override.
     *
     * A second redraw replaces the drawing, never the original - the thing
     * worth keeping is what the SOURCE published, not the user's previous
     * attempt. Overwriting it on every redraw would quietly turn "revert to
     * the OS polygon" into "revert to my last shape".
     */
    if (!next.footprintOriginal && next.footprint.method !== "user_drawn") {
      next.footprintOriginal = {
        geometry: next.footprint.geometry,
        areaM2: next.footprint.areaM2,
        method: next.footprint.method,
        overriddenAt: new Date().toISOString(),
      };
    }

    next.footprint = {
      geometry: override.footprint,
      areaM2: areaM2(override.footprint),
      method: "user_drawn",
    };
    // The inference flag described the SOURCE polygon's provenance. It says
    // nothing about a shape the user drew, so it goes.
    next.flags = next.flags.filter((f) => f !== "footprint_inferred");
    // Anything derived from the footprint was computed against the old shape.
    if (!next.flags.includes("footprint_overridden")) next.flags.push("footprint_overridden");

    next.sources.push(
      lineage({
        sourceId: "os-openmap-local",
        entityRef: null,
        method: "user redrew the footprint",
        tier: "T4",
      }),
    );
  }

  if (override.revertFootprint && next.footprintOriginal) {
    const original = next.footprintOriginal;
    next.footprint = {
      geometry: original.geometry,
      areaM2: original.areaM2,
      method: original.method,
    };
    next.footprintOriginal = null;
    next.flags = next.flags.filter((f) => f !== "footprint_overridden");
    // Restore the flag the source polygon carried, if it was an inference.
    if (original.method === "title_intersect" && !next.flags.includes("footprint_inferred")) {
      next.flags.push("footprint_inferred");
    }
    next.sources.push(
      lineage({
        sourceId: "os-openmap-local",
        entityRef: null,
        method: "user reverted to the published footprint",
        tier: "T4",
      }),
    );
  }

  if (override.confirmed) {
    next.userConfirmed = true;
    next.flags = next.flags.filter((f) => f !== "needs_confirmation");
  }

  return next;
}

/**
 * Convenience for the constraints work in S-02: the geometry to query with is
 * the footprint if we have one, otherwise the title extent, otherwise nothing.
 */
export function queryGeometry(
  profile: SiteProfile,
): { wkt: string; basis: string; geometry: GeoJSON.Geometry } | null {
  if (profile.footprint.geometry) {
    const geometry = profile.footprint.geometry;
    return { wkt: toWkt(geometry), basis: "footprint", geometry };
  }
  if (profile.titleExtents.length === 1) {
    const geometry = profile.titleExtents[0].geometry;
    return { wkt: toWkt(geometry), basis: "title extent", geometry };
  }
  return null;
}

/** Exported for tests: does this point fall inside any of the title extents? */
export function pointInTitles(point: LatLon, profile: SiteProfile): boolean {
  return profile.titleExtents.some((t) => pointInPolygon(point, t.geometry));
}

export async function largestIntersectingArea(
  store: FootprintStore,
  geometry: GeoJSON.Geometry,
): Promise<number | null> {
  return areaM2(await store.largestIntersecting(geometry));
}
