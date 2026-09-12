import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { wmsCapabilitiesUrl, wmsFeatureInfo, type WmsFeature } from "../_shared/wms";

/**
 * British Geological Survey geology at a point.
 *   1:50,000 DiGMapGB via OGC WMS GetFeatureInfo:
 *     https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer
 *     layers BGS.50k.Bedrock, BGS.50k.Superficial.deposits (confirmed from BGS
 *     documentation and public clients; BGS.50k.Artificial.ground and
 *     BGS.50k.Mass.movement are listed by BGS but the exact names are inferred).
 *   1:625,000 open geology via the BGS OGC API Features (bbox query):
 *     https://ogcapi.bgs.ac.uk/collections/bgsgeology625kbedrock/items
 *     https://ogcapi.bgs.ac.uk/collections/bgsgeology625ksuperficial/items
 * DiGMapGB attribute names (LEX_D, RCS_D, RANK_D, MAX_TIME_D, MIN_TIME_D,
 * BED_EQ_D, VERSION) follow the published DiGMapGB-50 user guide. Not
 * exercised live from this codebase.
 */

export const DEFAULT_WMS = "https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer";
export const OGC_API = "https://ogcapi.bgs.ac.uk";

export const LAYERS_50K = [
  { name: "BGS.50k.Bedrock", theme: "bedrock", confirmed: true },
  { name: "BGS.50k.Superficial.deposits", theme: "superficial deposits", confirmed: true },
  { name: "BGS.50k.Artificial.ground", theme: "artificial ground", confirmed: false },
  { name: "BGS.50k.Mass.movement", theme: "mass movement", confirmed: false },
];

type Props = Record<string, unknown>;

function p(props: Props, ...names: string[]): string | null {
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase());
    if (key !== undefined && props[key] !== null && props[key] !== undefined && String(props[key]).trim() !== "" && String(props[key]) !== "Null") return String(props[key]);
  }
  return null;
}

const COLUMNS = ["theme", "unit", "lithology", "rank", "age", "parent_units", "lex_code", "scale", "source", "attributes"];

export function themeOf(layer: string | null, props: Props): string {
  const l = (layer ?? "").toLowerCase();
  const sup = /superficial/.test(l) || /superficial/i.test(p(props, "MAP_THEME", "THEME") ?? "");
  const art = /artificial/.test(l) || /artificial/i.test(p(props, "MAP_THEME", "THEME") ?? "");
  const mass = /mass/.test(l);
  return art ? "artificial ground" : mass ? "mass movement" : sup ? "superficial deposits" : "bedrock";
}

export function geologyRow(f: WmsFeature, scale: string, source: string) {
  const props = f.properties;
  const maxT = p(props, "MAX_TIME_D", "MAX_AGE", "MAX_EPOCH", "MAX_PERIOD");
  const minT = p(props, "MIN_TIME_D", "MIN_AGE", "MIN_EPOCH", "MIN_PERIOD");
  const parents = [p(props, "BED_EQ_D"), p(props, "MB_EQ_D"), p(props, "FM_EQ_D"), p(props, "SUBFM_EQ_D"), p(props, "GP_EQ_D"), p(props, "SUPGP_EQ_D")].filter((x): x is string => !!x);
  const attrs = Object.entries(props)
    .filter(([k, v]) => v !== null && v !== "" && !/^(objectid|shape|shape_area|shape_length|id|fid)$/i.test(k))
    .slice(0, 16)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("; ");
  return {
    theme: themeOf(f.layer, props),
    unit: p(props, "LEX_D", "LEX_RCS_D", "RCS_ORIGIN", "NAME", "LEX_RCS", "UNIT", "GEOL_UNIT"),
    lithology: p(props, "RCS_D", "RCS_X", "LITHOLOGY", "ROCK_D", "RCS"),
    rank: p(props, "RANK_D", "RANK"),
    age: maxT && minT && maxT !== minT ? `${maxT} to ${minT}` : (maxT ?? minT),
    parent_units: parents.length ? parents.join(" > ") : null,
    lex_code: p(props, "LEX", "LEX_RCS", "LEX_CODE"),
    scale,
    source,
    attributes: attrs || null,
  };
}

