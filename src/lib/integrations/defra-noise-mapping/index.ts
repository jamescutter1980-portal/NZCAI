import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";
import { wmsCapabilitiesUrl, wmsFeatureInfo, wmsQueryableLayers, type WmsFeature } from "../_shared/wms";
import { arcgisPointQuery, attr } from "../_shared/arcgis";

/**
 * Defra strategic noise mapping, Round 4 (2022 maps, 2021 data), road and
 * rail noise at a point.
 *
 * Round 4 is published on the Defra Data Services Platform as 10 m rasters
 * (WMS/WCS), one layer per metric (Lden, Lnight, LAeq16h, LAeq6h, ...):
 *   https://environment.data.gov.uk/spatialdata/road-noise-all-metrics-england-round-4/wms  (confirmed)
 *   https://environment.data.gov.uk/spatialdata/rail-noise-all-metrics-england-round-4/wms  (slug inferred from the road service and the dataset title)
 * Values are modelled dB with a lower cutoff of 40 dB (35 dB for Lnight and
 * LAeq6h). Layer names inside each WMS are not known, so the connector reads
 * GetCapabilities, picks the queryable layers whose name or title contains
 * the requested metric, and runs GetFeatureInfo on each. No Round 4 ArcGIS
 * REST service name could be confirmed (only Round 2/3 MapServers such as
 * DEFRA/RoadNoiseLAeq16hRound3 are indexed); DEFRA_NOISE_ARCGIS_LAYERS lets
 * an operator point at REST layers instead. Not exercised live.
 */

export const DEFAULT_ROAD_WMS = "https://environment.data.gov.uk/spatialdata/road-noise-all-metrics-england-round-4/wms";
export const DEFAULT_RAIL_WMS = "https://environment.data.gov.uk/spatialdata/rail-noise-all-metrics-england-round-4/wms";
export const DEFAULT_ARCGIS_BASE = "https://environment.data.gov.uk/arcgis/rest/services/DEFRA";

export const METRICS: Record<string, { label: string; cutoffDb: number; description: string }> = {
  Lden: { label: "Lden", cutoffDb: 40, description: "Day-evening-night level, annual average with +5 dB evening and +10 dB night penalties" },
  Lnight: { label: "Lnight", cutoffDb: 35, description: "Night-time (23:00-07:00) annual average level" },
  LAeq16h: { label: "LAeq,16h", cutoffDb: 40, description: "Daytime (07:00-23:00) annual average level" },
  LAeq6h: { label: "LAeq,6h", cutoffDb: 35, description: "Night-time (23:00-05:00 / 6 h) annual average level" },
  LA10_18h: { label: "LA10,18h", cutoffDb: 40, description: "Road traffic noise index used for the Noise Insulation Regulations" },
};

export interface Source {
  source: "road" | "rail";
  wms: string;
  confirmed: boolean;
}

export function sources(env: EnvLike): Source[] {
  return [
    { source: "road", wms: env.DEFRA_NOISE_WMS_ROAD?.trim() || DEFAULT_ROAD_WMS, confirmed: !env.DEFRA_NOISE_WMS_ROAD },
    { source: "rail", wms: env.DEFRA_NOISE_WMS_RAIL?.trim() || DEFAULT_RAIL_WMS, confirmed: false },
  ];
}

export interface ArcGisLayerSpec {
  source: string;
  metric: string;
  url: string;
}

/** DEFRA_NOISE_ARCGIS_LAYERS = "road|Lden|<layer url or Service/MapServer/0>;rail|Lnight|..." (relative paths resolve against DEFRA_NOISE_ARCGIS_BASE). */
export function arcgisLayers(env: EnvLike): ArcGisLayerSpec[] {
  const spec = env.DEFRA_NOISE_ARCGIS_LAYERS?.trim();
  if (!spec) return [];
  const base = (env.DEFRA_NOISE_ARCGIS_BASE?.trim() || DEFAULT_ARCGIS_BASE).replace(/\/$/, "");
  return spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [source, metric, path] = s.split("|").map((x) => x.trim());
      return { source, metric, url: /^https?:\/\//.test(path) ? path : `${base}/${path}` };
    });
}

