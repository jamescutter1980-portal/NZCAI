import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { type EaList, haversineKm, lastSegment, num, round, text, trimItems } from "../ea-flood-monitoring/ea-lda";

/**
 * Environment Agency Hydrology API: the long-term, quality-controlled archive
 * of river flow, level, groundwater level and rainfall (England).
 * Reference: https://environment.data.gov.uk/hydrology/doc/reference
 *
 *   /id/stations?lat&long&dist&observedProperty     stations near a point
 *   /id/stations/{id}/measures                      measures (time series) at a station
 *   /id/measures/{measure}/readings?mineq-date&maxeq-date&_limit
 * Measure ids end in `-qualified` for quality-controlled series; other series
 * are near-real-time and unchecked. Built from the reference and open-source
 * clients (UKFE, river_ml_sandbox); not exercised live from this codebase.
 */

export const BASE = "https://environment.data.gov.uk/hydrology";

export const OBSERVED_PROPERTIES = [
  { value: "any", label: "Any" },
  { value: "waterFlow", label: "River flow" },
  { value: "waterLevel", label: "River level" },
  { value: "groundwaterLevel", label: "Groundwater level" },
  { value: "rainfall", label: "Rainfall" },
];

export interface HydroStation {
  "@id"?: string;
  notation?: string;
  label?: unknown;
  stationReference?: string;
  stationGuid?: string;
  riverName?: string;
  catchmentName?: string;
  town?: string;
  lat?: number | number[];
  long?: number | number[];
  easting?: number;
  northing?: number;
  dateOpened?: string;
  dateClosed?: string;
  status?: unknown;
  observedProperty?: unknown;
  type?: unknown;
}

export interface HydroMeasure {
  "@id"?: string;
  notation?: string;
  label?: unknown;
  observedProperty?: unknown;
  observationType?: unknown;
  periodName?: unknown;
  period?: number;
  valueStatistic?: unknown;
  valueType?: unknown;
  unitName?: unknown;
  unit?: unknown;
  station?: unknown;
  datumType?: unknown;
}

export interface HydroReading {
  "@id"?: string;
  dateTime?: string;
  date?: string;
  value?: number | string | null;
  quality?: unknown;
  qcode?: unknown;
  completeness?: unknown;
  measure?: unknown;
}

function firstNum(v: unknown): number | null {
  return Array.isArray(v) ? num(v[0]) : num(v);
}

const STATION_COLUMNS = ["station_id", "label", "station_reference", "river_name", "catchment", "town", "observed_properties", "status", "date_opened", "date_closed", "latitude", "longitude", "distance_km"];

export function stationRow(s: HydroStation, origin?: { lat: number; lon: number }) {
  const lat = firstNum(s.lat);
  const lon = firstNum(s.long);
  const props = Array.isArray(s.observedProperty) ? s.observedProperty : s.observedProperty ? [s.observedProperty] : [];
  return {
    station_id: s.notation ?? lastSegment(s["@id"]),
    label: text(s.label),
    station_reference: s.stationReference ?? null,
    river_name: s.riverName ?? null,
    catchment: s.catchmentName ?? null,
    town: s.town ?? null,
    observed_properties: props.map((p) => lastSegment(p)).filter(Boolean).join("; ") || null,
    status: lastSegment(text(s.status)) ?? null,
    date_opened: s.dateOpened ?? null,
    date_closed: s.dateClosed ?? null,
    latitude: lat,
    longitude: lon,
    distance_km: origin && lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
  };
}

const MEASURE_COLUMNS = ["measure_id", "label", "observed_property", "period", "value_statistic", "unit", "quality_controlled", "station_id"];

export function measureRow(m: HydroMeasure) {
  const id = m.notation ?? lastSegment(m["@id"]);
  return {
    measure_id: id,
    label: text(m.label),
    observed_property: lastSegment(m.observedProperty) ?? null,
    period: text(m.periodName) ?? (m.period !== undefined ? `${m.period}s` : null),
    value_statistic: lastSegment(m.valueStatistic) ?? null,
    unit: text(m.unitName) ?? lastSegment(m.unit) ?? null,
    quality_controlled: id ? /qualified$/i.test(id) : null,
    station_id: lastSegment(m.station) ?? null,
  };
}

export interface DailySummary {
  date: string;
  readings: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  qualities: string | null;
}

