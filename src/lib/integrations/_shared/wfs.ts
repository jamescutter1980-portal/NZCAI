import { fetchText, IntegrationHttpError, type OperationContext } from "../framework";

/**
 * Minimal OGC WFS 2.0 GetFeature helper for GeoServer-style endpoints
 * (DataMapWales, NatureScot, SEPA). Builds the GET URL, requests GeoJSON and
 * parses it, promoting an `ows:ExceptionReport` to IntegrationHttpError.
 *
 * Spatial filtering is done with the WFS `bbox` parameter carrying the
 * EPSG:4326 URN (lat,lon axis order in WFS 2.0), which the server reprojects
 * to the layer's native CRS. That avoids two things that bite with
 * `CQL_FILTER=DWITHIN(...)`: the geometry column name (geom / the_geom /
 * msGeometry varies by layer) and the CRS of the literal (interpreted in the
 * layer's native CRS, so a WGS84 POINT against an EPSG:27700 layer is wrong).
 * Callers post-filter by `distanceToGeometryM` when they need a true radius.
 * A `cqlFilter` option is still available for attribute filters.
 */

export interface WfsGetFeatureOptions {
  typeName: string;
  /** [minLon, minLat, maxLon, maxLat] in WGS84. */
  bbox?: [number, number, number, number];
  cqlFilter?: string;
  count?: number;
  startIndex?: number;
  /** Output CRS; GeoJSON coordinates are always lon,lat. */
  srsName?: string;
  outputFormat?: string;
  timeoutMs?: number;
}

export type GeoJsonGeometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "MultiPoint" | "LineString"; coordinates: number[][] }
  | { type: "MultiLineString" | "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "GeometryCollection"; geometries: GeoJsonGeometry[] };

export interface GeoJsonFeature<P = Record<string, unknown>> {
  type?: string;
  id?: string | number;
  geometry: GeoJsonGeometry | null;
  properties: P;
}

export interface GeoJsonCollection<P = Record<string, unknown>> {
  type: string;
  features: GeoJsonFeature<P>[];
  totalFeatures?: number | string;
  numberMatched?: number | string;
  numberReturned?: number;
  crs?: unknown;
}

/** Appends query parameters without disturbing the service path. */
export function wfsUrl(base: string, query: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function wfsGetFeatureUrl(base: string, opts: WfsGetFeatureOptions): string {
  const bbox = opts.bbox ? `${opts.bbox[1].toFixed(6)},${opts.bbox[0].toFixed(6)},${opts.bbox[3].toFixed(6)},${opts.bbox[2].toFixed(6)},urn:ogc:def:crs:EPSG::4326` : undefined;
  return wfsUrl(base, {
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: opts.typeName,
    outputFormat: opts.outputFormat ?? "application/json",
    srsName: opts.srsName ?? "EPSG:4326",
    count: opts.count ?? 100,
    startIndex: opts.startIndex,
    bbox,
    CQL_FILTER: opts.cqlFilter,
  });
}

export function wfsCapabilitiesUrl(base: string): string {
  return wfsUrl(base, { service: "WFS", version: "2.0.0", request: "GetCapabilities" });
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** WGS84 bbox [minLon, minLat, maxLon, maxLat] enclosing a circle of `radiusM` around the point. */
export function bboxAround(latitude: number, longitude: number, radiusM: number): [number, number, number, number] {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.max(Math.cos((latitude * Math.PI) / 180), 1e-6);
  const dLon = dLat / cos;
  return [longitude - dLon, latitude - dLat, longitude + dLon, latitude + dLat];
}

/** Ray-casting point in ring test on lon/lat coordinates. */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
  for (const hole of rings.slice(1)) if (pointInRing(lon, lat, hole)) return false;
  return true;
}

/**
 * Approximate distance from a point to a geometry in metres: 0 when the point
 * lies inside a polygon, otherwise the distance to the nearest vertex (an
 * upper bound on the true distance; fine for screening radii of tens of
 * metres or more). Returns null for empty geometry.
 */
export function distanceToGeometryM(latitude: number, longitude: number, geometry: GeoJsonGeometry | null | undefined): number | null {
  if (!geometry) return null;
  let best: number | null = null;
  const consider = (coord: number[]) => {
    if (coord.length < 2) return;
    const d = haversineM(latitude, longitude, coord[1], coord[0]);
    if (best === null || d < best) best = d;
  };
  switch (geometry.type) {
    case "Point":
      consider(geometry.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(consider);
      break;
    case "MultiLineString":
      geometry.coordinates.forEach((line) => line.forEach(consider));
      break;
    case "Polygon":
      if (pointInPolygon(longitude, latitude, geometry.coordinates)) return 0;
      geometry.coordinates.forEach((ring) => ring.forEach(consider));
      break;
    case "MultiPolygon":
      for (const poly of geometry.coordinates) if (pointInPolygon(longitude, latitude, poly)) return 0;
      geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(consider)));
      break;
    case "GeometryCollection":
      for (const g of geometry.geometries) {
        const d = distanceToGeometryM(latitude, longitude, g);
        if (d !== null && (best === null || d < best)) best = d;
      }
      break;
  }
  return best === null ? null : Math.round(best);
}

/** Extracts the text of an OWS ExceptionReport, or null when the body is not one. */
export function wfsException(text: string): string | null {
  if (!/ExceptionReport|ServiceException/i.test(text)) return null;
  const m = /<(?:ows:)?ExceptionText[^>]*>([\s\S]*?)<\/(?:ows:)?ExceptionText>/i.exec(text) ?? /<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/i.exec(text);
  const body = m ? m[1] : text;
  return body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Parses a GeoJSON FeatureCollection body; throws IntegrationHttpError for an exception report or non-JSON. */
export function parseGeoJson<P = Record<string, unknown>>(text: string, url: string, status = 200): GeoJsonCollection<P> {
  const body = text.trim();
  const exception = wfsException(body);
  if (exception) throw new IntegrationHttpError(`WFS exception: ${exception}`, status, url, body.slice(0, 1000));
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new IntegrationHttpError(`Non-JSON WFS response from ${new URL(url).host}`, status, url, body.slice(0, 1000));
  }
  const d = (data ?? {}) as Partial<GeoJsonCollection<P>>;
  return { type: d.type ?? "FeatureCollection", features: Array.isArray(d.features) ? d.features : [], totalFeatures: d.totalFeatures, numberMatched: d.numberMatched, numberReturned: d.numberReturned, crs: d.crs };
}

/** GetFeature as GeoJSON. HTTP 400 bodies are parsed for the exception text; other non-2xx throw. */
export async function wfsGetFeature<P = Record<string, unknown>>(ctx: OperationContext, base: string, opts: WfsGetFeatureOptions): Promise<{ url: string; collection: GeoJsonCollection<P> }> {
  const url = wfsGetFeatureUrl(base, opts);
  const { text, status } = await fetchText(ctx, url, { headers: { accept: "application/json, */*" } }, { timeoutMs: opts.timeoutMs ?? 25_000, acceptStatuses: [400] });
  return { url, collection: parseGeoJson<P>(text, url, status) };
}
