/**
 * S-03 grid lookup for a site. Brief §5.1 and §5.4.
 *
 * The order of operations is the brief's, and it matters:
 *
 *   1. Which DNO — by CONTAINMENT against the NESO licence-area polygons, not
 *      by nearest substation. Those are different questions and a site near a
 *      boundary gets different answers.
 *   2. Which substations — the DNO's own supply-area polygon containing the
 *      site if it publishes one, otherwise the nearest N, LABELLED as such.
 *   3. ECR within the configured radius above the configured export floor.
 *   4. Screens, which stay `unrated` until something supplies their input.
 *
 * Every path that returns nothing says whether it looked and found none or
 * could not look — brief §0 rule 4, and the same `ResultState` vocabulary the
 * rest of site-intel uses.
 */

import { query } from "@/lib/db";
import { asAreaGeometry, bboxForRadius, contains, haversineM } from "@/lib/geo-polygon";
import type { Rag } from "@/lib/types";
import type { ResultState } from "./types";
import {
  fixedCaveat,
  freshness,
  loadGridRules,
  nearestByDistanceNote,
  networkVsSiteNote,
  ragFor,
  screen,
  summariseEcr,
  type EcrEntry,
  type EcrSummary,
  type Freshness,
  type Screen,
} from "./grid-screen";

/* ------------------------------------------------------------------ DNO --- */

export interface DnoMatch {
  dnoId: string | null;
  areaName: string | null;
  licenceRef: string | null;
  versionDate: string | null;
  state: ResultState;
  /** How the answer was reached. Never left implicit. */
  method: string;
  /**
   * Every area whose polygon contains the point. Licence areas should not
   * overlap, so more than one is a data problem - and picking one of them
   * silently would answer a connection question with a coin toss.
   */
  alsoMatched: string[];
}

/**
 * The licence area containing a point.
 *
 * The bounding box filter runs in SQL and the ray cast in TypeScript: with ~14
 * areas the cast is trivial, and it keeps PostGIS optional.
 */
