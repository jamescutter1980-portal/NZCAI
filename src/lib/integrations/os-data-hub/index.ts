import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext, type OperationResult } from "../framework";

/**
 * Ordnance Survey Data Hub: OS Names API (OpenData plan), OS Places API
 * (premium, outside the free allowance) and OS NGD API - Features (premium,
 * within the monthly allowance). All take the key as a `key` query parameter.
 * Built from OS docs and the OrdnanceSurvey/osdatahub-js and osdatahub (R)
 * clients; not exercised live from this codebase.
 */

export const NAMES_BASE = "https://api.os.uk/search/names/v1";
export const PLACES_BASE = "https://api.os.uk/search/places/v1";
export const NGD_BASE = "https://api.os.uk/features/ngd/ofa/v1";
const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";

function key(env: EnvLike): string {
  const k = env.OS_DATA_HUB_API_KEY?.trim();
  if (!k) throw new Error("OS_DATA_HUB_API_KEY is not set. Create a project at https://osdatahub.os.uk and add the API you need to it.");
  return k;
}

function spacedPostcode(pc: string): string {
  const s = pc.replace(/\s+/g, "").toUpperCase();
  return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s;
}

/* ---------- OS Names ---------- */

interface GazetteerEntry {
  ID: string;
  NAME1: string;
  NAME2?: string;
  TYPE: string;
  LOCAL_TYPE: string;
  GEOMETRY_X: number;
  GEOMETRY_Y: number;
  POSTCODE_DISTRICT?: string;
  POPULATED_PLACE?: string;
  DISTRICT_BOROUGH?: string;
  COUNTY_UNITARY?: string;
  REGION?: string;
  COUNTRY?: string;
}
interface NamesResponse {
  header: { totalresults: number; maxresults: number; offset: number };
  results?: { GAZETTEER_ENTRY: GazetteerEntry }[];
}
const NAMES_COLUMNS = ["name", "local_type", "type", "easting", "northing", "postcode_district", "populated_place", "district_borough", "county_unitary", "region", "country", "id"];

/* ---------- OS Places ---------- */

interface Dpa {
  UPRN: string;
  UDPRN?: string;
  ADDRESS: string;
  ORGANISATION_NAME?: string;
  BUILDING_NAME?: string;
  BUILDING_NUMBER?: string;
  THOROUGHFARE_NAME?: string;
  DEPENDENT_LOCALITY?: string;
  POST_TOWN?: string;
  POSTCODE?: string;
  X_COORDINATE?: number;
  Y_COORDINATE?: number;
  LNG?: number;
  LAT?: number;
  CLASSIFICATION_CODE?: string;
  CLASSIFICATION_CODE_DESCRIPTION?: string;
  LOCAL_CUSTODIAN_CODE_DESCRIPTION?: string;
  COUNTRY_CODE?: string;
  BLPU_STATE_CODE_DESCRIPTION?: string;
  TOPOGRAPHY_LAYER_TOID?: string;
  LOGICAL_STATUS_CODE?: string;
  MATCH?: number;
  MATCH_DESCRIPTION?: string;
}
interface Lpi {
  UPRN: string;
  ADDRESS: string;
  USRN?: string;
  LPI_KEY?: string;
  PAO_TEXT?: string;
  PAO_START_NUMBER?: string;
  STREET_DESCRIPTION?: string;
  TOWN_NAME?: string;
  POSTCODE_LOCATOR?: string;
  X_COORDINATE?: number;
  Y_COORDINATE?: number;
  LNG?: number;
  LAT?: number;
  CLASSIFICATION_CODE?: string;
  CLASSIFICATION_CODE_DESCRIPTION?: string;
  LOCAL_CUSTODIAN_CODE_DESCRIPTION?: string;
  COUNTRY_CODE?: string;
  BLPU_STATE_CODE_DESCRIPTION?: string;
  TOPOGRAPHY_LAYER_TOID?: string;
  LOGICAL_STATUS_CODE?: string;
  MATCH?: number;
  MATCH_DESCRIPTION?: string;
}
interface PlacesResponse {
  header: { totalresults: number; maxresults?: number; offset?: number; dataset?: string; epoch?: string; lastupdate?: string; output_srs?: string };
  results?: { DPA?: Dpa; LPI?: Lpi }[];
}
const PLACES_COLUMNS = ["dataset", "uprn", "address", "postcode", "post_town", "organisation", "classification_code", "classification", "blpu_state", "logical_status_code", "latitude", "longitude", "easting", "northing", "toid", "usrn", "custodian", "country_code", "match"];

