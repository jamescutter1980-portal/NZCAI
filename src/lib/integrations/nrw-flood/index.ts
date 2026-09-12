import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { haversineKm, num, round, text } from "../ea-flood-monitoring/ea-lda";

/**
 * Natural Resources Wales open-data APIs (Azure API Management):
 *   https://api.naturalresources.wales/floodwarnings/v3/all
 *   https://api.naturalresources.wales/floodwarnings/v3/distance/{metres}/latlon/{lat}/{lon}
 *   https://api.naturalresources.wales/floodforecast/v2/summary
 * Header: Ocp-Apim-Subscription-Key. Routes confirmed from the NRW API portal
 * (flood risk forecast) and open-source clients (flood warnings v3 all and
 * distance); the JSON field names of a warning were not confirmed, so they are
 * matched loosely. Not exercised live from this codebase.
 */

export const BASE = "https://api.naturalresources.wales";

type Loose = Record<string, unknown>;

function pick(o: Loose, ...names: string[]): unknown {
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase().replace(/[_\-\s]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[_\-\s]/g, ""));
    if (key !== undefined && o[key] !== null && o[key] !== undefined && o[key] !== "") return o[key];
  }
  return null;
}

export function listOf(data: unknown): Loose[] {
  if (Array.isArray(data)) return data as Loose[];
  if (data && typeof data === "object") {
    const o = data as Loose;
    for (const k of ["warnings", "items", "data", "results", "value", "features"]) {
      if (Array.isArray(o[k])) return (o[k] as Loose[]).map((x) => ((x as Loose).properties as Loose) ?? x);
    }
  }
  return [];
}

export const SEVERITY_LABELS: Record<number, string> = { 1: "Severe Flood Warning", 2: "Flood Warning", 3: "Flood Alert", 4: "Warning no longer in force" };

export function severityLevel(w: Loose): number | null {
  const n = num(pick(w, "severityLevel", "severity_level", "warningLevel", "level", "severityCode"));
  if (n !== null && n >= 1 && n <= 4) return n;
  const s = (text(pick(w, "severity", "warningType", "type", "warningLevelDescription", "status")) ?? "").toLowerCase();
  if (s.includes("severe")) return 1;
  if (s.includes("no longer") || s.includes("removed")) return 4;
  if (s.includes("warning")) return 2;
  if (s.includes("alert")) return 3;
  return null;
}

const COLUMNS = ["severity_level", "severity", "area", "area_code", "river_or_sea", "time_raised", "time_changed", "message", "latitude", "longitude", "distance_km"];

export function warningRow(w: Loose, origin?: { lat: number; lon: number }) {
  const level = severityLevel(w);
  const lat = num(pick(w, "lat", "latitude", "y"));
  const lon = num(pick(w, "lon", "long", "longitude", "x"));
  return {
    severity_level: level,
    severity: text(pick(w, "severity", "warningType", "warningLevelDescription")) ?? (level !== null ? SEVERITY_LABELS[level] : null),
    area: text(pick(w, "warningArea", "areaName", "area", "name", "title", "description", "warningAreaName")),
    area_code: text(pick(w, "fwaCode", "FWACode", "code", "areaCode", "warningAreaCode", "id")),
    river_or_sea: text(pick(w, "riverOrSea", "river", "waterBody", "catchment")),
    time_raised: text(pick(w, "timeRaised", "raisedDate", "dateRaised", "issued", "created", "startDate")),
    time_changed: text(pick(w, "timeSeverityChanged", "severityChanged", "lastUpdated", "updated", "modified", "changed")),
    message: (text(pick(w, "message", "messageEnglish", "situation", "text", "advice")) ?? "").replace(/\s+/g, " ").slice(0, 500) || null,
    latitude: lat,
    longitude: lon,
    distance_km: origin && lat !== null && lon !== null ? round(haversineKm(origin.lat, origin.lon, lat, lon)) : null,
  };
}

function headers(ctx: OperationContext): Record<string, string> {
  const key = ctx.env.NRW_API_KEY?.trim();
  if (!key) throw new Error("NRW_API_KEY is not configured");
  return { "Ocp-Apim-Subscription-Key": key };
}

function summarise(rows: ReturnType<typeof warningRow>[]): string {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.severity_level !== null) counts.set(r.severity_level, (counts.get(r.severity_level) ?? 0) + 1);
  return [1, 2, 3, 4].filter((l) => counts.has(l)).map((l) => `${counts.get(l)} ${SEVERITY_LABELS[l]}${counts.get(l)! > 1 ? "s" : ""}`).join(", ");
}

