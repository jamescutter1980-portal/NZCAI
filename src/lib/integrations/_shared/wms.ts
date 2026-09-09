import { buildUrl, fetchText, IntegrationHttpError, type OperationContext } from "../framework";

/**
 * OGC WMS 1.3.0 GetFeatureInfo point query, for map services that expose no
 * feature API (BGS geology, Coal Authority). Builds a small bbox around the
 * point in CRS:84 (lon/lat, so no 1.3.0 axis-order ambiguity), asks for a
 * 101x101 image and the pixel at its centre (I=J=50), and parses whatever the
 * server returns: GeoJSON/Esri JSON, ArcGIS text/plain, HTML tables, or a
 * ServiceException. ArcGIS Server WMS endpoints differ by version in which
 * INFO_FORMAT values they accept, so `wmsFeatureInfo` tries several in turn.
 */

export interface WmsFeatureInfoOptions {
  layers: string[];
  latitude: number;
  longitude: number;
  /** Half-width of the query bbox in degrees of longitude (default 0.0005, ~35 m). */
  halfWidthDeg?: number;
  width?: number;
  height?: number;
  infoFormat?: string;
  featureCount?: number;
  timeoutMs?: number;
}

export interface WmsFeature {
  layer: string | null;
  properties: Record<string, unknown>;
}

export interface WmsFeatureInfoResult {
  url: string;
  infoFormat: string;
  format: "json" | "text" | "html" | "xml" | "empty";
  features: WmsFeature[];
  raw: string;
}

export const WMS_INFO_FORMATS = ["application/json", "text/plain", "text/html"];

export function wmsFeatureInfoUrl(base: string, opts: WmsFeatureInfoOptions): string {
  const w = opts.width ?? 101;
  const h = opts.height ?? 101;
  const dx = opts.halfWidthDeg ?? 0.0005;
  const dy = dx * Math.cos((opts.latitude * Math.PI) / 180);
  const bbox = [opts.longitude - dx, opts.latitude - dy, opts.longitude + dx, opts.latitude + dy].map((v) => v.toFixed(7)).join(",");
  const layers = opts.layers.join(",");
  return buildUrl(base, "", {
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetFeatureInfo",
    LAYERS: layers,
    QUERY_LAYERS: layers,
    STYLES: "",
    CRS: "CRS:84",
    BBOX: bbox,
    WIDTH: w,
    HEIGHT: h,
    I: Math.floor(w / 2),
    J: Math.floor(h / 2),
    FORMAT: "image/png",
    INFO_FORMAT: opts.infoFormat ?? "application/json",
    FEATURE_COUNT: opts.featureCount ?? 10,
  });
}