export async function dnoForPoint(lat: number, lng: number): Promise<DnoMatch> {
  const rows = await query<Record<string, unknown>>(
    `SELECT dno_id, area_name, licence_ref, geometry, version_date
       FROM dno_licence_area
      WHERE $1 BETWEEN min_lat AND max_lat
        AND $2 BETWEEN min_lng AND max_lng`,
    [lat, lng],
  );

  if (!rows.length) {
    // No bbox hit is ambiguous on its own: either no boundary covers this point
    // or no boundaries have been loaded. Those are different answers.
    const [count] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dno_licence_area`,
    );
    const loaded = Number(count?.n ?? 0);
    return {
      dnoId: null,
      areaName: null,
      licenceRef: null,
      versionDate: null,
      state: loaded > 0 ? "not_found_coverage_complete" : "not_found_coverage_unknown",
      method: loaded > 0
        ? `Point-in-polygon against ${loaded} loaded licence area(s); none contains this point.`
        : "No DNO licence areas are loaded. Run `npm run grid:boundaries` with the NESO GeoJSON.",
      alsoMatched: [],
    };
  }

  // Collect every containing area rather than returning the first. A bounding
  // box overlap is common and harmless; a POLYGON overlap is a data problem,
  // and resolving it by taking whichever row the query returned first would
  // answer "which DNO" arbitrarily.
  const matches = rows.filter((row) => {
    const geometry = asAreaGeometry(row.geometry);
    return geometry ? contains(geometry, lat, lng) : false;
  });

  if (!matches.length) {
    return {
      dnoId: null,
      areaName: null,
      licenceRef: null,
      versionDate: null,
      state: "not_found_coverage_complete",
      method:
        `${rows.length} licence area bounding box(es) cover this point but none of the ` +
        `polygons contains it.`,
      alsoMatched: [],
    };
  }

  const [first, ...rest] = matches;
  const versionDate = first.version_date
    ? new Date(first.version_date as string).toISOString().slice(0, 10)
    : null;
  const alsoMatched = rest.map((r) => String(r.area_name));

  return {
    dnoId: (first.dno_id as string) ?? null,
    areaName: (first.area_name as string) ?? null,
    licenceRef: (first.licence_ref as string) ?? null,
    versionDate,
    state: alsoMatched.length ? "proximity" : "present",
    method:
      `Point-in-polygon against the NESO DNO licence-area boundaries` +
      (versionDate ? `, version ${versionDate}` : ", version date not published") +
      (first.dno_id ? "" : ". The area did not map to a known DNO, so no adapter applies.") +
      (alsoMatched.length
        ? ` OVERLAP: ${alsoMatched.length + 1} licence areas contain this point ` +
          `(${[String(first.area_name), ...alsoMatched].join("; ")}). Licence areas should not ` +
          `overlap, so confirm which applies before relying on the DNO shown.`
        : ""),
    alsoMatched,
  };
}

/* ---------------------------------------------------------- substations --- */

export type SubstationMethod = "supply_area" | "nearest_by_distance";

export interface NearbySubstation {
  id: number;
  dnoId: string;
  dnoName: string;
  sourceRef: string;
  name: string | null;
  level: string | null;
  levelSource: string;
  voltageKv: number | null;
  lat: number | null;
  lng: number | null;
  demandHeadroomMva: number | null;
  generationHeadroomMva: number | null;
  demandRag: Rag | null;
  generationRag: Rag | null;
  /** True when the RAG came from the DNO, false when it is our band. */
  ragPublished: boolean;
  constraintNote: string | null;
  distanceM: number | null;
  freshness: Freshness;
}

export interface SubstationLookup {
  substations: NearbySubstation[];
  method: SubstationMethod | null;
  state: ResultState;
  /** Present whenever the method is nearest_by_distance. */
  proximityNote: string | null;
}

export async function substationsForSite(
  lat: number,
  lng: number,
  dnoId: string | null,
  now: Date = new Date(),
): Promise<SubstationLookup> {
  const rules = loadGridRules();
  const { dLat, dLng } = bboxForRadius(lat, rules.proximity.radius_m);

  const rows = await query<Record<string, unknown>>(
    `SELECT s.id, s.dno_id, d.name AS dno_name, s.source_ref, s.name, s.level,
            s.level_source, s.voltage_kv, s.lat, s.lng,
            s.demand_headroom_mva, s.generation_headroom_mva,
            s.demand_rag, s.generation_rag, s.constraint_note,
            s.area_geom, s.source_date, s.ingested_at
       FROM substation s
       JOIN dno d ON d.id = s.dno_id
      WHERE s.lat BETWEEN $1 AND $2
        AND s.lng BETWEEN $3 AND $4
        ${dnoId ? "AND s.dno_id = $5" : ""}`,
    dnoId
      ? [lat - dLat, lat + dLat, lng - dLng, lng + dLng, dnoId]
      : [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
  );

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  const toSubstation = (r: Record<string, unknown>, distanceM: number | null): NearbySubstation => {
    const publishedGenRag = (r.generation_rag as Rag) ?? null;
    const publishedDemRag = (r.demand_rag as Rag) ?? null;
    const genHeadroom = num(r.generation_headroom_mva);
    const demHeadroom = num(r.demand_headroom_mva);

    return {
      id: Number(r.id),
      dnoId: String(r.dno_id),
      dnoName: String(r.dno_name),
      sourceRef: String(r.source_ref),
      name: (r.name as string) ?? null,
      level: (r.level as string) ?? null,
      levelSource: (r.level_source as string) ?? "unknown",
      voltageKv: num(r.voltage_kv),
      lat: num(r.lat),
      lng: num(r.lng),
      demandHeadroomMva: demHeadroom,
      generationHeadroomMva: genHeadroom,
      // The DNO's own rating wins. Ours is a fallback and is marked as such.
      demandRag: publishedDemRag ?? ragFor(demHeadroom, rules.rag_bands.demand),
      generationRag: publishedGenRag ?? ragFor(genHeadroom, rules.rag_bands.generation),
      ragPublished: Boolean(publishedGenRag || publishedDemRag),
      constraintNote: (r.constraint_note as string) ?? null,
      distanceM,
      freshness: freshness(
        r.source_date ? new Date(r.source_date as string).toISOString() : null,
        r.ingested_at ? new Date(r.ingested_at as string).toISOString() : null,
        now,
      ),
    };
  };

  // Step 1: a published supply-area polygon containing the site wins outright.
  const containing = rows.filter((r) => {
    const geometry = asAreaGeometry(r.area_geom);
    return geometry ? contains(geometry, lat, lng) : false;
  });

  if (containing.length) {
    return {
      substations: containing.map((r) => toSubstation(r, distanceTo(r, lat, lng))),
      method: "supply_area",
      state: "present",
      proximityNote: null,
    };
  }

  // Step 2: otherwise the nearest N within the radius, labelled as such.
  const withDistance = rows
    .map((r) => ({ r, d: distanceTo(r, lat, lng) }))
    .filter((x): x is { r: Record<string, unknown>; d: number } => x.d !== null)
    .filter((x) => x.d <= rules.proximity.radius_m)
    .sort((a, b) => a.d - b.d)
    .slice(0, rules.proximity.nearest_count);

  if (!withDistance.length) {
    // Nothing nearby is only meaningful if anything is loaded at all.
    const [count] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM substation`);
    const loaded = Number(count?.n ?? 0);
    return {
      substations: [],
      method: null,
      state: loaded > 0 ? "not_found_coverage_complete" : "not_found_coverage_unknown",
      proximityNote:
        loaded > 0
          ? `No substation is loaded within ${rules.proximity.radius_m / 1000} km of this site.`
          : "No substations are loaded, so this is an absence of data rather than an absence of network.",
    };
  }

  return {
    substations: withDistance.map((x) => toSubstation(x.r, x.d)),
    method: "nearest_by_distance",
    state: "proximity",
    proximityNote: nearestByDistanceNote(),
  };
}

