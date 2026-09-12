import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";
import { UK_CDD_BASE_C, UK_HDD_BASE_C, dailyDegreeDays, degreeDayTotals } from "../_shared/degree-days";

/**
 * Open-Meteo weather forecast and ERA5-based historical archive.
 *
 * Built from the OpenAPI specs in github.com/open-meteo/open-meteo (openapi/forecast.yml,
 * openapi/historical-weather.yml). Free tier uses api.open-meteo.com and
 * archive-api.open-meteo.com; a commercial key switches to the customer-* hosts and
 * adds &apikey=. Not exercised live from this environment.
 */

const FORECAST_HOST = "https://api.open-meteo.com";
const ARCHIVE_HOST = "https://archive-api.open-meteo.com";
const CUSTOMER_FORECAST_HOST = "https://customer-api.open-meteo.com";
const CUSTOMER_ARCHIVE_HOST = "https://customer-archive-api.open-meteo.com";
const TIMEZONE = "Europe/London";
const MAX_DAILY_DAYS = 366;
const MAX_HOURLY_DAYS = 14;

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone?: string;
  utc_offset_seconds?: number;
  daily_units?: Record<string, string>;
  daily?: Record<string, (number | null)[] | string[]> & { time: string[] };
  hourly_units?: Record<string, string>;
  hourly?: Record<string, (number | null)[] | string[]> & { time: string[] };
  error?: boolean;
  reason?: string;
}

function hosts(env: EnvLike) {
  const key = env.OPEN_METEO_API_KEY?.trim();
  return key ? { forecast: CUSTOMER_FORECAST_HOST, archive: CUSTOMER_ARCHIVE_HOST, apikey: key } : { forecast: FORECAST_HOST, archive: ARCHIVE_HOST, apikey: undefined };
}

function series(block: Record<string, (number | null)[] | string[]> | undefined, key: string): (number | null)[] {
  const v = block?.[key];
  return Array.isArray(v) ? (v as (number | null)[]) : [];
}

function round(v: number | null | undefined, dp = 1): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000);
}

function assertRange(start: string, end: string, maxDays: number) {
  const n = daysBetween(start, end);
  if (Number.isNaN(n)) throw new Error("Dates must be valid YYYY-MM-DD");
  if (n < 0) throw new Error("end_date must be on or after start_date");
  if (n + 1 > maxDays) throw new Error(`Date range is limited to ${maxDays} days per request`);
}

const HISTORY_WARNINGS = [
  "Historical values come from the ERA5 / ERA5-Land reanalysis (modelled, ~9-11 km grid), not a weather station; they lag real time by about five days.",
  "Degree days use the daily-mean method (max(0, base - mean)); Met Office and CIBSE tables use a max-min method, so totals can differ slightly.",
  "Outdoor temperature alone does not establish overheating risk in a building; internal gains, ventilation and glazing dominate.",
];

