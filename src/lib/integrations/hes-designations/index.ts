import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type EnvLike } from "../framework";
import { arcgisPointQuery, attr } from "../_shared/arcgis";

/**
 * Historic Environment Scotland designations via the HES INSPIRE ArcGIS Server
 * (https://inspire.hes.scot/arcgis/rest/services/HES/...).
 *
 * Confirmed from the HES services directory as indexed by search engines and
 * from open-source consumers (IBM/chuk-mcp-her, locgrimshaw/mastermapper,
 * frankintech00/historic_map): the MapServer services Listed_Buildings
 * (layer 0 "Listed Buildings by Category", points, display field ENT_TITLE,
 * JSON/GeoJSON query, maxRecordCount 5000), Scheduled_Monuments,
 * Conservation_Areas and the combined HES_Designations service. Attribute
 * names DES_REF, DES_TITLE, CATEGORY and LINK come from chuk-mcp-her's
 * Scotland adapter; the HES_Designations sub-layer ids used for gardens,
 * battlefields and world heritage sites come from the same adapter and are
 * unverified. No live call has been made from this codebase.
 */

export const DEFAULT_BASE = "https://inspire.hes.scot/arcgis/rest/services/HES";

export function arcgisBase(env: EnvLike): string {
  return (env.HES_ARCGIS_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

export interface Layer {
  /** Path under the HES folder, e.g. "Listed_Buildings/MapServer/0". */
  path: string;
  designation: string;
  kind: "statutory" | "area";
  hasCategory: boolean;
  /** Service and layer id confirmed from the HES directory (true) or inferred from a third-party adapter (false). */
  confirmed: boolean;
}

export const DEFAULT_LAYERS: Layer[] = [
  { path: "Listed_Buildings/MapServer/0", designation: "Listed building", kind: "statutory", hasCategory: true, confirmed: true },
  { path: "Scheduled_Monuments/MapServer/0", designation: "Scheduled monument", kind: "statutory", hasCategory: false, confirmed: true },
  { path: "Conservation_Areas/MapServer/0", designation: "Conservation area", kind: "area", hasCategory: false, confirmed: true },
  { path: "HES_Designations/MapServer/4", designation: "Garden and designed landscape", kind: "area", hasCategory: false, confirmed: false },
  { path: "HES_Designations/MapServer/3", designation: "Battlefield", kind: "area", hasCategory: false, confirmed: false },
  { path: "HES_Designations/MapServer/6", designation: "World heritage site", kind: "area", hasCategory: false, confirmed: false },
];

/**
 * HES_ARCGIS_LAYERS overrides the layer list as "Designation=Service/MapServer/id;..." (relative to the base,
 * or an absolute URL). Designations named "Listed building" keep the category column.
 */
export function layersFor(env: EnvLike): Layer[] {
  const spec = env.HES_ARCGIS_LAYERS?.trim();
  if (!spec) return DEFAULT_LAYERS;
  return spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [designation, path] = s.split("=").map((x) => x.trim());
      const known = DEFAULT_LAYERS.find((l) => l.designation.toLowerCase() === designation.toLowerCase());
      return { path, designation, kind: known?.kind ?? "statutory", hasCategory: known?.hasCategory ?? /listed/i.test(designation), confirmed: false };
    });
}

export function layerUrl(env: EnvLike, layer: Layer): string {
  return /^https?:\/\//.test(layer.path) ? layer.path : `${arcgisBase(env)}/${layer.path}`;
}

export function portalUrl(desRef: string): string {
  return `https://portal.historicenvironment.scot/designation/${encodeURIComponent(desRef)}`;
}

export type Hit = {
  type: string;
  name: string | null;
  category: string | null;
  reference: string | null;
  address: string | null;
  local_authority: string | null;
  link: string | null;
  layer: string;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}

export function featureToHit(layer: Layer, attributes: Record<string, unknown>): Hit {
  const ref = str(attr(attributes, "DES_REF", "DESIGNATION_REF", "DES_REFERENCE", "REF"));
  const link = str(attr(attributes, "LINK", "URL", "HYPERLINK", "PORTAL_LINK"));
  return {
    type: layer.designation,
    name: str(attr(attributes, "DES_TITLE", "ENT_TITLE", "NAME", "TITLE")),
    category: layer.hasCategory ? str(attr(attributes, "CATEGORY", "CAT", "LB_CATEGORY")) : null,
    reference: ref,
    address: str(attr(attributes, "ADDRESS", "ENT_ADDRESS", "DES_ADDRESS", "LOCATION")),
    local_authority: str(attr(attributes, "LOCAL_AUTH", "LOCAL_AUTHORITY", "LA", "COUNCIL", "LA_NAME")),
    link: link ?? (ref ? portalUrl(ref) : null),
    layer: layer.path,
  };
}

