import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * Solcast irradiance and rooftop PV forecasts.
 *
 * Endpoint paths and parameter handling from the official solcast-api-python-sdk
 * (solcast/urls.py, solcast/api.py: the SDK sends the key as `Authorization: Bearer`,
 * joins output_parameters with commas and only supports format=json). Response shape
 * ({"forecasts": [{period_end, period, ...}]}, {"estimated_actuals": [...]}) from the SDK
 * docs and open-source consumers. Not exercised live from this environment.
 */

const BASE = "https://api.solcast.com.au";
/** Solcast's unmetered test location (Sydney Opera House); calls here do not consume quota. */
const UNMETERED = { latitude: -33.856784, longitude: 151.215297 };
const MAX_HOURS = 168;

interface ForecastPoint {
  period_end: string;
  period: string;
  ghi?: number;
  dni?: number;
  dhi?: number;
  air_temp?: number;
  cloud_opacity?: number;
  pv_power_rooftop?: number;
}

interface ForecastResponse {
  forecasts?: ForecastPoint[];
  estimated_actuals?: ForecastPoint[];
}

function auth(env: EnvLike): Record<string, string> {
  const key = env.SOLCAST_API_KEY?.trim();
  if (!key) throw new Error("SOLCAST_API_KEY is not set");
  return { authorization: `Bearer ${key}` };
}