export function wmsCapabilitiesUrl(base: string): string {
  return buildUrl(base, "", { SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetCapabilities" });
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Extracts a ServiceException message if the body is one, else null. */
export function wmsServiceException(text: string): string | null {
  const m = /<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/i.exec(text);
  return m ? stripTags(m[1]) : null;
}

function parseJsonFeatures(text: string): WmsFeature[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { features?: unknown[]; results?: unknown[] };
  const list = Array.isArray(d.features) ? d.features : Array.isArray(d.results) ? d.results : null;
  if (!list) return null;
  return list.map((f) => {
    const o = (f ?? {}) as { properties?: Record<string, unknown>; attributes?: Record<string, unknown>; layerName?: string; layerId?: number };
    return { layer: o.layerName ?? (o.layerId !== undefined ? String(o.layerId) : null), properties: o.properties ?? o.attributes ?? {} };
  });
}

/**
 * ArcGIS text/plain looks like:
 *   Layer 'BGS.50k.Bedrock'
 *     Feature 1:
 *       LEX_D = 'LONDON CLAY FORMATION'
 * Lines of `KEY = value` are grouped per Feature (or per Layer when no Feature line).
 */
function parseTextFeatures(text: string): WmsFeature[] {
  const out: WmsFeature[] = [];
  let layer: string | null = null;
  let current: Record<string, unknown> | null = null;
  const flush = () => {
    if (current && Object.keys(current).length) out.push({ layer, properties: current });
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^Layer\s+['"]?(.+?)['"]?\s*:?$/i.exec(line);
    if (m) {
      flush();
      layer = m[1];
      continue;
    }
    if (/^Feature\s+\d+\s*:?$/i.test(line)) {
      flush();
      current = {};
      continue;
    }
    m = /^([A-Za-z0-9_.\- ]+?)\s*=\s*'?(.*?)'?$/.exec(line);
    if (m) {
      if (!current) current = {};
      current[m[1].trim()] = m[2];
    }
  }
  flush();
  return out;
}

/** HTML tables: a header row (th) followed by feature rows, or two-column key/value rows. */
function parseHtmlFeatures(text: string): WmsFeature[] {
  const out: WmsFeature[] = [];
  const tables = text.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((tr) => (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map(stripTags));
    if (!rows.length) continue;
    const headerIdx = rows.findIndex((r) => r.length > 1);
    if (headerIdx < 0) continue;
    const header = rows[headerIdx];
    const hasTh = /<th/i.test(table);
    if (hasTh && rows.length > headerIdx + 1 && rows[headerIdx + 1].length === header.length) {
      for (const r of rows.slice(headerIdx + 1)) {
        const props: Record<string, unknown> = {};
        header.forEach((h, i) => {
          if (h) props[h] = r[i] ?? "";
        });
        out.push({ layer: null, properties: props });
      }
    } else if (rows.every((r) => r.length === 2)) {
      const props: Record<string, unknown> = {};
      for (const r of rows) props[r[0]] = r[1];
      out.push({ layer: null, properties: props });
    }
  }
  return out;
}

export function parseFeatureInfo(text: string): Pick<WmsFeatureInfoResult, "format" | "features"> {
  const body = text.trim();
  if (!body) return { format: "empty", features: [] };
  const json = parseJsonFeatures(body);
  if (json) return { format: "json", features: json };
  if (/^<\?xml|^<ServiceExceptionReport|^<FeatureInfoResponse|^<[a-zA-Z]/.test(body) && /<html/i.test(body)) {
    return { format: "html", features: parseHtmlFeatures(body) };
  }
  if (/^<\?xml|^<ServiceExceptionReport/i.test(body)) return { format: "xml", features: [] };
  if (/<table/i.test(body)) return { format: "html", features: parseHtmlFeatures(body) };
  return { format: "text", features: parseTextFeatures(body) };
}

/**
 * GetFeatureInfo with INFO_FORMAT fallback. Throws IntegrationHttpError when
 * every format yields a ServiceException; returns an empty feature list when
 * the point simply has no feature.
 */
export async function wmsFeatureInfo(ctx: OperationContext, base: string, opts: WmsFeatureInfoOptions): Promise<WmsFeatureInfoResult> {
  const formats = opts.infoFormat ? [opts.infoFormat] : WMS_INFO_FORMATS;
  let lastException: { url: string; message: string } | null = null;
  for (const infoFormat of formats) {
    const url = wmsFeatureInfoUrl(base, { ...opts, infoFormat });
    const { text } = await fetchText(ctx, url, { headers: { accept: "*/*" } }, { timeoutMs: opts.timeoutMs ?? 20_000 });
    const exception = wmsServiceException(text);
    if (exception) {
      lastException = { url, message: exception };
      continue;
    }
    const parsed = parseFeatureInfo(text);
    return { url, infoFormat, raw: text.slice(0, 20_000), ...parsed };
  }
  throw new IntegrationHttpError(`WMS ServiceException: ${lastException?.message ?? "unknown"}`, 200, lastException?.url ?? base, lastException?.message ?? "");
}

export interface WmsLayerInfo {
  name: string;
  title: string;
  queryable: boolean;
}

/** Parses GetCapabilities XML for named layers (no XML library needed). */
export function parseCapabilitiesLayers(xml: string): WmsLayerInfo[] {
  const out: WmsLayerInfo[] = [];
  const re = /<Layer\b([^>]*)>([\s\S]*?)(?=<Layer\b|<\/Layer>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(body);
    if (!name) continue;
    const title = /<Title>([\s\S]*?)<\/Title>/.exec(body);
    out.push({ name: decodeEntities(name[1]), title: title ? decodeEntities(title[1]) : decodeEntities(name[1]), queryable: /queryable="1"/.test(attrs) });
  }
  return out;
}

export async function wmsQueryableLayers(ctx: OperationContext, base: string, timeoutMs = 20_000): Promise<WmsLayerInfo[]> {
  const { text } = await fetchText(ctx, wmsCapabilitiesUrl(base), { headers: { accept: "*/*" } }, { timeoutMs });
  const exception = wmsServiceException(text);
  if (exception) throw new IntegrationHttpError(`WMS ServiceException: ${exception}`, 200, wmsCapabilitiesUrl(base), exception);
  return parseCapabilitiesLayers(text).filter((l) => l.queryable);
}
