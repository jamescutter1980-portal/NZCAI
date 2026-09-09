import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { type EaList, haversineKm, lastSegment, num, round, text, trimItems } from "./ea-lda";

/**
 * Environment Agency real-time flood-monitoring API (England).
 * Reference: https://environment.data.gov.uk/flood-monitoring/doc/reference
 *
 * Endpoints used (all GET, JSON):
 *   /id/floods?lat&long&dist              flood warnings and alerts in force
 *   /id/floodAreas?lat&long&dist          flood warning / alert areas
 *   /id/stations?lat&long&dist&parameter&type&_view=full
 *   /id/stations/{ref}                    one station with its measures
 *   /id/stations/{ref}/readings?latest    latest reading per measure
 *   /id/stations/{ref}/readings?since=&_sorted&_limit
 *   /id/3dayforecast                      Flood Forecasting Centre outlook
 * Built from the published reference and open-source clients; not exercised live
 * from this codebase.
 */

export const BASE = "https://environment.data.gov.uk/flood-monitoring";

export const SEVERITY_LABELS: Record<number, string> = {
  1: "Severe Flood Warning",
  2: "Flood Warning",
  3: "Flood Alert",
  4: "Warning no longer in force",
};

export const SEVERITY_MEANING: Record<number, string> = {
  1: "severe flooding, danger to life",
  2: "flooding is expected, immediate action required",
  3: "flooding is possible, be prepared",
  4: "no longer in force",
};

export interface FloodWarning {
  "@id"?: string;
  description?: string;
  eaAreaName?: string;
  floodAreaID?: string;
  floodArea?: { "@id"?: string; county?: string; notation?: string; riverOrSea?: string; description?: string; lat?: number; long?: number; polygon?: string };
  isTidal?: boolean;
  message?: string;
  severity?: string;
  severityLevel?: number;
  timeMessageChanged?: string;
  timeRaised?: string;
  timeSeverityChanged?: string;
}

export interface FloodArea {
  "@id"?: string;
  notation?: string;
  fwdCode?: string;
  label?: string;
  description?: string;
  county?: string;
  eaAreaName?: string;
  riverOrSea?: string;
  quickDialNumber?: string;
  lat?: number;
  long?: number;
  polygon?: string;
}

export interface Measure {
  "@id"?: string;
  notation?: string;
  label?: string;
  parameter?: string;
  parameterName?: string;
  qualifier?: string;
  unitName?: string;
  period?: number;
  valueType?: string;
  datumType?: string;
  latestReading?: { "@id"?: string; dateTime?: string; value?: number; measure?: string } | string;
}

export interface Station {
  "@id"?: string;
  stationReference?: string;
  RLOIid?: string;
  label?: unknown;
  riverName?: string;
  town?: string;
  catchmentName?: string;
  dateOpened?: string;
  status?: unknown;
  type?: unknown;
  lat?: number | number[];
  long?: number | number[];
  easting?: number;
  northing?: number;
  gridReference?: string;
  measures?: Measure[] | Measure;
  stageScale?: { typicalRangeHigh?: number; typicalRangeLow?: number; highestRecent?: { value?: number; dateTime?: string }; maxOnRecord?: { value?: number; dateTime?: string }; minOnRecord?: { value?: number; dateTime?: string }; datum?: number };
}

export interface Reading {
  "@id"?: string;
  dateTime?: string;
  measure?: string;
  value?: number;
}

const WARNING_COLUMNS = ["severity_level", "severity", "meaning", "area", "county", "river_or_sea", "flood_area_id", "is_tidal", "time_raised", "time_severity_changed", "time_message_changed", "message"];

