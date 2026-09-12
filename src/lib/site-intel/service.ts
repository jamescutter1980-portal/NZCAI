import { query } from "@/lib/db";
import { applyStaleness } from "./sources";
import { buildProfile, applyOverride, withStoredOverrides, type ProfileDeps } from "./profile";
import { resolve, type ResolveDeps, type ResolveInput, type ResolveResult } from "./resolve";
import { footprintStore, postcodeStore, uprnStore } from "./stores";
import { epcAddressRegister } from "./epc";
import { buildingIdFor, type Candidate, type SiteProfile, type SourceRecord } from "./types";
import { areaM2, type LatLon } from "./geo";
import { screenConstraints, type ConstraintScreening } from "./constraints";
import { eaFloodCheck, noFloodCheck } from "./flood";

/**
 * Service layer. `getProfile` is the single entry point skills, reports and the
 * MCP tool call (brief section 7).
 *
 * The EPC register (Task 0) is wired in when EPC_API_EMAIL and EPC_API_KEY are
 * set, which makes step (a) of the resolution chain reachable - an address can
 * then resolve at `exact`, and the resulting profile carries a street address
 * that lifts the ownership and VOA matches out of postcode-only. Without the
 * credentials the chain still runs and says so through match_confidence.
 */

export interface ResolveOptions {
  /** Google geocoding, if a server key is configured. Coordinates never stored. */
  allowGeocode?: boolean;
}

async function deps(options: ResolveOptions = {}): Promise<ResolveDeps> {
  const base: ResolveDeps = { uprns: uprnStore, postcodes: postcodeStore };

  // Task 0. With the register wired in, step (a) of the chain is reachable and
  // an address can resolve at `exact` instead of falling through to a geocode.
  if (process.env.EPC_API_KEY && process.env.EPC_API_EMAIL) {
    base.register = epcAddressRegister();
  }

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

  // Steps (b) to (e) of the chain resolve a UPRN without ever seeing a street
  // address - OS Open UPRN carries coordinates, not addresses. Where the
  // register holds a certificate for this UPRN, take the address from it, so a
  // site resolved by map click or UPRN lookup still reaches the ownership and
  // VOA matchers with something to compare.
  if (!profile.address && profile.uprn && profile.postcode) {
    const epc = await epcFor(profile);
    const forThisUprn = epc.certificates.find((c) => c.uprn === profile.uprn);
    if (forThisUprn?.address) {
      profile.address = forThisUprn.address;
      profile.sources.push(certificateLineage(forThisUprn));
    }
  }

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
  const candidate = resolved.candidates[0];
  const fresh = await profileForCandidate(candidate);
  const profile = candidate.uprn
    ? withStoredOverrides(fresh, await loadProfile(buildingIdFor(candidate.uprn)))
    : fresh;
  return { profile, candidates: resolved.candidates, step: resolved.step };
}

