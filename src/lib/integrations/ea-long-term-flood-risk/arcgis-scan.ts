import { arcgisPointQuery, attr, type ArcGisQueryResponse } from "../_shared/arcgis";
import { fetchJson, IntegrationHttpError, type OperationContext } from "../framework";

/**
 * Scans a list of ArcGIS map/feature services at a point: reads each
 * service's layer list (`{service}?f=json`) unless layer ids are given, runs a
 * point (or point-with-distance) query on every leaf layer, and returns one
 * row per layer. Errors are reported per layer rather than thrown, because
 * some service names in the calling connectors are best guesses; the caller
 * decides whether an all-failed scan should throw.
 */

export type Scenario = "present day" | "future (climate change)" | "historic" | "reference";

export interface ServiceSpec {
  /** Stable key used for env overrides and rows. */
  id: string;
  /** Path relative to the base, e.g. `FloodMapForPlanningRiversAndSeaFloodZone3/MapServer`. */
  service: string;
  label: string;
  scenario: Scenario;
  /** True when the service path was confirmed from a public source; false for a best guess. */
  confirmed: boolean;
  /** Known layer ids (skips discovery) with optional display names. */
  layers?: { id: number; name: string }[];
  /** Attribute names that carry the headline band/zone/class for this service. */
  bandFields?: string[];
  /** Query distance in metres (0 = intersects the point). */
  distanceMeters?: number;
  /** Cap on discovered layers to query. */
  maxLayers?: number;
}

export interface ScanRow extends Record<string, unknown> {
  layer_group: string;
  layer: string;
  scenario: Scenario;
  hit: boolean | null;
  risk_band: string | null;
  feature_count: number;
  attributes: string | null;
  status: "hit" | "no feature" | "error" | "skipped";
  message: string | null;
  confirmed_service: boolean;
  layer_url: string;
}

interface ServiceInfo {
  layers?: { id: number; name: string; subLayerIds?: number[] | null; type?: string }[];
  error?: { code: number; message: string };
}

const DEFAULT_BAND_FIELDS = ["prob_4band", "risk_band", "riskband", "risk", "flood_zone", "floodzone", "zone", "likelihood", "band", "class", "category", "suitability", "type", "layer", "name", "label", "spz", "spz_zone", "designation", "aquifer", "classification", "class_name", "erosion_risk", "prob_4b", "probability"];

function summariseAttributes(a: Record<string, unknown>, max = 12): string {
  const skip = /^(objectid|shape|shape_area|shape_length|shape__area|shape__length|globalid|fid|st_area|st_length)/i;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (skip.test(k) || v === null || v === undefined || v === "") continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    if (parts.length >= max) break;
  }
  return parts.join("; ");
}

export function bandOf(a: Record<string, unknown>, fields?: string[]): string | null {
  const v = attr(a, ...(fields ?? []), ...DEFAULT_BAND_FIELDS);
  return v === null ? null : String(v);
}

export async function listLeafLayers(ctx: OperationContext, serviceUrl: string, max: number): Promise<{ id: number; name: string }[]> {
  const { data } = await fetchJson<ServiceInfo>(ctx, `${serviceUrl}?f=json`, {}, { timeoutMs: 15_000 });
  if (data?.error) throw new IntegrationHttpError(`ArcGIS error ${data.error.code}: ${data.error.message}`, 200, serviceUrl, JSON.stringify(data.error));
  const layers = (data?.layers ?? []).filter((l) => !(Array.isArray(l.subLayerIds) && l.subLayerIds.length) && (l.type === undefined || /feature/i.test(l.type)));
  return layers.slice(0, max).map((l) => ({ id: l.id, name: l.name }));
}

export interface ScanOptions {
  latitude: number;
  longitude: number;
  /** Overrides the per-service distance. */
  distanceMeters?: number;
  /** Optional override map of service id -> service path (from env). */
  overrides?: Record<string, string>;
}

