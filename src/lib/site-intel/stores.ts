import { query } from "@/lib/db";
import { boxAround, bounds, distanceM, type LatLon } from "./geo";
import type { PostcodeStore, UprnPoint, UprnStore } from "./resolve";
import type { FootprintStore } from "./profile";

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