function periodHours(iso: string | undefined): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? "");
  if (!m) return 0.5;
  return Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60;
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function r(v: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

const POINT = [
  { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
  { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
] as const;

export const definition = defineIntegration({
  id: "solcast",
  name: "Solcast",
  group: "solar",
  access: "commercial",
  territory: "Global",
  description: "Satellite-nowcast and NWP-based solar irradiance (GHI, DNI, DHI), weather and rooftop PV power forecasts up to 14 days ahead, plus live estimated actuals, for any point.",
  docsUrl: "https://docs.solcast.com.au/",
  termsUrl: "https://solcast.com/terms-and-conditions",
  attribution: "Solar forecast data © Solcast (solcast.com).",
  licence: "commercial",
  envVars: [{ name: "SOLCAST_API_KEY", required: true, description: "Solcast API key (sent as Authorization: Bearer). Free 'Hobbyist' keys are limited to 10 calls/day and non-commercial use; commercial plans by subscription." }],
  status: "built_unverified",
  notes: [
    "Commercial service; the free hobbyist tier is for personal, non-commercial use and returns 429 once its daily quota is used.",
    "Calls to Solcast's unmetered test location (Sydney Opera House) do not consume quota; the health check uses it.",
    "Rooftop PV forecasts use Solcast's basic rooftop model, suitable for residential and small C&I roofs only. Azimuth follows Solcast's convention (0 = north, -90 = east, 90 = west, 180 = south; northern-hemisphere south-facing = 180) - not confirmed live, check the docs before relying on it.",
    "Forecast horizon is up to 336 hours; this connector caps requests at 168 hours (7 days) to keep result sizes manageable.",
    "Built from the official Python SDK's URL and parameter handling; response field names from SDK docs. Not exercised live from this environment.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const url = buildUrl(BASE, "data/forecast/radiation_and_weather", { ...UNMETERED, hours: 1, output_parameters: "ghi", format: "json" });
      const { data } = await fetchJson<ForecastResponse>(ctx, url, { headers: auth(ctx.env) }, { timeoutMs: 15_000 });
      const count = data.forecasts?.length ?? 0;
      return { ok: count > 0, detail: count ? `${count} forecast periods at the unmetered test site` : "no forecasts in response", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "irradiance-forecast",
      label: "Irradiance forecast at a point",
      description: "GHI, DNI, DHI and air temperature for each 30- or 60-minute period over the next hours.",
      params: [
        ...POINT,
        { name: "hours", label: "Hours ahead", type: "integer", default: 48, min: 1, max: MAX_HOURS },
        { name: "period", label: "Period", type: "select", default: "PT30M", options: [{ value: "PT30M", label: "30 minutes" }, { value: "PT60M", label: "60 minutes" }] },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "data/forecast/radiation_and_weather", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          hours: Number(params.hours ?? 48),
          period: String(params.period ?? "PT30M"),
          output_parameters: "ghi,dni,dhi,air_temp",
          format: "json",
        });
        const { data } = await fetchJson<ForecastResponse>(ctx, url, { headers: auth(ctx.env) });
        const points = data.forecasts ?? [];
        const columns = ["period_end", "ghi_w_m2", "dni_w_m2", "dhi_w_m2", "air_temp_c"];
        if (!points.length) {
          return { summary: "No irradiance forecast returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "forecast/radiation_and_weather", basis: "unavailable" }) };
        }
        const rows = points.map((p) => ({ period_end: p.period_end, ghi_w_m2: n(p.ghi), dni_w_m2: n(p.dni), dhi_w_m2: n(p.dhi), air_temp_c: n(p.air_temp) }));
        const h = periodHours(points[0].period);
        const ghiKwh = points.reduce((a, p) => a + (p.ghi ?? 0) * h, 0) / 1000;
        const peak = Math.max(...points.map((p) => p.ghi ?? 0));
        return {
          summary: `${rows.length} periods to ${rows[rows.length - 1].period_end}: about ${r(ghiKwh, 2)} kWh/m² global horizontal irradiation, peak GHI ${r(peak, 0)} W/m².`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "forecast/radiation_and_weather", basis: "modelled" }),
          warnings: ["Forecast, not measurement; beyond about 4 hours the values come from numerical weather models rather than satellite nowcasts."],
        };
      },
    },
    {
      id: "rooftop-pv-forecast",
      label: "Rooftop PV power forecast",
      description: "Expected AC power from a rooftop array of given capacity, tilt and orientation for each period over the next hours.",
      params: [
        ...POINT,
        { name: "capacity_kw", label: "Capacity (kW AC)", type: "number", required: true, placeholder: "10", min: 0.1, max: 5000 },
        { name: "tilt_deg", label: "Tilt (°)", type: "number", default: 30, min: 0, max: 90 },
        { name: "azimuth_deg", label: "Azimuth (Solcast convention)", type: "number", default: 180, min: -180, max: 180, help: "0 = north, -90 = east, 90 = west, 180 = south." },
        { name: "hours", label: "Hours ahead", type: "integer", default: 48, min: 1, max: MAX_HOURS },
        { name: "loss_factor", label: "Loss factor", type: "number", default: 0.9, min: 0.5, max: 1, help: "Fraction of DC output reaching the meter after inverter, wiring and soiling losses." },
      ],
      async run(params, ctx) {
        const capacity = Number(params.capacity_kw);
        const url = buildUrl(BASE, "data/forecast/rooftop_pv_power", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          capacity,
          tilt: Number(params.tilt_deg ?? 30),
          azimuth: Number(params.azimuth_deg ?? 180),
          loss_factor: Number(params.loss_factor ?? 0.9),
          hours: Number(params.hours ?? 48),
          period: "PT30M",
          output_parameters: "pv_power_rooftop",
          format: "json",
        });
        const { data } = await fetchJson<ForecastResponse>(ctx, url, { headers: auth(ctx.env) });
        const points = data.forecasts ?? [];
        const columns = ["period_end", "pv_power_kw"];
        if (!points.length) {
          return { summary: "No PV power forecast returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "forecast/rooftop_pv_power", basis: "unavailable" }) };
        }
        const h = periodHours(points[0].period);
        const rows = points.map((p) => ({ period_end: p.period_end, pv_power_kw: n(p.pv_power_rooftop) }));
        const kwh = points.reduce((a, p) => a + (p.pv_power_rooftop ?? 0) * h, 0);
        const peak = Math.max(...points.map((p) => p.pv_power_rooftop ?? 0));
        return {
          summary: `${capacity} kW array: about ${r(kwh, 1)} kWh expected over the next ${rows.length * h} hours, peaking at ${r(peak, 2)} kW.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "forecast/rooftop_pv_power", basis: "modelled" }),
          warnings: ["Modelled from a generic rooftop PV model and the irradiance forecast; it is not a metered reading and does not account for site shading, curtailment or outages."],
        };
      },
    },
    {
      id: "live-irradiance",
      label: "Recent irradiance (estimated actuals)",
      description: "Satellite-derived estimates of GHI, DNI and air temperature for the past hours at a point.",
      params: [...POINT, { name: "hours", label: "Hours back", type: "integer", default: 24, min: 1, max: MAX_HOURS }],
      async run(params, ctx) {
        const url = buildUrl(BASE, "data/live/radiation_and_weather", { latitude: params.latitude as number, longitude: params.longitude as number, hours: Number(params.hours ?? 24), output_parameters: "ghi,dni,air_temp", format: "json" });
        const { data } = await fetchJson<ForecastResponse>(ctx, url, { headers: auth(ctx.env) });
        const points = data.estimated_actuals ?? [];
        const columns = ["period_end", "ghi_w_m2", "dni_w_m2", "air_temp_c"];
        if (!points.length) {
          return { summary: "No estimated actuals returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "live/radiation_and_weather", basis: "unavailable" }) };
        }
        const rows = points.map((p) => ({ period_end: p.period_end, ghi_w_m2: n(p.ghi), dni_w_m2: n(p.dni), air_temp_c: n(p.air_temp) }));
        const h = periodHours(points[0].period);
        const ghiKwh = points.reduce((a, p) => a + (p.ghi ?? 0) * h, 0) / 1000;
        return {
          summary: `${rows.length} periods of estimated actuals: about ${r(ghiKwh, 2)} kWh/m² global horizontal irradiation.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "live/radiation_and_weather", basis: "modelled" }),
          warnings: ["Estimated actuals are satellite-derived estimates, not pyranometer measurements."],
        };
      },
    },
  ],
});