function distanceTo(r: Record<string, unknown>, lat: number, lng: number): number | null {
  if (r.lat === null || r.lng === null || r.lat === undefined || r.lng === undefined) return null;
  return Math.round(haversineM(lat, lng, Number(r.lat), Number(r.lng)));
}

/* ------------------------------------------------------------------ ECR --- */

export async function ecrNearSite(
  lat: number,
  lng: number,
  dnoId: string | null,
): Promise<{ summary: EcrSummary; state: ResultState }> {
  const rules = loadGridRules();
  const { dLat, dLng } = bboxForRadius(lat, rules.ecr.radius_m);
  const minExportMva = rules.ecr.min_export_kw / 1000;

  const rows = await query<Record<string, unknown>>(
    `SELECT source_ref, site_name, technology, status, energy_source,
            export_capacity_mva, import_capacity_mva, lat, lng, source_date
       FROM ecr_record
      WHERE lat BETWEEN $1 AND $2
        AND lng BETWEEN $3 AND $4
        AND export_capacity_mva >= $5
        ${dnoId ? "AND dno_id = $6" : ""}`,
    dnoId
      ? [lat - dLat, lat + dLat, lng - dLng, lng + dLng, minExportMva, dnoId]
      : [lat - dLat, lat + dLat, lng - dLng, lng + dLng, minExportMva],
  );

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  const entries: EcrEntry[] = rows
    .map((r) => ({
      sourceRef: (r.source_ref as string) ?? null,
      siteName: (r.site_name as string) ?? null,
      // Falls back to the raw energy_source so a row whose technology did not
      // normalise still says what the register called it.
      technology: (r.technology as string) ?? (r.energy_source as string) ?? null,
      status: (r.status as EcrEntry["status"]) ?? "unknown",
      exportMva: num(r.export_capacity_mva),
      importMva: num(r.import_capacity_mva),
      lat: num(r.lat),
      lng: num(r.lng),
      distanceM: distanceTo(r, lat, lng),
      sourceDate: r.source_date ? new Date(r.source_date as string).toISOString().slice(0, 10) : null,
    }))
    .filter((e) => e.distanceM !== null && e.distanceM <= rules.ecr.radius_m)
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));

  if (!entries.length) {
    const [count] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ecr_record`);
    return {
      summary: summariseEcr([]),
      state: Number(count?.n ?? 0) > 0 ? "not_found_coverage_complete" : "not_found_coverage_unknown",
    };
  }

  return { summary: summariseEcr(entries), state: "present" };
}

/* --------------------------------------------------------------- profile --- */

export interface GridProfile {
  dno: DnoMatch;
  substations: SubstationLookup;
  ecr: EcrSummary;
  ecrState: ResultState;
  screens: Screen[];
  /** Brief §5.4 step 4. Fixed, and on every output. */
  caveat: string;
  networkVsSite: string;
  /** Rule blocks still awaiting sign-off. */
  wordingUnapproved: string[];
}

export interface GridInputs {
  /** Proposed PV export in MVA. Absent leaves pv_export unrated. */
  proposedExportMva?: number | null;
  /** Estimated added load in MVA. Absent leaves electrification unrated. */
  addedLoadMva?: number | null;
  now?: Date;
}

export async function gridProfile(
  lat: number,
  lng: number,
  inputs: GridInputs = {},
): Promise<GridProfile> {
  const now = inputs.now ?? new Date();
  const dno = await dnoForPoint(lat, lng);
  const substations = await substationsForSite(lat, lng, dno.dnoId, now);
  const { summary, state: ecrState } = await ecrNearSite(lat, lng, dno.dnoId);

  // The screens compare against the best headroom among the substations
  // returned. Best, not nearest: the question is whether the network nearby can
  // absorb the load at all, and the DNO decides the point of connection.
  const best = substations.substations.reduce<{ gen: number | null; dem: number | null }>(
    (acc, s) => ({
      gen: max(acc.gen, s.generationHeadroomMva),
      dem: max(acc.dem, s.demandHeadroomMva),
    }),
    { gen: null, dem: null },
  );

  const sourceDate =
    substations.substations.find((s) => s.freshness.basis === "published")?.freshness.asOf ??
    substations.substations[0]?.freshness.asOf ??
    null;

  const { unapprovedGridRules } = await import("./grid-screen");

  return {
    dno,
    substations,
    ecr: summary,
    ecrState,
    screens: [
      screen("pv_export", best.gen, inputs.proposedExportMva ?? null),
      screen("electrification", best.dem, inputs.addedLoadMva ?? null),
    ],
    caveat: fixedCaveat(
      substations.substations[0]?.dnoName ?? dno.areaName,
      sourceDate,
    ),
    networkVsSite: networkVsSiteNote(),
    wordingUnapproved: unapprovedGridRules(),
  };
}

function max(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
