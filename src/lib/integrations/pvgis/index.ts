import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext } from "../framework";

/**
 * European Commission JRC PVGIS 5.3 non-interactive API.
 *
 * Endpoints and parameter names from the JRC "API non-interactive service" page
 * (as summarised in search results), pvlib.iotools.pvgis and two open-source clients.
 * PVGIS 5.3 has been the production version since September 2024; v5_2 still answers.
 * Output keys (outputs.totals.fixed E_d/E_m/E_y/H(i)_d/H(i)_m/H(i)_y/SD_m/SD_y/l_*) follow
 * the documented PVcalc JSON. Not exercised live from this environment.
 */

const BASE = "https://re.jrc.ec.europa.eu/api/v5_3";

interface PvcalcMonthly {
  month: number;
  E_d: number;
  E_m: number;
  "H(i)_d": number;
  "H(i)_m": number;
  SD_m: number;
}

interface PvcalcTotals {
  E_d: number;
  E_m: number;
  E_y: number;
  "H(i)_d": number;
  "H(i)_m": number;
  "H(i)_y": number;
  SD_m: number;
  SD_y: number;
  l_aoi: number;
  l_spec: number | string;
  l_tg: number;
  l_total: number;
}

interface PvcalcResponse {
  inputs?: {
    location?: { latitude: number; longitude: number; elevation?: number };
    meteo_data?: { radiation_db?: string; meteo_db?: string; year_min?: number; year_max?: number; use_horizon?: boolean; horizon_db?: string };
    mounting_system?: { fixed?: { slope?: { value: number; optimal?: boolean }; azimuth?: { value: number; optimal?: boolean }; type?: string } };
    pv_module?: { technology?: string; peak_power?: number; system_loss?: number };
  };
  outputs?: { monthly?: { fixed?: PvcalcMonthly[] }; totals?: { fixed?: PvcalcTotals } };
  meta?: unknown;
  message?: string;
}

interface MrcalcMonth {
  year: number;
  month: number;
  "H(h)_m"?: number;
  "H(i_opt)_m"?: number;
  "H(i)_m"?: number;
  T2m?: number;
}

