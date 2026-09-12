import { buildUrl, fetchJson, IntegrationHttpError, type OperationContext } from "../framework";

/**
 * Minimal helpers for ArcGIS REST FeatureServer / MapServer layer queries.
 *
 * Reference: https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/
 * A layer URL looks like `{service}/FeatureServer/{layerId}`; queries go to `{layer}/query`.
 * ArcGIS returns HTTP 200 with an `error` object for most failures, so we
 * promote that to IntegrationHttpError ourselves.
 */

export interface ArcGisFeature<A = Record<string, unknown>> {
  attributes: A;
  geometry?: unknown;
}

export interface ArcGisQueryResponse<A = Record<string, unknown>> {
  features?: ArcGisFeature<A>[];
  fields?: { name: string; type: string; alias?: string }[];
  exceededTransferLimit?: boolean;
  count?: number;
  error?: { code: number; message: string; details?: string[] };
}

export interface ArcGisPointQueryOptions {
  latitude: number;
  longitude: number;
  /** Search radius in metres around the point (0 = intersects the point only). */
  distanceMeters?: number;
  outFields?: string;
  where?: string;
  returnGeometry?: boolean;
  /** Cap on features returned; ArcGIS Online caps at the layer's maxRecordCount (often 1000-2000). */
  resultRecordCount?: number;
  timeoutMs?: number;
}

/** Builds `{layer}/query?...` for a point-with-distance search in WGS84. */
export function arcgisPointQueryUrl(layerUrl: string, opts: ArcGisPointQueryOptions): string {
  const distance = opts.distanceMeters ?? 0;
  return buildUrl(layerUrl.replace(/\/$/, ""), "query", {
    geometry: `${opts.longitude},${opts.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    distance: distance > 0 ? distance : undefined,
    units: distance > 0 ? "esriSRUnit_Meter" : undefined,
    spatialRel: "esriSpatialRelIntersects",
    where: opts.where ?? "1=1",
    outFields: opts.outFields ?? "*",
    returnGeometry: opts.returnGeometry ?? false,
    resultRecordCount: opts.resultRecordCount ?? 200,
    f: "json",
  });
}

/** Builds `{layer}/query?where=...` for an attribute search. */
export function arcgisWhereQueryUrl(layerUrl: string, where: string, opts: { outFields?: string; returnGeometry?: boolean; resultRecordCount?: number } = {}): string {
  return buildUrl(layerUrl.replace(/\/$/, ""), "query", {
    where,
    outFields: opts.outFields ?? "*",
    returnGeometry: opts.returnGeometry ?? false,
    resultRecordCount: opts.resultRecordCount ?? 200,
    f: "json",
  });
}

/** GET a prebuilt ArcGIS query URL and surface ArcGIS-level errors as IntegrationHttpError. */
export async function arcgisQuery<A = Record<string, unknown>>(ctx: OperationContext, url: string, timeoutMs = 20_000): Promise<ArcGisQueryResponse<A>> {
  const { data, status } = await fetchJson<ArcGisQueryResponse<A>>(ctx, url, {}, { timeoutMs });
  if (data && typeof data === "object" && data.error) {
    throw new IntegrationHttpError(`ArcGIS error ${data.error.code}: ${data.error.message}`, status, url, JSON.stringify(data.error).slice(0, 1000));
  }
  return data;
}

/** Point/distance query in one call. */
export async function arcgisPointQuery<A = Record<string, unknown>>(ctx: OperationContext, layerUrl: string, opts: ArcGisPointQueryOptions): Promise<ArcGisQueryResponse<A>> {
  return arcgisQuery<A>(ctx, arcgisPointQueryUrl(layerUrl, opts), opts.timeoutMs);
}

/** Quote a string for an ArcGIS SQL `where` clause. */
export function arcgisQuote(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/** ArcGIS date fields are epoch milliseconds; return YYYY-MM-DD or null. */
export function arcgisDate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Case-insensitive attribute lookup (ArcGIS field casing varies between services). */
export function attr(attributes: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map(Object.keys(attributes).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase());
    if (key !== undefined && attributes[key] !== undefined && attributes[key] !== null && attributes[key] !== "") return attributes[key];
  }
  return null;
}