export const definition = defineIntegration({
  id: "hes-designations",
  name: "Historic Environment Scotland designations",
  group: "identity",
  access: "gis",
  territory: "Scotland",
  description: "Listed buildings (categories A, B and C), scheduled monuments, conservation areas, gardens and designed landscapes, battlefields and world heritage sites within a distance of a point in Scotland, from the HES INSPIRE ArcGIS services.",
  docsUrl: "https://inspire.hes.scot/arcgis/rest/services/HES",
  termsUrl: "https://portal.historicenvironment.scot/termsandconditions",
  attribution: "Contains Historic Environment Scotland and Ordnance Survey data © Historic Environment Scotland - Scottish Charity No. SC045925 © Crown copyright and database right 2026. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [
    { name: "HES_ARCGIS_BASE", required: false, description: `Override the HES ArcGIS services folder (default ${DEFAULT_BASE}).` },
    { name: "HES_ARCGIS_LAYERS", required: false, description: "Override the layer list as 'Designation=Service/MapServer/id;...' relative to the base, e.g. 'Listed building=Listed_Buildings/MapServer/0;Scheduled monument=Scheduled_Monuments/MapServer/0'." },
  ],
  status: "built_unverified",
  notes: [
    "Service names Listed_Buildings, Scheduled_Monuments, Conservation_Areas and HES_Designations under https://inspire.hes.scot/arcgis/rest/services/HES are confirmed from the HES services directory; layer 0 of Listed_Buildings is 'Listed Buildings by Category' (points, display field ENT_TITLE). Layer 0 for Scheduled_Monuments and Conservation_Areas is assumed.",
    "Gardens and designed landscapes, battlefields and world heritage sites are read from HES_Designations/MapServer sub-layers 4, 3 and 6, ids taken from a third-party adapter (IBM/chuk-mcp-her) and not verified; rows from those layers should be checked against the HES portal until a live call confirms them. Use HES_ARCGIS_LAYERS to correct ids.",
    "Attribute names expected: DES_REF (designation reference, e.g. LB12345 / SM1234), DES_TITLE, ENT_TITLE, CATEGORY (A/B/C for listed buildings), LINK. Lookups are case-insensitive with fallbacks; when LINK is absent the portal URL https://portal.historicenvironment.scot/designation/{DES_REF} is used.",
    "Native spatial reference is British National Grid (EPSG:27700); queries send WGS84 with inSR=4326 and distance in metres, which ArcGIS Server reprojects. Distance-per-feature is not returned, so a hit means the feature lies within the radius.",
    "Listed building consent (Planning (Listed Buildings and Conservation Areas) (Scotland) Act 1997) is needed for works affecting character; category A/B/C indicates importance, not what is protected - the whole building and curtilage are. Conservation area consent applies to demolition. Scheduled monument consent is a separate HES process.",
    "Coverage is Scotland only; use historic-england-nhle for England and cadw-listed-buildings for Wales.",
  ],
  healthCheck: simpleHealth((env) => `${layerUrl(env, DEFAULT_LAYERS[0])}?f=json`),
  operations: [
    {
      id: "designations_near",
      label: "HES designations within a distance of a point",
      description: "Queries each HES designation layer for features within the radius and lists one row per hit.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "55.9533" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-3.1883" },
        { name: "distance_m", label: "Distance (m)", type: "integer", default: 100, min: 1, max: 5000, help: "100 m catches the building and its neighbours; 500 m or more for setting, conservation areas and designed landscapes." },
        { name: "layers", label: "Designations", type: "select", default: "all", options: [{ value: "all", label: "All" }, { value: "statutory", label: "Listed buildings and scheduled monuments" }, { value: "area", label: "Areas only (conservation areas, gardens, battlefields, world heritage)" }] },
      ],
      async run(params, ctx) {
        const radius = Number(params.distance_m ?? 100);
        const selected = layersFor(ctx.env).filter((l) => !params.layers || params.layers === "all" || l.kind === params.layers);
        const hits: Hit[] = [];
        const warnings: string[] = [];
        const raw: Record<string, unknown> = {};
        const results = await Promise.all(
          selected.map(async (layer) => {
            try {
              const res = await arcgisPointQuery(ctx, layerUrl(ctx.env, layer), { latitude: params.latitude as number, longitude: params.longitude as number, distanceMeters: radius, returnGeometry: false, resultRecordCount: 100 });
              return { layer, res };
            } catch (e) {
              return { layer, error: e instanceof IntegrationHttpError ? e.message : e instanceof Error ? e.message : String(e) };
            }
          }),
        );
        for (const r of results) {
          if ("error" in r) {
            warnings.push(`${r.layer.designation} layer (${r.layer.path}) could not be queried: ${r.error}`);
            continue;
          }
          raw[r.layer.path] = { count: r.res.features?.length ?? 0, exceededTransferLimit: r.res.exceededTransferLimit ?? false, features: r.res.features };
          if (!r.layer.confirmed && r.res.features?.length) warnings.push(`${r.layer.designation}: layer id ${r.layer.path} is unverified; confirm hits on the HES portal.`);
          for (const f of r.res.features ?? []) hits.push(featureToHit(r.layer, f.attributes));
        }
        const seen = new Set<string>();
        const unique = hits.filter((h) => {
          const k = `${h.type}|${h.reference ?? h.name}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        unique.sort((a, b) => a.type.localeCompare(b.type) || (a.name ?? "").localeCompare(b.name ?? ""));
        const counts = new Map<string, number>();
        for (const h of unique) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
        const breakdown = [...counts.entries()].map(([t, n]) => `${n} ${t.toLowerCase()}${n === 1 ? "" : "s"}`).join(", ");
        const queried = results.filter((r) => !("error" in r)).length;
        const listed = unique.filter((h) => h.type === "Listed building");
        return {
          summary: unique.length
            ? `${unique.length} HES designation(s) within ${radius} m across ${queried} of ${selected.length} layers: ${breakdown}.${listed.length ? ` Listed: ${listed.slice(0, 4).map((h) => `${h.name ?? h.reference}${h.category ? ` (category ${h.category})` : ""}`).join("; ")}.` : ""}`
            : `No HES designations within ${radius} m of ${params.latitude}, ${params.longitude} in the ${queried} of ${selected.length} layer(s) queried.`,
          columns: ["type", "name", "category", "reference", "address", "local_authority", "link", "layer"],
          rows: unique,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "HES INSPIRE MapServer point-distance query", basis: unique.length ? "measured" : "unavailable" }),
          warnings: [
            "Desktop screening only: read the designation record on the HES portal for what is protected and consult the planning authority before designing works to a listed building or in a conservation area.",
            ...warnings,
          ],
        };
      },
    },
  ],
});
