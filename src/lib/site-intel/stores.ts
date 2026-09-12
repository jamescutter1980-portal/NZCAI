import { query } from "@/lib/db";
import { boxAround, bounds, distanceM, type LatLon } from "./geo";
import type { PostcodeStore, UprnPoint, UprnStore } from "./resolve";
import type { FootprintStore } from "./profile";
import type { CorporateTitle, Proprietor } from "./ownership";
import type { SurveyLine, VoaAssessment } from "./voa";
import type { EpcCertificate, EpcRegister, UprnSource } from "./epc";

/**
 * Postgres-backed stores for the resolution chain.
 *
 * Proximity uses a bounding-box prefilter on the (lat, lng) index and then an
 * exact great-circle filter in application code. That keeps the whole of S-01
 * working on plain Postgres; PostGIS would let the database do both, and this
 * is the natural place to swap once migration 004 has added the geography
 * column on a cluster that has the extension.
 */

interface UprnRow {
  uprn: string;
  lat: number;
  lng: number;
  postcode: string | null;
}

function toPoint(row: UprnRow): UprnPoint {
  return { uprn: row.uprn, lat: row.lat, lon: row.lng, postcode: row.postcode };
}

export const uprnStore: UprnStore = {
  async byUprn(uprn) {
    const rows = await query<UprnRow & Record<string, unknown>>(
      "SELECT uprn, lat, lng, postcode FROM os_uprn WHERE uprn = $1",
      [uprn.trim()],
    );
    return rows.length ? toPoint(rows[0]) : null;
  },

  async near(point, radiusM, limit) {
    const box = bounds(boxAround(point, radiusM));
    if (!box) return [];
    const [west, south, east, north] = box;

    const rows = await query<UprnRow & Record<string, unknown>>(
      `SELECT uprn, lat, lng, postcode
         FROM os_uprn
        WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
        LIMIT $5`,
      [south, north, west, east, Math.max(limit * 4, 50)],
    );

    // The box is a superset of the circle; cut it to the true radius here.
    return rows
      .map(toPoint)
      .map((p) => ({ p, d: distanceM(point, { lat: p.lat, lon: p.lon }) }))
      .filter(({ d }) => d <= radiusM)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ p }) => p);
  },

  async byPostcode(postcode) {
    const rows = await query<UprnRow & Record<string, unknown>>(
      "SELECT uprn, lat, lng, postcode FROM os_uprn WHERE postcode = $1 ORDER BY uprn LIMIT 250",
      [postcode.toUpperCase()],
    );
    return rows.map(toPoint);
  },
};

export const postcodeStore: PostcodeStore = {
  async centroid(postcode) {
    const rows = await query<{ lat: number; lng: number }>(
      "SELECT lat, lng FROM postcode_centroid WHERE postcode = $1",
      [postcode.toUpperCase()],
    );
    return rows.length ? { lat: rows[0].lat, lon: rows[0].lng } : null;
  },
};

/**
 * Building footprints from OS OpenMap Local. Genuinely needs PostGIS - polygon
 * containment and intersection are not things to hand-roll over a whole
 * national dataset - so this returns null until the extension and the bulk
 * load are both in place, and the profile reports `unavailable` rather than
 * inventing a footprint.
 */
export async function footprintStore(): Promise<FootprintStore | undefined> {
  const rows = await query<{ ready: boolean }>(
    `SELECT (to_regclass('public.os_building') IS NOT NULL
             AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')) AS ready`,
  );
  if (!rows[0]?.ready) return undefined;

  return {
    async containing(point: LatLon) {
      const found = await query<{ geom: string }>(
        `SELECT ST_AsGeoJSON(geom) AS geom
           FROM os_building
          WHERE ST_Contains(geom::geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
          LIMIT 1`,
        [point.lon, point.lat],
      );
      return found.length ? (JSON.parse(found[0].geom) as GeoJSON.Geometry) : null;
    },

    async largestIntersecting(geometry: GeoJSON.Geometry) {
      const found = await query<{ geom: string }>(
        `SELECT ST_AsGeoJSON(geom) AS geom
           FROM os_building
          WHERE ST_Intersects(geom::geometry, ST_GeomFromGeoJSON($1))
          ORDER BY ST_Area(geom::geometry) DESC
          LIMIT 1`,
        [JSON.stringify(geometry)],
      );
      return found.length ? (JSON.parse(found[0].geom) as GeoJSON.Geometry) : null;
    },
  };
}

