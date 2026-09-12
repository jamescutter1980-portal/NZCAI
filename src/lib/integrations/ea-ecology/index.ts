import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { haversineKm, lastSegment, num, round, text } from "../ea-flood-monitoring/ea-lda";

/**
 * Environment Agency Ecology and Fish Data API (Biosys and NFPD surveys).
 * Base: https://environment.data.gov.uk/ecology/api/v1 (documentation at
 * /ecology/api/v1/index.html). The API is a REST/JSON service distinct from
 * the linked-data family: responses are plain arrays or {data: [...]} pages.
 *
 * Route and parameter names (sites?lat&lon&radius, surveys?site_id) follow
 * the task brief and the documented resource names (sites, surveys,
 * observations); they could not be verified from an open-source client, so
 * this connector matches response fields loosely and is marked unverified.
 */

export const BASE = "https://environment.data.gov.uk/ecology/api/v1";

type Loose = Record<string, unknown>;

function pick(o: Loose, ...names: string[]): unknown {
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase().replace(/[_\-\s]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[_\-\s]/g, ""));
    if (key !== undefined && o[key] !== null && o[key] !== undefined && o[key] !== "") return o[key];
  }
  return null;
}

/** Accepts a bare array, {data: []}, {items: []}, {results: []} or {sites: []}. */
export function listOf(data: unknown): Loose[] {
  if (Array.isArray(data)) return data as Loose[];
  if (data && typeof data === "object") {
    const o = data as Loose;
    for (const k of ["data", "items", "results", "sites", "surveys", "observations"]) {
      if (Array.isArray(o[k])) return o[k] as Loose[];
    }
  }
  return [];
}

const SITE_COLUMNS = ["site_id", "site_name", "site_type", "survey_type", "water_body", "latitude", "longitude", "easting", "northing", "distance_km"];

export function siteRow(s: Loose, origin?: { lat: number; lon: number }) {
  const lat = num(pick(s, "lat", "latitude", "y"));
  const lon = num(pick(s, "lon", "long", "longitude", "x"));
  const id = pick(s, "site_id", "siteId", "id", "notation", "@id");
  return {
    site_id: typeof id === "string" && id.startsWith("http") ? lastSegment(id) : text(id),
    site_name: text(pick(s, "site_name", "siteName", "name", "label")),
    site_type: text(pick(s, "site_type", "siteType", "type")),
    survey_type: text(pick(s, "survey_type", "surveyType", "dataset", "source")),
    water_body: text(pick(s, "water_body", "waterBody", "water_body_name", "river", "riverName")),
    latitude: lat,
    longitude: lon,
    easting: num(pick(s, "easting", "x_coord")),
    northing: num(pick(s, "northing", "y_coord")),
    distance_km: origin && lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
  };
}

const SURVEY_COLUMNS = ["survey_id", "site_id", "survey_date", "survey_type", "survey_method", "purpose", "observations", "url"];

export function surveyRow(s: Loose) {
  const id = pick(s, "survey_id", "surveyId", "id", "@id");
  return {
    survey_id: typeof id === "string" && id.startsWith("http") ? lastSegment(id) : text(id),
    site_id: text(pick(s, "site_id", "siteId", "site")),
    survey_date: text(pick(s, "survey_date", "surveyDate", "date", "sample_date", "sampleDate")),
    survey_type: text(pick(s, "survey_type", "surveyType", "type", "dataset")),
    survey_method: text(pick(s, "survey_method", "surveyMethod", "method")),
    purpose: text(pick(s, "purpose", "survey_purpose")),
    observations: num(pick(s, "observation_count", "observations", "count")),
    url: typeof id === "string" && id.startsWith("http") ? id : null,
  };
}

export const definition = defineIntegration({
  id: "ea-ecology",
  name: "EA Ecology and Fish Data (Biosys and NFPD)",
  group: "nature",
  access: "open",
  territory: "England",
  description: "Environment Agency freshwater and marine ecology survey sites (macroinvertebrates, diatoms, macrophytes) and fish population surveys, harmonised in the Ecology and Fish Data API.",
  docsUrl: "https://environment.data.gov.uk/ecology/api/v1/index.html",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. Query parameter names for the sites search (lat, lon, radius in km) and survey filter (site_id) follow the resource names in the API documentation but could not be confirmed against a client; response fields are matched case-insensitively across the likely names. Verify against /ecology/api/v1/index.html on first live run.",
    "Survey presence near a site is environmental context (receiving-water ecology), not a biodiversity baseline for the site. Use the Biodiversity Net Gain metric and an ecologist's survey for that.",
    "Bulk downloads of the same data are available from the Ecology and Fish Data Explorer.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "sites", { take: 1, limit: 1 })),
  operations: [
    {
      id: "sites",
      label: "Ecology survey sites near a point",
      description: "Biosys and NFPD survey sites within a radius of the point.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "radius", label: "Radius (km)", type: "number", default: 5, min: 0.5, max: 25 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const url = buildUrl(BASE, "sites", { lat: origin.lat, lon: origin.lon, radius: params.radius as number, take: 100 });
        const { data } = await fetchJson<unknown>(ctx, url);
        const rows = listOf(data).map((s) => siteRow(s, origin)).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999)).slice(0, 100);
        return {
          summary: rows.length ? `${rows.length} ecology/fish survey sites within ${params.radius} km; nearest ${rows[0].site_name ?? rows[0].site_id} (${rows[0].distance_km ?? "?"} km).` : `No ecology or fish survey sites within ${params.radius} km.`,
          columns: SITE_COLUMNS,
          rows,
          raw: Array.isArray(data) ? data.slice(0, 200) : data,
          provenance: makeProvenance(definition, ctx, { dataset: "ecology/sites", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Parameter names for this endpoint are unverified; if the service returns an error, check the API index for the current spatial filter."],
        };
      },
    },
    {
      id: "surveys",
      label: "Recent surveys at a site",
      description: "Surveys recorded at one Biosys/NFPD site, newest first.",
      params: [
        { name: "siteId", label: "Site id", type: "string", required: true, placeholder: "43378", help: "site_id from the sites search." },
        { name: "limit", label: "Max surveys", type: "integer", default: 50, min: 1, max: 100 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const siteId = String(params.siteId).trim();
        const url = buildUrl(BASE, "surveys", { site_id: siteId, take: params.limit as number });
        const { data, status } = await fetchJson<unknown>(ctx, url, {}, { acceptStatuses: [404] });
        const rows = status === 404 ? [] : listOf(data).map(surveyRow).sort((a, b) => ((b.survey_date ?? "") < (a.survey_date ?? "") ? -1 : 1));
        const latest = rows[0];
        return {
          summary: rows.length ? `${rows.length} surveys at site ${siteId}; latest ${latest.survey_date ?? "n/a"} (${latest.survey_type ?? latest.survey_method ?? "type unknown"}).` : `No surveys found for site ${siteId}.`,
          columns: SURVEY_COLUMNS,
          rows,
          raw: Array.isArray(data) ? data.slice(0, 200) : data,
          provenance: makeProvenance(definition, ctx, { dataset: "ecology/surveys", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
  ],
});
