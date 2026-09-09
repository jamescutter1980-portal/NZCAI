import { defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { assertRange, chunkDays, floorToHalfHour, mean, round, toIsoMinute } from "../_shared/dates";

/**
 * NESO Carbon Intensity API (formerly National Grid ESO). Half-hourly national and regional carbon intensity
 * (gCO2/kWh) with forecast, "actual" and a generation mix. Paths and shapes from the official Slate reference
 * (https://carbon-intensity.github.io/api-definitions/) and from open-source clients; not exercised live here.
 */

const BASE = "https://api.carbonintensity.org.uk";

/** The API accepts ISO 8601 and documents 14 days as the maximum window per request. */
const MAX_DAYS_PER_REQUEST = 14;
/** Our own cap so a single portal call stays a sensible size (31 days = 1,488 half hours). */
const MAX_HISTORY_DAYS = 31;

export interface IntensityPoint {
  from: string;
  to: string;
  intensity: { forecast: number | null; actual?: number | null; index: string };
  generationmix?: { fuel: string; perc: number }[];
}

interface RegionalBlock {
  regionid: number;
  dnoregion: string;
  shortname: string;
  postcode?: string;
  data: IntensityPoint[];
}

const FUELS = ["gas", "coal", "biomass", "nuclear", "hydro", "imports", "other", "wind", "solar"] as const;

const NATIONAL_COLUMNS = ["from", "to", "forecast_gco2_kwh", "actual_gco2_kwh", "index"];
const REGIONAL_COLUMNS = ["from", "to", "region", "dno_region", "forecast_gco2_kwh", "index", ...FUELS.map((f) => `${f}_pct`)];

function outwardCode(postcode: string): string {
  // paramsToSchema strips the space and upper-cases: "SW1A1AA" -> "SW1A"
  const p = postcode.replace(/\s+/g, "").toUpperCase();
  return p.length > 3 ? p.slice(0, -3) : p;
}

function nationalRow(p: IntensityPoint) {
  return { from: p.from, to: p.to, forecast_gco2_kwh: p.intensity.forecast, actual_gco2_kwh: p.intensity.actual ?? null, index: p.intensity.index };
}

function mixColumns(mix: { fuel: string; perc: number }[] | undefined) {
  const out: Record<string, number | null> = {};
  for (const f of FUELS) out[`${f}_pct`] = mix?.find((m) => m.fuel === f)?.perc ?? null;
  return out;
}

function regionalRow(block: RegionalBlock, p: IntensityPoint): Record<string, unknown> {
  return { from: p.from, to: p.to, region: block.shortname, dno_region: block.dnoregion, forecast_gco2_kwh: p.intensity.forecast, index: p.intensity.index, ...mixColumns(p.generationmix) };
}

/** /regional/postcode/{code} wraps the block in an array; the fw48h variants return a bare object. Accept both. */
function firstBlock(data: unknown): RegionalBlock | null {
  if (Array.isArray(data)) return (data[0] as RegionalBlock | undefined) ?? null;
  if (data && typeof data === "object" && "data" in data) return data as RegionalBlock;
  return null;
}

async function fetchNational(ctx: OperationContext, fromIso: string, toIso: string): Promise<IntensityPoint[]> {
  const { data } = await fetchJson<{ data: IntensityPoint[] }>(ctx, `${BASE}/intensity/${encodeURIComponent(fromIso)}/${encodeURIComponent(toIso)}`);
  return data.data ?? [];
}

/**
 * Half-hourly national (or regional, if a postcode is given) carbon intensity series between two dates
 * (inclusive, UTC days), chunked into the API's 14-day windows. Intended for joining to half-hourly meter
 * readings: kgCO2 = kWh x gco2_per_kwh / 1000. Rows are ordered by `from`.
 *
 * This is for time-varying operational analysis (load shifting, flexibility, PV self-consumption). It is NOT
 * a GHG Protocol location-based Scope 2 factor; that uses the DESNZ annual UK grid factor.
 */
export async function halfHourlyIntensitySeries(
  ctx: OperationContext,
  from: string,
  to: string,
  postcode?: string,
): Promise<{ from: string; to: string; gco2_per_kwh: number | null; basis: "measured" | "modelled"; region?: string }[]> {
  assertRange(from, to, MAX_HISTORY_DAYS, "carbon-intensity history");
  const out: { from: string; to: string; gco2_per_kwh: number | null; basis: "measured" | "modelled"; region?: string }[] = [];
  for (const chunk of chunkDays(from, to, MAX_DAYS_PER_REQUEST)) {
    const fromIso = `${chunk.from}T00:00Z`;
    const toIso = `${chunk.to}T23:59Z`;
    if (postcode) {
      const url = `${BASE}/regional/intensity/${encodeURIComponent(fromIso)}/${encodeURIComponent(toIso)}/postcode/${encodeURIComponent(outwardCode(postcode))}`;
      const { data } = await fetchJson<{ data: unknown }>(ctx, url);
      const block = firstBlock(data.data);
      for (const p of block?.data ?? []) out.push({ from: p.from, to: p.to, gco2_per_kwh: p.intensity.forecast, basis: "modelled", region: block?.shortname });
    } else {
      for (const p of await fetchNational(ctx, fromIso, toIso)) {
        const actual = p.intensity.actual ?? null;
        out.push({ from: p.from, to: p.to, gco2_per_kwh: actual ?? p.intensity.forecast, basis: actual === null ? "modelled" : "measured" });
      }
    }
  }
  return out;
}

const OPERATIONAL_WARNING = "Carbon intensity from this API is for time-varying operational analysis (when to run plant, load shifting, PV self-consumption). It is not the GHG Protocol location-based Scope 2 factor, which uses the DESNZ annual UK electricity factor.";
const ACTUAL_WARNING = "'Actual' intensity is computed by NESO from metered generation by fuel and fixed per-fuel factors; it is an outturn estimate, not a direct measurement, and can be revised.";
const REGIONAL_WARNING = "Regional values are forecasts only (no regional 'actual' series is published) and are for the DNO region containing the postcode's outward code, not for the individual building.";

export const definition = defineIntegration({
  id: "carbon-intensity",
  name: "NESO Carbon Intensity API",
  group: "grid",
  access: "open",
  territory: "GB",
  description: "Half-hourly GB grid carbon intensity (gCO2/kWh): national forecast and outturn, 48-hour regional forecasts by postcode with generation mix, and per-fuel emission factors. Use for operational and time-of-use carbon analysis.",
  docsUrl: "https://carbon-intensity.github.io/api-definitions/",
  termsUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Carbon intensity data from the NESO Carbon Intensity API (https://carbonintensity.org.uk), licensed under CC BY 4.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Licence is CC BY 4.0 (recorded here in the OGL bucket as the closest open, attribution-only category). Attribution required when values are displayed or redistributed.",
    "No key and no published rate limit; requests for ranges over 14 days must be chunked (done here) and each portal call is capped at 31 days.",
    "Half-hourly periods are UTC ('Z'). Join to meter readings on the UTC interval start.",
    "Regional data (by postcode outward code) is forecast-only; national data has forecast and outturn ('actual'). Both are modelled from generation mix and fixed fuel factors, so they suit operational analysis rather than location-based Scope 2 reporting.",
    "Built from the official API reference and open-source clients without a live call; the /regional/postcode response is documented as an array wrapper and the fw48h variants as a bare object, and both are handled.",
  ],
  healthCheck: simpleHealth(`${BASE}/intensity`),
  operations: [
    {
      id: "national_now",
      label: "National carbon intensity now",
      description: "The current half-hour GB carbon intensity: forecast, outturn (if published yet) and the index band.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<{ data: IntensityPoint[] }>(ctx, `${BASE}/intensity`);
        const p = data.data?.[0];
        if (!p) return { summary: "No current intensity returned.", columns: NATIONAL_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "intensity", basis: "unavailable" }) };
        const actual = p.intensity.actual ?? null;
        return {
          summary: `GB carbon intensity ${p.from}–${p.to}: ${actual ?? p.intensity.forecast} gCO2/kWh (${p.intensity.index}${actual === null ? ", forecast" : ", actual"}).`,
          columns: NATIONAL_COLUMNS,
          rows: [nationalRow(p)],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "intensity", basis: actual === null ? "modelled" : "measured" }),
          warnings: [OPERATIONAL_WARNING, ACTUAL_WARNING],
        };
      },
    },
    {
      id: "national_history",
      label: "National carbon intensity for a date range",
      description: "Half-hourly forecast and outturn intensity between two dates (UTC), up to 31 days, chunked into the API's 14-day windows. Suitable for joining to half-hourly meter data.",
      params: [
        { name: "from", label: "From (UTC date)", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "to", label: "To (UTC date, inclusive)", type: "date", required: true, placeholder: "2026-08-31", help: "Maximum 31 days per call." },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, MAX_HISTORY_DAYS, "date range");
        const points: IntensityPoint[] = [];
        const chunks = chunkDays(from, to, MAX_DAYS_PER_REQUEST);
        for (const c of chunks) points.push(...(await fetchNational(ctx, `${c.from}T00:00Z`, `${c.to}T23:59Z`)));
        const rows = points.map(nationalRow);
        if (rows.length === 0) return { summary: `No intensity data for ${from} to ${to}.`, columns: NATIONAL_COLUMNS, rows: [], raw: points, provenance: makeProvenance(definition, ctx, { dataset: "intensity/{from}/{to}", basis: "unavailable" }) };
        const actuals = rows.map((r) => r.actual_gco2_kwh).filter((v): v is number => typeof v === "number");
        const forecasts = rows.map((r) => r.forecast_gco2_kwh).filter((v): v is number => typeof v === "number");
        const avgActual = mean(actuals);
        const avgForecast = mean(forecasts);
        const basis = actuals.length >= rows.length / 2 ? "measured" : "modelled";
        return {
          summary: `${rows.length} half-hour periods from ${from} to ${to} (${chunks.length} request${chunks.length === 1 ? "" : "s"}). Mean outturn ${avgActual === null ? "n/a" : round(avgActual, 0)} gCO2/kWh over ${actuals.length} periods with an actual; mean forecast ${avgForecast === null ? "n/a" : round(avgForecast, 0)} gCO2/kWh.`,
          columns: NATIONAL_COLUMNS,
          rows,
          raw: points,
          provenance: makeProvenance(definition, ctx, { dataset: "intensity/{from}/{to}", basis }),
          warnings: [OPERATIONAL_WARNING, ACTUAL_WARNING, ...(actuals.length < rows.length ? [`${rows.length - actuals.length} periods have no outturn yet (future or not yet published); use the forecast column for those.`] : [])],
        };
      },
    },
    {
      id: "regional_now",
      label: "Regional carbon intensity now for a postcode",
      description: "Current half-hour forecast intensity and generation mix for the DNO region of a postcode (outward code only is sent).",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "BS16 1QY" }],
      async run(params, ctx): Promise<OperationResult> {
        const outward = outwardCode(String(params.postcode));
        const { data } = await fetchJson<{ data: unknown }>(ctx, `${BASE}/regional/postcode/${encodeURIComponent(outward)}`);
        const block = firstBlock(data.data);
        const p = block?.data?.[0];
        if (!block || !p) return { summary: `No regional data for postcode area ${outward}.`, columns: REGIONAL_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "regional/postcode", basis: "unavailable" }), warnings: [REGIONAL_WARNING] };
        const row = regionalRow(block, p);
        const mix = mixColumns(p.generationmix);
        const topFuel = [...(p.generationmix ?? [])].sort((a, b) => b.perc - a.perc)[0];
        return {
          summary: `${block.shortname} (${block.dnoregion}) ${p.from}–${p.to}: ${p.intensity.forecast} gCO2/kWh (${p.intensity.index}). Largest source ${topFuel ? `${topFuel.fuel} ${topFuel.perc}%` : "n/a"}; wind ${mix.wind_pct ?? "n/a"}%, solar ${mix.solar_pct ?? "n/a"}%.`,
          columns: REGIONAL_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "regional/postcode", basis: "modelled" }),
          warnings: [OPERATIONAL_WARNING, REGIONAL_WARNING],
        };
      },
    },
    {
      id: "regional_forecast_48h",
      label: "Regional 48-hour forecast for a postcode",
      description: "Half-hourly forecast intensity and generation mix for the next 48 hours in the DNO region of a postcode. Use to pick low-carbon windows for flexible loads.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "BS16 1QY" }],
      async run(params, ctx): Promise<OperationResult> {
        const outward = outwardCode(String(params.postcode));
        const from = toIsoMinute(floorToHalfHour(ctx.now()));
        const url = `${BASE}/regional/intensity/${encodeURIComponent(from)}/fw48h/postcode/${encodeURIComponent(outward)}`;
        const { data } = await fetchJson<{ data: unknown }>(ctx, url);
        const block = firstBlock(data.data);
        const points = block?.data ?? [];
        if (!block || points.length === 0) return { summary: `No 48-hour forecast for postcode area ${outward}.`, columns: REGIONAL_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "regional/intensity/fw48h/postcode", basis: "unavailable" }), warnings: [REGIONAL_WARNING] };
        const rows = points.map((p) => regionalRow(block, p));
        const vals = points.map((p) => p.intensity.forecast).filter((v): v is number => typeof v === "number");
        const min = points.reduce((best, p) => ((p.intensity.forecast ?? Infinity) < (best.intensity.forecast ?? Infinity) ? p : best), points[0]);
        const max = points.reduce((best, p) => ((p.intensity.forecast ?? -Infinity) > (best.intensity.forecast ?? -Infinity) ? p : best), points[0]);
        return {
          summary: `${block.shortname}: ${rows.length} half hours from ${from}. Forecast ranges ${min.intensity.forecast} gCO2/kWh (lowest, from ${min.from}) to ${max.intensity.forecast} gCO2/kWh (highest, from ${max.from}); mean ${round(mean(vals) ?? 0, 0)}.`,
          columns: REGIONAL_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "regional/intensity/fw48h/postcode", basis: "modelled" }),
          warnings: [OPERATIONAL_WARNING, REGIONAL_WARNING, "Forecasts are revised every half hour; re-query before acting on a window more than a few hours ahead."],
        };
      },
    },
    {
      id: "generation_mix_now",
      label: "National generation mix now",
      description: "Share of GB generation by fuel for the current half hour.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<{ data: { from: string; to: string; generationmix: { fuel: string; perc: number }[] } }>(ctx, `${BASE}/generation`);
        const g = data.data;
        const mix = g?.generationmix ?? [];
        if (mix.length === 0) return { summary: "No generation mix returned.", columns: ["from", "to", "fuel", "percent"], rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "generation", basis: "unavailable" }) };
        const rows = mix.map((m) => ({ from: g.from, to: g.to, fuel: m.fuel, percent: m.perc }));
        const renewables = mix.filter((m) => ["wind", "solar", "hydro", "biomass"].includes(m.fuel)).reduce((a, m) => a + m.perc, 0);
        const lowCarbon = renewables + (mix.find((m) => m.fuel === "nuclear")?.perc ?? 0);
        return {
          summary: `GB generation ${g.from}–${g.to}: ${round(renewables)}% renewable (wind, solar, hydro, biomass), ${round(lowCarbon)}% low carbon including nuclear; gas ${mix.find((m) => m.fuel === "gas")?.perc ?? "n/a"}%, imports ${mix.find((m) => m.fuel === "imports")?.perc ?? "n/a"}%.`,
          columns: ["from", "to", "fuel", "percent"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "generation", basis: "measured" }),
          warnings: ["Percentages are of GB transmission-metered generation plus imports; embedded (distribution-connected) solar and wind are estimated by NESO. 'Imports' carries the interconnector share, whose carbon content depends on the exporting market."],
        };
      },
    },
    {
      id: "fuel_factors",
      label: "Per-fuel emission factors used by the API",
      description: "The fixed gCO2/kWh factors NESO applies to each fuel to compute intensity. Reference data for explaining results, not for Scope 2 reporting.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<{ data: Record<string, number>[] }>(ctx, `${BASE}/intensity/factors`);
        const factors = data.data?.[0] ?? {};
        const rows = Object.entries(factors).map(([fuel, gco2_per_kwh]) => ({ fuel, gco2_per_kwh }));
        return {
          summary: `${rows.length} fuel factors published (e.g. ${rows.slice(0, 3).map((r) => `${r.fuel} ${r.gco2_per_kwh}`).join(", ")} gCO2/kWh).`,
          columns: ["fuel", "gco2_per_kwh"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "intensity/factors", basis: rows.length ? "modelled" : "unavailable" }),
          warnings: [OPERATIONAL_WARNING],
        };
      },
    },
  ],
});

export { outwardCode };
