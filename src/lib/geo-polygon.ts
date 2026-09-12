/**
 * Point-in-polygon over GeoJSON, without PostGIS.
 *
 * Brief §5.1 wants the DNO decided by containment against the NESO licence-area
 * boundaries. PostGIS is optional in this build (migration 004), and there are
 * roughly fourteen licence areas, so a ray cast here is both fast enough and
 * one fewer deployment requirement.
 *
 * A leaf module: no imports, no I/O, so the map component can use it too.
 *
 * COORDINATE ORDER. GeoJSON positions are [longitude, latitude]. Every UK
 * latitude (~50-61) is also a plausible longitude, so a transposed pair does
 * not throw - it silently answers about a point in the North Sea. Arguments
 * here are named lat/lng and converted once, at the boundary.
 */

export type Position = [number, number];
export type LinearRing = Position[];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: LinearRing[];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: LinearRing[][];
}

export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Crossing-number test for one ring.
 *
 * The half-open rule on the y comparison - one bound strict, the other not -
 * is what stops a vertex being counted twice when the ray passes exactly
 * through it. Points on the boundary itself are not defined either way, which
 * for a licence-area lookup is immaterial.
 */
function inRing(lng: number, lat: number, ring: LinearRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat) {
      const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * A GeoJSON Polygon is an outer ring followed by holes. A point inside a hole
 * is outside the polygon - relevant here because a licence area can enclose
 * another (an IDNO's area, say), and reporting the wrong DNO is worse than
 * reporting none.
 */
function inPolygon(lng: number, lat: number, rings: LinearRing[]): boolean {
  if (!rings.length || !inRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lng, lat, rings[i])) return false;
  }
  return true;
}

export function contains(geometry: AreaGeometry, lat: number, lng: number): boolean {
  if (geometry.type === "Polygon") return inPolygon(lng, lat, geometry.coordinates);
  return geometry.coordinates.some((rings) => inPolygon(lng, lat, rings));
}

/** Bounding box of a geometry, for a cheap rejection before the ray cast. */
export function bboxOf(geometry: AreaGeometry): Bbox {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;

  const walk = (ring: LinearRing): void => {
    for (const [lng, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  };

  if (geometry.type === "Polygon") geometry.coordinates.forEach(walk);
  else geometry.coordinates.forEach((rings) => rings.forEach(walk));

  return { minLat, maxLat, minLng, maxLng };
}

export function inBbox(bbox: Bbox, lat: number, lng: number): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

/** Narrows unknown JSON to a geometry this module can test. */
export function asAreaGeometry(value: unknown): AreaGeometry | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(g.coordinates)) return null;
  if (g.type === "Polygon" || g.type === "MultiPolygon") return g as AreaGeometry;
  return null;
}

/* ------------------------------------------------------------- distance --- */

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversineM(
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Latitude/longitude deltas for a radius, for a bounding-box prefilter.
 *
 * The longitude delta widens with latitude. Using the flat 1 deg = 111.32 km
 * everywhere - as the S-07 grid join does - makes the box too NARROW in
 * longitude at UK latitudes and quietly drops candidates near its edges. Here
 * the box must not lose anything, because the haversine that follows does the
 * real filtering.
 */
export function bboxForRadius(
  lat: number,
  radiusM: number,
): { dLat: number; dLng: number } {
  const dLat = radiusM / 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Guard the poles, where the longitude delta diverges.
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.abs(cos)));
  return { dLat, dLng };
}