export async function referenceDataCounts(): Promise<{
  uprns: number;
  postcodes: number;
  profiles: number;
}> {
  const [row] = await query<{ uprns: string; postcodes: string; profiles: string }>(
    `SELECT (SELECT count(*) FROM os_uprn)::text AS uprns,
            (SELECT count(*) FROM postcode_centroid)::text AS postcodes,
            (SELECT count(*) FROM site_profile)::text AS profiles`,
  );
  return {
    uprns: Number(row.uprns),
    postcodes: Number(row.postcodes),
    profiles: Number(row.profiles),
  };
}

/* --------------------------------------------------------- S-04 titles --- */

interface TitleRow {
  title_number: string;
  dataset: "ccod" | "ocod";
  tenure: string | null;
  property_address: string | null;
  postcode: string | null;
  district: string | null;
  county: string | null;
  region: string | null;
  multiple_address: boolean;
  price_paid: string | null;
  proprietors: Proprietor[];
  date_proprietor_added: Date | string | null;
}

function toTitle(row: TitleRow): CorporateTitle {
  return {
    titleNumber: row.title_number,
    dataset: row.dataset,
    tenure: row.tenure,
    propertyAddress: row.property_address,
    postcode: row.postcode,
    district: row.district,
    county: row.county,
    region: row.region,
    multipleAddress: row.multiple_address,
    pricePaid: row.price_paid === null ? null : Number(row.price_paid),
    proprietors: row.proprietors ?? [],
    dateProprietorAdded: row.date_proprietor_added
      ? new Date(row.date_proprietor_added).toISOString().slice(0, 10)
      : null,
  };
}

/** Candidate titles for a postcode. The address scoring happens in ownership.ts. */
export async function titlesInPostcode(postcode: string): Promise<CorporateTitle[]> {
  const rows = await query<TitleRow & Record<string, unknown>>(
    `SELECT title_number, dataset, tenure, property_address, postcode, district,
            county, region, multiple_address, price_paid, proprietors,
            date_proprietor_added
       FROM corporate_title
      WHERE postcode = $1
      ORDER BY title_number
      LIMIT 200`,
    [postcode.toUpperCase()],
  );
  return rows.map(toTitle);
}

/** Everything a company owns - the portfolio question. */
export async function titlesForCompany(companyNumber: string): Promise<CorporateTitle[]> {
  const rows = await query<TitleRow & Record<string, unknown>>(
    `SELECT title_number, dataset, tenure, property_address, postcode, district,
            county, region, multiple_address, price_paid, proprietors,
            date_proprietor_added
       FROM corporate_title
      WHERE proprietors @> $1::jsonb
      ORDER BY postcode, title_number
      LIMIT 500`,
    [JSON.stringify([{ companyNumber: companyNumber.toUpperCase() }])],
  );
  return rows.map(toTitle);
}

export async function titleCounts(): Promise<{ ccod: number; ocod: number }> {
  const [row] = await query<{ ccod: string; ocod: string }>(
    `SELECT count(*) FILTER (WHERE dataset = 'ccod')::text AS ccod,
            count(*) FILTER (WHERE dataset = 'ocod')::text AS ocod
       FROM corporate_title`,
  );
  return { ccod: Number(row.ccod), ocod: Number(row.ocod) };
}

/* ------------------------------------------------------ S-06 VOA records --- */