function toPlacesRow(r: { DPA?: Dpa; LPI?: Lpi }) {
  const d = r.DPA;
  const l = r.LPI;
  const a = (d ?? l) as (Dpa & Lpi) | undefined;
  if (!a) return { dataset: null };
  const wgs = a.LNG !== undefined && a.LAT !== undefined;
  return {
    dataset: d ? "DPA" : "LPI",
    uprn: a.UPRN,
    address: a.ADDRESS,
    postcode: d?.POSTCODE ?? l?.POSTCODE_LOCATOR ?? null,
    post_town: d?.POST_TOWN ?? l?.TOWN_NAME ?? null,
    organisation: d?.ORGANISATION_NAME ?? null,
    classification_code: a.CLASSIFICATION_CODE ?? null,
    classification: a.CLASSIFICATION_CODE_DESCRIPTION ?? null,
    blpu_state: a.BLPU_STATE_CODE_DESCRIPTION ?? null,
    logical_status_code: a.LOGICAL_STATUS_CODE ?? null,
    latitude: wgs ? a.LAT : null,
    longitude: wgs ? a.LNG : null,
    easting: wgs ? null : (a.X_COORDINATE ?? null),
    northing: wgs ? null : (a.Y_COORDINATE ?? null),
    toid: a.TOPOGRAPHY_LAYER_TOID ?? null,
    usrn: l?.USRN ?? null,
    custodian: a.LOCAL_CUSTODIAN_CODE_DESCRIPTION ?? null,
    country_code: a.COUNTRY_CODE ?? null,
    match: a.MATCH ?? null,
  };
}

const DATASET_PARAM = {
  name: "dataset",
  label: "Address dataset",
  type: "select" as const,
  default: "DPA",
  options: [
    { value: "DPA", label: "DPA (Royal Mail deliverable addresses)" },
    { value: "LPI", label: "LPI (local authority land and property identifiers)" },
    { value: "DPA,LPI", label: "Both" },
  ],
  help: "LPI includes non-postal objects (car parks, substations, plots) and gives USRN and classification; DPA is the postal view.",
};

async function placesCall(ctx: OperationContext, path: string, query: Record<string, string | number | undefined>, dataset: string, label: string): Promise<OperationResult> {
  const url = buildUrl(PLACES_BASE, path, { ...query, dataset, output_srs: "WGS84", key: key(ctx.env) });
  const { data } = await fetchJson<PlacesResponse>(ctx, url, {}, { acceptStatuses: [404] });
  const rows = (data.results ?? []).map(toPlacesRow);
  const raw = { ...data, header: { ...data.header, uri: undefined } };
  const provenanceExtra = { dataset: "os-places", version: data.header?.epoch ? `epoch ${data.header.epoch}` : undefined };
  if (!rows.length) {
    return { summary: `No addresses found for ${label}.`, columns: PLACES_COLUMNS, rows: [], raw, provenance: makeProvenance(definition, ctx, { ...provenanceExtra, basis: "unavailable" }) };
  }
  return {
    summary: `${data.header?.totalresults ?? rows.length} address record${rows.length === 1 ? "" : "s"} for ${label}${rows.length < (data.header?.totalresults ?? 0) ? ` (showing ${rows.length})` : ""}.`,
    columns: PLACES_COLUMNS,
    rows,
    raw,
    provenance: makeProvenance(definition, ctx, { ...provenanceExtra, basis: "measured" }),
    warnings: [
      "OS Places API calls are chargeable and sit outside the £1,000 monthly free allowance. Coordinates are the address seed point (usually inside the footprint), not a centroid of the parcel.",
      "Coordinates were requested as WGS84 (output_srs=WGS84 gives LNG/LAT); if the service ignored the parameter the easting/northing columns hold British National Grid instead.",
    ],
  };
}