export const definition = defineIntegration({
  id: "nrw-flood",
  name: "NRW flood warnings and alerts (Wales)",
  group: "flood_water",
  access: "open_key",
  territory: "Wales",
  description: "Natural Resources Wales live flood warnings and alerts, near a point or across Wales, and the 5-day flood risk outlook, from the NRW open-data API (free subscription key).",
  docsUrl: "https://api-portal.naturalresources.wales/",
  termsUrl: "https://naturalresources.wales/evidence-and-data/accessing-our-data/access-our-data-maps-and-reports/?lang=en",
  attribution: "Contains Natural Resources Wales information © Natural Resources Wales and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [{ name: "NRW_API_KEY", required: true, description: "Ocp-Apim-Subscription-Key from the NRW API portal (register free, subscribe to the Flood Warnings and Flood Forecast products)." }],
  status: "built_unverified",
  notes: [
    "Register at api-portal.naturalresources.wales, subscribe to the open-data products (Live Flood Warnings and Alerts, Flood Risk Forecast, River Levels) and put the subscription key in NRW_API_KEY. Products may issue separate keys; one key subscribed to all products is simplest.",
    "Routes confirmed from the portal and open-source clients: floodwarnings/v3/all, floodwarnings/v3/distance/{metres}/latlon/{lat}/{lon}, floodforecast/v2/summary. Warning JSON field names were not confirmed and are matched loosely (area, severity, message, timestamps); check the first live response.",
    "The feed updates every 15 minutes and carries no service-level guarantee; it is not a safety-critical source and not a flood risk assessment. Long-term flood risk for Wales is on the Flood Map for Planning and NRW's flood risk viewer (no public API here).",
  ],
  healthCheck: simpleHealth(`${BASE}/floodwarnings/v3/all`, (env) => ({ headers: { "Ocp-Apim-Subscription-Key": env.NRW_API_KEY ?? "" } })),
  operations: [
    {
      id: "warnings-near",
      label: "Flood warnings and alerts in force near a point (Wales)",
      description: "NRW warnings and alerts whose area lies within a distance of the point.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.481" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-3.179" },
        { name: "distance", label: "Distance (m)", type: "integer", default: 10000, min: 100, max: 50000 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const origin = { lat: params.latitude as number, lon: params.longitude as number };
        const url = buildUrl(BASE, `floodwarnings/v3/distance/${params.distance}/latlon/${origin.lat}/${origin.lon}`);
        const { data } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx) });
        const rows = listOf(data).map((w) => warningRow(w, origin)).sort((a, b) => (a.severity_level ?? 9) - (b.severity_level ?? 9));
        return {
          summary: rows.length ? `${rows.length} NRW warnings/alerts within ${params.distance} m: ${summarise(rows)}.` : `No NRW flood warnings or alerts within ${params.distance} m of the point.`,
          columns: COLUMNS,
          rows,
          raw: Array.isArray(data) ? data.slice(0, 200) : data,
          provenance: makeProvenance(definition, ctx, { dataset: "floodwarnings/v3/distance", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Live warnings show what is in force now; absence of a warning is not absence of risk. Wales only."],
          links: [{ label: "NRW flood warnings", url: "https://naturalresources.wales/floodwarnings?lang=en" }],
        };
      },
    },
    {
      id: "warnings-all",
      label: "All flood warnings and alerts in force (Wales)",
      description: "Every NRW warning and alert currently in force.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "floodwarnings/v3/all");
        const { data } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx) });
        const rows = listOf(data).map((w) => warningRow(w)).sort((a, b) => (a.severity_level ?? 9) - (b.severity_level ?? 9));
        return {
          summary: rows.length ? `${rows.length} NRW warnings/alerts in force across Wales: ${summarise(rows)}.` : "No NRW flood warnings or alerts in force in Wales.",
          columns: COLUMNS,
          rows,
          raw: Array.isArray(data) ? data.slice(0, 200) : data,
          provenance: makeProvenance(definition, ctx, { dataset: "floodwarnings/v3/all", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Live operational feed; not a flood risk assessment."],
        };
      },
    },
    {
      id: "forecast",
      label: "5-day flood risk outlook (Wales)",
      description: "The NRW flood risk forecast summary for the coming days.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "floodforecast/v2/summary");
        const { data } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx) });
        const items = listOf(data);
        const rows = (items.length ? items : data && typeof data === "object" ? [data as Loose] : []).map((d) => ({
          day: text(pick(d, "day", "date", "forecastDate", "dayNumber")),
          risk_level: text(pick(d, "riskLevel", "risk", "level", "overallRisk", "floodRisk")),
          area: text(pick(d, "area", "region", "areaName")),
          summary: (text(pick(d, "summary", "statement", "text", "description", "englishStatement", "message")) ?? "").slice(0, 500) || null,
          issued: text(pick(d, "issued", "issuedAt", "published", "date")),
        }));
        return {
          summary: rows.length ? `${rows.length} forecast entries; ${rows.map((r) => `${r.day ?? r.area ?? "?"}: ${r.risk_level ?? r.summary ?? "n/a"}`).slice(0, 5).join("; ")}.` : "No forecast entries returned.",
          columns: ["day", "risk_level", "area", "summary", "issued"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "floodforecast/v2/summary", basis: rows.length ? "modelled" : "unavailable" }),
          warnings: ["National outlook for Wales, not site specific."],
        };
      },
    },
  ],
});
