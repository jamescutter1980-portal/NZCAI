import { query } from "@/lib/db";
import { applyStaleness } from "./sources";
import { buildProfile, applyOverride, type ProfileDeps } from "./profile";
import { resolve, type ResolveDeps, type ResolveInput, type ResolveResult } from "./resolve";
import { footprintStore, postcodeStore, uprnStore } from "./stores";
import type { Candidate, SiteProfile, SourceRecord } from "./types";
import type { LatLon } from "./geo";
import { screenConstraints, type ConstraintScreening } from "./constraints";
import { eaFloodCheck, noFloodCheck } from "./flood";

/**
 * Service layer. `getProfile` is the single entry point skills, reports and the
 * MCP tool call (brief section 7).
 *
 * There is deliberately no address-register dependency wired in: the EPC
 * retrieval module does not exist yet (Task 0), so the `exact` branch of the
 * chain is unreachable and every address resolves at `probable` or worse. That
 * is visible in the result rather than hidden - match_confidence says so.
 */

export interface ResolveOptions {
  /** Google geocoding, if a server key is configured. Coordinates never stored. */
  allowGeocode?: boolean;
}

async function deps(options: ResolveOptions = {}): Promise<ResolveDeps> {
  const base: ResolveDeps = { uprns: uprnStore, postcodes: postcodeStore };

  if (options.allowGeocode && process.env.GOOGLE_MAPS_SERVER_KEY) {
    base.geocoder = {
      async geocode(address: string): Promise<LatLon | null> {
        const url =
          "https://maps.googleapis.com/maps/api/geocode/json" +
          `?address=${encodeURIComponent(address)}&region=uk` +
          `&key=${encodeURIComponent(process.env.GOOGLE_MAPS_SERVER_KEY as string)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const body = (await res.json()) as {
          results?: { geometry?: { location?: { lat: number; lng: number } } }[];
        };
        const loc = body.results?.[0]?.geometry?.location;
        // Used ONLY to find candidate UPRNs nearby. This coordinate is
        // discarded and never reaches the database - brief section 3.1.
        return loc ? { lat: loc.lat, lon: loc.lng } : null;
      },
    };
  }

  return base;
}

export async function resolveCandidates(
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  return resolve(input, await deps(options));
}

export async function profileForCandidate(candidate: Candidate): Promise<SiteProfile> {
  const profileDeps: ProfileDeps = { footprints: await footprintStore() };
  const profile = await buildProfile(candidate, profileDeps);
  profile.sources = profile.sources.map((s) => applyStaleness(s));
  return profile;
}

/**
 * Screens a profile for planning and environmental constraints.
 *
 * The EA flood cross-check is on by default and off when EA_FLOOD_DISABLED is
 * set - useful where the service is unreachable, since an unreachable EA is
 * reported as unconfirmed rather than as an absence of risk either way.
 */
export async function constraintsFor(profile: SiteProfile): Promise<ConstraintScreening> {
  return screenConstraints(profile, {
    flood: process.env.EA_FLOOD_DISABLED ? noFloodCheck : eaFloodCheck(),
  });
}

/** Resolve then profile in one step, taking the best candidate. */
export async function getProfile(
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<{ profile: SiteProfile | null; candidates: Candidate[]; step: string; reason?: string }> {
  const resolved = await resolveCandidates(input, options);
  if (!resolved.candidates.length) {
    return { profile: null, candidates: [], step: resolved.step, reason: resolved.reason };
  }
  const profile = await profileForCandidate(resolved.candidates[0]);
  return { profile, candidates: resolved.candidates, step: resolved.step };
}

interface ProfileRow {
  id: number;
  building_id: string | null;
  uprn: string | null;
  lat: number | null;
  lng: number | null;
  postcode: string | null;
  country: string | null;
  lpa_code: string | null;
  lpa_name: string | null;
  title_extents: SiteProfile["titleExtents"];
  footprint: GeoJSON.Geometry | null;
  footprint_method: SiteProfile["footprint"]["method"] | null;
  footprint_area_m2: string | null;
  match_confidence: SiteProfile["matchConfidence"];
  user_confirmed: boolean;
  flags: string[];
  states: SiteProfile["states"];
}

function rowToProfile(row: ProfileRow, sources: SourceRecord[]): SiteProfile {
  return {
    uprn: row.uprn,
    lat: row.lat,
    lon: row.lng,
    postcode: row.postcode,
    country: row.country,
    lpaCode: row.lpa_code,
    lpaName: row.lpa_name,
    titleExtents: row.title_extents ?? [],
    footprint: {
      geometry: row.footprint,
      areaM2: row.footprint_area_m2 === null ? null : Number(row.footprint_area_m2),
      method: row.footprint_method ?? "unavailable",
    },
    matchConfidence: row.match_confidence,
    userConfirmed: row.user_confirmed,
    flags: row.flags ?? [],
    states: row.states ?? {},
    sources,
  };
}

/** Upserts the profile and replaces its lineage rows. */
export async function saveProfile(
  buildingId: string,
  profile: SiteProfile,
): Promise<number> {
  const [row] = await query<{ id: number }>(
    `INSERT INTO site_profile
       (building_id, uprn, lat, lng, postcode, country, lpa_code, lpa_name,
        title_extents, footprint, footprint_method, footprint_area_m2,
        match_confidence, user_confirmed, flags, states, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb, now())
     ON CONFLICT (building_id) DO UPDATE SET
       uprn = EXCLUDED.uprn, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       postcode = EXCLUDED.postcode, country = EXCLUDED.country,
       lpa_code = EXCLUDED.lpa_code, lpa_name = EXCLUDED.lpa_name,
       title_extents = EXCLUDED.title_extents, footprint = EXCLUDED.footprint,
       footprint_method = EXCLUDED.footprint_method,
       footprint_area_m2 = EXCLUDED.footprint_area_m2,
       match_confidence = EXCLUDED.match_confidence,
       user_confirmed = EXCLUDED.user_confirmed, flags = EXCLUDED.flags,
       states = EXCLUDED.states, updated_at = now()
     RETURNING id`,
    [
      buildingId, profile.uprn, profile.lat, profile.lon, profile.postcode,
      profile.country, profile.lpaCode, profile.lpaName,
      JSON.stringify(profile.titleExtents),
      profile.footprint.geometry ? JSON.stringify(profile.footprint.geometry) : null,
      profile.footprint.method, profile.footprint.areaM2,
      profile.matchConfidence, profile.userConfirmed, profile.flags,
      JSON.stringify(profile.states),
    ],
  );

  await query("DELETE FROM site_profile_source WHERE site_profile_id = $1", [row.id]);
  for (const source of profile.sources) {
    await query(
      `INSERT INTO site_profile_source
         (site_profile_id, source_id, dataset, entity_ref, licence, attribution,
          retrieved_at, source_updated, method, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.id, source.sourceId, source.dataset, source.entityRef, source.licence,
        source.attribution, source.retrievedAt, source.sourceUpdated,
        source.method, source.tier,
      ],
    );
  }
  return row.id;
}

export async function loadProfile(buildingId: string): Promise<SiteProfile | null> {
  const rows = await query<ProfileRow & Record<string, unknown>>(
    "SELECT * FROM site_profile WHERE building_id = $1",
    [buildingId],
  );
  if (!rows.length) return null;

  const sources = await query<Record<string, unknown>>(
    `SELECT source_id, dataset, entity_ref, licence, attribution,
            retrieved_at, source_updated, method, tier
       FROM site_profile_source WHERE site_profile_id = $1 ORDER BY id`,
    [rows[0].id],
  );

  return rowToProfile(
    rows[0],
    sources.map((s) => ({
      sourceId: String(s.source_id),
      dataset: String(s.dataset),
      entityRef: (s.entity_ref as string) ?? null,
      licence: String(s.licence),
      attribution: String(s.attribution),
      retrievedAt: new Date(s.retrieved_at as string).toISOString(),
      sourceUpdated: s.source_updated ? new Date(s.source_updated as string).toISOString() : null,
      method: String(s.method),
      tier: s.tier as SourceRecord["tier"],
    })),
  );
}

/** PATCH .../override - a confirmed pin or a redrawn footprint. */
export async function overrideProfile(
  buildingId: string,
  override: { confirmed?: boolean; footprint?: GeoJSON.Geometry; point?: LatLon },
): Promise<SiteProfile | null> {
  const existing = await loadProfile(buildingId);
  if (!existing) return null;
  const updated = applyOverride(existing, override);
  await saveProfile(buildingId, updated);
  return updated;
}

/* ------------------------------------------------------- S-04 ownership --- */

import { buildOwnershipResult, distinctProprietors, type OwnershipResult } from "./ownership";
import { getCompany, normaliseCompanyNumber, type CompanyRecord } from "./companies-house";
import { titlesForCompany, titlesInPostcode } from "./stores";

export interface OwnershipReport {
  ownership: OwnershipResult;
  /** Companies House records, keyed by normalised company number. */
  companies: Record<string, CompanyRecord>;
  /** Set when Companies House could not be consulted at all. */
  companiesUnavailable: string | null;
}

/**
 * Ownership for a resolved site.
 *
 * The match is by address within a postcode, because open polygon data has no
 * title number - see the header of ownership.ts. Every candidate is a lead to
 * verify, and `inferredFromAddress` is always true.
 */
export async function ownershipFor(
  profile: SiteProfile,
  options: { enrich?: boolean } = {},
): Promise<OwnershipReport> {
  if (!profile.postcode) {
    return {
      ownership: buildOwnershipResult({ address: null, postcode: null }, []),
      companies: {},
      companiesUnavailable: null,
    };
  }

  const titles = await titlesInPostcode(profile.postcode);
  // Pass address: null rather than the postcode. A SiteProfile carries no
  // free-text address today - that arrives with the EPC register (Task 0) -
  // and feeding the postcode in as an address produces "tokens agree 0%",
  // which claims a comparison that never happened. Null makes the match
  // report honestly that there was no address to compare.
  const ownership = buildOwnershipResult(
    { address: null, postcode: profile.postcode },
    titles,
  );

  if (options.enrich === false) {
    return { ownership, companies: {}, companiesUnavailable: null };
  }

  const companies: Record<string, CompanyRecord> = {};
  let unavailable: string | null = null;

  for (const proprietor of distinctProprietors(ownership)) {
    const number = normaliseCompanyNumber(proprietor.companyNumber);
    if (!number || companies[number]) continue;
    const record = await getCompany(number);
    companies[number] = record;
    if (!record.profile && record.unavailable && !unavailable) {
      unavailable = record.unavailable;
    }
  }

  return { ownership, companies, companiesUnavailable: unavailable };
}

/** Everything a company owns, for the portfolio question. */
export async function portfolioFor(companyNumber: string) {
  const number = normaliseCompanyNumber(companyNumber);
  if (!number) return { companyNumber: null, titles: [], company: null };
  const [titles, company] = await Promise.all([
    titlesForCompany(number),
    getCompany(number),
  ]);
  return { companyNumber: number, titles, company };
}
