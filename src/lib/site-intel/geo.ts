/**
 * Geometry helpers for site resolution.
 *
 * Deliberately dependency-free and deterministic, per the brief's rule that
 * every derived value comes from deterministic code. Accurate enough for
 * screening at building scale; anything needing survey-grade accuracy belongs
 * in PostGIS once the OS bulk loads land.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Ring = [number, number][];

/** Outer rings of a Polygon or MultiPolygon, as [lon, lat] pairs. */
function outerRings(geometry: GeoJSON.Geometry): Ring[] {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.length ? [geometry.coordinates[0] as Ring] : [];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .filter((poly) => poly.length > 0)
      .map((poly) => poly[0] as Ring);
  }
  return [];
}

/** Inner rings (holes), flattened. */
function holes(geometry: GeoJSON.Geometry): Ring[] {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.slice(1) as Ring[];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap((poly) => poly.slice(1) as Ring[]);
  }
  return [];
}

/** Spherical excess area of one ring, in m². Sign follows winding order. */
function ringAreaM2(ring: Ring): number {
  if (ring.length < 4) return 0;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    total += (lon2 - lon1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return (total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2;
}

/** Polygon area in m², holes subtracted. Returns null for non-areal geometry. */
export function areaM2(geometry: GeoJSON.Geometry | null): number | null {
  if (!geometry) return null;
  const outers = outerRings(geometry);
  if (!outers.length) return null;
  const gross = outers.reduce((sum, ring) => sum + Math.abs(ringAreaM2(ring)), 0);
  const inner = holes(geometry).reduce((sum, ring) => sum + Math.abs(ringAreaM2(ring)), 0);
  return Math.max(0, Math.round(gross - inner));
}

/** Ray casting against one ring. Coordinates are [lon, lat]. */
function inRing(point: LatLon, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True if the point falls inside the polygon and outside all its holes. */
export function pointInPolygon(point: LatLon, geometry: GeoJSON.Geometry | null): boolean {
  if (!geometry) return false;
  const hit = outerRings(geometry).some((ring) => inRing(point, ring));
  if (!hit) return false;
  return !holes(geometry).some((ring) => inRing(point, ring));
}

function coordPair([lon, lat]: [number, number]): string {
  return `${lon} ${lat}`;
}

function ringWkt(ring: Ring): string {
  return `(${ring.map(coordPair).join(", ")})`;
}

/** GeoJSON geometry to WKT, as planning.data's `geometry` parameter expects. */
export function toWkt(geometry: GeoJSON.Geometry): string {
  switch (geometry.type) {
    case "Point": {
      const [lon, lat] = geometry.coordinates as [number, number];
      return `POINT(${lon} ${lat})`;
    }
    case "Polygon": {
      const rings = (geometry.coordinates as Ring[]).map(ringWkt).join(", ");
      return `POLYGON(${rings})`;
    }
    case "MultiPolygon": {
      const polys = (geometry.coordinates as Ring[][])
        .map((poly) => `(${poly.map(ringWkt).join(", ")})`)
        .join(", ");
      return `MULTIPOLYGON(${polys})`;
    }
    default:
      throw new Error(`toWkt: unsupported geometry type ${geometry.type}`);
  }
}

/** Axis-aligned bounds as [west, south, east, north]. */
export function bounds(
  geometry: GeoJSON.Geometry | null,
): [number, number, number, number] | null {
  if (!geometry) return null;
  const rings = [...outerRings(geometry), ...holes(geometry)];
  if (!rings.length) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

/**
 * A square bounding box of `metres` half-width around a point, as a Polygon.
 * Used to ask a source for anything near a click before filtering by true
 * great-circle distance.
 */
export function boxAround(point: LatLon, metres: number): GeoJSON.Polygon {
  const dLat = (metres / EARTH_RADIUS_M) / DEG;
  const dLon = dLat / Math.max(0.01, Math.cos(point.lat * DEG));
  const west = point.lon - dLon;
  const east = point.lon + dLon;
  const south = point.lat - dLat;
  const north = point.lat + dLat;
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** UK postcode, normalised to uppercase with a single space. Null if invalid. */
export function normalisePostcode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  // Outward code is 2-4 chars, inward is always digit + two letters.
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** Extracts a postcode from a free-text address, if one is present. */
export function extractPostcode(address: string): string | null {
  const match = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})/i.exec(address);
  return match ? normalisePostcode(`${match[1]}${match[2]}`) : null;
}

/**
 * Expands a geometry's bounding box by `metres` and returns it as a Polygon.
 *
 * This is a bounding-box buffer, not a true geometric buffer: at the corners it
 * reaches further than `metres`, so it OVER-captures. That is the safe
 * direction for a screening tool - flagging something just outside the radius
 * as nearby costs a reviewer a moment, missing one does not surface at all.
 * Results from it are reported as `proximity`, never as `present`.
 */
export function bufferBounds(
  geometry: GeoJSON.Geometry,
  metres: number,
): GeoJSON.Polygon | null {
  const box = bounds(geometry);
  if (!box) return null;
  const [west, south, east, north] = box;

  const dLat = metres / EARTH_RADIUS_M / DEG;
  const midLat = (south + north) / 2;
  const dLon = dLat / Math.max(0.01, Math.cos(midLat * DEG));

  const w = west - dLon;
  const e = east + dLon;
  const s = south - dLat;
  const n = north + dLat;

  return {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}