/* ---------- OS NGD Features ---------- */

interface NgdFeature {
  id: string;
  type: "Feature";
  geometry?: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}
interface NgdFeatureCollection {
  type: "FeatureCollection";
  numberReturned?: number;
  numberMatched?: number;
  features?: NgdFeature[];
  links?: { href: string; rel: string }[];
  timeStamp?: string;
}
const NGD_COLUMNS = ["osid", "toid", "description", "height_absolute_max_m", "height_relative_max_m", "height_roofbase_m", "land_use_tier_a", "land_use_tier_b", "address_primary", "address_classification_code", "geometry_area_m2", "physical_level", "version_date", "geometry_type"];

function first(p: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (p[n] !== undefined && p[n] !== null && p[n] !== "") return p[n];
  return null;
}

function toNgdRow(f: NgdFeature) {
  const p = f.properties ?? {};
  return {
    osid: (p.osid as string) ?? f.id,
    toid: first(p, "toid"),
    description: first(p, "description"),
    height_absolute_max_m: first(p, "height_absolutemax_m", "absoluteheightmaximum"),
    height_relative_max_m: first(p, "height_relativemax_m", "relativeheightmaximum"),
    height_roofbase_m: first(p, "height_relativeroofbase_m", "relativeheightroofbase"),
    land_use_tier_a: first(p, "oslandusetiera"),
    land_use_tier_b: first(p, "oslandusetierb"),
    address_primary: first(p, "address_primarydescription"),
    address_classification_code: first(p, "address_classificationcode"),
    geometry_area_m2: first(p, "geometry_area_m2", "geometry_area"),
    physical_level: first(p, "physicallevel"),
    version_date: first(p, "versiondate"),
    geometry_type: f.geometry?.type ?? null,
  };
}

/** Square bbox of half-width `radius` metres around a point, as CRS84 "minLon,minLat,maxLon,maxLat". */
export function bboxAround(latitude: number, longitude: number, radiusMeters: number): string {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const f = (n: number) => n.toFixed(6);
  return `${f(longitude - dLon)},${f(latitude - dLat)},${f(longitude + dLon)},${f(latitude + dLat)}`;
}

