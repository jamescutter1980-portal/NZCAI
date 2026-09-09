import { defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * Google Maps Platform Solar API, buildingInsights:findClosest.
 *
 * Request and response types from Google's own sample
 * (github.com/googlemaps-samples/js-solar-potential, src/routes/solar.ts) and the REST
 * reference. Key goes in the `key` query parameter. solar.googleapis.com is reachable from
 * this environment and answers 403 without a key, which the health check reports.
 */

const BASE = "https://solar.googleapis.com/v1";

interface LatLng {
  latitude: number;
  longitude: number;
}

interface SizeAndSunshineStats {
  areaMeters2: number;
  sunshineQuantiles: number[];
  groundAreaMeters2: number;
}

interface RoofSegmentStats {
  pitchDegrees: number;
  azimuthDegrees: number;
  stats: SizeAndSunshineStats;
  center: LatLng;
  planeHeightAtCenterMeters?: number;
}

interface SolarPanelConfig {
  panelsCount: number;
  yearlyEnergyDcKwh: number;
  roofSegmentSummaries: { pitchDegrees: number; azimuthDegrees: number; panelsCount: number; yearlyEnergyDcKwh: number; segmentIndex: number }[];
}

interface BuildingInsights {
  name: string;
  center: LatLng;
  imageryDate?: { year: number; month: number; day: number };
  imageryProcessedDate?: { year: number; month: number; day: number };
  postalCode?: string;
  administrativeArea?: string;
  regionCode?: string;
  imageryQuality?: "HIGH" | "MEDIUM" | "LOW" | "BASE";
  solarPotential?: {
    maxArrayPanelsCount: number;
    panelCapacityWatts: number;
    panelHeightMeters: number;
    panelWidthMeters: number;
    panelLifetimeYears: number;
    maxArrayAreaMeters2: number;
    maxSunshineHoursPerYear: number;
    carbonOffsetFactorKgPerMwh: number;
    wholeRoofStats?: SizeAndSunshineStats;
    roofSegmentStats?: RoofSegmentStats[];
    solarPanelConfigs?: SolarPanelConfig[];
  };
  error?: { code: number; message: string; status: string };
}

/** The method path contains a colon, which the URL constructor would read as a scheme, so build it by hand. */
function insightsUrl(query: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return `${BASE}/buildingInsights:findClosest?${qs.toString()}`;
}

function key(env: EnvLike): string {
  const k = env.GOOGLE_MAPS_API_KEY?.trim();
  if (!k) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  return k;
}

function median(xs: number[] | undefined): number | null {
  if (!xs?.length) return null;
  return xs[Math.floor(xs.length / 2)];
}

function r(v: number | null | undefined, dp = 1): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function fmtDate(d?: { year: number; month: number; day: number }): string | undefined {
  return d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined;
}

const COLUMNS = ["row_type", "index", "pitch_deg", "azimuth_deg", "area_m2", "sunshine_median_h_yr", "panels_count", "yearly_energy_dc_kwh"];

export const definition = defineIntegration({
  id: "google-solar",
  name: "Google Solar API",
  group: "solar",
  access: "open_key",
  territory: "Selected countries incl. UK (coverage varies by building)",
  description: "Roof solar potential for the building nearest a point from Google's aerial imagery and 3D roof model: usable roof area, sunshine hours, roof segment pitch and orientation, and yearly DC energy for panel configurations of increasing size.",
  docsUrl: "https://developers.google.com/maps/documentation/solar/building-insights",
  termsUrl: "https://cloud.google.com/maps-platform/terms",
  attribution: "Roof solar potential from the Google Solar API © Google.",
  licence: "commercial",
  envVars: [{ name: "GOOGLE_MAPS_API_KEY", required: true, description: "Google Cloud API key with the Solar API enabled, sent as the `key` query parameter. Restrict the key to the Solar API and to server IPs." }],
  status: "built_unverified",
  notes: [
    "Billed per request under Google Maps Platform pricing (Building Insights is a paid SKU with a monthly free allowance; check the current price list). Cache results per building.",
    "Coverage and imagery quality vary: HIGH quality needs recent high-resolution aerial imagery, so rural and some commercial sites may only have MEDIUM, LOW or BASE quality, or no data (404 NOT_FOUND, reported here as an empty result).",
    "findClosest returns the nearest building to the point, which may not be the building of interest in dense areas; check the returned centre and postcode.",
    "Yearly energy figures are DC kWh from Google's model with a default panel size; they are not a design, they exclude inverter losses, and they assume the whole roof segment is usable.",
    "Health check confirmed live from this environment: the host answers HTTP 403 without a valid key.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    const k = ctx.env.GOOGLE_MAPS_API_KEY?.trim();
    const url = insightsUrl({ "location.latitude": 51.5007, "location.longitude": -0.1246, requiredQuality: "LOW", key: k });
    try {
      const res = await ctx.fetch(url, { signal: AbortSignal.timeout(15_000) });
      const latencyMs = Date.now() - started;
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}`, latencyMs };
      const text = (await res.text()).slice(0, 200);
      return { ok: false, detail: `HTTP ${res.status}${k ? "" : " (no GOOGLE_MAPS_API_KEY set; 403 expected)"}: ${text}`, latencyMs };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "building-insights",
      label: "Roof solar potential for a building",
      description: "Solar potential of the building nearest a point: roof segments with pitch, orientation, area and sunshine, and panel configurations with yearly DC energy.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.5007" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.1246" },
        {
          name: "required_quality",
          label: "Minimum imagery quality",
          type: "select",
          default: "LOW",
          options: [
            { value: "HIGH", label: "HIGH only (best model, least coverage)" },
            { value: "MEDIUM", label: "MEDIUM or better" },
            { value: "LOW", label: "LOW or better (widest coverage)" },
            { value: "BASE", label: "BASE or better (experimental global coverage)" },
          ],
          help: "The API returns the best quality available at or above this level.",
        },
        { name: "max_configs", label: "Panel configurations to list", type: "integer", default: 10, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const url = insightsUrl({
          "location.latitude": params.latitude as number,
          "location.longitude": params.longitude as number,
          requiredQuality: String(params.required_quality ?? "LOW"),
          key: key(ctx.env),
        });
        const { data, status } = await fetchJson<BuildingInsights>(ctx, url, {}, { acceptStatuses: [404] });
        if (status === 404 || !data.solarPotential) {
          return {
            summary: `No building with solar data found near ${params.latitude}, ${params.longitude}${data.error?.message ? ` (${data.error.message})` : ""}.`,
            columns: COLUMNS,
            rows: [],
            raw: data,
            provenance: makeProvenance(definition, ctx, { dataset: "buildingInsights", basis: "unavailable" }),
            warnings: ["Try a lower minimum imagery quality; coverage outside urban areas is patchy."],
          };
        }
        const sp = data.solarPotential;
        const segments = (sp.roofSegmentStats ?? []).map((s, i) => ({
          row_type: "segment",
          index: i,
          pitch_deg: r(s.pitchDegrees),
          azimuth_deg: r(s.azimuthDegrees),
          area_m2: r(s.stats?.areaMeters2),
          sunshine_median_h_yr: r(median(s.stats?.sunshineQuantiles), 0),
          panels_count: null,
          yearly_energy_dc_kwh: null,
        }));
        const configs = (sp.solarPanelConfigs ?? []).slice(0, Number(params.max_configs ?? 10)).map((c, i) => ({
          row_type: "config",
          index: i,
          pitch_deg: null,
          azimuth_deg: null,
          area_m2: null,
          sunshine_median_h_yr: null,
          panels_count: c.panelsCount,
          yearly_energy_dc_kwh: r(c.yearlyEnergyDcKwh, 0),
        }));
        const largest = sp.solarPanelConfigs?.length ? sp.solarPanelConfigs[sp.solarPanelConfigs.length - 1] : undefined;
        const maxKwp = (sp.maxArrayPanelsCount * sp.panelCapacityWatts) / 1000;
        const imagery = fmtDate(data.imageryDate);
        return {
          summary: `Nearest building (${data.postalCode ?? "postcode unknown"}, imagery ${data.imageryQuality ?? "?"}${imagery ? ` from ${imagery}` : ""}): up to ${sp.maxArrayPanelsCount} panels (${r(maxKwp, 1)} kWp at ${sp.panelCapacityWatts} W each) on ${r(sp.maxArrayAreaMeters2, 0)} m² of roof; ${r(sp.maxSunshineHoursPerYear, 0)} sunshine hours/yr on the best segment; ${segments.length} roof segments${largest ? `; largest configuration ${largest.panelsCount} panels giving about ${r(largest.yearlyEnergyDcKwh, 0)} kWh DC/yr` : ""}.`,
          columns: COLUMNS,
          rows: [...segments, ...configs],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "buildingInsights", basis: "modelled", version: imagery }),
          warnings: [
            "Modelled from aerial imagery and a generic panel; DC energy excludes inverter and system losses and is not a design or a yield guarantee.",
            "Roof condition, structure, access, planning and grid connection are not assessed; a site survey is still required.",
            `Carbon offset factor reported by Google (${r(sp.carbonOffsetFactorKgPerMwh, 0)} kg CO2/MWh) is a generic grid figure; use the portal's UK grid factors instead.`,
          ],
        };
      },
    },
  ],
});
