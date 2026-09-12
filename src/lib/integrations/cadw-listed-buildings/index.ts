import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type EnvLike } from "../framework";
import { bboxAround, distanceToGeometryM, wfsCapabilitiesUrl, wfsGetFeature, type GeoJsonFeature } from "../_shared/wfs";
import { attr } from "../_shared/arcgis";

/**
 * Cadw designated historic assets in Wales via the DataMapWales GeoServer WFS.
 *
 * Confirmed from DataMapWales layer pages and open-source consumers
 * (domdfcoding/nhle-map, SPWareing/AzureTimerTrigger, nestauk):
 *   endpoint  https://datamap.gov.wales/geoserver/ows
 *   typeNames inspire-wg:Cadw_ListedBuildings (points), inspire-wg:Cadw_SAM
 *             (scheduled monument polygons), geonode:conservation_areas_wales
 *             (local-authority conservation area polygons).
 * Listed-building attribute names (RecordNumber, Name, Grade, DesignationDate,
 * Community, UnitaryAuthority, Report, BroadClass, Easting, Northing) come from
 * the Cadw CSV export of the same dataset; the WFS is expected to carry the
 * same names but this has not been checked live. Scheduled monument and
 * conservation area attributes are read from a list of candidates.
 */

export const DEFAULT_WFS = "https://datamap.gov.wales/geoserver/ows";

export function wfsBase(env: EnvLike): string {
  return env.CADW_WFS_BASE?.trim() || DEFAULT_WFS;
}

export interface Layer {
  key: "listed" | "sam" | "conservation";
  type: string;
  envVar: string;
  defaultTypeName: string;
  nameFields: string[];
  refFields: string[];
  gradeFields: string[];
  linkFields: string[];
  confirmed: boolean;
}

export const LAYERS: Layer[] = [
  { key: "listed", type: "Listed building", envVar: "CADW_WFS_TYPENAME", defaultTypeName: "inspire-wg:Cadw_ListedBuildings", nameFields: ["Name", "NAME", "name"], refFields: ["RecordNumber", "RECORDNUMBER", "record_number", "RecordNo"], gradeFields: ["Grade", "GRADE", "grade"], linkFields: ["Report", "REPORT", "report", "Link", "URL"], confirmed: true },
  { key: "sam", type: "Scheduled monument", envVar: "CADW_WFS_TYPENAME_SAM", defaultTypeName: "inspire-wg:Cadw_SAM", nameFields: ["Name", "NAME", "name", "SiteName", "SITENAME"], refFields: ["RecordNumber", "RECORDNUMBER", "SAM_Number", "SAMNumber", "SamRef", "SAM_REF", "Reference"], gradeFields: [], linkFields: ["Report", "REPORT", "Link", "URL"], confirmed: true },
  { key: "conservation", type: "Conservation area", envVar: "CADW_WFS_TYPENAME_CONSERVATION", defaultTypeName: "geonode:conservation_areas_wales", nameFields: ["Name", "NAME", "name", "CA_Name", "ca_name", "CONS_AREA", "Title"], refFields: ["Reference", "REF", "ref", "ID", "id", "CA_ID"], gradeFields: [], linkFields: ["Link", "URL", "url"], confirmed: true },
];

export function typeNameFor(env: EnvLike, layer: Layer): string {
  return env[layer.envVar]?.trim() || layer.defaultTypeName;
}

export type Hit = {
  type: string;
  name: string | null;
  grade: string | null;
  reference: string | null;
  distance_m: number | null;
  community: string | null;
  authority: string | null;
  designated: string | null;
  link: string | null;
  layer: string;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}