interface MrcalcResponse {
  inputs?: PvcalcResponse["inputs"];
  outputs?: { monthly?: MrcalcMonth[] };
  meta?: unknown;
  message?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function r(v: number | string | null | undefined, dp = 1): number | null {
  const x = typeof v === "string" ? Number(v) : v;
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** PVGIS azimuth (0 = south, -90 = east, 90 = west) to compass bearing. */
export function compassFromPvgisAspect(aspect: number): number {
  return ((aspect + 180) % 360 + 360) % 360;
}

/** Compass bearing (0 = north, 90 = east, 180 = south, 270 = west) to PVGIS aspect. */
export function pvgisAspectFromCompass(bearing: number): number {
  return ((bearing % 360) + 360) % 360 - 180;
}

const POINT = [
  { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
  { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
] as const;

const MODEL_WARNINGS = [
  "Modelled long-term average from satellite irradiation and a generic PV performance model; it is a screening estimate, not a system design or a yield guarantee.",
  "No allowance for roof-specific shading, soiling, snow or curtailment beyond the flat loss percentage; MCS-style design and a site survey are still needed before procurement.",
];

async function pvgisGet<T extends { message?: string }>(ctx: OperationContext, tool: string, query: Record<string, string | number | boolean | undefined>): Promise<{ data: T; status: number }> {
  const url = buildUrl(BASE, tool, { ...query, outputformat: "json" });
  const { data, status } = await fetchJson<T>(ctx, url, {}, { timeoutMs: 30_000, acceptStatuses: [400] });
  return { data, status };
}

export const definition = defineIntegration({
  id: "pvgis",
  name: "PVGIS (JRC)",
  group: "solar",
  access: "open",
  territory: "Europe, Africa, Asia and the Americas (UK covered by PVGIS-SARAH3)",
  description: "European Commission Joint Research Centre PV Geographical Information System: modelled PV yield, monthly solar irradiation and optimal tilt for any point, from long-term satellite radiation databases.",
  docsUrl: "https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en",
  termsUrl: "https://commission.europa.eu/legal-notice_en",
  attribution: "Solar radiation and PV performance data: PVGIS © European Union, 2001-2026 (Joint Research Centre), CC BY 4.0.",
  licence: "restricted",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. Rate limit 30 calls/second per IP; PVGIS returns 429 when exceeded and may return 529 under load.",
    "Licence: European Commission reuse policy (CC BY 4.0). Cite PVGIS and the JRC.",
    "PVGIS 5.3 is the production version (since September 2024). If v5_3 is withdrawn, change BASE to v5_2.",
    "Azimuth uses the PVGIS convention: 0 = south, -90 = east, 90 = west. Enter a compass bearing in the form and it is converted.",
    "Points over the sea or outside the radiation databases return a 400 with a message; this is reported as an empty result.",
    "Default UK radiation database is PVGIS-SARAH3 (2005-2023). Yields are long-term averages, so a single year can differ by ±10%.",
    "Not exercised live from this environment.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "PVcalc", { lat: 51.5, lon: -0.12, peakpower: 1, loss: 14, outputformat: "json" })),
  operations: [
    {
      id: "pv-yield",
      label: "Annual PV yield estimate",
      description: "Modelled annual and monthly generation for a fixed PV array of a given size, tilt, orientation and loss factor.",
      params: [
        ...POINT,
        { name: "peak_power_kwp", label: "Array size (kWp)", type: "number", required: true, placeholder: "50", min: 0.1, max: 100000 },
        { name: "tilt_deg", label: "Tilt from horizontal (°)", type: "number", default: 35, min: 0, max: 90, help: "Typical UK pitched roof 30-40°; flat-roof frames 10-15°." },
        { name: "azimuth_deg", label: "Orientation (compass °)", type: "number", default: 180, min: 0, max: 360, help: "Compass bearing the panels face: 180 = south, 90 = east, 270 = west." },
        { name: "loss_pct", label: "System losses (%)", type: "number", default: 14, min: 0, max: 50, help: "PVGIS default 14% covers cabling, inverter, soiling and mismatch." },
        { name: "mounting", label: "Mounting", type: "select", default: "building", options: [{ value: "building", label: "Building (roof-mounted, warmer modules)" }, { value: "free", label: "Free-standing (ground or frames)" }] },
        { name: "optimise", label: "Optimise angles", type: "select", default: "none", options: [{ value: "none", label: "Use the tilt and orientation given" }, { value: "tilt", label: "Optimise tilt only" }, { value: "both", label: "Optimise tilt and orientation" }] },
      ],
      async run(params, ctx) {
        const kwp = Number(params.peak_power_kwp);
        const optimise = String(params.optimise ?? "none");
        const { data, status } = await pvgisGet<PvcalcResponse>(ctx, "PVcalc", {
          lat: params.latitude as number,
          lon: params.longitude as number,
          peakpower: kwp,
          loss: Number(params.loss_pct ?? 14),
          angle: Number(params.tilt_deg ?? 35),
          aspect: pvgisAspectFromCompass(Number(params.azimuth_deg ?? 180)),
          mountingplace: String(params.mounting ?? "building"),
          pvtechchoice: "crystSi",
          optimalinclination: optimise === "tilt" ? 1 : 0,
          optimalangles: optimise === "both" ? 1 : 0,
        });
        const columns = ["month", "energy_kwh", "energy_per_day_kwh", "in_plane_irradiation_kwh_m2", "sd_kwh"];
        const totals = data.outputs?.totals?.fixed;
        if (status === 400 || !totals) {
          return { summary: `PVGIS could not model this point: ${data.message ?? "no totals returned"}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "PVcalc", basis: "unavailable" }) };
        }
        const monthly = data.outputs?.monthly?.fixed ?? [];
        const rows = monthly.map((m) => ({ month: MONTHS[m.month - 1] ?? String(m.month), energy_kwh: r(m.E_m, 0), energy_per_day_kwh: r(m.E_d, 1), in_plane_irradiation_kwh_m2: r(m["H(i)_m"], 1), sd_kwh: r(m.SD_m, 0) }));
        const fixed = data.inputs?.mounting_system?.fixed;
        const slope = fixed?.slope?.value;
        const aspect = fixed?.azimuth?.value;
        const perKwp = totals.E_y / kwp;
        const db = data.inputs?.meteo_data?.radiation_db;
        return {
          summary: `Estimated ${r(totals.E_y, 0)} kWh/yr (${r(perKwp, 0)} kWh/kWp) for ${kwp} kWp at ${slope ?? "?"}° tilt facing ${aspect !== undefined ? compassFromPvgisAspect(aspect) : "?"}° (compass)${fixed?.slope?.optimal || fixed?.azimuth?.optimal ? ", angles optimised by PVGIS" : ""}. In-plane irradiation ${r(totals["H(i)_y"], 0)} kWh/m²/yr; total system losses ${r(totals.l_total, 1)}%; year-to-year SD ${r(totals.SD_y, 0)} kWh.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "PVcalc", basis: "modelled", version: db }),
          warnings: MODEL_WARNINGS,
        };
      },
    },
    {
      id: "monthly-irradiation",
      label: "Monthly solar irradiation at a point",
      description: "Long-term monthly averages of global horizontal irradiation and irradiation at the optimal tilt, plus air temperature.",
      params: [...POINT],
      async run(params, ctx) {
        const { data, status } = await pvgisGet<MrcalcResponse>(ctx, "MRcalc", { lat: params.latitude as number, lon: params.longitude as number, horirrad: 1, optrad: 1, avtemp: 1 });
        const columns = ["month", "horizontal_kwh_m2", "optimal_tilt_kwh_m2", "air_temp_c", "years"];
        const monthly = data.outputs?.monthly ?? [];
        if (status === 400 || !monthly.length) {
          return { summary: `PVGIS returned no monthly radiation for this point${data.message ? `: ${data.message}` : ""}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "MRcalc", basis: "unavailable" }) };
        }
        const acc = new Map<number, { h: number[]; opt: number[]; t: number[]; years: Set<number> }>();
        for (const m of monthly) {
          const a = acc.get(m.month) ?? { h: [], opt: [], t: [], years: new Set<number>() };
          if (typeof m["H(h)_m"] === "number") a.h.push(m["H(h)_m"]);
          if (typeof m["H(i_opt)_m"] === "number") a.opt.push(m["H(i_opt)_m"]);
          if (typeof m.T2m === "number") a.t.push(m.T2m);
          a.years.add(m.year);
          acc.set(m.month, a);
        }
        const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
        const rows = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([month, a]) => ({ month: MONTHS[month - 1] ?? String(month), horizontal_kwh_m2: r(mean(a.h), 1), optimal_tilt_kwh_m2: r(mean(a.opt), 1), air_temp_c: r(mean(a.t), 1), years: a.years.size }));
        const annualH = rows.reduce((s, x) => s + (x.horizontal_kwh_m2 ?? 0), 0);
        const annualOpt = rows.reduce((s, x) => s + (x.optimal_tilt_kwh_m2 ?? 0), 0);
        const years = [...new Set(monthly.map((m) => m.year))];
        return {
          summary: `Average ${r(annualH, 0)} kWh/m²/yr on the horizontal and ${r(annualOpt, 0)} kWh/m²/yr at the optimal tilt, averaged over ${Math.min(...years)}-${Math.max(...years)} (${data.inputs?.meteo_data?.radiation_db ?? "PVGIS"}).`,
          columns,
          rows,
          raw: { ...data, outputs: { monthly_rows: monthly.length } },
          provenance: makeProvenance(definition, ctx, { dataset: "MRcalc", basis: "modelled", version: data.inputs?.meteo_data?.radiation_db }),
          warnings: ["Satellite-derived long-term averages on a grid of a few km; local shading is not included."],
        };
      },
    },
    {
      id: "optimal-tilt",
      label: "Optimal tilt and orientation",
      description: "The tilt and orientation PVGIS finds to maximise annual yield at this point, with the yield per kWp they give.",
      params: [...POINT],
      async run(params, ctx) {
        const { data, status } = await pvgisGet<PvcalcResponse>(ctx, "PVcalc", { lat: params.latitude as number, lon: params.longitude as number, peakpower: 1, loss: 14, mountingplace: "free", pvtechchoice: "crystSi", optimalangles: 1 });
        const columns = ["optimal_tilt_deg", "optimal_orientation_compass_deg", "pvgis_aspect_deg", "yield_kwh_per_kwp", "in_plane_irradiation_kwh_m2"];
        const totals = data.outputs?.totals?.fixed;
        const fixed = data.inputs?.mounting_system?.fixed;
        if (status === 400 || !totals || fixed?.slope?.value === undefined || fixed?.azimuth?.value === undefined) {
          return { summary: `PVGIS could not optimise angles for this point${data.message ? `: ${data.message}` : ""}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "PVcalc/optimalangles", basis: "unavailable" }) };
        }
        const row = { optimal_tilt_deg: r(fixed.slope.value, 0), optimal_orientation_compass_deg: r(compassFromPvgisAspect(fixed.azimuth.value), 0), pvgis_aspect_deg: r(fixed.azimuth.value, 0), yield_kwh_per_kwp: r(totals.E_y, 0), in_plane_irradiation_kwh_m2: r(totals["H(i)_y"], 0) };
        return {
          summary: `Optimal fixed array: ${row.optimal_tilt_deg}° tilt facing ${row.optimal_orientation_compass_deg}° (compass), giving about ${row.yield_kwh_per_kwp} kWh/kWp/yr at 14% losses.`,
          columns,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "PVcalc/optimalangles", basis: "modelled", version: data.inputs?.meteo_data?.radiation_db }),
          warnings: ["Optimal for annual yield only; roofs, structures and export limits usually dictate a different angle, and shallower tilts often suit flat roofs better once wind loading and row shading are considered."],
        };
      },
    },
  ],
});
