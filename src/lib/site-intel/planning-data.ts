/**
 * Client for planning.data.gov.uk.
 *
 * Docs: https://www.planning.data.gov.uk/docs
 *   /entity.geojson  - entities as a GeoJSON FeatureCollection
 *   /dataset.json    - the dataset catalogue, used to validate configured slugs
 *
 * `fetchImpl` is injectable so tests run against recorded fixtures with no
 * network, per the brief ("No live network calls in CI").
 */

/**
 * Overridable so the app can be pointed at a recorded-fixture server for
 * contract testing and offline demos, without touching call sites.
 */
const BASE = process.env.PLANNING_DATA_BASE ?? "https://www.planning.data.gov.uk";
const USER_AGENT = "NZC-AI/0.1 (site intelligence)";

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const defaultFetch: FetchLike = (url) =>
  fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });

export interface PlanningEntity {
  entity: number;
  dataset: string;
  reference: string | null;
  name: string | null;
  geometry: GeoJSON.Geometry | null;
  /** Publisher's entry-date, used as sourceUpdated in lineage. */
  entryDate: string | null;
  properties: Record<string, unknown>;
}

export interface EntityQuery {
  datasets: string[];
  limit?: number;
  offset?: number;
}

export interface PointQuery extends EntityQuery {
  lat: number;
  lon: number;
}

export interface GeometryQuery extends EntityQuery {
  /** WKT, as planning.data expects. */
  wkt: string;
  relation?: "intersects" | "within" | "contains";
}

function buildUrl(path: string, params: [string, string][]): string {
  const search = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${BASE}${path}?${search}`;
}

function datasetParams(q: EntityQuery): [string, string][] {
  // `dataset` is repeatable rather than comma-separated.
  const params: [string, string][] = q.datasets.map((d) => ["dataset", d]);
  params.push(["limit", String(q.limit ?? 50)]);
  if (q.offset) params.push(["offset", String(q.offset)]);
  return params;
}

interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJSON.Geometry | null;
  properties: Record<string, unknown> | null;
}

function toEntity(feature: GeoJsonFeature): PlanningEntity {
  const props = feature.properties ?? {};
  const asString = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null;

  return {
    entity: Number(props.entity ?? 0),
    dataset: asString(props.dataset) ?? "",
    reference: asString(props.reference),
    name: asString(props.name),
    geometry: feature.geometry,
    // planning.data uses hyphenated keys.
    entryDate: asString(props["entry-date"]) ?? asString(props.entryDate),
    properties: props,
  };
}

async function getFeatures(url: string, fetchImpl: FetchLike): Promise<PlanningEntity[]> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`planning.data ${res.status} for ${url}${body ? ` - ${body.slice(0, 160)}` : ""}`);
  }
  const payload = (await res.json()) as { features?: GeoJsonFeature[] };
  return (payload.features ?? []).map(toEntity);
}

/** Entities whose geometry contains, or is near, a point. */
export function entitiesByPoint(
  query: PointQuery,
  fetchImpl: FetchLike = defaultFetch,
): Promise<PlanningEntity[]> {
  const url = buildUrl("/entity.geojson", [
    ["longitude", String(query.lon)],
    ["latitude", String(query.lat)],
    ...datasetParams(query),
  ]);
  return getFeatures(url, fetchImpl);
}

/** Entities intersecting an arbitrary geometry - used for footprint queries. */
export function entitiesByGeometry(
  query: GeometryQuery,
  fetchImpl: FetchLike = defaultFetch,
): Promise<PlanningEntity[]> {
  const url = buildUrl("/entity.geojson", [
    ["geometry", query.wkt],
    ["geometry_relation", query.relation ?? "intersects"],
    ...datasetParams(query),
  ]);
  return getFeatures(url, fetchImpl);
}

/**
 * Dataset catalogue. Brief section 4.1: resolve slugs at startup and fail
 * loudly if one is missing, rather than silently skipping a constraint.
 */
export async function listDatasets(fetchImpl: FetchLike = defaultFetch): Promise<string[]> {
  const res = await fetchImpl(`${BASE}/dataset.json`);
  if (!res.ok) throw new Error(`planning.data dataset.json returned ${res.status}`);
  const payload = (await res.json()) as { datasets?: { dataset?: string }[] };
  return (payload.datasets ?? [])
    .map((d) => d.dataset)
    .filter((d): d is string => typeof d === "string");
}

export interface SlugCheck {
  missing: string[];
  present: string[];
}

export async function checkSlugs(
  wanted: string[],
  fetchImpl: FetchLike = defaultFetch,
): Promise<SlugCheck> {
  const available = new Set(await listDatasets(fetchImpl));
  return {
    present: wanted.filter((slug) => available.has(slug)),
    missing: wanted.filter((slug) => !available.has(slug)),
  };
}