/** Assessments in a postcode, with their survey lines. Matching is in voa.ts. */
export async function assessmentsInPostcode(postcode: string): Promise<VoaAssessment[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT a.uarn, a.billing_authority_code, a.billing_authority_reference,
            a.primary_description, a.scat_code, a.property_address, a.postcode,
            a.rateable_value, a.effective_date, a.list_year,
            COALESCE(
              json_agg(
                json_build_object(
                  'description', l.description,
                  'areaM2', l.area_m2,
                  'basis', l.basis,
                  'pricePerM2', l.price_per_m2,
                  'value', l.value
                ) ORDER BY l.line_no
              ) FILTER (WHERE l.id IS NOT NULL),
              '[]'
            ) AS survey_lines
       FROM voa_assessment a
       LEFT JOIN voa_survey_line l ON l.uarn = a.uarn
      WHERE a.postcode = $1
      GROUP BY a.uarn
      ORDER BY a.uarn
      LIMIT 100`,
    [postcode.toUpperCase()],
  );

  return rows.map((r) => ({
    uarn: String(r.uarn),
    billingAuthorityCode: (r.billing_authority_code as string) ?? null,
    billingAuthorityReference: (r.billing_authority_reference as string) ?? null,
    primaryDescription: (r.primary_description as string) ?? null,
    scatCode: (r.scat_code as string) ?? null,
    propertyAddress: (r.property_address as string) ?? null,
    postcode: (r.postcode as string) ?? null,
    rateableValue: r.rateable_value === null ? null : Number(r.rateable_value),
    effectiveDate: r.effective_date
      ? new Date(r.effective_date as string).toISOString().slice(0, 10)
      : null,
    listYear: r.list_year === null ? null : Number(r.list_year),
    surveyLines: (r.survey_lines as SurveyLine[]).map((l) => ({
      description: l.description ?? null,
      areaM2: l.areaM2 === null ? null : Number(l.areaM2),
      basis: l.basis ?? "unknown",
      pricePerM2: l.pricePerM2 === null ? null : Number(l.pricePerM2),
      value: l.value === null ? null : Number(l.value),
    })),
  }));
}

export async function voaCounts(): Promise<{ assessments: number; surveyLines: number }> {
  const [row] = await query<{ assessments: string; lines: string }>(
    `SELECT (SELECT count(*) FROM voa_assessment)::text AS assessments,
            (SELECT count(*) FROM voa_survey_line)::text AS lines`,
  );
  return { assessments: Number(row.assessments), surveyLines: Number(row.lines) };
}

/* ---------------------------------------------------- Task 0: EPC cache --- */

/**
 * Cached certificates for a postcode, if any were retrieved within `ttlDays`.
 *
 * Returns null rather than an empty array when nothing is cached, so "we have
 * looked and this postcode has no certificates" stays distinct from "we have
 * not looked yet".
 */
export async function cachedCertificates(
  postcode: string,
  ttlDays: number,
): Promise<EpcCertificate[] | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT lmk_key, register, address, postcode, uprn, uprn_source, rating,
            asset_rating, floor_area_m2, inspection_date, lodgement_date,
            property_type, building_reference
       FROM epc_certificate
      WHERE postcode = $1
        AND retrieved_at > now() - ($2 || ' days')::interval`,
    [postcode.toUpperCase(), String(ttlDays)],
  );
  if (!rows.length) return null;

  const date = (v: unknown): string | null =>
    v ? new Date(v as string).toISOString().slice(0, 10) : null;

  return rows.map((r) => ({
    lmkKey: String(r.lmk_key),
    register: r.register as EpcRegister,
    address: (r.address as string) ?? "",
    postcode: (r.postcode as string) ?? null,
    uprn: (r.uprn as string) ?? null,
    uprnSource: r.uprn_source as UprnSource,
    rating: (r.rating as string) ?? null,
    assetRating: r.asset_rating === null ? null : Number(r.asset_rating),
    floorAreaM2: r.floor_area_m2 === null ? null : Number(r.floor_area_m2),
    inspectionDate: date(r.inspection_date),
    lodgementDate: date(r.lodgement_date),
    propertyType: (r.property_type as string) ?? null,
    buildingReference: (r.building_reference as string) ?? null,
  }));
}

export async function storeCertificates(certificates: EpcCertificate[]): Promise<void> {
  for (const c of certificates) {
    await query(
      `INSERT INTO epc_certificate
         (lmk_key, register, address, postcode, uprn, uprn_source, rating,
          asset_rating, floor_area_m2, inspection_date, lodgement_date,
          property_type, building_reference, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (lmk_key) DO UPDATE SET
         address = EXCLUDED.address, postcode = EXCLUDED.postcode,
         uprn = EXCLUDED.uprn, uprn_source = EXCLUDED.uprn_source,
         rating = EXCLUDED.rating, asset_rating = EXCLUDED.asset_rating,
         floor_area_m2 = EXCLUDED.floor_area_m2,
         inspection_date = EXCLUDED.inspection_date,
         lodgement_date = EXCLUDED.lodgement_date,
         property_type = EXCLUDED.property_type,
         building_reference = EXCLUDED.building_reference,
         retrieved_at = now()`,
      [
        c.lmkKey, c.register, c.address, c.postcode, c.uprn, c.uprnSource,
        c.rating, c.assetRating, c.floorAreaM2, c.inspectionDate,
        c.lodgementDate, c.propertyType, c.buildingReference,
      ],
    );
  }
}

export async function epcCounts(): Promise<{ certificates: number; withUprn: number }> {
  const [row] = await query<{ total: string; with_uprn: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE uprn IS NOT NULL)::text AS with_uprn
       FROM epc_certificate`,
  );
  return { certificates: Number(row.total), withUprn: Number(row.with_uprn) };
}
