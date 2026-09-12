import { defineIntegration, makeProvenance, simpleHealth, type EnvLike } from "../framework";
import { arcgisPointQuery, attr } from "../_shared/arcgis";

/**
 * WRI Aqueduct 4.0 baseline annual water risk at a point.
 *
 * Service: the Esri Living Atlas feature service published with WRI,
 *   https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/aqueduct_water_risk/FeatureServer/1
 * (layer 1 = "Baseline Annual"; layer 2 = "Baseline Monthly"), confirmed
 * from several open-source consumers that run point queries against it with
 * fields bws_score/bws_cat/bws_label/name_0/name_1. Indicator codes and the
 * _raw/_score/_cat/_label suffixes come from the Aqueduct 4.0 data
 * dictionary (github.com/wri/Aqueduct40). WRI also hosts a copy at
 * services9.arcgis.com/RHVPKKiFTONKtxq3/.../Aqueduct40_waterrisk_download_y2023m07d05/FeatureServer/0.
 * Not exercised live from this codebase.
 */

export const DEFAULT_LAYER = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/aqueduct_water_risk/FeatureServer/1";

export function layerUrl(env: EnvLike): string {
  return (env.AQUEDUCT_ARCGIS_URL?.trim() || DEFAULT_LAYER).replace(/\/$/, "");
}

/** Aqueduct 4.0 indicators reported, in display order. */
export const INDICATORS: { code: string; indicator: string; group: string; source: string }[] = [
  { code: "bws", indicator: "Baseline water stress", group: "Physical risk: quantity", source: "Aqueduct 4.0" },
  { code: "bwd", indicator: "Baseline water depletion", group: "Physical risk: quantity", source: "Aqueduct 4.0" },
  { code: "iav", indicator: "Interannual variability", group: "Physical risk: quantity", source: "Aqueduct 4.0" },
  { code: "sev", indicator: "Seasonal variability", group: "Physical risk: quantity", source: "Aqueduct 4.0" },
  { code: "gtd", indicator: "Groundwater table decline", group: "Physical risk: quantity", source: "Aqueduct 3.0" },
  { code: "rfr", indicator: "Riverine flood risk", group: "Physical risk: quantity", source: "Aqueduct 3.0" },
  { code: "cfr", indicator: "Coastal flood risk", group: "Physical risk: quantity", source: "Aqueduct 3.0" },
  { code: "drr", indicator: "Drought risk", group: "Physical risk: quantity", source: "Aqueduct 3.0" },
  { code: "ucw", indicator: "Untreated connected wastewater", group: "Physical risk: quality", source: "Aqueduct 3.0" },
  { code: "cep", indicator: "Coastal eutrophication potential", group: "Physical risk: quality", source: "Aqueduct 3.0" },
  { code: "udw", indicator: "Unimproved/no drinking water", group: "Regulatory and reputational", source: "Aqueduct 3.0" },
  { code: "usa", indicator: "Unimproved/no sanitation", group: "Regulatory and reputational", source: "Aqueduct 3.0" },
  { code: "rri", indicator: "Peak RepRisk country ESG risk index", group: "Regulatory and reputational", source: "Aqueduct 3.0" },
  { code: "w_awr_def_tot", indicator: "Overall water risk (default weighting)", group: "Aggregated", source: "Aqueduct 4.0" },
];