interface ProfileRow {
  id: number;
  building_id: string | null;
  uprn: string | null;
  lat: number | null;
  lng: number | null;
  postcode: string | null;
  address: string | null;
  country: string | null;
  lpa_code: string | null;
  lpa_name: string | null;
  title_extents: SiteProfile["titleExtents"];
  footprint: GeoJSON.Geometry | null;
  footprint_method: SiteProfile["footprint"]["method"] | null;
  footprint_area_m2: string | null;
  footprint_original: GeoJSON.Geometry | null;
  footprint_original_method: SiteProfile["footprint"]["method"] | null;
  footprint_overridden_at: string | Date | null;
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
    address: row.address,
    country: row.country,
    lpaCode: row.lpa_code,
    lpaName: row.lpa_name,
    titleExtents: row.title_extents ?? [],
    footprint: {
      geometry: row.footprint,
      areaM2: row.footprint_area_m2 === null ? null : Number(row.footprint_area_m2),
      method: row.footprint_method ?? "unavailable",
    },
    footprintOriginal: row.footprint_original
      ? {
          geometry: row.footprint_original,
          areaM2: areaM2(row.footprint_original),
          method: row.footprint_original_method ?? "unavailable",
          overriddenAt: row.footprint_overridden_at
            ? new Date(row.footprint_overridden_at).toISOString()
            : new Date(0).toISOString(),
        }
      : null,
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
       (building_id, uprn, lat, lng, postcode, address, country, lpa_code, lpa_name,
        title_extents, footprint, footprint_method, footprint_area_m2,
        footprint_original, footprint_original_method, footprint_overridden_at,
        match_confidence, user_confirmed, flags, states, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,
             $14::jsonb,$15,$16,$17,$18,$19,$20::jsonb, now())
     ON CONFLICT (building_id) DO UPDATE SET
       uprn = EXCLUDED.uprn, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       postcode = EXCLUDED.postcode, address = EXCLUDED.address,
       country = EXCLUDED.country,
       lpa_code = EXCLUDED.lpa_code, lpa_name = EXCLUDED.lpa_name,
       title_extents = EXCLUDED.title_extents, footprint = EXCLUDED.footprint,
       footprint_method = EXCLUDED.footprint_method,
       footprint_area_m2 = EXCLUDED.footprint_area_m2,
       footprint_original = EXCLUDED.footprint_original,
       footprint_original_method = EXCLUDED.footprint_original_method,
       footprint_overridden_at = EXCLUDED.footprint_overridden_at,
       match_confidence = EXCLUDED.match_confidence,
       user_confirmed = EXCLUDED.user_confirmed, flags = EXCLUDED.flags,
       states = EXCLUDED.states, updated_at = now()
     RETURNING id`,
    [
      buildingId, profile.uprn, profile.lat, profile.lon, profile.postcode,
      profile.address, profile.country, profile.lpaCode, profile.lpaName,
      JSON.stringify(profile.titleExtents),
      profile.footprint.geometry ? JSON.stringify(profile.footprint.geometry) : null,
      profile.footprint.method, profile.footprint.areaM2,
      profile.footprintOriginal?.geometry
        ? JSON.stringify(profile.footprintOriginal.geometry)
        : null,
      profile.footprintOriginal?.method ?? null,
      profile.footprintOriginal?.overriddenAt ?? null,
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
  override: {
    confirmed?: boolean;
    footprint?: GeoJSON.Geometry;
    point?: LatLon;
    revertFootprint?: boolean;
  },
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
  // The street address comes from the EPC register (Task 0) where credentials
  // are set. Without one this stays null, and the match reports honestly that
  // there was no address to compare rather than claiming a 0% comparison.
  const ownership = buildOwnershipResult(
    { address: profile.address, postcode: profile.postcode },
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

/* -------------------------------------------------------------- S-06 VOA --- */

import {
  buildVoaResult,
  compareAreas,
  inferUseClass,
  voaAreaEstimates,
  type AreaComparison,
  type AreaEstimate,
  type UseClassInference,
  type VoaResult,
} from "./voa";
import { assessmentsInPostcode } from "./stores";

export interface VoaReport {
  voa: VoaResult;
  /** Use class inferred from the best candidate's valuation description. */
  useClass: UseClassInference | null;
  /** Every floor area available, with its basis, and how far they diverge. */
  areas: AreaComparison;
}

/**
 * VOA assessment, floor area and inferred use class for a resolved site.
 *
 * `storeys` lets the caller add the footprint x storeys estimate to the
 * comparison; without it that estimate is simply absent rather than assumed.
 * The EPC floor area would be a third input and arrives with Task 0.
 */
export async function voaFor(
  profile: SiteProfile,
  options: { storeys?: number; epcFloorAreaM2?: number } = {},
): Promise<VoaReport> {
  const assessments = profile.postcode
    ? await assessmentsInPostcode(profile.postcode)
    : [];

  // As with ownership, the address is whatever the register supplied; null
  // when there is none, so a postcode-only match says so rather than claiming
  // an address comparison it never made.
  const voa = buildVoaResult({ address: profile.address, postcode: profile.postcode }, assessments);

  const estimates: AreaEstimate[] = [...voaAreaEstimates(voa)];

  if (profile.footprint.areaM2 && options.storeys && options.storeys > 0) {
    estimates.push({
      areaM2: Math.round(profile.footprint.areaM2 * options.storeys),
      basis: "GEA",
      source: `Footprint ${profile.footprint.areaM2} m² × ${options.storeys} storeys`,
      // Inherits the footprint's own tier: a drawn footprint is an override.
      tier: profile.footprint.method === "user_drawn" ? "T4" : "T3",
    });
  }

  // Prefer an explicitly supplied figure; otherwise take it from the register.
  // The EPC is the only floor area here that comes from a measured assessment
  // rather than a valuation or a footprint, which is why it is T1.
  let epcArea = options.epcFloorAreaM2;
  let epcSource = "EPC total floor area";
  if (!epcArea) {
    const epc = await epcFor(profile);
    if (epc.current?.floorAreaM2) {
      epcArea = epc.current.floorAreaM2;
      epcSource = `EPC total floor area (${epc.current.register}, ${epc.current.inspectionDate ?? "date unknown"})`;
    }
  }

  if (epcArea && epcArea > 0) {
    estimates.push({
      areaM2: epcArea,
      basis: "GIA",
      source: epcSource,
      tier: "T1",
    });
  }

  return {
    voa,
    useClass: inferUseClass(voa.candidates[0]?.assessment.primaryDescription),
    areas: compareAreas(estimates),
  };
}

/* ------------------------------------------------------ Task 0: EPC data --- */

import {
  certificatesByPostcode,
  certificateLineage,
  currentCertificate,
  type EpcCertificate,
  type EpcLookup,
} from "./epc";
import { cachedCertificates, storeCertificates } from "./stores";
import { ttlDays } from "./sources";

export interface EpcReport {
  certificates: EpcCertificate[];
  /** The one that best describes the building: newest non-domestic if any. */
  current: EpcCertificate | null;
  unavailable: string | null;
  /** True when served from the local cache rather than the live register. */
  fromCache: boolean;
}

/**
 * Certificates for a site's postcode, cached for the source's TTL.
 *
 * The cache returns null when nothing has been stored, which is distinct from
 * an empty list meaning "looked, and this postcode has none" - so a cold cache
 * triggers a fetch and a genuinely empty postcode does not.
 */
export async function epcFor(profile: SiteProfile): Promise<EpcReport> {
  if (!profile.postcode) {
    return { certificates: [], current: null, unavailable: null, fromCache: false };
  }

  const ttl = ttlDays("epc-register") ?? 30;
  const cached = await cachedCertificates(profile.postcode, ttl);
  if (cached) {
    return {
      certificates: cached,
      current: currentCertificate(cached),
      unavailable: null,
      fromCache: true,
    };
  }

  const lookup: EpcLookup = await certificatesByPostcode(profile.postcode);
  if (lookup.certificates.length) await storeCertificates(lookup.certificates);

  return {
    certificates: lookup.certificates,
    current: currentCertificate(lookup.certificates),
    unavailable: lookup.unavailable,
    fromCache: false,
  };
}

/** Lineage for whichever certificate is being relied on. */
export function epcLineage(certificate: EpcCertificate) {
  return certificateLineage(certificate);
}

/* ------------------------------------------ S-05: building performance --- */

import { screenMees, type AreaInput, type MeesScreening } from "./mees";
import { certificateAge, intensity, readRating, type CertificateAge, type Intensity, type RatingReading } from "./performance";

export interface PerformanceReport {
  /** The certificate screened: newest non-domestic where one exists. */
  certificate: EpcCertificate | null;
  rating: RatingReading | null;
  age: CertificateAge | null;
  intensity: Intensity | null;
  mees: MeesScreening;
  /** Every certificate in the postcode, so a wrong pick is visible. */
  considered: number;
  unavailable: string | null;
  fromCache: boolean;
}

/**
 * Performance and MEES screening for a resolved site.
 *
 * The floor area for the 1,000 m² test is taken from the EPC unless a better
 * one is passed in. A VOA area is a different measurement on a stated basis
 * (S-06), so where one is supplied its basis travels with it into the result
 * rather than being silently substituted.
 */
export async function performanceFor(
  profile: SiteProfile,
  options: { area?: AreaInput; now?: Date } = {},
): Promise<PerformanceReport> {
  const epc = await epcFor(profile);

  // Prefer the certificate carrying this building's UPRN over the newest in
  // the postcode: the postcode pick is a lead, the UPRN pick is the building.
  const forThisUprn = profile.uprn
    ? epc.certificates.find((c) => c.uprn === profile.uprn) ?? null
    : null;
  const certificate = forThisUprn ?? epc.current;

  return {
    certificate,
    rating: certificate ? readRating(certificate) : null,
    age: certificate ? certificateAge(certificate, options.now) : null,
    intensity: certificate ? intensity(certificate) : null,
    mees: screenMees(certificate, {
      area: options.area,
      unavailable: epc.unavailable,
      now: options.now,
    }),
    considered: epc.certificates.length,
    unavailable: epc.unavailable,
    fromCache: epc.fromCache,
  };
}
