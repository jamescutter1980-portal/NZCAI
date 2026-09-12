import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { haversineKm, num, round, text } from "../ea-flood-monitoring/ea-lda";

/**
 * Defra UK-AIR Sensor Observation Service, 52North REST API:
 * https://uk-air.defra.gov.uk/sos-ukair/api/v1
 *   /stations                      every station (one entry per station+pollutant)
 *   /timeseries?station={id}&expanded=true
 *   /timeseries/{id}/getData?timespan=P7D/now  (or ISO/ISO)
 * Shapes confirmed from open-source clients (aeolus, TheWorldAvatar,
 * defra-sos-ingester): station geometry coordinates are [lat, lon, elev]
 * (not GeoJSON order), timeseries carry parameters.phenomenon (EIONET id),
 * uom and lastValue, getData returns {values:[{timestamp(ms), value}]} with
 * -99 as the missing sentinel. Not exercised live from this codebase.
 */

export const BASE = "https://uk-air.defra.gov.uk/sos-ukair/api/v1";

/** EIONET pollutant vocabulary ids used by the SOS phenomenon parameter. */
export const EIONET_POLLUTANTS: Record<number, string> = {
  1: "SO2",
  5: "PM10",
  7: "O3",
  8: "NO2",
  9: "NOx as NO2",
  10: "CO",
  38: "NO",
  6001: "PM2.5",
  20: "Benzene",
  5012: "Lead in PM10",
  5018: "Arsenic in PM10",
  5015: "Nickel in PM10",
  5014: "Cadmium in PM10",
  5029: "Benzo(a)pyrene in PM10",
};

export const MISSING_SENTINEL = -99;

export interface SosStation {
  id: number | string;
  properties?: { id?: number | string; label?: string };
  geometry?: { type?: string; coordinates?: number[] };
}

export interface SosTimeseries {
  id: number | string;
  label?: string;
  uom?: string;
  station?: SosStation;
  parameters?: { service?: { id?: string; label?: string }; offering?: { id?: string; label?: string }; feature?: { id?: string; label?: string }; procedure?: { id?: string; label?: string }; phenomenon?: { id?: string; label?: string }; category?: { id?: string; label?: string } };
  firstValue?: { timestamp?: number; value?: number };
  lastValue?: { timestamp?: number; value?: number };
}

export interface SosData {
  values?: { timestamp: number; value: number | null }[];
}

/** UK-AIR SOS returns [lat, lon, elevation]; detect and correct if a service update flips the order. */
export function latLonOf(coords: number[] | undefined): { lat: number | null; lon: number | null } {
  if (!coords || coords.length < 2) return { lat: null, lon: null };
  const [a, b] = coords;
  const looksLat = (v: number) => v >= 49 && v <= 61.5;
  const looksLon = (v: number) => v >= -9 && v <= 2.5;
  if (looksLat(a) && looksLon(b)) return { lat: a, lon: b };
  if (looksLat(b) && looksLon(a)) return { lat: b, lon: a };
  return { lat: a, lon: b };
}

/** "Camden Kerbside-Nitrogen dioxide (air)" -> site "Camden Kerbside", pollutant "Nitrogen dioxide (air)". */
export function splitLabel(label: string | undefined): { site: string | null; pollutant: string | null } {
  if (!label) return { site: null, pollutant: null };
  const i = label.indexOf("-");
  if (i < 0) return { site: label.trim(), pollutant: null };
  return { site: label.slice(0, i).trim(), pollutant: label.slice(i + 1).trim() };
}

