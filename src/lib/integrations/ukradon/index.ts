import { buildUrl, defineIntegration, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";
import { arcgisPointQuery, arcgisQuery, attr } from "../_shared/arcgis";

/**
 * UKHSA/BGS Indicative Atlas of Radon (1 km grid, OGL) at a point.
 *
 * Default route: the BGS GeoIndex ArcGIS MapServer
 *   https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/radon/MapServer
 * queried with the REST `identify` operation (layers=all), as used by an
 * open-source property service that reads attributes CLASS_MAX and
 * Description from results[0]. BGS documents the same service as a WMS
 * (GeoIndex_Onshore/radon/MapServer/WmsServer). The layer id is not needed
 * for identify. Alternative route: UKRADON_ARCGIS_URL pointing at a
 * FeatureServer/MapServer layer (e.g. the BGS ArcGIS Hub "Radon Indicative
 * Atlas" item) queried with the standard point query. Not exercised live.
 */

export const DEFAULT_MAPSERVER = "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/radon/MapServer";

/** Indicative atlas classes: percentage of homes estimated above the 200 Bq/m3 Action Level. */
export const CLASS_BANDS: Record<number, { band: string; affected: boolean; protection: string }> = {
  1: { band: "Less than 1% of homes above the Action Level", affected: false, protection: "No radon protective measures required for new build" },
  2: { band: "1-3% of homes above the Action Level", affected: true, protection: "Radon Affected Area: testing advised; no protective measures for new build below 3%" },
  3: { band: "3-5% of homes above the Action Level", affected: true, protection: "Basic radon protection (radon-proof membrane) for new build (BR 211)" },
  4: { band: "5-10% of homes above the Action Level", affected: true, protection: "Basic radon protection (radon-proof membrane) for new build (BR 211)" },
  5: { band: "10-30% of homes above the Action Level", affected: true, protection: "Full radon protection (membrane plus sump or ventilated subfloor) for new build (BR 211)" },
  6: { band: "More than 30% of homes above the Action Level", affected: true, protection: "Full radon protection (membrane plus sump or ventilated subfloor) for new build (BR 211)" },
};

export function mapServer(env: EnvLike): string {
  return (env.UKRADON_MAPSERVER?.trim() || DEFAULT_MAPSERVER).replace(/\/$/, "");
}

export function layerUrl(env: EnvLike): string | null {
  const u = env.UKRADON_ARCGIS_URL?.trim();
  return u ? u.replace(/\/$/, "") : null;
}

/** ArcGIS MapServer identify at a point with a small map extent (required by the operation). */
export function identifyUrl(base: string, latitude: number, longitude: number): string {
  const d = 0.02;
  return buildUrl(base, "identify", {
    geometry: `${longitude},${latitude}`,
    geometryType: "esriGeometryPoint",
    sr: 4326,
    layers: "all",
    tolerance: 1,
    mapExtent: `${(longitude - d).toFixed(5)},${(latitude - d).toFixed(5)},${(longitude + d).toFixed(5)},${(latitude + d).toFixed(5)}`,
    imageDisplay: "400,400,96",
    returnGeometry: false,
    f: "json",
  });
}

interface IdentifyResponse {
  results?: { layerId?: number; layerName?: string; attributes?: Record<string, unknown> }[];
  error?: { code: number; message: string };
}

export type RadonRow = {
  class_max: number | null;
  band: string | null;
  radon_affected_area: boolean | null;
  new_build_protection: string | null;
  description: string | null;
  grid_square: string | null;
  layer: string | null;
}

/** Reads the class from CLASS_MAX (or similar) and a text description; infers the class from a "%" band string when only text is present. */
export function attributesToRow(attributes: Record<string, unknown>, layer: string | null): RadonRow {
  const rawClass = attr(attributes, "CLASS_MAX", "CLASSMAX", "MAX_CLASS", "CLASS", "RADON_CLASS", "RadonClass", "gridcode", "GRIDCODE", "Value");
  let classMax = typeof rawClass === "number" ? rawClass : typeof rawClass === "string" && /^\d+$/.test(rawClass.trim()) ? Number(rawClass) : null;
  const description = attr(attributes, "Description", "DESCRIPTION", "DESC", "BAND", "Band", "RADON_BAND", "LEGEND") as string | null;
  if (classMax === null && typeof description === "string") {
    const compact = description.toLowerCase().replace(/\s+/g, "");
    const patterns = [/(<1|lessthan1)%/, /1-3%/, /3-5%/, /5-10%/, /10-30%/, /(>30|morethan30)%/];
    const idx = patterns.findIndex((re) => re.test(compact));
    if (idx >= 0) classMax = idx + 1;
  }
  const info = classMax !== null ? CLASS_BANDS[classMax] : undefined;
  return {
    class_max: classMax,
    band: info?.band ?? (typeof description === "string" ? description : null),
    radon_affected_area: info ? info.affected : null,
    new_build_protection: info?.protection ?? null,
    description: typeof description === "string" ? description : null,
    grid_square: (attr(attributes, "GRID_REF", "GRIDREF", "TILE", "km_square", "KM_SQUARE", "OSGB") as string | null) ?? null,
    layer,
  };
}

export const definition = defineIntegration({
  id: "ukradon",
  name: "UKradon indicative atlas (UKHSA/BGS radon affected areas)",
  group: "ground",
  access: "gis",
  territory: "UK",
  description: "Radon affected-area class for the 1 km grid square containing a point, from the joint UKHSA/BGS Indicative Atlas of Radon (percentage of homes estimated above the 200 Bq/m3 Action Level), used to decide whether radon protective measures and workplace testing apply.",
  docsUrl: "https://www.bgs.ac.uk/datasets/radon-data-indicative-atlas-of-radon/",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Radon Indicative Atlas © UKHSA and BGS (UKRI), licensed under the Open Government Licence v3.0. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [
    { name: "UKRADON_ARCGIS_URL", required: false, description: "Optional FeatureServer/MapServer layer URL for the Radon Indicative Atlas (e.g. from the BGS ArcGIS Hub item); when set, a standard point query is used instead of the GeoIndex identify call." },
    { name: "UKRADON_MAPSERVER", required: false, description: `Override the BGS GeoIndex radon MapServer used for identify (default ${DEFAULT_MAPSERVER}).` },
  ],
  status: "built_unverified",
  notes: [
    "Service: BGS GeoIndex radon MapServer (map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/radon/MapServer) via the REST identify operation, confirmed from BGS's WMS documentation and an open-source consumer that reads CLASS_MAX and Description; the BGS ArcGIS Hub 'Radon Indicative Atlas' FeatureServer URL was not confirmed and can be supplied as UKRADON_ARCGIS_URL. Not exercised live from this environment.",
    "Class values 1-6 are mapped to the published atlas bands (<1%, 1-3%, 3-5%, 5-10%, 10-30%, >30% of homes above the Action Level) in that order; the mapping of CLASS_MAX integers to bands is inferred from the legend order and should be checked against the Description text, which is passed through verbatim.",
    "Indicative only: each 1 km square is classed by the highest radon potential found within it, so most properties in a square have lower potential than the class. The definitive 25 m radon potential dataset is licensed (BGS/UKHSA) and is what a UKradon address report or Groundsure/Landmark report uses.",
    "Being in a Radon Affected Area (1% or more) does not mean a building has high radon; only a 3-month measurement does. Employers must assess radon in workplaces in affected areas (Ionising Radiations Regulations 2017); Approved Document C / BR 211 set basic (3-10%) and full (>10%) protection for new build.",
    "New-build protection thresholds shown are BR 211 guidance for England and Wales; Scotland and Northern Ireland follow their own building standards.",
  ],
  healthCheck: simpleHealth((env) => `${layerUrl(env) ?? mapServer(env)}?f=json`),
  operations: [
    {
      id: "radon_class_at_point",
      label: "Radon affected-area class at a point",
      description: "Indicative atlas class for the 1 km square containing the point, with the band, affected-area flag and BR 211 new-build protection level.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "50.37" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-4.14" },
      ],
      async run(params, ctx: OperationContext) {
        const latitude = params.latitude as number;
        const longitude = params.longitude as number;
        const columns = ["class_max", "band", "radon_affected_area", "new_build_protection", "description", "grid_square", "layer"];
        const layer = layerUrl(ctx.env);
        let rows: RadonRow[] = [];
        let raw: unknown;
        let dataset: string;
        if (layer) {
          const res = await arcgisPointQuery(ctx, layer, { latitude, longitude, returnGeometry: false, resultRecordCount: 5 });
          raw = res;
          dataset = "Radon Indicative Atlas layer point query";
          rows = (res.features ?? []).map((f) => attributesToRow(f.attributes, layer));
        } else {
          const url = identifyUrl(mapServer(ctx.env), latitude, longitude);
          const data = await arcgisQuery<Record<string, unknown>>(ctx, url) as unknown as IdentifyResponse;
          raw = data;
          dataset = "BGS GeoIndex radon MapServer identify";
          rows = (data.results ?? []).map((r) => attributesToRow(r.attributes ?? {}, r.layerName ?? (r.layerId !== undefined ? String(r.layerId) : null)));
        }
        rows = rows.filter((r) => r.class_max !== null || r.description !== null).slice(0, 1);
        const warnings = [
          "Indicative 1 km class, not a measurement: the square is classed by its highest radon potential. Order a UKradon address report for the definitive class and measure the building to know its level.",
        ];
        if (!rows.length) {
          return {
            summary: `No radon atlas class returned for ${latitude}, ${longitude}; the point may be outside Great Britain/Northern Ireland coverage or in a square below the 1% class where the service returns no feature.`,
            columns,
            rows: [],
            raw,
            provenance: makeProvenance(definition, ctx, { dataset, basis: "unavailable" }),
            warnings,
          };
        }
        const r = rows[0];
        return {
          summary: r.class_max !== null
            ? `Radon indicative class ${r.class_max}: ${r.band}. ${r.radon_affected_area ? "This is a Radon Affected Area: workplace assessment applies and " : "Not a Radon Affected Area; "}${r.new_build_protection?.toLowerCase() ?? "no protection guidance"}.`
            : `Radon atlas description at the point: ${r.description}. The class number could not be read; treat the description as the result.`,
          columns,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset, basis: "modelled" }),
          warnings,
        };
      },
    },
  ],
});
