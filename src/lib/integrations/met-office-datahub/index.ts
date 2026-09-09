import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * Met Office Weather DataHub, site-specific forecast (Global Spot).
 *
 * Request shape confirmed from the Met Office's own example script
 * (github.com/MetOffice/weather_datahub_utilities, site_specific_download/ss_download.py):
 * GET https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/{hourly|three-hourly|daily}
 * with header `apikey` and query latitude, longitude, includeLocationName, excludeParameterMetadata.
 * Response field names taken from three open-source clients (Home Assistant metoffice,
 * MagicMirror ukmetofficedatahub, Breezy Weather). Not exercised live from this environment.
 */

const BASE = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point";
const HOURLY_LIMIT = 48;

interface HourlyStep {
  time: string;
  screenTemperature?: number;
  feelsLikeTemperature?: number;
  totalPrecipAmount?: number;
  probOfPrecipitation?: number;
  windSpeed10m?: number;
  windGustSpeed10m?: number;
  windDirectionFrom10m?: number;
  screenRelativeHumidity?: number;
  uvIndex?: number;
  mslp?: number;
  significantWeatherCode?: number;
}

interface DailyStep {
  time: string;
  dayMaxScreenTemperature?: number;
  nightMinScreenTemperature?: number;
  dayMaxFeelsLikeTemp?: number;
  nightMinFeelsLikeTemp?: number;
  dayProbabilityOfPrecipitation?: number;
  nightProbabilityOfPrecipitation?: number;
  midday10MWindSpeed?: number;
  midday10MWindGust?: number;
  midday10MWindDirection?: number;
  middayRelativeHumidity?: number;
  maxUvIndex?: number;
  daySignificantWeatherCode?: number;
  nightSignificantWeatherCode?: number;
}

interface SiteSpecificResponse<T> {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number, number?] };
    properties: {
      location?: { name?: string };
      requestPointDistance?: number;
      modelRunDate?: string;
      timeSeries: T[];
    };
  }[];
  parameters?: unknown[];
}