/** Groups readings by calendar day (UTC) and summarises min/max/mean. Non-numeric values are counted but excluded from statistics. */
export function summariseDaily(readings: HydroReading[]): DailySummary[] {
  const byDay = new Map<string, { values: number[]; count: number; q: Set<string> }>();
  for (const r of readings) {
    const day = (r.date ?? r.dateTime ?? "").slice(0, 10);
    if (!day) continue;
    const entry = byDay.get(day) ?? { values: [], count: 0, q: new Set<string>() };
    entry.count += 1;
    const v = num(r.value);
    if (v !== null) entry.values.push(v);
    const q = lastSegment(text(r.quality));
    if (q) entry.q.add(q);
    byDay.set(day, entry);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, e]) => ({
      date,
      readings: e.count,
      min: e.values.length ? round(Math.min(...e.values), 3) : null,
      max: e.values.length ? round(Math.max(...e.values), 3) : null,
      mean: e.values.length ? round(e.values.reduce((s, v) => s + v, 0) / e.values.length, 3) : null,
      qualities: e.q.size ? Array.from(e.q).sort().join("; ") : null,
    }));
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export const definition = defineIntegration({
  id: "ea-hydrology",
  name: "EA Hydrology archive (flow, level, groundwater, rainfall)",
  group: "flood_water",
  access: "open",
  territory: "England",
  description: "Environment Agency Hydrology API: the quality-controlled long-term archive of river flow and level, groundwater level and rainfall time series from about 8,000 stations, with daily and 15-minute resolution.",
  docsUrl: "https://environment.data.gov.uk/hydrology/doc/reference",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The archive holds billions of rows; request only the measure, resolution and window you need. Readings are capped here at 20,000 per call (about 200 days of 15-minute data).",
    "Measure ids ending `-qualified` are quality-controlled historical series with a quality flag on every reading (Good, Estimated, Suspect, Unchecked, Missing). Other series are near-real-time and unchecked; the flood-monitoring API is the live feed.",
    "Date filters use the Linked Data API forms mineq-date and maxeq-date (inclusive) on the reading date; confirmed from the reference examples, not exercised live here.",
    "Station identifiers are GUIDs; the older stationReference (WISKI / RLOI) is carried as an annotation and links to the equivalent flood-monitoring station.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "id/stations.json", { _limit: 1 })),
  operations: [
    {
      id: "stations",
      label: "Hydrology stations near a point",
      description: "Archive stations within a radius of the point, optionally limited to one observed property.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "dist", label: "Radius (km)", type: "number", default: 10, min: 0.5, max: 50 },
        { name: "observedProperty", label: "Observed property", type: "select", default: "any", options: OBSERVED_PROPERTIES },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const url = buildUrl(BASE, "id/stations.json", { lat: origin.lat, long: origin.lon, dist: params.dist as number, observedProperty: params.observedProperty === "any" ? undefined : (params.observedProperty as string), _limit: 100 });
        const { data } = await fetchJson<EaList<HydroStation>>(ctx, url);
        const rows = (data.items ?? []).map((s) => stationRow(s, origin)).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        return {
          summary: rows.length ? `${rows.length} hydrology stations within ${params.dist} km; nearest ${rows[0].label ?? rows[0].station_id} (${rows[0].distance_km ?? "?"} km, ${rows[0].observed_properties ?? "unknown property"}).` : `No hydrology stations within ${params.dist} km.`,
          columns: STATION_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "hydrology/stations", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "measures",
      label: "Time series available at a station",
      description: "Measures (flow, level, rainfall series at each resolution) for one station, flagging which are quality-controlled.",
      params: [{ name: "stationId", label: "Station id (GUID or notation)", type: "string", required: true, placeholder: "e8d4c4b1-2b8e-4b0f-9c3b-0f0f6d4e1a11" }],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.stationId).trim();
        const url = buildUrl(BASE, `id/stations/${encodeURIComponent(id)}/measures.json`, { _limit: 100 });
        const { data, status } = await fetchJson<EaList<HydroMeasure>>(ctx, url, {}, { acceptStatuses: [404] });
        const rows = (data?.items ?? []).map(measureRow);
        const qc = rows.filter((r) => r.quality_controlled).length;
        return {
          summary: status === 404 ? `Station ${id} not found.` : rows.length ? `${rows.length} measures at station ${id}, ${qc} quality-controlled (${Array.from(new Set(rows.map((r) => r.observed_property).filter(Boolean))).join(", ")}).` : `No measures listed for station ${id}.`,
          columns: MEASURE_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "hydrology/measures", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "readings",
      label: "Readings for a measure over a date range",
      description: "Daily min/max/mean summary of a measure between two dates, with quality flags; the raw readings are kept in the payload.",
      params: [
        { name: "measureId", label: "Measure id", type: "string", required: true, placeholder: "...-flow-m-86400-m3s-qualified", help: "A measure notation from the station's measure list." },
        { name: "from", label: "From", type: "date", required: true, placeholder: "2026-01-01" },
        { name: "to", label: "To", type: "date", required: true, placeholder: "2026-01-31" },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.measureId).trim();
        const from = String(params.from);
        const to = String(params.to);
        const span = daysBetween(from, to);
        if (!Number.isFinite(span) || span < 0) throw new Error("`to` must be on or after `from`");
        if (span > 366) throw new Error("date range must be 366 days or less");
        const url = buildUrl(BASE, `id/measures/${encodeURIComponent(id)}/readings.json`, { "mineq-date": from, "maxeq-date": to, _limit: 20_000 });
        const { data, status } = await fetchJson<EaList<HydroReading>>(ctx, url, {}, { acceptStatuses: [404], timeoutMs: 60_000 });
        const readings = data?.items ?? [];
        const rows = summariseDaily(readings);
        const values = rows.filter((r) => r.mean !== null);
        const overall = values.length ? { min: Math.min(...values.map((r) => r.min as number)), max: Math.max(...values.map((r) => r.max as number)) } : null;
        const qualityControlled = /qualified$/i.test(id);
        return {
          summary: status === 404 ? `Measure ${id} not found.` : readings.length ? `${readings.length} readings on ${rows.length} days between ${from} and ${to}${overall ? `; overall range ${round(overall.min, 3)} to ${round(overall.max, 3)}` : ""}. Series is ${qualityControlled ? "quality-controlled" : "near-real-time, unchecked"}.${readings.length >= 20_000 ? " Capped at 20,000 readings; narrow the window." : ""}` : `No readings for ${id} between ${from} and ${to}.`,
          columns: ["date", "readings", "min", "max", "mean", "qualities"],
          rows,
          raw: trimItems(data ?? {}, 500),
          provenance: makeProvenance(definition, ctx, { dataset: `hydrology/readings (${qualityControlled ? "qualified" : "unchecked"})`, basis: readings.length ? "measured" : "unavailable" }),
          warnings: qualityControlled ? [] : ["This measure is not a `-qualified` series: values are provisional and unchecked."],
        };
      },
    },
  ],
});