interface OgcItems {
  type?: string;
  features?: { id?: unknown; properties?: Props; geometry?: { type?: string } }[];
  numberReturned?: number;
  numberMatched?: number;
}

export const definition = defineIntegration({
  id: "bgs-geology",
  name: "BGS geology at a point (bedrock and superficial)",
  group: "ground",
  access: "open",
  territory: "GB",
  description: "British Geological Survey mapped bedrock and superficial geology at a point: the 1:50,000 DiGMapGB layers via the BGS WMS (GetFeatureInfo) and the open 1:625,000 geology via the BGS OGC API. Gives the geological unit, lithology and age for ground-condition screening.",
  docsUrl: "https://www.bgs.ac.uk/technologies/web-map-services-wms/web-map-services-geology-50k/",
  termsUrl: "https://www.bgs.ac.uk/geological-data/datasets/licensing/",
  attribution: "Contains British Geological Survey materials © UKRI. 1:625,000 data under the Open Government Licence; 1:50,000 data viewed via the BGS WMS under BGS terms of use.",
  licence: "restricted",
  envVars: [
    { name: "BGS_WMS_BASE", required: false, description: "Override the BGS 50k geology WMS endpoint (default https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer)." },
    { name: "BGS_OGC_API_BASE", required: false, description: "Override the BGS OGC API Features base (default https://ogcapi.bgs.ac.uk)." },
  ],
  status: "built_unverified",
  notes: [
    "The 1:50,000 WMS is free to use for viewing and point queries under the BGS WMS terms; the underlying DiGMapGB-50 dataset is licensed and must not be redistributed. The 1:625,000 dataset is OGL.",
    "Mapped geology is a desk-study input, not a ground investigation: it does not replace boreholes, trial pits or a geotechnical report, and it says nothing about made ground thickness or contamination.",
    "GeoSure ground stability (shrink-swell, landslide, compressible ground, collapsible deposits, running sand, soluble rocks) is a licensed BGS product available via GeoReports or a data licence; it is referenced here, not queried. Radon potential is a separate joint UKHSA/BGS product (see ukradon).",
    "WMS INFO_FORMAT support varies by ArcGIS Server version; the helper tries application/json, then text/plain, then text/html. Layer names BGS.50k.Bedrock and BGS.50k.Superficial.deposits are confirmed; artificial ground and mass movement layer names are inferred from BGS descriptions.",
    "OGC API Features bbox filtering is standard; the 625k collection ids (bgsgeology625kbedrock, bgsgeology625ksuperficial) are confirmed from the BGS OGC API catalogue.",
  ],
  healthCheck: simpleHealth((env) => wmsCapabilitiesUrl(env.BGS_WMS_BASE || DEFAULT_WMS)),
  operations: [
    {
      id: "geology-at-point",
      label: "Bedrock and superficial geology at a point (1:50,000)",
      description: "Queries the BGS 50k bedrock, superficial deposits and (where present) artificial ground and mass movement layers at the point.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "includeInferredLayers", label: "Also query artificial ground and mass movement layers", type: "boolean", default: false },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.BGS_WMS_BASE || DEFAULT_WMS;
        const layers = LAYERS_50K.filter((l) => l.confirmed || params.includeInferredLayers).map((l) => l.name);
        const res = await wmsFeatureInfo(ctx, base, { layers, latitude: params.latitude as number, longitude: params.longitude as number });
        const rows = res.features.map((f) => geologyRow(f, "1:50,000", "BGS DiGMapGB-50 WMS"));
        const bedrock = rows.find((r) => r.theme === "bedrock");
        const superficial = rows.find((r) => r.theme === "superficial deposits");
        return {
          summary: rows.length
            ? `Bedrock: ${bedrock ? `${bedrock.unit ?? "unnamed unit"}${bedrock.lithology ? ` (${bedrock.lithology})` : ""}${bedrock.age ? `, ${bedrock.age}` : ""}` : "not returned"}. Superficial deposits: ${superficial ? `${superficial.unit ?? "unnamed unit"}${superficial.lithology ? ` (${superficial.lithology})` : ""}` : "none mapped at this point"}.${rows.length > 2 ? ` ${rows.length - 2} further feature(s) (artificial ground / mass movement).` : ""}`
            : `No BGS 50k geology returned at the point (response format ${res.format}); the point may be offshore, outside GB or the service may have returned an unparsed format.`,
          columns: COLUMNS,
          rows,
          raw: { url: res.url, infoFormat: res.infoFormat, format: res.format, body: res.raw.slice(0, 5000) },
          provenance: makeProvenance(definition, ctx, { dataset: "BGS DiGMapGB-50 (WMS GetFeatureInfo)", basis: rows.length ? "modelled" : "unavailable" }),
          warnings: ["Mapped geology at 1:50,000 is a desk-study input; it is not a site investigation and does not indicate ground stability, made ground or contamination."],
          links: [{ label: "BGS GeoIndex onshore", url: "https://mapapps2.bgs.ac.uk/geoindex/home.html" }, { label: "BGS GeoReports (GeoSure ground stability, licensed)", url: "https://www.bgs.ac.uk/geological-data/georeports/" }],
        };
      },
    },
    {
      id: "geology-625k",
      label: "Geology at a point (1:625,000, open data)",
      description: "Bedrock and superficial geology polygons from the open BGS 1:625,000 dataset intersecting a tiny bbox around the point, via the BGS OGC API Features.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.BGS_OGC_API_BASE || OGC_API;
        const lat = params.latitude as number;
        const lon = params.longitude as number;
        const d = 0.0002;
        const bbox = `${(lon - d).toFixed(6)},${(lat - d).toFixed(6)},${(lon + d).toFixed(6)},${(lat + d).toFixed(6)}`;
        const collections = [
          { id: "bgsgeology625kbedrock", theme: "bedrock" },
          { id: "bgsgeology625ksuperficial", theme: "superficial deposits" },
        ];
        const rows: ReturnType<typeof geologyRow>[] = [];
        const raw: Record<string, unknown> = {};
        for (const c of collections) {
          const url = buildUrl(base, `collections/${c.id}/items`, { bbox, limit: 5, f: "json" });
          const { data } = await fetchJson<OgcItems>(ctx, url, { headers: { accept: "application/geo+json, application/json" } });
          raw[c.id] = data?.features?.map((f) => f.properties) ?? [];
          for (const f of data?.features ?? []) rows.push({ ...geologyRow({ layer: c.theme, properties: f.properties ?? {} }, "1:625,000", "BGS OGC API Features"), theme: c.theme });
        }
        const bedrock = rows.find((r) => r.theme === "bedrock");
        const superficial = rows.find((r) => r.theme === "superficial deposits");
        return {
          summary: rows.length ? `1:625,000 bedrock: ${bedrock ? `${bedrock.unit ?? "unnamed"}${bedrock.lithology ? ` (${bedrock.lithology})` : ""}` : "none"}; superficial: ${superficial ? `${superficial.unit ?? "unnamed"}${superficial.lithology ? ` (${superficial.lithology})` : ""}` : "none mapped"}.` : "No 1:625,000 geology polygons intersect the point.",
          columns: COLUMNS,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "BGS Geology 625k (OGC API Features)", basis: rows.length ? "modelled" : "unavailable" }),
          warnings: ["1:625,000 is a national overview scale (generalised polygons); use the 1:50,000 query for site screening."],
        };
      },
    },
  ],
});