export const definition = defineIntegration({
  id: "os-data-hub",
  name: "OS Data Hub (Names, Places, NGD Features)",
  group: "identity",
  access: "open_key",
  territory: "GB",
  description:
    "Ordnance Survey APIs for locating a building: place-name and postcode gazetteer search (OS Names), authoritative addresses with UPRN, classification and coordinates (OS Places), and building footprints with heights and land use near a point (OS NGD Features).",
  docsUrl: "https://docs.os.uk/os-apis",
  termsUrl: "https://osdatahub.os.uk/legal/apiTermsConditions",
  attribution: "Contains OS data © Crown copyright and database right 2026. OS Places API: contains Royal Mail data © Royal Mail copyright and database right 2026; contains GeoPlace data © Local Government Information House Limited copyright and database right 2026.",
  licence: "restricted",
  envVars: [{ name: "OS_DATA_HUB_API_KEY", required: true, description: "Project API key from osdatahub.os.uk with OS Names API, OS Places API and OS NGD API - Features added to the project." }],
  status: "built_unverified",
  notes: [
    "Plans: OS OpenData plan is free and includes OS Names API. The Premium plan gives up to £1,000 of premium transactions per month free, which covers OS NGD API - Features but explicitly excludes OS Places API, which is always chargeable (per-transaction pricing on the OS Data Hub plans page). Public Sector Geospatial Agreement members get all of it free.",
    "OS Names covers GB place names, roads and postcodes (OS Open Names) and returns British National Grid coordinates only; the portal shows easting/northing. It does not contain individual addresses.",
    "OS Places returns AddressBase Premium (DPA = postal, LPI = local authority). LPI records include non-postal objects such as substations, car parks and plots; check BLPU state and logical status before treating a record as a live building.",
    "OS NGD Features is an OGC API Features service. Building parts are in collection 'bld-fts-buildingpart' (unversioned = latest; versioned ids such as bld-fts-buildingpart-1 and -2 also exist and their attribute names differ, e.g. height_absolutemax_m vs absoluteheightmaximum). Use 'List NGD collections' to confirm the ids available to the key.",
    "NGD queries here use a small bbox around the point in CRS84 (bbox-crs and crs parameters set to CRS84). Results are building parts, not whole buildings: a large building can return several parts, and a point can fall inside none if the coordinate is a postcode centroid rather than a footprint.",
    "Licensing: OS Names is OGL via OS OpenData; OS Places and NGD data are premium OS/Royal Mail/GeoPlace data under the OS Data Hub API terms and cannot be redistributed as bulk data. Attribution strings must be shown.",
    "Built from OS documentation and the OrdnanceSurvey/osdatahub-js and osdatahub (R) clients; no live request has been made from this codebase. Unverified: that output_srs=WGS84 adds LNG/LAT to Places results, the exact NGD bbox-crs parameter name, and the default collection id.",
  ],
  healthCheck: simpleHealth((env) => buildUrl(NAMES_BASE, "find", { query: "London", maxresults: 1, key: env.OS_DATA_HUB_API_KEY ?? "" })),
  operations: [
    {
      id: "names-find",
      label: "Find a place, road or postcode (OS Names)",
      description: "Gazetteer search for settlements, roads, postcodes and named features across Great Britain.",
      params: [
        { name: "query", label: "Search text", type: "string", required: true, placeholder: "Southampton" },
        { name: "maxresults", label: "Max results", type: "integer", default: 10, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const url = buildUrl(NAMES_BASE, "find", { query: String(params.query), maxresults: params.maxresults as number, key: key(ctx.env) });
        const { data } = await fetchJson<NamesResponse>(ctx, url);
        const rows = (data.results ?? []).map(({ GAZETTEER_ENTRY: g }) => ({
          name: g.NAME1,
          local_type: g.LOCAL_TYPE,
          type: g.TYPE,
          easting: g.GEOMETRY_X,
          northing: g.GEOMETRY_Y,
          postcode_district: g.POSTCODE_DISTRICT ?? null,
          populated_place: g.POPULATED_PLACE ?? null,
          district_borough: g.DISTRICT_BOROUGH ?? null,
          county_unitary: g.COUNTY_UNITARY ?? null,
          region: g.REGION ?? null,
          country: g.COUNTRY ?? null,
          id: g.ID,
        }));
        return {
          summary: rows.length ? `${data.header?.totalresults ?? rows.length} gazetteer match${rows.length === 1 ? "" : "es"} for "${params.query}"; top result ${rows[0].name} (${rows[0].local_type}, ${rows[0].county_unitary ?? rows[0].district_borough ?? rows[0].country}).` : `No gazetteer match for "${params.query}".`,
          columns: NAMES_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "os-names", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Coordinates are British National Grid (EPSG:27700) feature centroids, not building positions."],
        };
      },
    },
    {
      id: "places-postcode",
      label: "Addresses in a postcode (OS Places)",
      description: "Every address record in a postcode with UPRN, classification, status and coordinates.",
      params: [
        { name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SO16 0AS" },
        DATASET_PARAM,
        { name: "maxresults", label: "Max results", type: "integer", default: 100, min: 1, max: 100 },
      ],
      run: (params, ctx) => placesCall(ctx, "postcode", { postcode: spacedPostcode(String(params.postcode)), maxresults: params.maxresults as number }, String(params.dataset), `postcode ${spacedPostcode(String(params.postcode))}`),
    },
    {
      id: "places-uprn",
      label: "Address for a UPRN (OS Places)",
      description: "The address record behind a Unique Property Reference Number.",
      params: [
        { name: "uprn", label: "UPRN", type: "uprn", required: true, placeholder: "200010019924" },
        DATASET_PARAM,
      ],
      run: (params, ctx) => placesCall(ctx, "uprn", { uprn: String(params.uprn) }, String(params.dataset), `UPRN ${params.uprn}`),
    },
    {
      id: "places-find",
      label: "Match a free-text address (OS Places)",
      description: "Fuzzy address matching; returns candidates ranked by match score.",
      params: [
        { name: "query", label: "Address text", type: "string", required: true, placeholder: "4 Adanac Drive, Southampton" },
        DATASET_PARAM,
        { name: "maxresults", label: "Max results", type: "integer", default: 10, min: 1, max: 100 },
      ],
      run: (params, ctx) => placesCall(ctx, "find", { query: String(params.query), maxresults: params.maxresults as number, minmatch: 0.4 }, String(params.dataset), `"${params.query}"`),
    },
    {
      id: "ngd-buildings-near-point",
      label: "Building parts near a point (OS NGD)",
      description: "Building footprint parts within a small box around a coordinate, with heights, land use and address classification.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "50.9380" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-1.4708" },
        { name: "radius", label: "Half-width of search box (m)", type: "integer", default: 25, min: 1, max: 250 },
        {
          name: "collection",
          label: "Collection",
          type: "select",
          default: "bld-fts-buildingpart",
          options: [
            { value: "bld-fts-buildingpart", label: "bld-fts-buildingpart (latest version)" },
            { value: "bld-fts-buildingpart-1", label: "bld-fts-buildingpart-1" },
            { value: "bld-fts-buildingpart-2", label: "bld-fts-buildingpart-2" },
          ],
        },
        { name: "limit", label: "Max features", type: "integer", default: 20, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const lat = params.latitude as number;
        const lon = params.longitude as number;
        const bbox = bboxAround(lat, lon, params.radius as number);
        const url = buildUrl(NGD_BASE, `collections/${encodeURIComponent(String(params.collection))}/items`, {
          bbox,
          "bbox-crs": CRS84,
          crs: CRS84,
          limit: params.limit as number,
          key: key(ctx.env),
        });
        const { data } = await fetchJson<NgdFeatureCollection>(ctx, url, { headers: { accept: "application/geo+json, application/json" } });
        const rows = (data.features ?? []).map(toNgdRow);
        const heights = rows.map((r) => Number(r.height_absolute_max_m)).filter((n) => Number.isFinite(n));
        return {
          summary: rows.length
            ? `${rows.length} building part${rows.length === 1 ? "" : "s"} within ${params.radius} m of ${lat.toFixed(5)}, ${lon.toFixed(5)}${data.numberMatched && data.numberMatched > rows.length ? ` (${data.numberMatched} matched)` : ""}${heights.length ? `; tallest ${Math.max(...heights).toFixed(1)} m absolute` : ""}.`
            : `No building parts within ${params.radius} m of ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
          columns: NGD_COLUMNS,
          rows,
          raw: { ...data, features: (data.features ?? []).map((f) => ({ ...f, geometry: f.geometry ? { type: f.geometry.type } : undefined })) },
          provenance: makeProvenance(definition, ctx, { dataset: String(params.collection), basis: rows.length ? "measured" : "unavailable" }),
          warnings: [
            "Rows are building parts, not whole buildings; sum geometry_area_m2 with care and check which part the address seed falls in.",
            "A postcode centroid can sit in a road or garden; use an OS Places coordinate or a UPRN-derived point where possible.",
          ],
        };
      },
    },
    {
      id: "ngd-collections",
      label: "List NGD collections",
      description: "Feature collections (and versions) the key can access on OS NGD API - Features.",
      params: [],
      async run(_params, ctx) {
        const url = buildUrl(NGD_BASE, "collections", { key: key(ctx.env) });
        const { data } = await fetchJson<{ collections?: { id: string; title?: string; description?: string }[] }>(ctx, url);
        const rows = (data.collections ?? []).map((c) => ({ id: c.id, title: c.title ?? null, description: c.description ? String(c.description).slice(0, 200) : null }));
        return {
          summary: `${rows.length} NGD feature collections available.`,
          columns: ["id", "title", "description"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "ngd-collections", basis: "not_applicable" }),
        };
      },
    },
  ],
});