export function warningRow(w: FloodWarning) {
  const level = num(w.severityLevel);
  return {
    severity_level: level,
    severity: w.severity ?? (level !== null ? SEVERITY_LABELS[level] : null) ?? null,
    meaning: level !== null ? (SEVERITY_MEANING[level] ?? null) : null,
    area: w.description ?? w.floodArea?.description ?? null,
    county: w.floodArea?.county ?? null,
    river_or_sea: w.floodArea?.riverOrSea ?? null,
    flood_area_id: w.floodAreaID ?? w.floodArea?.notation ?? null,
    is_tidal: w.isTidal ?? null,
    time_raised: w.timeRaised ?? null,
    time_severity_changed: w.timeSeverityChanged ?? null,
    time_message_changed: w.timeMessageChanged ?? null,
    message: (w.message ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || null,
  };
}

function firstNum(v: unknown): number | null {
  if (Array.isArray(v)) return num(v[0]);
  return num(v);
}

function measuresOf(s: Station): Measure[] {
  if (!s.measures) return [];
  return Array.isArray(s.measures) ? s.measures : [s.measures];
}

function latestOf(m: Measure): { dateTime: string | null; value: number | null } {
  if (!m.latestReading || typeof m.latestReading === "string") return { dateTime: null, value: null };
  return { dateTime: m.latestReading.dateTime ?? null, value: num(m.latestReading.value) };
}

export function stationRow(s: Station, origin?: { lat: number; lon: number }) {
  const lat = firstNum(s.lat);
  const lon = firstNum(s.long);
  const ms = measuresOf(s);
  const params = Array.from(new Set(ms.map((m) => m.parameterName ?? m.parameter).filter(Boolean))).join("; ");
  return {
    station_reference: s.stationReference ?? lastSegment(s["@id"]),
    label: text(s.label),
    type: text(s.type) ? lastSegment(text(s.type)) : null,
    river_name: s.riverName ?? null,
    town: s.town ?? null,
    catchment: s.catchmentName ?? null,
    parameters: params || null,
    status: lastSegment(text(s.status)) ?? null,
    date_opened: s.dateOpened ?? null,
    latitude: lat,
    longitude: lon,
    distance_km: origin && lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
    typical_range_low: num(s.stageScale?.typicalRangeLow),
    typical_range_high: num(s.stageScale?.typicalRangeHigh),
  };
}

const STATION_COLUMNS = ["station_reference", "label", "type", "river_name", "town", "catchment", "parameters", "status", "date_opened", "latitude", "longitude", "distance_km", "typical_range_low", "typical_range_high"];

/** One row per measure with its latest reading (stations fetched with _view=full carry latestReading). */
export function measureRows(s: Station, origin?: { lat: number; lon: number }) {
  const base = stationRow(s, origin);
  return measuresOf(s).map((m) => {
    const latest = latestOf(m);
    return {
      station_reference: base.station_reference,
      label: base.label,
      parameter: m.parameterName ?? m.parameter ?? null,
      qualifier: m.qualifier ?? null,
      unit: m.unitName ?? null,
      period_s: num(m.period),
      latest_value: latest.value,
      latest_time: latest.dateTime,
      measure: m.notation ?? lastSegment(m["@id"]),
      river_name: base.river_name,
      town: base.town,
      latitude: base.latitude,
      longitude: base.longitude,
      distance_km: base.distance_km,
    };
  });
}

const MEASURE_COLUMNS = ["station_reference", "label", "parameter", "qualifier", "unit", "period_s", "latest_value", "latest_time", "measure", "river_name", "town", "latitude", "longitude", "distance_km"];

/** Parses a measure id like `1029TH-level-stage-i-15_min-mAOD` into its parts. */
export function parseMeasureId(id: string | null | undefined): { station: string | null; parameter: string | null; qualifier: string | null; unit: string | null } {
  if (!id) return { station: null, parameter: null, qualifier: null, unit: null };
  const parts = id.split("-");
  if (parts.length < 4) return { station: parts[0] ?? null, parameter: parts[1] ?? null, qualifier: null, unit: parts[parts.length - 1] ?? null };
  return { station: parts[0], parameter: parts[1], qualifier: parts[2], unit: parts[parts.length - 1] };
}

export function readingRow(r: Reading) {
  const measure = lastSegment(r.measure);
  const p = parseMeasureId(measure);
  return {
    date_time: r.dateTime ?? null,
    value: num(r.value),
    parameter: p.parameter,
    qualifier: p.qualifier,
    unit: p.unit,
    measure,
  };
}

const READING_COLUMNS = ["date_time", "value", "parameter", "qualifier", "unit", "measure"];

const POINT_PARAMS = [
  { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
  { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
] as const;

const LIVE_WARNING = "Live warnings show what is in force right now. No warning in force does not mean no flood risk; use the long-term flood risk layers for exposure.";
const ENGLAND_WARNING = "Covers England (Environment Agency). Wales is served by Natural Resources Wales, Scotland by SEPA and Northern Ireland by DfI Rivers.";

function summariseSeverity(rows: ReturnType<typeof warningRow>[]): string {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.severity_level !== null) counts.set(r.severity_level, (counts.get(r.severity_level) ?? 0) + 1);
  const parts = [1, 2, 3, 4].filter((l) => counts.has(l)).map((l) => `${counts.get(l)} ${SEVERITY_LABELS[l]}${counts.get(l)! > 1 ? "s" : ""}`);
  return parts.join(", ");
}

async function stationsNear(ctx: OperationContext, params: Record<string, unknown>, extra: Record<string, string | number | undefined>) {
  const url = buildUrl(BASE, "id/stations", { lat: params.latitude as number, long: params.longitude as number, dist: params.dist as number, _view: "full", _limit: 100, ...extra });
  const { data } = await fetchJson<EaList<Station>>(ctx, url);
  return { url, data, items: data.items ?? [] };
}

export const definition = defineIntegration({
  id: "ea-flood-monitoring",
  name: "EA flood warnings, river levels, rainfall and tide gauges",
  group: "flood_water",
  access: "open",
  territory: "England",
  description:
    "Environment Agency real-time flood-monitoring API: flood warnings and alerts in force, flood warning areas, river level and flow stations, rainfall gauges (listed in the catalogue as 'EA rainfall'), tide gauges ('EA tide gauges'), latest and historical readings, and the Flood Forecasting Centre 3-day outlook.",
  docsUrl: "https://environment.data.gov.uk/flood-monitoring/doc/reference",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The service asks for a polite request rate and caches responses; readings are typically 15-minute and appear within an hour or two.",
    "Warnings are live operational messages, not a flood risk assessment. Severity levels: 1 Severe Flood Warning, 2 Flood Warning, 3 Flood Alert, 4 warning no longer in force (kept for 24 hours).",
    "Station lists use _view=full so each measure carries its latest reading; the `parameter` filter on /id/stations and the /readings?since= form are per the reference but were not exercised live.",
    "Level readings are relative to the station datum (mASD) or ordnance datum (mAOD) as indicated by the measure unit; tide gauge levels use the same convention.",
    "The 3-day forecast JSON shape is the Flood Forecasting Centre statement mirrored by the API; field names (england_forecast, risk_areas, sources) are taken from published examples and treated defensively.",
    "England only. Some Welsh stations shared with NRW appear, but Welsh warnings come from the nrw-flood connector.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "id/floods", { _limit: 1 })),
  operations: [
    {
      id: "warnings",
      label: "Flood warnings and alerts in force near a point",
      description: "Current Environment Agency flood warnings and alerts whose area lies within a radius of the point, most severe first.",
      params: [
        ...POINT_PARAMS,
        { name: "dist", label: "Radius (km)", type: "number", default: 10, min: 0.5, max: 50, help: "Search radius around the point in kilometres." },
        { name: "minSeverity", label: "Include", type: "select", default: "3", options: [{ value: "3", label: "Warnings and alerts (levels 1-3)" }, { value: "2", label: "Warnings only (levels 1-2)" }, { value: "4", label: "Everything incl. recently removed (levels 1-4)" }] },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "id/floods", { lat: params.latitude as number, long: params.longitude as number, dist: params.dist as number, "min-severity": params.minSeverity as string });
        const { data } = await fetchJson<EaList<FloodWarning>>(ctx, url);
        const rows = (data.items ?? []).map(warningRow).sort((a, b) => (a.severity_level ?? 9) - (b.severity_level ?? 9));
        const inForce = rows.filter((r) => r.severity_level !== null && r.severity_level <= 3);
        const summary = rows.length === 0 ? `No flood warnings or alerts in force within ${params.dist} km of the point.` : `${inForce.length} in force within ${params.dist} km: ${summariseSeverity(rows)}.`;
        return {
          summary,
          columns: WARNING_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/floods", basis: rows.length ? "measured" : "unavailable" }),
          warnings: [LIVE_WARNING, ENGLAND_WARNING],
          links: [{ label: "Check for flooding (GOV.UK)", url: "https://check-for-flooding.service.gov.uk/" }],
        };
      },
    },
    {
      id: "flood-areas",
      label: "Flood warning and alert areas near a point",
      description: "Defined flood warning areas and flood alert areas within a radius of the point, whether or not a warning is currently in force.",
      params: [...POINT_PARAMS, { name: "dist", label: "Radius (km)", type: "number", default: 5, min: 0.5, max: 30 }],
      async run(params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "id/floodAreas", { lat: params.latitude as number, long: params.longitude as number, dist: params.dist as number, _limit: 100 });
        const { data } = await fetchJson<EaList<FloodArea>>(ctx, url);
        const rows = (data.items ?? []).map((a) => ({
          notation: a.notation ?? a.fwdCode ?? lastSegment(a["@id"]),
          label: a.label ?? null,
          description: a.description ?? null,
          county: a.county ?? null,
          river_or_sea: a.riverOrSea ?? null,
          ea_area: a.eaAreaName ?? null,
          quick_dial: a.quickDialNumber ?? null,
          latitude: num(a.lat),
          longitude: num(a.long),
        }));
        return {
          summary: rows.length ? `${rows.length} flood warning/alert areas within ${params.dist} km. Being inside an area means the EA issues warnings for it, not that flooding is expected now.` : `No EA flood warning or alert areas within ${params.dist} km.`,
          columns: ["notation", "label", "description", "county", "river_or_sea", "ea_area", "quick_dial", "latitude", "longitude"],
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/floodAreas", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Flood areas are administrative warning polygons, not modelled flood extents. Use ea-long-term-flood-risk for exposure.", ENGLAND_WARNING],
        };
      },
    },
    {
      id: "stations",
      label: "River level and flow stations near a point",
      description: "Monitoring stations within a radius, with their parameters, latest readings and typical level range.",
      params: [
        ...POINT_PARAMS,
        { name: "dist", label: "Radius (km)", type: "number", default: 10, min: 0.5, max: 50 },
        { name: "parameter", label: "Parameter", type: "select", default: "any", options: [{ value: "any", label: "Any" }, { value: "level", label: "Level" }, { value: "flow", label: "Flow" }, { value: "rainfall", label: "Rainfall" }, { value: "temperature", label: "Temperature" }] },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const { data, items } = await stationsNear(ctx, params, { parameter: params.parameter === "any" ? undefined : (params.parameter as string) });
        const rows = items.map((s) => stationRow(s, origin)).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        return {
          summary: rows.length ? `${rows.length} stations within ${params.dist} km; nearest is ${rows[0].label ?? rows[0].station_reference} (${rows[0].distance_km ?? "?"} km, ${rows[0].parameters ?? "no measures listed"}).` : `No EA monitoring stations within ${params.dist} km.`,
          columns: STATION_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/stations", basis: rows.length ? "measured" : "unavailable" }),
          warnings: [ENGLAND_WARNING],
        };
      },
    },
    {
      id: "rainfall",
      label: "EA rainfall: gauges near a point with latest totals",
      description: "Tipping-bucket rain gauges within a radius and their latest 15-minute (or daily) totals in mm.",
      params: [...POINT_PARAMS, { name: "dist", label: "Radius (km)", type: "number", default: 15, min: 1, max: 50 }],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const { data, items } = await stationsNear(ctx, params, { parameter: "rainfall" });
        const rows = items.flatMap((s) => measureRows(s, origin)).filter((r) => (r.parameter ?? "").toLowerCase().includes("rain")).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        const nearest = rows[0];
        return {
          summary: rows.length ? `${rows.length} rainfall measures at ${items.length} gauges within ${params.dist} km. Nearest: ${nearest.label ?? nearest.station_reference} at ${nearest.distance_km} km, latest ${nearest.latest_value ?? "n/a"} ${nearest.unit ?? "mm"} at ${nearest.latest_time ?? "n/a"}.` : `No EA rain gauges within ${params.dist} km.`,
          columns: MEASURE_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/stations?parameter=rainfall", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Rain gauge totals are point measurements for the gauge, not the site. Use several gauges or a gridded product for a site estimate.", ENGLAND_WARNING],
        };
      },
    },
    {
      id: "tide-gauges",
      label: "EA tide gauges near a point with latest levels",
      description: "Coastal tide gauge stations within a radius and their latest recorded level.",
      params: [...POINT_PARAMS, { name: "dist", label: "Radius (km)", type: "number", default: 30, min: 1, max: 100 }],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const { data, items } = await stationsNear(ctx, params, { type: "TideGauge" });
        const rows = items.flatMap((s) => measureRows(s, origin)).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        const nearest = rows[0];
        return {
          summary: rows.length ? `${items.length} tide gauges within ${params.dist} km. Nearest: ${nearest.label ?? nearest.station_reference} at ${nearest.distance_km} km, latest level ${nearest.latest_value ?? "n/a"} ${nearest.unit ?? ""} at ${nearest.latest_time ?? "n/a"}.` : `No EA tide gauges within ${params.dist} km.`,
          columns: MEASURE_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/stations?type=TideGauge", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Tide gauge levels are observed water levels at the gauge in the unit shown (mAOD or mASD); they are not a coastal flood risk assessment.", ENGLAND_WARNING],
        };
      },
    },
    {
      id: "station",
      label: "Station detail",
      description: "One station by its reference, with its measures, latest readings and stage scale.",
      params: [{ name: "stationReference", label: "Station reference", type: "string", required: true, placeholder: "1029TH", help: "The stationReference from a station search." }],
      async run(params, ctx): Promise<OperationResult> {
        const ref = String(params.stationReference).trim();
        const url = buildUrl(BASE, `id/stations/${encodeURIComponent(ref)}`);
        const { data, status } = await fetchJson<{ items?: Station | Station[] }>(ctx, url, {}, { acceptStatuses: [404] });
        const item = Array.isArray(data?.items) ? data.items[0] : data?.items;
        if (status === 404 || !item) {
          return { summary: `Station ${ref} not found.`, columns: MEASURE_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/stations", basis: "unavailable" }) };
        }
        const rows = measureRows(item);
        const head = stationRow(item);
        return {
          summary: `${head.label ?? ref} (${head.river_name ?? "no river"}, ${head.town ?? "no town"}): ${rows.length} measures. ${head.typical_range_low !== null ? `Typical level range ${head.typical_range_low} to ${head.typical_range_high}.` : ""}`.trim(),
          columns: MEASURE_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/stations", basis: "measured" }),
        };
      },
    },
    {
      id: "latest-readings",
      label: "Latest readings for a station",
      description: "The most recent reading for each measure at a station.",
      params: [{ name: "stationReference", label: "Station reference", type: "string", required: true, placeholder: "1029TH" }],
      async run(params, ctx): Promise<OperationResult> {
        const ref = String(params.stationReference).trim();
        const url = `${buildUrl(BASE, `id/stations/${encodeURIComponent(ref)}/readings`)}?latest`;
        const { data, status } = await fetchJson<EaList<Reading>>(ctx, url, {}, { acceptStatuses: [404] });
        const rows = (data?.items ?? []).map(readingRow);
        return {
          summary: status === 404 ? `Station ${ref} not found.` : rows.length ? `${rows.length} latest readings for ${ref}: ${rows.map((r) => `${r.parameter ?? r.measure} ${r.value ?? "n/a"} ${r.unit ?? ""} (${r.date_time ?? "n/a"})`).join("; ")}.` : `No readings available for ${ref}.`,
          columns: READING_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/readings?latest", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "readings-since",
      label: "Readings for a station since a date",
      description: "Time series of readings for a station from a start date/time, newest first (up to 500 values).",
      params: [
        { name: "stationReference", label: "Station reference", type: "string", required: true, placeholder: "1029TH" },
        { name: "since", label: "Since (UTC)", type: "datetime", required: true, placeholder: "2026-09-01T00:00:00Z" },
        { name: "parameter", label: "Parameter", type: "select", default: "any", options: [{ value: "any", label: "Any" }, { value: "level", label: "Level" }, { value: "flow", label: "Flow" }, { value: "rainfall", label: "Rainfall" }] },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const ref = String(params.stationReference).trim();
        const base = buildUrl(BASE, `id/stations/${encodeURIComponent(ref)}/readings`, { since: String(params.since), _limit: 500, parameter: params.parameter === "any" ? undefined : (params.parameter as string) });
        const url = `${base}&_sorted`;
        const { data, status } = await fetchJson<EaList<Reading>>(ctx, url, {}, { acceptStatuses: [404] });
        const rows = (data?.items ?? []).map(readingRow);
        const values = rows.map((r) => r.value).filter((v): v is number => v !== null);
        const stats = values.length ? ` Range ${Math.min(...values)} to ${Math.max(...values)}.` : "";
        return {
          summary: status === 404 ? `Station ${ref} not found.` : rows.length ? `${rows.length} readings for ${ref} since ${params.since}${rows.length === 500 ? " (capped at 500; narrow the window for more)" : ""}.${stats}` : `No readings for ${ref} since ${params.since}.`,
          columns: READING_COLUMNS,
          rows,
          raw: trimItems(data ?? {}, 500),
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/readings?since", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["The real-time API keeps roughly the last 28 days; use ea-hydrology for the quality-controlled archive."],
        };
      },
    },
    {
      id: "outlook",
      label: "3-day national flood outlook",
      description: "The Flood Forecasting Centre's 3-day flood risk statement for England and Wales, as mirrored by the API.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "id/3dayforecast");
        const { data } = await fetchJson<{ items?: Record<string, unknown> | Record<string, unknown>[] }>(ctx, url);
        const item = (Array.isArray(data?.items) ? data.items[0] : data?.items) ?? {};
        const pub = (item.public_forecast ?? {}) as Record<string, unknown>;
        const england = text(item.england_forecast ?? pub.england_forecast);
        const trend = (item.flood_risk_trend ?? {}) as Record<string, unknown>;
        const riskAreas = Array.isArray(item.risk_areas) ? (item.risk_areas as Record<string, unknown>[]) : [];
        const rows = riskAreas.map((ra) => ({
          risk_area: text(ra.ra_name ?? ra.name ?? ra.description),
          day: text(ra.day ?? ra.ra_day),
          risk_level: text(ra.risk_level ?? ra.riskLevel ?? ra.level),
          source: text(ra.source ?? ra.sources),
          counties: text(ra.counties ?? ra.area),
        }));
        const trendText = Object.entries(trend).map(([k, v]) => `${k}: ${text(v)}`).join(", ");
        return {
          summary: england ? `${england.slice(0, 400)}${england.length > 400 ? "..." : ""}${trendText ? ` Trend: ${trendText}.` : ""}` : "No forecast text found in the response.",
          columns: ["risk_area", "day", "risk_level", "source", "counties"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "flood-monitoring/3dayforecast", basis: england ? "modelled" : "unavailable" }),
          warnings: ["National outlook, not site specific. Field names in this feed are taken from published examples and may change."],
          links: [{ label: "Flood Forecasting Centre", url: "https://www.ffc-environment-agency.metoffice.gov.uk/" }],
        };
      },
    },
  ],
});
