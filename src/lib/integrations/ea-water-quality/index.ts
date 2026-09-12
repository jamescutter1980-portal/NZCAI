import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { type EaList, haversineKm, lastSegment, num, round, text, trimItems } from "../ea-flood-monitoring/ea-lda";

/**
 * Environment Agency Water Quality Archive (WIMS): sampling points and the
 * laboratory measurements taken at them, 2000 to present (England).
 * Reference: https://environment.data.gov.uk/water-quality/view/doc/reference
 *
 *   /id/sampling-point?lat&long&dist&_limit
 *   /data/measurement?samplingPoint=&startDate=&endDate=&determinand=&_limit&_sort
 * Measurement field names (sample.sampleDateTime, determinand.label,
 * determinand.unit.label, result, resultQualifier.notation) confirmed from
 * published CSV exports; not exercised live from this codebase.
 */

export const BASE = "https://environment.data.gov.uk/water-quality";

export interface SamplingPoint {
  "@id"?: string;
  notation?: string;
  label?: unknown;
  lat?: number;
  long?: number;
  easting?: number;
  northing?: number;
  samplingPointType?: unknown;
  samplingPointStatus?: unknown;
  area?: unknown;
  subArea?: unknown;
  comment?: unknown;
}

export interface Measurement {
  "@id"?: string;
  sample?: { "@id"?: string; sampleDateTime?: string; samplingPoint?: { "@id"?: string; notation?: string; label?: string }; sampledMaterialType?: unknown; purpose?: unknown; isComplianceSample?: boolean };
  determinand?: { "@id"?: string; label?: string; definition?: string; notation?: string; unit?: unknown };
  result?: number | string;
  resultQualifier?: { "@id"?: string; notation?: string };
  codedResultInterpretation?: unknown;
}

const POINT_COLUMNS = ["notation", "label", "type", "status", "area", "sub_area", "latitude", "longitude", "easting", "northing", "distance_km"];

export function pointRow(p: SamplingPoint, origin?: { lat: number; lon: number }) {
  const lat = num(p.lat);
  const lon = num(p.long);
  return {
    notation: p.notation ?? lastSegment(p["@id"]),
    label: text(p.label),
    type: text(p.samplingPointType),
    status: text(p.samplingPointStatus),
    area: text(p.area),
    sub_area: text(p.subArea),
    latitude: lat,
    longitude: lon,
    easting: num(p.easting),
    northing: num(p.northing),
    distance_km: origin && lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
  };
}

const MEASUREMENT_COLUMNS = ["sample_date_time", "determinand", "determinand_code", "result", "qualifier", "unit", "material", "purpose", "compliance_sample", "sampling_point"];

export function measurementRow(m: Measurement) {
  const qualifier = m.resultQualifier?.notation ?? null;
  return {
    sample_date_time: m.sample?.sampleDateTime ?? null,
    determinand: m.determinand?.definition ?? m.determinand?.label ?? null,
    determinand_code: m.determinand?.notation ?? null,
    result: num(m.result),
    qualifier,
    unit: text(m.determinand?.unit),
    material: text(m.sample?.sampledMaterialType),
    purpose: text(m.sample?.purpose),
    compliance_sample: m.sample?.isComplianceSample ?? null,
    sampling_point: m.sample?.samplingPoint?.notation ?? lastSegment(m.sample?.samplingPoint?.["@id"]),
  };
}

export const definition = defineIntegration({
  id: "ea-water-quality",
  name: "EA Water Quality Archive (WIMS)",
  group: "flood_water",
  access: "open",
  territory: "England",
  description: "Environment Agency water quality sampling points and laboratory measurements (rivers, lakes, groundwater, estuaries, discharges) from 2000 to date. Environmental context for a site's receiving waters; this is not a building's water consumption.",
  docsUrl: "https://environment.data.gov.uk/water-quality/view/doc/reference",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key; the archive is large (58 million measurements). Measurement queries are capped at 100 rows per call here; narrow by determinand or date.",
    "Results carry a qualifier `<` when below the limit of detection: treat such results as 'less than', not as the value.",
    "Environmental monitoring of receiving waters, not the site's own water use, discharge compliance or drinking water quality (DWI publishes the latter).",
    "Sampling point spatial filter (lat/long/dist) and the `determinand` filter (by notation) follow the archive reference; not exercised live from this codebase.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "id/sampling-point.json", { _limit: 1 })),
  operations: [
    {
      id: "sampling-points",
      label: "Water quality sampling points near a point",
      description: "WIMS sampling points within a radius, with type and status.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "dist", label: "Radius (km)", type: "number", default: 3, min: 0.1, max: 25 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const url = buildUrl(BASE, "id/sampling-point.json", { lat: origin.lat, long: origin.lon, dist: params.dist as number, _limit: 100 });
        const { data } = await fetchJson<EaList<SamplingPoint>>(ctx, url);
        const rows = (data.items ?? []).map((p) => pointRow(p, origin)).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        const types = Array.from(new Set(rows.map((r) => r.type).filter(Boolean)));
        return {
          summary: rows.length ? `${rows.length} sampling points within ${params.dist} km (${types.slice(0, 4).join("; ")}${types.length > 4 ? "; ..." : ""}); nearest ${rows[0].label ?? rows[0].notation} at ${rows[0].distance_km ?? "?"} km.` : `No WIMS sampling points within ${params.dist} km.`,
          columns: POINT_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "water-quality/sampling-point", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Sampling points may be closed or sampled rarely; check status and recent measurements before relying on one."],
        };
      },
    },
    {
      id: "measurements",
      label: "Recent measurements at a sampling point",
      description: "Laboratory results for one sampling point in a date window, newest first, optionally for one determinand.",
      params: [
        { name: "samplingPoint", label: "Sampling point notation", type: "string", required: true, placeholder: "AN-TRENT-01", help: "The notation from a sampling point search, e.g. SW-60250424." },
        { name: "startDate", label: "Start date", type: "date", required: false, placeholder: "2025-01-01" },
        { name: "endDate", label: "End date", type: "date", required: false, placeholder: "2025-12-31" },
        { name: "determinand", label: "Determinand code", type: "string", required: false, placeholder: "0117", help: "Optional WIMS determinand notation, e.g. 0117 Nitrate as N, 0180 Orthophosphate, 0061 pH." },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const sp = String(params.samplingPoint).trim();
        const url = buildUrl(BASE, "data/measurement.json", {
          samplingPoint: sp,
          startDate: params.startDate as string | undefined,
          endDate: params.endDate as string | undefined,
          determinand: params.determinand as string | undefined,
          _sort: "-sample.sampleDateTime",
          _limit: 100,
        });
        const { data } = await fetchJson<EaList<Measurement>>(ctx, url);
        const rows = (data.items ?? []).map(measurementRow);
        const dets = Array.from(new Set(rows.map((r) => r.determinand).filter(Boolean)));
        const first = rows[0];
        return {
          summary: rows.length ? `${rows.length} measurements at ${sp}${rows.length === 100 ? " (capped at 100)" : ""}, ${dets.length} determinands; latest ${first.determinand} ${first.qualifier ?? ""}${first.result ?? "n/a"} ${first.unit ?? ""} on ${first.sample_date_time ?? "n/a"}.` : `No measurements found for ${sp} in that window.`,
          columns: MEASUREMENT_COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "water-quality/measurement", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["A `<` qualifier means below the detection limit. Results are spot samples of the water body, not a compliance assessment."],
        };
      },
    },
  ],
});