export function pollutantOf(ts: SosTimeseries): string | null {
  const phen = ts.parameters?.phenomenon;
  const m = /(\d+)\s*$/.exec(String(phen?.id ?? ""));
  if (m && EIONET_POLLUTANTS[Number(m[1])]) return EIONET_POLLUTANTS[Number(m[1])];
  return text(phen?.label) ?? splitLabel(ts.label).pollutant ?? text(ts.parameters?.offering?.label);
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const STATION_COLUMNS = ["station_id", "site", "pollutant_label", "latitude", "longitude", "distance_km"];
const TS_COLUMNS = ["timeseries_id", "pollutant", "unit", "site", "offering", "first_value_time", "last_value_time", "last_value"];

export const definition = defineIntegration({
  id: "defra-uk-air",
  name: "Defra UK-AIR monitoring (SOS)",
  group: "ground",
  access: "open",
  territory: "UK",
  description: "Defra UK-AIR Sensor Observation Service: automatic air quality monitoring stations (AURN and affiliated networks) near a point, their pollutant time series (NO2, PM2.5, PM10, O3, SO2 and others) and recent hourly measurements.",
  docsUrl: "https://uk-air.defra.gov.uk/data/about_sos",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "© Crown copyright, Defra UK-AIR. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The SOS is run by a third party and is intermittently unavailable (502s); retry later rather than treating an outage as missing data. Recent values are provisional until ratified.",
    "Station search downloads the full station list (about 300 sites, one entry per pollutant) and filters by distance locally, which avoids the undocumented `near` parameter. Coordinates are returned as [lat, lon, elevation]; the order is checked defensively.",
    "Measured concentrations at the nearest monitor are not the site's concentrations. For screening a site against annual mean objectives, use Defra's 1 km modelled background maps (PCM) - the Air Quality Compliance Data Hub (compliance-data.defra.gov.uk) publishes them as ArcGIS Hub datasets, but the FeatureServer endpoints could not be confirmed here, so a 'modelled background at a point' operation is a follow-up; the `links` operation points to the datasets.",
    "Air Quality Management Areas (AQMAs) are local authority data (uk-air.defra.gov.uk/aqma) and are not in the SOS.",
    "A value of -99 means missing and is dropped from statistics. Units are as reported by the timeseries (usually ug/m3).",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "stations", { limit: 1 })),
  operations: [
    {
      id: "stations-near",
      label: "Air quality monitoring stations near a point",
      description: "UK-AIR SOS stations within a radius of the point (one row per station and pollutant), nearest first.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "radius", label: "Radius (km)", type: "number", default: 10, min: 0.5, max: 100 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const url = buildUrl(BASE, "stations");
        const { data } = await fetchJson<SosStation[]>(ctx, url, {}, { timeoutMs: 30_000 });
        const stations = Array.isArray(data) ? data : [];
        const rows = stations
          .map((s) => {
            const { lat, lon } = latLonOf(s.geometry?.coordinates);
            const label = splitLabel(s.properties?.label);
            return {
              station_id: String(s.id ?? s.properties?.id ?? ""),
              site: label.site,
              pollutant_label: label.pollutant,
              latitude: lat,
              longitude: lon,
              distance_km: lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
            };
          })
          .filter((r) => r.distance_km !== null && r.distance_km <= (params.radius as number))
          .sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999))
          .slice(0, 100);
        const sites = new Set(rows.map((r) => r.site));
        return {
          summary: rows.length ? `${sites.size} monitoring sites (${rows.length} station/pollutant entries) within ${params.radius} km; nearest ${rows[0].site} at ${rows[0].distance_km} km (${rows[0].pollutant_label ?? "pollutant not labelled"}).` : `No UK-AIR SOS stations within ${params.radius} km (${stations.length} stations checked).`,
          columns: STATION_COLUMNS,
          rows,
          raw: { stationsChecked: stations.length, nearest: rows.slice(0, 20) },
          provenance: makeProvenance(definition, ctx, { dataset: "sos-ukair/stations", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Monitors report conditions at the monitor, which may be roadside or urban background; do not transfer readings to a site without considering site type and distance."],
        };
      },
    },
    {
      id: "timeseries",
      label: "Pollutant time series at a station",
      description: "Time series available at one SOS station with pollutant, unit and last value.",
      params: [{ name: "stationId", label: "Station id", type: "string", required: true, placeholder: "GB_Station_GB0682A", help: "station_id from the station search." }],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.stationId).trim();
        const url = buildUrl(BASE, "timeseries", { station: id, expanded: "true" });
        const { data } = await fetchJson<SosTimeseries[]>(ctx, url);
        const list = Array.isArray(data) ? data : [];
        const rows = list.map((ts) => ({
          timeseries_id: String(ts.id),
          pollutant: pollutantOf(ts),
          unit: ts.uom ?? null,
          site: splitLabel(ts.station?.properties?.label ?? ts.label).site,
          offering: text(ts.parameters?.offering?.label),
          first_value_time: iso(ts.firstValue?.timestamp),
          last_value_time: iso(ts.lastValue?.timestamp),
          last_value: ts.lastValue?.value === MISSING_SENTINEL ? null : num(ts.lastValue?.value),
        }));
        return {
          summary: rows.length ? `${rows.length} time series at station ${id}: ${rows.map((r) => `${r.pollutant ?? r.timeseries_id}${r.last_value !== null ? ` ${r.last_value} ${r.unit ?? ""}`.trimEnd() : ""}`).join("; ")}.` : `No time series found for station ${id}.`,
          columns: TS_COLUMNS,
          rows,
          raw: list.slice(0, 50),
          provenance: makeProvenance(definition, ctx, { dataset: "sos-ukair/timeseries", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "recent-data",
      label: "Recent measurements for a time series",
      description: "Hourly values for one time series over the last N days (default 7) with min, max and mean, missing values excluded.",
      params: [
        { name: "timeseriesId", label: "Time series id", type: "string", required: true, placeholder: "12345" },
        { name: "days", label: "Days back", type: "integer", default: 7, min: 1, max: 31 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.timeseriesId).trim();
        const days = params.days as number;
        const [meta, series] = await Promise.all([
          fetchJson<SosTimeseries>(ctx, buildUrl(BASE, `timeseries/${encodeURIComponent(id)}`), {}, { acceptStatuses: [404] }),
          fetchJson<SosData>(ctx, buildUrl(BASE, `timeseries/${encodeURIComponent(id)}/getData`, { timespan: `P${days}D/now` }), {}, { acceptStatuses: [404], timeoutMs: 30_000 }),
        ]);
        const pollutant = meta.status === 404 || !meta.data ? null : pollutantOf(meta.data);
        const unit = meta.data?.uom ?? null;
        const values = series.data?.values ?? [];
        const rows = values.map((v) => ({ time: iso(v.timestamp), value: v.value === null || v.value === MISSING_SENTINEL ? null : num(v.value), pollutant, unit }));
        const nums = rows.map((r) => r.value).filter((v): v is number => v !== null);
        const mean = nums.length ? round(nums.reduce((s, v) => s + v, 0) / nums.length, 2) : null;
        return {
          summary: rows.length ? `${nums.length} valid of ${rows.length} values for ${pollutant ?? `time series ${id}`} over ${days} days: mean ${mean ?? "n/a"}, min ${nums.length ? round(Math.min(...nums), 2) : "n/a"}, max ${nums.length ? round(Math.max(...nums), 2) : "n/a"} ${unit ?? ""}.`.trim() : `No data for time series ${id} in the last ${days} days.`,
          columns: ["time", "value", "pollutant", "unit"],
          rows,
          raw: { timeseries: meta.data, valueCount: values.length },
          provenance: makeProvenance(definition, ctx, { dataset: "sos-ukair/getData", basis: nums.length ? "measured" : "unavailable" }),
          warnings: ["Hourly values are provisional until ratified by Defra; short windows do not represent annual means used for air quality objectives."],
        };
      },
    },
    {
      id: "links",
      label: "Modelled background maps and AQMA links",
      description: "Where to obtain Defra's 1 km modelled background concentrations (PCM) and local authority AQMA data, pending a point query.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Defra's PCM modelled background concentrations (NO2, PM2.5, PM10 annual means at 1 km) are published on the Air Quality Compliance Data Hub and the LAQM background maps; a point query is a follow-up once the FeatureServer endpoints are confirmed.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "uk-air links", basis: "not_applicable" }),
          links: [
            { label: "Air Quality Compliance Data Hub (modelled background datasets)", url: "https://compliance-data.defra.gov.uk/" },
            { label: "LAQM background maps (1 km, by local authority)", url: "https://uk-air.defra.gov.uk/data/laqm-background-home" },
            { label: "Air Quality Management Areas", url: "https://uk-air.defra.gov.uk/aqma/" },
            { label: "UK-AIR SOS API documentation", url: "https://uk-air.defra.gov.uk/sos-ukair/static/doc/api-doc/" },
          ],
        };
      },
    },
  ],
});