function headers(env: EnvLike): Record<string, string> {
  const key = env.MET_OFFICE_DATAHUB_API_KEY?.trim();
  if (!key) throw new Error("MET_OFFICE_DATAHUB_API_KEY is not set");
  return { apikey: key };
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pointUrl(kind: "hourly" | "three-hourly" | "daily", params: Record<string, unknown>) {
  return buildUrl(BASE, kind, { latitude: params.latitude as number, longitude: params.longitude as number, includeLocationName: true, excludeParameterMetadata: true });
}

const POINT_PARAMS = [
  { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
  { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
] as const;

const FORECAST_WARNINGS = [
  "Forecast values, not observations; accuracy falls off with lead time.",
  "Outdoor temperature alone does not establish overheating risk in a building.",
];

export const definition = defineIntegration({
  id: "met-office-datahub",
  name: "Met Office Weather DataHub",
  group: "weather",
  access: "open_key",
  territory: "Global (UK detail from the UKV model)",
  description: "Met Office site-specific forecasts (hourly to 48 h, three-hourly and daily to 7 days) for any point, from the Weather DataHub API that replaced DataPoint.",
  docsUrl: "https://datahub.metoffice.gov.uk/docs/f/category/site-specific/overview",
  termsUrl: "https://datahub.metoffice.gov.uk/terms",
  attribution: "Contains Met Office data licensed under the Met Office Weather DataHub terms. Data provided by the Met Office.",
  licence: "restricted",
  envVars: [{ name: "MET_OFFICE_DATAHUB_API_KEY", required: true, description: "Weather DataHub API key (sent as the `apikey` header). Free tier: register at datahub.metoffice.gov.uk and subscribe to the Site Specific plan; paid plans raise call limits." }],
  status: "built_unverified",
  notes: [
    "Weather DataHub replaced DataPoint (retired 2024). Site-specific forecasts are the closest equivalent to DataPoint's 3-hourly site forecasts.",
    "Free plan is limited (documented as 360 calls/day at time of writing; confirm on the DataHub plans page). Paid plans available for higher volumes.",
    "Header name `apikey` and query parameters confirmed from the Met Office example script; response field names taken from open-source clients and not confirmed live. Wind speed units are reported by the API's parameter metadata (m/s for windSpeed10m in the sources reviewed).",
    "UKCP18 climate projections and HadUK-Grid observations are separate services (see ukcp18 and haduk-grid-ceda); DataHub is forecast only.",
    "Not exercised live from this environment.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const url = buildUrl(BASE, "daily", { latitude: 51.5, longitude: -0.12, includeLocationName: false, excludeParameterMetadata: true });
      const { data } = await fetchJson<SiteSpecificResponse<DailyStep>>(ctx, url, { headers: headers(ctx.env) }, { timeoutMs: 15_000 });
      const steps = data.features?.[0]?.properties?.timeSeries?.length ?? 0;
      return { ok: steps > 0, detail: steps ? `${steps} daily steps` : "no timeSeries in response", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "hourly-forecast",
      label: "Hourly forecast (next 48 h)",
      description: "Hourly temperature, feels-like, rain, wind, humidity and UV for a point.",
      params: [...POINT_PARAMS],
      async run(params, ctx) {
        const url = pointUrl("hourly", params);
        const { data } = await fetchJson<SiteSpecificResponse<HourlyStep>>(ctx, url, { headers: headers(ctx.env) });
        const feature = data.features?.[0];
        const steps = (feature?.properties?.timeSeries ?? []).slice(0, HOURLY_LIMIT);
        const columns = ["time", "temp_c", "feels_like_c", "precip_mm", "precip_prob_pct", "wind_speed_10m", "wind_gust_10m", "wind_dir_deg", "humidity_pct", "uv_index", "weather_code"];
        const name = feature?.properties?.location?.name;
        if (!steps.length) {
          return { summary: "No hourly forecast returned for this point.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "sitespecific/point/hourly", basis: "unavailable" }) };
        }
        const rows = steps.map((s) => ({
          time: s.time,
          temp_c: n(s.screenTemperature),
          feels_like_c: n(s.feelsLikeTemperature),
          precip_mm: n(s.totalPrecipAmount),
          precip_prob_pct: n(s.probOfPrecipitation),
          wind_speed_10m: n(s.windSpeed10m),
          wind_gust_10m: n(s.windGustSpeed10m),
          wind_dir_deg: n(s.windDirectionFrom10m),
          humidity_pct: n(s.screenRelativeHumidity),
          uv_index: n(s.uvIndex),
          weather_code: n(s.significantWeatherCode),
        }));
        const temps = rows.map((r) => r.temp_c).filter((v): v is number => v !== null);
        const rain = rows.reduce((a, r) => a + (r.precip_mm ?? 0), 0);
        return {
          summary: `${rows.length} hourly steps${name ? ` for ${name}` : ""} from ${rows[0].time}: ${Math.min(...temps).toFixed(1)} to ${Math.max(...temps).toFixed(1)} °C, ${rain.toFixed(1)} mm rain expected.`,
          columns,
          rows,
          raw: { ...data, parameters: undefined },
          provenance: makeProvenance(definition, ctx, { dataset: "sitespecific/point/hourly", basis: "modelled", version: feature?.properties?.modelRunDate }),
          warnings: FORECAST_WARNINGS,
        };
      },
    },
    {
      id: "daily-forecast",
      label: "Daily forecast (7 days)",
      description: "Day maximum and night minimum temperature, rain probability, midday wind and UV for a point.",
      params: [...POINT_PARAMS],
      async run(params, ctx) {
        const url = pointUrl("daily", params);
        const { data } = await fetchJson<SiteSpecificResponse<DailyStep>>(ctx, url, { headers: headers(ctx.env) });
        const feature = data.features?.[0];
        const steps = feature?.properties?.timeSeries ?? [];
        const columns = ["date", "day_max_c", "night_min_c", "day_max_feels_like_c", "day_precip_prob_pct", "night_precip_prob_pct", "midday_wind_speed_10m", "midday_wind_gust_10m", "max_uv_index", "day_weather_code", "night_weather_code"];
        const name = feature?.properties?.location?.name;
        if (!steps.length) {
          return { summary: "No daily forecast returned for this point.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "sitespecific/point/daily", basis: "unavailable" }) };
        }
        const rows = steps.map((s) => ({
          date: s.time.slice(0, 10),
          day_max_c: n(s.dayMaxScreenTemperature),
          night_min_c: n(s.nightMinScreenTemperature),
          day_max_feels_like_c: n(s.dayMaxFeelsLikeTemp),
          day_precip_prob_pct: n(s.dayProbabilityOfPrecipitation),
          night_precip_prob_pct: n(s.nightProbabilityOfPrecipitation),
          midday_wind_speed_10m: n(s.midday10MWindSpeed),
          midday_wind_gust_10m: n(s.midday10MWindGust),
          max_uv_index: n(s.maxUvIndex),
          day_weather_code: n(s.daySignificantWeatherCode),
          night_weather_code: n(s.nightSignificantWeatherCode),
        }));
        const highs = rows.map((r) => r.day_max_c).filter((v): v is number => v !== null);
        const lows = rows.map((r) => r.night_min_c).filter((v): v is number => v !== null);
        return {
          summary: `${rows.length}-day forecast${name ? ` for ${name}` : ""} from ${rows[0].date}: day highs up to ${highs.length ? Math.max(...highs).toFixed(1) : "n/a"} °C, night lows down to ${lows.length ? Math.min(...lows).toFixed(1) : "n/a"} °C.`,
          columns,
          rows,
          raw: { ...data, parameters: undefined },
          provenance: makeProvenance(definition, ctx, { dataset: "sitespecific/point/daily", basis: "modelled", version: feature?.properties?.modelRunDate }),
          warnings: FORECAST_WARNINGS,
        };
      },
    },
  ],
});