export async function scanServices(ctx: OperationContext, base: string, services: ServiceSpec[], opts: ScanOptions): Promise<{ rows: ScanRow[]; raw: Record<string, unknown>; errors: number }> {
  const rows: ScanRow[] = [];
  const raw: Record<string, unknown> = {};
  let errors = 0;
  const root = base.replace(/\/$/, "");
  for (const spec of services) {
    const path = opts.overrides?.[spec.id] ?? spec.service;
    const serviceUrl = /^https?:/i.test(path) ? path : `${root}/${path.replace(/^\//, "")}`;
    let layers = spec.layers;
    if (!layers) {
      try {
        layers = await listLeafLayers(ctx, serviceUrl, spec.maxLayers ?? 8);
      } catch (e) {
        errors += 1;
        rows.push({ layer_group: spec.label, layer: "(service)", scenario: spec.scenario, hit: null, risk_band: null, feature_count: 0, attributes: null, status: "error", message: e instanceof Error ? e.message : String(e), confirmed_service: spec.confirmed, layer_url: serviceUrl });
        continue;
      }
      if (!layers.length) {
        rows.push({ layer_group: spec.label, layer: "(service)", scenario: spec.scenario, hit: null, risk_band: null, feature_count: 0, attributes: null, status: "skipped", message: "service lists no queryable layers", confirmed_service: spec.confirmed, layer_url: serviceUrl });
        continue;
      }
    }
    for (const layer of layers) {
      const layerUrl = `${serviceUrl}/${layer.id}`;
      const distance = opts.distanceMeters ?? spec.distanceMeters ?? 0;
      let res: ArcGisQueryResponse;
      try {
        res = await arcgisPointQuery(ctx, layerUrl, { latitude: opts.latitude, longitude: opts.longitude, distanceMeters: distance, resultRecordCount: 25 });
      } catch (e) {
        errors += 1;
        rows.push({ layer_group: spec.label, layer: layer.name, scenario: spec.scenario, hit: null, risk_band: null, feature_count: 0, attributes: null, status: "error", message: e instanceof Error ? e.message : String(e), confirmed_service: spec.confirmed, layer_url: layerUrl });
        continue;
      }
      const features = res.features ?? [];
      raw[`${spec.id}/${layer.id}`] = features.map((f) => f.attributes);
      if (!features.length) {
        rows.push({ layer_group: spec.label, layer: layer.name, scenario: spec.scenario, hit: false, risk_band: null, feature_count: 0, attributes: null, status: "no feature", message: null, confirmed_service: spec.confirmed, layer_url: layerUrl });
        continue;
      }
      const bands = Array.from(new Set(features.map((f) => bandOf(f.attributes, spec.bandFields)).filter((b): b is string => b !== null)));
      rows.push({
        layer_group: spec.label,
        layer: layer.name,
        scenario: spec.scenario,
        hit: true,
        risk_band: bands.length ? bands.join(" | ") : null,
        feature_count: features.length,
        attributes: summariseAttributes(features[0].attributes),
        status: "hit",
        message: features.length > 1 ? `${features.length} features; first shown` : null,
        confirmed_service: spec.confirmed,
        layer_url: layerUrl,
      });
    }
  }
  return { rows, raw, errors };
}

export const SCAN_COLUMNS = ["layer_group", "layer", "scenario", "hit", "risk_band", "feature_count", "attributes", "status", "message", "confirmed_service", "layer_url"];

/** Parses an optional JSON env var mapping service ids to paths/URLs. */
export function parseOverrides(json: string | undefined): Record<string, string> {
  if (!json?.trim()) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string") as [string, string][]);
  } catch {
    return {};
  }
}

/** Plain-English digest grouped by scenario; layer names are shown only for multi-layer services. */
export function digest(rows: ScanRow[]): string {
  const perGroup = new Map<string, number>();
  for (const r of rows) perGroup.set(r.layer_group, (perGroup.get(r.layer_group) ?? 0) + 1);
  const groups = new Map<Scenario, { hits: string[]; checked: number }>();
  for (const r of rows) {
    const g = groups.get(r.scenario) ?? { hits: [], checked: 0 };
    if (r.status === "hit" || r.status === "no feature") g.checked += 1;
    if (r.status === "hit") {
      const multi = (perGroup.get(r.layer_group) ?? 1) > 1 && r.layer !== "(service)";
      g.hits.push(`${r.layer_group}${multi ? ` / ${r.layer}` : ""}: ${r.risk_band ?? "within"}`);
    }
    groups.set(r.scenario, g);
  }
  const parts: string[] = [];
  for (const [scenario, g] of groups) {
    if (!g.checked) continue;
    parts.push(`${scenario[0].toUpperCase()}${scenario.slice(1)}: ${g.hits.length ? g.hits.join("; ") : `no features at the point (${g.checked} layers checked)`}`);
  }
  return parts.join(". ");
}