export type IndicatorRow = {
  indicator: string;
  code: string;
  group: string;
  category: number | null;
  label: string | null;
  score: number | null;
  raw_value: number | null;
  source: string;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function attributesToRows(a: Record<string, unknown>): IndicatorRow[] {
  return INDICATORS.map((i) => {
    const cat = num(attr(a, `${i.code}_cat`));
    return {
      indicator: i.indicator,
      code: i.code,
      group: i.group,
      category: cat,
      label: (attr(a, `${i.code}_label`) as string | null) ?? null,
      score: num(attr(a, `${i.code}_score`)),
      raw_value: num(attr(a, `${i.code}_raw`)),
      source: i.source,
    };
  }).filter((r) => r.category !== null || r.label !== null || r.score !== null);
}

export const definition = defineIntegration({
  id: "wri-aqueduct",
  name: "WRI Aqueduct 4.0 water risk",
  group: "flood_water",
  access: "gis",
  territory: "Global",
  description: "Baseline water stress, water depletion, variability, groundwater decline, riverine and coastal flood risk, drought risk and the other Aqueduct 4.0 indicators for the sub-basin containing a point, from WRI's feature service in the ArcGIS Living Atlas.",
  docsUrl: "https://github.com/wri/Aqueduct40",
  termsUrl: "https://www.wri.org/data/aqueduct-global-maps-40-data",
  attribution: "Aqueduct 4.0 © World Resources Institute, licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). Hosted in the ArcGIS Living Atlas of the World.",
  licence: "CC_BY",
  envVars: [{ name: "AQUEDUCT_ARCGIS_URL", required: false, description: `Override the Aqueduct baseline annual layer URL (default ${DEFAULT_LAYER}).` }],
  status: "built_unverified",
  notes: [
    "Service URL and field names (bws_cat, bws_label, bws_score, name_0, name_1, pfaf_id) are confirmed from open-source point-query clients and the Aqueduct 4.0 data dictionary; the connector has not been run live from this environment.",
    "Geometries are HydroBASINS level-6 sub-basins intersected with provinces and aquifers (thousands of km2); values describe the basin, not the site. Category -1 / label 'No data' means the indicator is not computed for that basin (e.g. arid and low water use for water stress).",
    "For England, the Environment Agency's water stressed areas classification (used for metering and water resources planning) is the preferred national reference; Aqueduct is for non-UK sites and for GRESB, CDP and TCFD-style portfolio screening.",
    "Baseline period 1979-2019 hydrology (PCR-GLOBWB 2). Future projections (2030/2050/2080, optimistic / business-as-usual / pessimistic) are separate layers and are not queried here; do not mix baseline and projected values.",
    "Flood and drought indicators (rfr, cfr, drr) and the quality/reputational indicators are carried over from Aqueduct 3.0 (see data dictionary); they are basin-scale probabilities, not site flood risk - use the EA, SEPA, NRW or DfI flood connectors for that.",
  ],
  healthCheck: simpleHealth((env) => `${layerUrl(env)}?f=json`),
  operations: [
    {
      id: "water_risk_at_point",
      label: "Aqueduct water risk indicators at a point",
      description: "Baseline annual indicators for the sub-basin containing the point: one row per indicator with category, label and score.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.5074" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.1278" },
      ],
      async run(params, ctx) {
        const latitude = params.latitude as number;
        const longitude = params.longitude as number;
        const res = await arcgisPointQuery(ctx, layerUrl(ctx.env), { latitude, longitude, returnGeometry: false, resultRecordCount: 1 });
        const columns = ["indicator", "code", "group", "category", "label", "score", "raw_value", "source"];
        const feature = res.features?.[0];
        if (!feature) {
          return {
            summary: `No Aqueduct sub-basin covers ${latitude}, ${longitude} (open ocean, Antarctica or outside the modelled basins).`,
            columns,
            rows: [],
            raw: res,
            provenance: makeProvenance(definition, ctx, { dataset: "Aqueduct 4.0 baseline annual", basis: "unavailable" }),
          };
        }
        const a = feature.attributes;
        const rows = attributesToRows(a);
        const by = (code: string) => rows.find((r) => r.code === code);
        const bws = by("bws");
        const place = [attr(a, "name_1"), attr(a, "name_0")].filter(Boolean).join(", ");
        const basin = attr(a, "pfaf_id", "PFAF_ID");
        const flood = [by("rfr"), by("cfr")].filter(Boolean).map((r) => `${r!.indicator.toLowerCase()} ${r!.label ?? "n/a"}`).join(", ");
        return {
          summary: `Baseline water stress ${bws?.label ?? "not available"}${bws?.score !== null && bws?.score !== undefined ? ` (score ${bws.score}/5)` : ""} for the sub-basin${place ? ` in ${place}` : ""}${basin ? ` (HydroBASINS ${basin})` : ""}. Water depletion ${by("bwd")?.label ?? "n/a"}; drought risk ${by("drr")?.label ?? "n/a"}; ${flood || "flood risk n/a"}.`,
          columns,
          rows,
          raw: { attributes: a, fields: res.fields },
          provenance: makeProvenance(definition, ctx, { dataset: "Aqueduct 4.0 baseline annual", version: "4.0 (baseline 1979-2019)", basis: "modelled" }),
          warnings: [
            "Basin-scale modelled indicators: they describe the sub-basin (typically thousands of km2), not the site. For England prefer the EA water stressed areas classification; for site flood risk use the national flood-map connectors.",
          ],
        };
      },
    },
  ],
});