/** Cadw dates arrive as ISO strings or dd/mm/yyyy in the CSV export; normalise to YYYY-MM-DD where possible. */
export function normaliseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString().slice(0, 10) : null;
  const s = String(v).trim();
  const uk = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (uk) return `${uk[3]}-${uk[2]}-${uk[1]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : s;
}

export function featureToHit(layer: Layer, typeName: string, feature: GeoJsonFeature, latitude: number, longitude: number): Hit {
  const p = feature.properties ?? {};
  const ref = attr(p, ...layer.refFields);
  return {
    type: layer.type,
    name: str(attr(p, ...layer.nameFields)),
    grade: layer.gradeFields.length ? str(attr(p, ...layer.gradeFields)) : null,
    reference: ref === null ? (feature.id !== undefined ? String(feature.id) : null) : String(ref),
    distance_m: distanceToGeometryM(latitude, longitude, feature.geometry),
    community: str(attr(p, "Community", "COMMUNITY", "community")),
    authority: str(attr(p, "UnitaryAuthority", "UNITARYAUTHORITY", "LocalAuthority", "la_name", "LA_NAME", "Authority")),
    designated: normaliseDate(attr(p, "DesignationDate", "DESIGNATIONDATE", "DateDesignated", "DATE_DESIG", "Designated")),
    link: str(attr(p, ...layer.linkFields)),
    layer: typeName,
  };
}

export const definition = defineIntegration({
  id: "cadw-listed-buildings",
  name: "Cadw listed buildings, scheduled monuments and conservation areas (Wales)",
  group: "identity",
  access: "gis",
  territory: "Wales",
  description: "Cadw designated historic assets within a distance of a point in Wales: listed buildings (grades I, II* and II), scheduled monuments and local-authority conservation areas, from the DataMapWales WFS.",
  docsUrl: "https://datamap.gov.wales/layers/inspire-wg:Cadw_ListedBuildings",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Designated Historic Asset GIS Data, The Welsh Historic Environment Service (Cadw); conservation area boundaries from Welsh local planning authorities via DataMapWales (Welsh Government).",
  licence: "OGL",
  envVars: [
    { name: "CADW_WFS_BASE", required: false, description: `Override the DataMapWales WFS endpoint (default ${DEFAULT_WFS}).` },
    { name: "CADW_WFS_TYPENAME", required: false, description: "Override the listed buildings feature type (default inspire-wg:Cadw_ListedBuildings)." },
    { name: "CADW_WFS_TYPENAME_SAM", required: false, description: "Override the scheduled monuments feature type (default inspire-wg:Cadw_SAM)." },
    { name: "CADW_WFS_TYPENAME_CONSERVATION", required: false, description: "Override the conservation areas feature type (default geonode:conservation_areas_wales)." },
  ],
  status: "built_unverified",
  notes: [
    "Type names inspire-wg:Cadw_ListedBuildings, inspire-wg:Cadw_SAM and geonode:conservation_areas_wales are confirmed from DataMapWales layer pages; the WFS GetFeature call itself has not been exercised from this environment.",
    "Listed-building attribute names (RecordNumber, Name, Grade, DesignationDate, Community, UnitaryAuthority, Report, BroadClass) are those of the Cadw CSV export; the WFS is assumed to use the same names and lookups are case-insensitive with fallbacks. Scheduled monument and conservation area attribute names are unconfirmed candidates, so name or reference may be null until checked against a live response.",
    "The search sends a WGS84 bounding box (WFS 2.0 bbox with the EPSG:4326 URN) enclosing the radius and then filters by great-circle distance client-side; polygons score 0 m when the point is inside and the nearest-vertex distance otherwise. CQL_FILTER DWITHIN was avoided because the geometry column name and the CRS of the literal differ per layer.",
    "Registered historic parks and gardens are published as a layer group (geonode:registered_historic_parks_and_gardens), not a WFS feature type, and are not queried here; registered historic landscapes (inspire-wg:Cadw_HistoricLandscapes) are non-statutory and omitted.",
    "Listed building consent is required for works affecting the character of a listed building (external insulation, window replacement, roof PV, plant on elevations); a refusal supports a MEES consent exemption. Scheduled monument consent is separate. A hit within the radius is a screening prompt: read the Cof Cymru record for what the listing covers, including curtilage structures.",
    "Coverage is Wales only; use historic-england-nhle for England and hes-designations for Scotland.",
  ],
  healthCheck: simpleHealth((env) => wfsCapabilitiesUrl(wfsBase(env))),
  operations: [
    {
      id: "designations_near",
      label: "Cadw designations within a distance of a point",
      description: "Listed buildings, scheduled monuments and conservation areas within the radius, one row per designation with distance and grade.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.4816" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-3.1791" },
        { name: "distance_m", label: "Distance (m)", type: "integer", default: 100, min: 1, max: 5000, help: "100 m catches the building and its neighbours; use 500 m or more for setting and conservation area context." },
        { name: "layers", label: "Designations", type: "select", default: "all", options: [{ value: "all", label: "All" }, { value: "listed", label: "Listed buildings only" }, { value: "sam", label: "Scheduled monuments only" }, { value: "conservation", label: "Conservation areas only" }] },
      ],
      async run(params, ctx) {
        const latitude = params.latitude as number;
        const longitude = params.longitude as number;
        const radius = Number(params.distance_m ?? 100);
        const selected = LAYERS.filter((l) => !params.layers || params.layers === "all" || l.key === params.layers);
        const bbox = bboxAround(latitude, longitude, radius);
        const warnings: string[] = [];
        const raw: Record<string, unknown> = {};
        const hits: Hit[] = [];
        const results = await Promise.all(
          selected.map(async (layer) => {
            const typeName = typeNameFor(ctx.env, layer);
            try {
              const { url, collection } = await wfsGetFeature(ctx, wfsBase(ctx.env), { typeName, bbox, count: 100 });
              return { layer, typeName, url, collection };
            } catch (e) {
              return { layer, typeName, error: e instanceof IntegrationHttpError ? e.message : e instanceof Error ? e.message : String(e) };
            }
          }),
        );
        for (const r of results) {
          if ("error" in r) {
            warnings.push(`${r.layer.type} layer (${r.typeName}) could not be queried: ${r.error}`);
            continue;
          }
          const within = r.collection.features.map((f) => featureToHit(r.layer, r.typeName, f, latitude, longitude)).filter((h) => h.distance_m === null || h.distance_m <= radius);
          raw[r.typeName] = { url: r.url, returned: r.collection.features.length, numberMatched: r.collection.numberMatched ?? r.collection.totalFeatures ?? null, features: r.collection.features.slice(0, 50) };
          if (r.collection.features.length >= 100) warnings.push(`${r.layer.type}: 100 features returned (the page limit); narrow the radius to be sure nothing is missed.`);
          hits.push(...within);
        }
        hits.sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) || a.type.localeCompare(b.type));
        const queried = results.filter((r) => !("error" in r)).length;
        const counts = new Map<string, number>();
        for (const h of hits) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
        const breakdown = [...counts.entries()].map(([t, n]) => `${n} ${t.toLowerCase()}${n === 1 ? "" : "s"}`).join(", ");
        const nearest = hits[0];
        return {
          summary: hits.length
            ? `${hits.length} Cadw designation(s) within ${radius} m: ${breakdown}. Nearest: ${nearest.type.toLowerCase()} ${nearest.name ?? nearest.reference ?? ""}${nearest.grade ? ` (grade ${nearest.grade})` : ""} at ${nearest.distance_m ?? "?"} m.`
            : `No Cadw listed buildings, scheduled monuments or conservation areas within ${radius} m of ${latitude}, ${longitude} in the ${queried} of ${selected.length} layer(s) queried.`,
          columns: ["type", "name", "grade", "reference", "distance_m", "community", "authority", "designated", "link", "layer"],
          rows: hits,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "DataMapWales WFS GetFeature (bbox + client-side radius)", basis: hits.length ? "measured" : "unavailable" }),
          warnings: [
            "Desktop screening only: confirm the extent of any listing (including curtilage structures) in the Cof Cymru record and with the local planning authority conservation officer before designing works.",
            ...warnings,
          ],
        };
      },
    },
  ],
});