/** Which metric a WMS layer name/title refers to, or null when it is not one we report. */
export function metricForLayer(name: string, title: string): string | null {
  const s = `${name} ${title}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.includes("lden")) return "Lden";
  if (s.includes("lnight")) return "Lnight";
  if (s.includes("laeq16")) return "LAeq16h";
  if (s.includes("laeq6")) return "LAeq6h";
  if (s.includes("la1018") || s.includes("la10")) return "LA10_18h";
  return null;
}

/** 5 dB band label for a modelled level, matching the published contour classes. */
export function bandFor(db: number | null, metric: string): string {
  if (db === null) return `Below ${METRICS[metric]?.cutoffDb ?? 40} dB cutoff or not mapped`;
  const top = metric === "Lnight" || metric === "LAeq6h" ? 70 : 75;
  if (db >= top) return `${top} dB and above`;
  const lower = Math.floor(db / 5) * 5;
  return `${lower}.0-${lower + 4}.9 dB`;
}

/** Pulls a numeric level out of GetFeatureInfo properties (raster pixel value, class or band field). */
export function levelFromProperties(props: Record<string, unknown>): { value: number | null; field: string | null } {
  const entries = Object.entries(props);
  const preferred = entries.filter(([k]) => /pixel|value|noise|db|class|band|gray|level/i.test(k));
  for (const [k, v] of [...preferred, ...entries]) {
    if (typeof v === "number" && Number.isFinite(v)) return { value: v, field: k };
    if (typeof v === "string") {
      const m = /-?\d+(\.\d+)?/.exec(v);
      if (m && !/nodata|no data/i.test(v)) return { value: Number(m[0]), field: k };
    }
  }
  return { value: null, field: null };
}

export type NoiseRow = {
  source: string;
  metric: string;
  level_db: number | null;
  band: string;
  layer: string;
  field: string | null;
}

function rowFromFeatures(source: string, metric: string, layer: string, features: WmsFeature[]): NoiseRow {
  const best = features.map((f) => levelFromProperties(f.properties)).find((x) => x.value !== null) ?? { value: null, field: null };
  const value = best.value !== null && best.value <= 0 ? null : best.value;
  return { source, metric, level_db: value === null ? null : Math.round(value * 10) / 10, band: bandFor(value, metric), layer, field: best.field };
}

async function viaWms(ctx: OperationContext, src: Source, metric: string, latitude: number, longitude: number, warnings: string[], raw: Record<string, unknown>): Promise<NoiseRow[]> {
  const layers = await wmsQueryableLayers(ctx, src.wms);
  const wanted = layers.map((l) => ({ ...l, metric: metricForLayer(l.name, l.title) })).filter((l) => l.metric && (metric === "all" || l.metric === metric));
  raw[`${src.source}_layers`] = layers.map((l) => l.name);
  if (!wanted.length) {
    warnings.push(`${src.source}: no queryable WMS layer matching ${metric === "all" ? "a known metric" : metric} was found among ${layers.length} layer(s); names seen: ${layers.slice(0, 8).map((l) => l.name).join(", ") || "none"}.`);
    return [];
  }
  const rows: NoiseRow[] = [];
  for (const l of wanted) {
    try {
      const info = await wmsFeatureInfo(ctx, src.wms, { layers: [l.name], latitude, longitude, halfWidthDeg: 0.0002, featureCount: 5 });
      raw[`${src.source}_${l.name}`] = { url: info.url, format: info.format, features: info.features };
      rows.push(rowFromFeatures(src.source, l.metric!, l.name, info.features));
    } catch (e) {
      warnings.push(`${src.source} ${l.name}: ${e instanceof IntegrationHttpError ? e.message : e instanceof Error ? e.message : String(e)}`);
    }
  }
  return rows;
}

async function viaArcgis(ctx: OperationContext, spec: ArcGisLayerSpec, latitude: number, longitude: number, raw: Record<string, unknown>): Promise<NoiseRow> {
  const res = await arcgisPointQuery(ctx, spec.url, { latitude, longitude, returnGeometry: false, resultRecordCount: 5 });
  raw[`${spec.source}_${spec.metric}`] = res;
  const a = res.features?.[0]?.attributes;
  if (!a) return { source: spec.source, metric: spec.metric, level_db: null, band: bandFor(null, spec.metric), layer: spec.url, field: null };
  const cls = attr(a, "NoiseClass", "NOISECLASS", "Noise_Class", "CLASS", "BAND", "Band", "gridcode", "GRIDCODE", "VALUE", "Value", "Pixel Value");
  const { value, field } = levelFromProperties(cls !== null ? { NoiseClass: cls } : a);
  return { source: spec.source, metric: spec.metric, level_db: value, band: typeof cls === "string" && !/^-?\d+(\.\d+)?$/.test(cls.trim()) ? cls.trim() : bandFor(value, spec.metric), layer: spec.url, field };
}

export const definition = defineIntegration({
  id: "defra-noise-mapping",
  name: "Defra strategic noise mapping (England, Round 4)",
  group: "ground",
  access: "gis",
  territory: "England",
  description: "Modelled road and rail noise levels (Lden, Lnight and the other END metrics) at a point from Defra's Round 4 (2022) strategic noise maps, reported as a level and 5 dB band per source and metric. Context for BREEAM Pol 05 / Hea 05 and WELL Sound screening, not a site noise survey.",
  docsUrl: "https://www.gov.uk/government/publications/strategic-noise-mapping-2022",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Defra strategic noise mapping data © Crown copyright and database right 2026, licensed under the Open Government Licence v3.0. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [
    { name: "DEFRA_NOISE_WMS_ROAD", required: false, description: `Override the road noise Round 4 WMS (default ${DEFAULT_ROAD_WMS}).` },
    { name: "DEFRA_NOISE_WMS_RAIL", required: false, description: `Override the rail noise Round 4 WMS (default ${DEFAULT_RAIL_WMS}, slug unconfirmed).` },
    { name: "DEFRA_NOISE_ARCGIS_BASE", required: false, description: `ArcGIS REST folder for Round 4 noise layers (default ${DEFAULT_ARCGIS_BASE}); only used with DEFRA_NOISE_ARCGIS_LAYERS.` },
    { name: "DEFRA_NOISE_ARCGIS_LAYERS", required: false, description: "Use ArcGIS REST point queries instead of WMS: 'road|Lden|RoadNoiseLdenRound4/MapServer/0;rail|Lnight|https://.../FeatureServer/0'. Round 4 service names are not confirmed, so none is assumed." },
  ],
  status: "built_unverified",
  notes: [
    "Road Round 4 WMS (environment.data.gov.uk/spatialdata/road-noise-all-metrics-england-round-4/wms) is confirmed from the Defra Data Services Platform dataset page; the rail slug is inferred from the dataset title 'Rail Noise - All Metrics - England Round 4'. Layer names within each WMS were not available, so they are discovered from GetCapabilities and matched by metric name (Lden, Lnight, LAeq16h, LAeq6h, LA10,18h).",
    "Round 4 layers are 10 m rasters of modelled dB (receptor 4 m above ground, annual average, 2021 traffic), with a lower cutoff of 40 dB (35 dB for Lnight and LAeq,6h); a null level means below cutoff or outside the mapped network, not silence. The 5 dB band is derived here from the level.",
    "No Round 4 ArcGIS REST service under environment.data.gov.uk/arcgis/rest/services/DEFRA could be confirmed (Round 2 and 3 MapServers such as RoadNoiseLAeq16hRound3 exist); DEFRA_NOISE_ARCGIS_LAYERS switches to REST point queries when an operator confirms the layer URLs.",
    "Coverage: major roads (>3 million vehicles a year), major railways (>30,000 trains a year) and agglomerations over 100,000 people. Airport noise is a separate dataset not queried here.",
    "Strategic maps cannot substitute for a BS 7445 / BS 8233 survey required for BREEAM Hea 05 (indoor ambient noise), Pol 05 (noise attenuation to neighbours) or WELL S02, or for planning (ProPG). Use them to flag sites where a survey and facade sound insulation are likely to matter (Lden above 55 dB, Lnight above 50 dB are WHO Environmental Noise Guidelines thresholds).",
  ],
  healthCheck: simpleHealth((env) => wmsCapabilitiesUrl(sources(env)[0].wms)),
  operations: [
    {
      id: "noise_at_point",
      label: "Road and rail noise levels at a point",
      description: "One row per source and metric with the modelled level (dB) and 5 dB band from the Round 4 maps.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.5074" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.1278" },
        { name: "metric", label: "Metric", type: "select", default: "all", options: [{ value: "all", label: "All available (Lden, Lnight, LAeq)" }, { value: "Lden", label: "Lden (day-evening-night)" }, { value: "Lnight", label: "Lnight (night)" }, { value: "LAeq16h", label: "LAeq,16h (daytime)" }] },
        { name: "source", label: "Source", type: "select", default: "all", options: [{ value: "all", label: "Road and rail" }, { value: "road", label: "Road only" }, { value: "rail", label: "Rail only" }] },
      ],
      async run(params, ctx) {
        const latitude = params.latitude as number;
        const longitude = params.longitude as number;
        const metric = String(params.metric ?? "all");
        const sourceFilter = String(params.source ?? "all");
        const warnings: string[] = [];
        const raw: Record<string, unknown> = {};
        const rows: NoiseRow[] = [];
        const rest = arcgisLayers(ctx.env).filter((l) => (sourceFilter === "all" || l.source === sourceFilter) && (metric === "all" || l.metric === metric));
        let route: string;
        if (rest.length) {
          route = "ArcGIS REST point query";
          for (const spec of rest) {
            try {
              rows.push(await viaArcgis(ctx, spec, latitude, longitude, raw));
            } catch (e) {
              warnings.push(`${spec.source} ${spec.metric}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } else {
          route = "Defra Data Services Platform WMS GetFeatureInfo";
          for (const src of sources(ctx.env).filter((s) => sourceFilter === "all" || s.source === sourceFilter)) {
            try {
              rows.push(...(await viaWms(ctx, src, metric, latitude, longitude, warnings, raw)));
            } catch (e) {
              warnings.push(`${src.source} WMS (${src.wms}) could not be queried: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        const order = ["Lden", "Lnight", "LAeq16h", "LAeq6h", "LA10_18h"];
        rows.sort((a, b) => a.source.localeCompare(b.source) || order.indexOf(a.metric) - order.indexOf(b.metric));
        const mapped = rows.filter((r) => r.level_db !== null);
        const headline = ["road", "rail"].map((s) => {
          const lden = rows.find((r) => r.source === s && r.metric === "Lden");
          const lnight = rows.find((r) => r.source === s && r.metric === "Lnight");
          if (!lden && !lnight) return null;
          return `${s}: Lden ${lden?.level_db !== null && lden?.level_db !== undefined ? `${lden.level_db} dB (${lden.band})` : lden ? "below cutoff" : "n/a"}, Lnight ${lnight?.level_db !== null && lnight?.level_db !== undefined ? `${lnight.level_db} dB` : lnight ? "below cutoff" : "n/a"}`;
        }).filter(Boolean);
        const columns = ["source", "metric", "level_db", "band", "layer", "field"];
        if (!rows.length) {
          return {
            summary: `No Round 4 noise layers could be read at ${latitude}, ${longitude}.`,
            columns,
            rows: [],
            raw,
            provenance: makeProvenance(definition, ctx, { dataset: "END Round 4 (2022) road and rail noise", basis: "unavailable" }),
            warnings: warnings.length ? warnings : ["No layers were returned by the services; check the WMS endpoints in the notes."],
          };
        }
        return {
          summary: mapped.length
            ? `Strategic noise map (Round 4, 2022) at the point. ${headline.join("; ")}. ${mapped.some((r) => (r.metric === "Lden" && r.level_db! >= 55) || (r.metric === "Lnight" && r.level_db! >= 50)) ? "Levels exceed WHO guideline thresholds: expect a noise survey and facade sound insulation to be material for BREEAM Hea 05 / WELL S02." : "Levels are below WHO guideline thresholds where mapped."}`
            : `The point is outside the mapped road and rail noise contours (below the ${metric === "Lnight" ? 35 : 40} dB cutoff or away from major roads/railways) in the ${rows.length} layer(s) read. This means unmapped, not necessarily quiet: local roads, industry and aircraft are not included.`,
          columns,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "END Round 4 (2022) road and rail noise", version: "Round 4 (2021 data, published 2022)", basis: mapped.length ? "modelled" : "unavailable" }),
          warnings: [
            "Modelled long-term average at 4 m height on a 10 m grid; not a substitute for a BS 7445 / BS 8233 noise survey (BREEAM Hea 05 / Pol 05, WELL S02, ProPG). Unmapped means outside the strategic network, not quiet.",
            ...(route.startsWith("ArcGIS") ? ["Read via operator-supplied ArcGIS REST layers; band derivation assumes a NoiseClass/value field."] : []),
            ...warnings,
          ],
        };
      },
    },
  ],
});
