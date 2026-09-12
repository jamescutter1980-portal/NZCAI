import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult } from "../framework";

/**
 * Open Charge Map POI API v3.
 *
 * Built from the OCM API documentation (https://openchargemap.org/site/develop/api)
 * and open-source clients; no live call has been made from this codebase.
 */

export const BASE = "https://api.openchargemap.io/v3";

function apiKey(env: EnvLike): string {
  const key = env.OPEN_CHARGE_MAP_API_KEY?.trim();
  if (!key) throw new Error("OPEN_CHARGE_MAP_API_KEY is not set. Get a free key at https://openchargemap.org/site/profile/applications");
  return key;
}

interface Poi {
  ID?: number;
  UUID?: string;
  AddressInfo?: { Title?: string; AddressLine1?: string; Town?: string; Postcode?: string; Latitude?: number; Longitude?: number; Distance?: number; DistanceUnit?: number };
  Connections?: { PowerKW?: number; Quantity?: number; ConnectionType?: { Title?: string }; CurrentType?: { Title?: string }; Level?: { Title?: string } }[];
  OperatorInfo?: { Title?: string };
  StatusType?: { Title?: string; IsOperational?: boolean };
  UsageType?: { Title?: string; IsPayAtLocation?: boolean; IsMembershipRequired?: boolean };
  NumberOfPoints?: number;
  DateLastVerified?: string;
  DateLastStatusUpdate?: string;
  DataProvider?: { Title?: string };
}

export const COLUMNS = ["name", "operator", "max_kw", "connectors", "connector_types", "status", "usage", "distance_km", "postcode", "address", "latitude", "longitude", "last_verified", "ocm_id"];

export function toRow(p: Poi) {
  const conns = p.Connections ?? [];
  const maxKw = conns.reduce((m, c) => Math.max(m, c.PowerKW ?? 0), 0);
  const types = [...new Set(conns.map((c) => c.ConnectionType?.Title).filter(Boolean))].join("; ");
  return {
    name: p.AddressInfo?.Title ?? null,
    operator: p.OperatorInfo?.Title ?? null,
    max_kw: maxKw || null,
    connectors: conns.reduce((n, c) => n + (c.Quantity ?? 1), 0) || p.NumberOfPoints || null,
    connector_types: types || null,
    status: p.StatusType?.Title ?? null,
    usage: p.UsageType?.Title ?? null,
    distance_km: p.AddressInfo?.Distance !== undefined ? Math.round(p.AddressInfo.Distance * 100) / 100 : null,
    postcode: p.AddressInfo?.Postcode ?? null,
    address: [p.AddressInfo?.AddressLine1, p.AddressInfo?.Town].filter(Boolean).join(", ") || null,
    latitude: p.AddressInfo?.Latitude ?? null,
    longitude: p.AddressInfo?.Longitude ?? null,
    last_verified: p.DateLastVerified ?? p.DateLastStatusUpdate ?? null,
    ocm_id: p.ID ?? null,
  };
}

export const definition = defineIntegration({
  id: "open-charge-map",
  name: "Open Charge Map",
  group: "transport",
  access: "open_key",
  territory: "Global",
  description: "Crowd-sourced and operator-contributed register of public EV charge points: location, operator, connector types and power, status and usage terms. Used to assess charging availability around a site for fleet electrification.",
  docsUrl: "https://openchargemap.org/site/develop/api",
  termsUrl: "https://openchargemap.org/site/about/terms",
  attribution: "Charge point data © Open Charge Map contributors, licensed under the Open Database Licence (ODbL) and CC BY-SA 4.0 for content.",
  licence: "CC_BY_SA",
  envVars: [{ name: "OPEN_CHARGE_MAP_API_KEY", required: true, description: "Free API key from an Open Charge Map account; sent as X-API-Key." }],
  status: "built_unverified",
  notes: [
    "Data is community-maintained with operator imports; status and connector counts can be stale. Verify before relying on a specific site for a fleet plan.",
    "The UK National Chargepoint Registry (NCR) was decommissioned in November 2024; Open Charge Map and operator feeds are the remaining open sources. DfT publishes quarterly charge point statistics separately.",
    "ODbL requires attribution and share-alike for derived databases; check the terms before redistributing extracts.",
    "Distance is calculated by the API in the requested unit (km here). Results are capped at 100 per call.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    try {
      const res = await ctx.fetch(buildUrl(BASE, "poi", { countrycode: "GB", maxresults: 1, compact: true, verbose: false }), { headers: { "X-API-Key": apiKey(ctx.env), accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? { ok: true, detail: `HTTP ${res.status}`, latencyMs: Date.now() - started } : { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "nearby",
      label: "Charge points near a point",
      description: "Public charge points within a radius, nearest first, with operator, maximum power and connector types.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "distance_km", label: "Radius (km)", type: "number", default: 5, min: 0.1, max: 100 },
        { name: "max_results", label: "Maximum results", type: "integer", default: 50, min: 1, max: 100 },
        { name: "country_code", label: "Country code", type: "string", default: "GB", placeholder: "GB" },
        { name: "min_kw", label: "Minimum power (kW)", type: "number", min: 0, help: "Filter to sites with at least one connector at this power." },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "poi", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          distance: params.distance_km as number,
          distanceunit: "km",
          maxresults: params.max_results as number,
          countrycode: String(params.country_code ?? "GB").toUpperCase(),
          compact: true,
          verbose: false,
          minpowerkw: params.min_kw as number | undefined,
        });
        const { data } = await fetchJson<Poi[]>(ctx, url, { headers: { "X-API-Key": apiKey(ctx.env) } });
        const rows = (Array.isArray(data) ? data : []).map(toRow).sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
        const rapid = rows.filter((r) => (r.max_kw ?? 0) >= 50).length;
        const operational = rows.filter((r) => /operational/i.test(r.status ?? "") && !/not/i.test(r.status ?? "")).length;
        return {
          summary: `${rows.length} charge point sites within ${params.distance_km} km of ${params.latitude}, ${params.longitude}; ${rapid} with 50 kW or faster, ${operational} marked operational.${rows[0] ? ` Nearest: ${rows[0].name ?? "unnamed"} (${rows[0].distance_km ?? "?"} km, ${rows[0].max_kw ?? "?"} kW).` : ""}`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "poi", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Community-maintained data; status, power and connector counts may be out of date."],
        };
      },
    },
  ],
});
