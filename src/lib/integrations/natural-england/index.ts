import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type EnvLike } from "../framework";
import { arcgisDate, arcgisPointQuery, attr } from "../_shared/arcgis";

/**
 * Natural England Open Data (ArcGIS Online FeatureServer layers).
 *
 * Built from the ArcGIS REST query reference and the layer names used by
 * open-source consumers (digital-ecology/EcoDS_Package, digital-land,
 * traffordDataLab and others); no live call has been made from this
 * codebase. Attribute names differ per layer, so names are read from a list
 * of candidates and the raw attributes are kept.
 */

export const DEFAULT_BASE = "https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services";

export function arcgisBase(env: EnvLike): string {
  return (env.NATURAL_ENGLAND_ARCGIS_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

export interface Layer {
  /** Service name in the FeatureServer URL. */
  service: string;
  designation: string;
  kind: "statutory" | "habitat" | "landscape";
  nameFields: string[];
  refFields: string[];
  /** Confirmed from open-source usage of this exact service name. */
  confirmed: boolean;
}

export const LAYERS: Layer[] = [
  { service: "SSSI_England", designation: "Site of Special Scientific Interest", kind: "statutory", nameFields: ["SSSI_NAME", "NAME"], refFields: ["REFERENCE", "SSSI_CODE", "ENSISID"], confirmed: true },
  { service: "Special_Areas_of_Conservation_England", designation: "Special Area of Conservation", kind: "statutory", nameFields: ["SAC_NAME", "NAME"], refFields: ["SAC_CODE", "SITE_CODE", "CODE"], confirmed: true },
  { service: "Special_Protection_Areas_England", designation: "Special Protection Area", kind: "statutory", nameFields: ["SPA_NAME", "NAME"], refFields: ["SPA_CODE", "SITE_CODE", "CODE"], confirmed: true },
  { service: "Ramsar_England", designation: "Ramsar wetland", kind: "statutory", nameFields: ["NAME", "RAMSAR_NAME"], refFields: ["CODE", "SITE_CODE", "REFERENCE"], confirmed: true },
  { service: "National_Nature_Reserves_England", designation: "National Nature Reserve", kind: "statutory", nameFields: ["NNR_NAME", "NAME"], refFields: ["REFERENCE", "NNR_CODE", "CODE"], confirmed: true },
  { service: "Local_Nature_Reserves_England", designation: "Local Nature Reserve", kind: "statutory", nameFields: ["LNR_NAME", "NAME"], refFields: ["REFERENCE", "LNR_CODE", "CODE"], confirmed: true },
  { service: "Ancient_Woodland_England", designation: "Ancient woodland", kind: "habitat", nameFields: ["NAME", "THEMNAME"], refFields: ["OBJECTID", "AWI_ID"], confirmed: true },
  { service: "Priority_Habitats_Inventory_England", designation: "Priority habitat", kind: "habitat", nameFields: ["Main_Habit", "MAIN_HABIT", "Habitat"], refFields: ["OBJECTID", "Confidence"], confirmed: true },
  { service: "National_Parks_England", designation: "National Park", kind: "landscape", nameFields: ["NAME", "NP_NAME"], refFields: ["CODE", "REFERENCE"], confirmed: true },
  { service: "Areas_of_Outstanding_Natural_Beauty_England", designation: "National Landscape (AONB)", kind: "landscape", nameFields: ["NAME", "AONB_NAME"], refFields: ["CODE", "REFERENCE"], confirmed: true },
];

export function layerUrl(env: EnvLike, layer: Layer): string {
  return `${arcgisBase(env)}/${layer.service}/FeatureServer/0`;
}

export type Hit = {
  designation: string;
  kind: string;
  name: string | null;
  reference: string | null;
  area_ha: number | null;
  status: string | null;
  notified: string | null;
  distance_m: null;
  layer: string;
};

export function featureToHit(layer: Layer, attributes: Record<string, unknown>): Hit {
  const area = attr(attributes, "Shape__Area", "SHAPE_Area", "AREA", "Area_Ha", "HECTARES");
  const areaHa = typeof area === "number" ? (attributes.Shape__Area !== undefined || attributes.SHAPE_Area !== undefined ? Math.round(area / 100) / 100 : Math.round(area * 100) / 100) : null;
  return {
    designation: layer.designation,
    kind: layer.kind,
    name: (attr(attributes, ...layer.nameFields) as string | null) ?? null,
    reference: attr(attributes, ...layer.refFields) !== null ? String(attr(attributes, ...layer.refFields)) : null,
    area_ha: areaHa,
    status: (attr(attributes, "STATUS", "Status", "CONDITION") as string | null) ?? null,
    notified: arcgisDate(attr(attributes, "NOTIFYDATE", "NOTIF_DATE", "DATE_DESIG", "Date_Desig")) ?? ((attr(attributes, "NOTIFYDATE", "DATE_DESIG") as string | null) ?? null),
    distance_m: null,
    layer: layer.service,
  };
}

export const definition = defineIntegration({
  id: "natural-england",
  name: "Natural England designated sites and habitats",
  group: "nature",
  access: "gis",
  territory: "England",
  description: "Statutory designated sites (SSSI, SAC, SPA, Ramsar, NNR, LNR), ancient woodland, priority habitats, National Parks and National Landscapes within a distance of a point, from Natural England's open ArcGIS services.",
  docsUrl: "https://naturalengland-defra.opendata.arcgis.com/",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Natural England Open Data Geoportal. © Natural England, © Crown copyright and database right.",
  licence: "OGL",
  envVars: [{ name: "NATURAL_ENGLAND_ARCGIS_BASE", required: false, description: `ArcGIS REST services root. Default ${DEFAULT_BASE}.` }],
  status: "built_unverified",
  notes: [
    "Service names are those used by open-source consumers of the Natural England ArcGIS Online organisation (SSSI_England, Special_Areas_of_Conservation_England, Special_Protection_Areas_England, Ramsar_England, National_Nature_Reserves_England, Local_Nature_Reserves_England, Ancient_Woodland_England, Priority_Habitats_Inventory_England, National_Parks_England, Areas_of_Outstanding_Natural_Beauty_England); Natural England renames layers occasionally, so a failing layer is reported as a warning rather than failing the whole query.",
    "Attribute field names differ per layer and have not been checked live; name and reference are read from candidate fields and the raw attributes are returned.",
    "ArcGIS point-distance queries return features intersecting the buffer but not the distance to each, so distance_m is null; a hit means the feature lies within the radius.",
    "A desktop designated-site search is not a biodiversity survey. Biodiversity Net Gain requires a habitat survey by a competent ecologist and the statutory biodiversity metric; SSSI Impact Risk Zones and Habitats Regulations Assessment screening are separate steps.",
    "Coverage is England only; use NatureScot, NRW (DataMapWales) and DAERA services for the other UK nations.",
  ],
  healthCheck: simpleHealth((env) => `${layerUrl(env, LAYERS[0])}?f=json`),
  operations: [
    {
      id: "designations_near",
      label: "Designated sites and habitats within a distance of a point",
      description: "Queries each Natural England layer for features within the radius and lists one row per hit.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "distance_m", label: "Distance (m)", type: "integer", default: 2000, min: 0, max: 20000, help: "Statutory sites are often screened at 2 km (SSSI) to 10 km+ (SAC/SPA bats, Ramsar)." },
        { name: "layers", label: "Layers", type: "select", default: "all", options: [{ value: "all", label: "All layers" }, { value: "statutory", label: "Statutory sites only" }, { value: "habitat", label: "Habitats only (ancient woodland, priority habitat)" }, { value: "landscape", label: "Landscape designations only" }] },
      ],
      async run(params, ctx) {
        const selected = LAYERS.filter((l) => params.layers === "all" || !params.layers || l.kind === params.layers);
        const hits: Hit[] = [];
        const warnings: string[] = [];
        const raw: Record<string, unknown> = {};
        const results = await Promise.all(
          selected.map(async (layer) => {
            try {
              const res = await arcgisPointQuery(ctx, layerUrl(ctx.env, layer), { latitude: params.latitude as number, longitude: params.longitude as number, distanceMeters: params.distance_m as number, returnGeometry: false, resultRecordCount: 100 });
              return { layer, res };
            } catch (e) {
              const msg = e instanceof IntegrationHttpError ? `${e.message}` : e instanceof Error ? e.message : String(e);
              return { layer, error: msg };
            }
          }),
        );
        for (const r of results) {
          if ("error" in r) {
            warnings.push(`${r.layer.designation} layer (${r.layer.service}) could not be queried: ${r.error}`);
            continue;
          }
          raw[r.layer.service] = { count: r.res.features?.length ?? 0, exceededTransferLimit: r.res.exceededTransferLimit ?? false, features: r.res.features };
          for (const f of r.res.features ?? []) hits.push(featureToHit(r.layer, f.attributes));
        }
        const order: Record<string, number> = { statutory: 0, habitat: 1, landscape: 2 };
        hits.sort((a, b) => order[a.kind] - order[b.kind] || a.designation.localeCompare(b.designation) || (a.name ?? "").localeCompare(b.name ?? ""));
        const statutory = hits.filter((h) => h.kind === "statutory");
        const byDesignation = new Map<string, number>();
        for (const h of hits) byDesignation.set(h.designation, (byDesignation.get(h.designation) ?? 0) + 1);
        const breakdown = [...byDesignation.entries()].map(([d, n]) => `${n} ${d}`).join(", ");
        const queried = results.filter((r) => !("error" in r)).length;
        return {
          summary: hits.length
            ? `${hits.length} designated feature(s) within ${params.distance_m} m across ${queried} of ${selected.length} layers: ${breakdown}. ${statutory.length ? `Statutory sites: ${[...new Set(statutory.map((h) => h.name).filter(Boolean))].slice(0, 5).join("; ")}.` : "No statutory sites within the radius."}`
            : `No designated sites or mapped habitats within ${params.distance_m} m of ${params.latitude}, ${params.longitude} in the ${queried} layer(s) queried.`,
          columns: ["designation", "kind", "name", "reference", "area_ha", "status", "notified", "distance_m", "layer"],
          rows: hits,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "FeatureServer point-distance query", basis: hits.length ? "measured" : queried ? "unavailable" : "unavailable" }),
          warnings: [
            "Desktop screening only: Biodiversity Net Gain needs a site survey by an ecologist and the statutory metric; consult SSSI Impact Risk Zones and, for European sites, Habitats Regulations Assessment.",
            ...warnings,
          ],
        };
      },
    },
  ],
});