export const definition = defineIntegration({
  id: "open-meteo",
  name: "Open-Meteo",
  group: "weather",
  access: "open",
  territory: "Global",
  description: "Free weather API: 16-day forecasts from national weather models and an ERA5-based historical archive back to 1940. Used for outdoor temperature, degree days and solar radiation at a point.",
  docsUrl: "https://open-meteo.com/en/docs",
  termsUrl: "https://open-meteo.com/en/terms",
  attribution: "Weather data by Open-Meteo.com (CC BY 4.0).",
  licence: "CC_BY",
  envVars: [{ name: "OPEN_METEO_API_KEY", required: false, description: "Commercial API key. When set, requests go to the customer-* hosts with &apikey=; required for commercial use." }],
  status: "built_unverified",
  notes: [
    "Licence: data CC BY 4.0, free for non-commercial use (under 10,000 calls/day); commercial use needs a subscription and the OPEN_METEO_API_KEY.",
    "Attribution 'Weather data by Open-Meteo.com' must be shown wherever the data is displayed.",
    "Historical archive is ERA5 reanalysis with a delay of about 5 days; it is modelled, not observed. Recent days can be filled from the forecast API's past_days if needed.",
    "Timezone is fixed to Europe/London so daily aggregates align with UK calendar days.",
    "Built from the OpenAPI specs in the open-meteo GitHub repository; no live call made from this environment.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const h = hosts(ctx.env);
    const url = buildUrl(h.forecast, "v1/forecast", { latitude: 51.5, longitude: -0.12, daily: "temperature_2m_max", forecast_days: 1, timezone: TIMEZONE, apikey: h.apikey });
    const started = Date.now();
    try {
      const { data } = await fetchJson<OpenMeteoResponse>(ctx, url, {}, { timeoutMs: 15_000 });
      return { ok: Array.isArray(data.daily?.time), detail: data.daily?.time ? `daily ok (${h.apikey ? "customer host" : "free host"})` : "unexpected body", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "daily-history",
      label: "Daily weather history with degree days",
      description: "Daily mean, max and min temperature, rainfall and solar radiation for a point and date range, with heating and cooling degree-day totals.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2025-01-01" },
        { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2025-12-31", help: `Up to ${MAX_DAILY_DAYS} days per request; the archive lags by about 5 days.` },
        { name: "hdd_base", label: "Heating base (°C)", type: "number", default: UK_HDD_BASE_C, min: 0, max: 30, help: "UK convention 15.5 °C" },
        { name: "cdd_base", label: "Cooling base (°C)", type: "number", default: UK_CDD_BASE_C, min: 0, max: 35, help: "UK convention 22 °C" },
      ],
      async run(params, ctx) {
        const start = String(params.start_date);
        const end = String(params.end_date);
        assertRange(start, end, MAX_DAILY_DAYS);
        const h = hosts(ctx.env);
        const url = buildUrl(h.archive, "v1/archive", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          start_date: start,
          end_date: end,
          daily: "temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,shortwave_radiation_sum",
          timezone: TIMEZONE,
          apikey: h.apikey,
        });
        const { data } = await fetchJson<OpenMeteoResponse>(ctx, url, {}, { timeoutMs: 30_000 });
        const time = data.daily?.time ?? [];
        const columns = ["date", "temp_mean_c", "temp_max_c", "temp_min_c", "precipitation_mm", "shortwave_radiation_mj_m2", "hdd", "cdd"];
        if (!time.length) {
          return { summary: `No daily data returned for ${start} to ${end}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "archive/daily", basis: "unavailable" }) };
        }
        const means = series(data.daily, "temperature_2m_mean");
        const opts = { hddBase: Number(params.hdd_base ?? UK_HDD_BASE_C), cddBase: Number(params.cdd_base ?? UK_CDD_BASE_C) };
        const dd = dailyDegreeDays(means, opts);
        const totals = degreeDayTotals(means, opts);
        const maxs = series(data.daily, "temperature_2m_max");
        const mins = series(data.daily, "temperature_2m_min");
        const precip = series(data.daily, "precipitation_sum");
        const rad = series(data.daily, "shortwave_radiation_sum");
        const rows = time.map((date, i) => ({
          date,
          temp_mean_c: round(means[i]),
          temp_max_c: round(maxs[i]),
          temp_min_c: round(mins[i]),
          precipitation_mm: round(precip[i]),
          shortwave_radiation_mj_m2: round(rad[i], 2),
          hdd: round(dd[i].hdd, 2),
          cdd: round(dd[i].cdd, 2),
        }));
        const rainTotal = precip.reduce<number>((a, v) => a + (v ?? 0), 0);
        const warnings = [...HISTORY_WARNINGS];
        if (totals.missing) warnings.push(`${totals.missing} day(s) had no mean temperature and were excluded from the degree-day totals.`);
        return {
          summary: `${totals.days} days from ${start} to ${end}: mean ${round(totals.meanTemperature)} °C, ${round(totals.hdd, 0)} heating degree days (base ${totals.hddBase} °C), ${round(totals.cdd, 0)} cooling degree days (base ${totals.cddBase} °C), ${round(rainTotal, 0)} mm rain.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "archive/daily", basis: "modelled", version: "ERA5" }),
          warnings,
        };
      },
    },
    {
      id: "forecast",
      label: "Daily forecast",
      description: "Daily max, min and mean temperature and rainfall for the next 1 to 16 days (default 7). Hourly temperature, rain, wind and solar radiation are included in the raw payload.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "days", label: "Forecast days", type: "integer", default: 7, min: 1, max: 16 },
      ],
      async run(params, ctx) {
        const h = hosts(ctx.env);
        const url = buildUrl(h.forecast, "v1/forecast", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          hourly: "temperature_2m,precipitation,wind_speed_10m,shortwave_radiation",
          daily: "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum",
          timezone: TIMEZONE,
          forecast_days: Number(params.days ?? 7),
          apikey: h.apikey,
        });
        const { data } = await fetchJson<OpenMeteoResponse>(ctx, url);
        const time = data.daily?.time ?? [];
        const columns = ["date", "temp_max_c", "temp_min_c", "temp_mean_c", "precipitation_mm"];
        if (!time.length) {
          return { summary: "No forecast returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "forecast/daily", basis: "unavailable" }) };
        }
        const maxs = series(data.daily, "temperature_2m_max");
        const mins = series(data.daily, "temperature_2m_min");
        const means = series(data.daily, "temperature_2m_mean");
        const precip = series(data.daily, "precipitation_sum");
        const rows = time.map((date, i) => ({ date, temp_max_c: round(maxs[i]), temp_min_c: round(mins[i]), temp_mean_c: round(means[i]), precipitation_mm: round(precip[i]) }));
        const hi = Math.max(...maxs.filter((v): v is number => v !== null));
        const lo = Math.min(...mins.filter((v): v is number => v !== null));
        const rain = precip.reduce<number>((a, v) => a + (v ?? 0), 0);
        return {
          summary: `${time.length}-day forecast from ${time[0]}: highs up to ${round(hi)} °C, lows down to ${round(lo)} °C, ${round(rain, 0)} mm rain in total.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "forecast/daily", basis: "modelled" }),
          warnings: ["This is a forecast, not a measurement; skill falls off beyond about 5 days.", "Outdoor temperature alone does not establish overheating risk in a building."],
        };
      },
    },
    {
      id: "hourly-history",
      label: "Hourly weather history (short range)",
      description: "Hourly temperature, rainfall, wind speed and solar radiation from the reanalysis archive for up to 14 days.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2025-07-01" },
        { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2025-07-07", help: `Up to ${MAX_HOURLY_DAYS} days per request.` },
      ],
      async run(params, ctx) {
        const start = String(params.start_date);
        const end = String(params.end_date);
        assertRange(start, end, MAX_HOURLY_DAYS);
        const h = hosts(ctx.env);
        const url = buildUrl(h.archive, "v1/archive", {
          latitude: params.latitude as number,
          longitude: params.longitude as number,
          start_date: start,
          end_date: end,
          hourly: "temperature_2m,precipitation,wind_speed_10m,shortwave_radiation",
          timezone: TIMEZONE,
          apikey: h.apikey,
        });
        const { data } = await fetchJson<OpenMeteoResponse>(ctx, url, {}, { timeoutMs: 30_000 });
        const time = data.hourly?.time ?? [];
        const units = data.hourly_units ?? {};
        const windUnit = units.wind_speed_10m ?? "km/h";
        const columns = ["time", "temp_c", "precipitation_mm", `wind_speed_${windUnit.replace(/[^a-z0-9]/gi, "").toLowerCase()}`, "shortwave_radiation_w_m2"];
        if (!time.length) {
          return { summary: `No hourly data returned for ${start} to ${end}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "archive/hourly", basis: "unavailable" }) };
        }
        const temp = series(data.hourly, "temperature_2m");
        const precip = series(data.hourly, "precipitation");
        const wind = series(data.hourly, "wind_speed_10m");
        const rad = series(data.hourly, "shortwave_radiation");
        const rows = time.map((t, i) => ({ time: t, temp_c: round(temp[i]), precipitation_mm: round(precip[i], 2), [columns[3]]: round(wind[i]), shortwave_radiation_w_m2: round(rad[i], 0) }));
        const valid = temp.filter((v): v is number => v !== null);
        const radKwh = rad.reduce<number>((a, v) => a + (v ?? 0), 0) / 1000;
        return {
          summary: `${time.length} hours from ${start} to ${end}: temperature ${round(Math.min(...valid))} to ${round(Math.max(...valid))} °C, ${round(radKwh, 1)} kWh/m² global horizontal radiation.`,
          columns,
          rows,
          raw: { ...data, hourly: undefined, hourly_rows: time.length },
          provenance: makeProvenance(definition, ctx, { dataset: "archive/hourly", basis: "modelled", version: "ERA5" }),
          warnings: HISTORY_WARNINGS.slice(0, 1).concat(["Hourly reanalysis values are grid-cell averages and smooth out local extremes."]),
        };
      },
    },
  ],
});
