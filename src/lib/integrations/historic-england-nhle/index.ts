import { arcgisDate, arcgisPointQuery, arcgisQuery, arcgisWhereQueryUrl, attr } from "../_shared/arcgis";
import { defineIntegration, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";

/**
 * Historic England National Heritage List for England (NHLE) via the public
 * ArcGIS FeatureServer on services-eu1.arcgis.com. Layer ids and field names
 * were taken from the service's use in open-source projects and Historic
 * England's open data hub listings; the service itself is not reachable from
 * this build environment, so treat them as unverified until a live call.
 */

export const DEFAULT_SERVICE = "https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer";

export function serviceUrl(env: EnvLike): string {
  return (env.NHLE_FEATURESERVER_URL?.trim() || DEFAULT_SERVICE).replace(/\/$/, "");
}

/** Layer ids on the NHLE v02 view service. */
export const LAYERS: { id: number; designation: string; hasGrade: boolean; geometry: "point" | "polygon" }[] = [
  { id: 0, designation: "Listed building", hasGrade: true, geometry: "point" },
  { id: 3, designation: "Listed building", hasGrade: true, geometry: "polygon" },
  { id: 6, designation: "Scheduled monument", hasGrade: false, geometry: "polygon" },
  { id: 7, designation: "Registered park or garden", hasGrade: true, geometry: "polygon" },
  { id: 8, designation: "Registered battlefield", hasGrade: false, geometry: "polygon" },
  { id: 10, designation: "World heritage site", hasGrade: false, geometry: "polygon" },
];

export function listEntryUrl(listEntry: string | number): string {
  return `https://historicengland.org.uk/listing/the-list/list-entry/${listEntry}`;
}

const COLUMNS = ["designation", "name", "grade", "list_entry", "list_date", "amend_date", "location", "ngr", "link", "layer"];

export function toRow(a: Record<string, unknown>, layer: { id: number; designation: string; geometry: string }) {
  const listEntry = attr(a, "ListEntry", "ListEntryNumber", "list_entry");
  return {
    designation: layer.designation,
    name: attr(a, "Name"),
    grade: attr(a, "Grade"),
    list_entry: listEntry == null ? null : String(listEntry),
    list_date: arcgisDate(attr(a, "ListDate")),
    amend_date: arcgisDate(attr(a, "AmendDate")),
    location: attr(a, "Location"),
    ngr: attr(a, "NGR"),
    link: listEntry == null ? attr(a, "hyperlink", "Hyperlink") : listEntryUrl(String(listEntry)),
    layer: `${layer.id} (${layer.geometry})`,
  };
}

function dedupe(rows: ReturnType<typeof toRow>[]) {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.designation}|${r.list_entry ?? r.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const definition = defineIntegration({
  id: "historic-england-nhle",
  name: "National Heritage List for England (Historic England)",
  group: "identity",
  access: "open",
  territory: "England",
  description:
    "Listed buildings (grades I, II* and II), scheduled monuments, registered parks and gardens, battlefields and world heritage sites from the statutory National Heritage List, queried around a point or by list entry number.",
  docsUrl: "https://opendata-historicengland.hub.arcgis.com/datasets/historicengland::national-heritage-list-for-england-nhle/about",
  termsUrl: "https://historicengland.org.uk/terms/website-terms-conditions/",
  attribution: "© Historic England 2026. Contains Ordnance Survey data © Crown copyright and database right 2026. The Historic England GIS Data contained in this material was obtained on the retrieval date; the most publicly available up to date Historic England GIS Data can be obtained from historicengland.org.uk. Licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [{ name: "NHLE_FEATURESERVER_URL", required: false, description: `Override for the NHLE FeatureServer root. Default ${DEFAULT_SERVICE}.` }],
  status: "built_unverified",
  notes: [
    "Layer ids used: 0 listed building points, 3 listed building polygons, 6 scheduled monuments, 7 parks and gardens, 8 battlefields, 10 world heritage sites (layers 1, 2, 4, 5 are building preservation notices and certificates of immunity; 9 is protected wrecks). These ids come from the service's use in open-source projects and the Historic England open data hub, not from a live call.",
    "Field names expected: ListEntry, Name, Grade, ListDate, AmendDate, Location, NGR, hyperlink. Case varies between layers; lookups are case-insensitive.",
    "Native spatial reference is British National Grid (EPSG:27700); queries send WGS84 with inSR=4326 and ask the service to reproject. Distances are geodesic metres via units=esriSRUnit_Meter.",
    "Listing status changes what is permissible: listed building consent is needed for works affecting character (windows, external insulation, roof PV, plant on elevations) and refusal supports a MEES 'consent' exemption; scheduled monument consent is separate. Conservation areas are not on the NHLE - use planning-data for those.",
    "A hit within the radius is a screening prompt. List entry polygons are indicative and points can be on the road; read the list entry text for what the designation actually covers (curtilage structures are often listed by association).",
    "The service is updated daily by Historic England and has ArcGIS Online limits (about 1,000-2,000 records per query, no documented rate limit). Full downloads are at https://historicengland.org.uk/listing/the-list/data-downloads/.",
  ],
  healthCheck: simpleHealth((env) => `${serviceUrl(env)}?f=json`),
  operations: [
    {
      id: "designations-near-point",
      label: "Heritage designations within a distance of a point",
      description: "Listed buildings, scheduled monuments, parks and gardens, battlefields and world heritage sites within N metres of a coordinate.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.5033" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.1196" },
        { name: "distance", label: "Distance (m)", type: "integer", default: 100, min: 0, max: 2000, help: "0 returns only designations whose polygon contains the point." },
        { name: "include_polygons", label: "Include listed building polygons", type: "boolean", default: true, help: "Polygons catch buildings whose point sits further away; results are de-duplicated by list entry." },
      ],
      async run(params, ctx: OperationContext) {
        const base = serviceUrl(ctx.env);
        const lat = params.latitude as number;
        const lon = params.longitude as number;
        const distance = params.distance as number;
        const layers = LAYERS.filter((l) => l.id !== 3 || params.include_polygons);
        const rows: ReturnType<typeof toRow>[] = [];
        const raw: Record<string, unknown> = {};
        let truncated = false;
        for (const layer of layers) {
          const res = await arcgisPointQuery(ctx, `${base}/${layer.id}`, { latitude: lat, longitude: lon, distanceMeters: distance, resultRecordCount: 200 });
          raw[`layer_${layer.id}`] = res;
          if (res.exceededTransferLimit) truncated = true;
          for (const f of res.features ?? []) rows.push(toRow(f.attributes, layer));
        }
        const out = dedupe(rows);
        const counts = new Map<string, number>();
        for (const r of out) counts.set(r.designation, (counts.get(r.designation) ?? 0) + 1);
        const warnings = [
          "Screening only: confirm the extent of each designation from the list entry before deciding what works need consent.",
          "A postcode centroid can be tens of metres from the building; use a footprint or UPRN coordinate for a tight radius.",
        ];
        if (truncated) warnings.push("One or more layers hit the record limit; reduce the distance.");
        return {
          summary: out.length
            ? `${out.length} heritage designation${out.length === 1 ? "" : "s"} within ${distance} m: ${[...counts.entries()].map(([d, n]) => `${n} ${d.toLowerCase()}${n === 1 ? "" : "s"}`).join(", ")}.`
            : `No NHLE designations within ${distance} m of ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
          columns: COLUMNS,
          rows: out,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "nhle", basis: out.length ? "measured" : "unavailable" }),
          warnings,
        };
      },
    },
    {
      id: "list-entry",
      label: "Look up a list entry number",
      description: "Finds the designation record for a National Heritage List entry number across all designation layers.",
      params: [{ name: "list_entry", label: "List entry number", type: "integer", required: true, min: 1, placeholder: "1000005" }],
      async run(params, ctx) {
        const base = serviceUrl(ctx.env);
        const n = Math.trunc(params.list_entry as number);
        const rows: ReturnType<typeof toRow>[] = [];
        const raw: Record<string, unknown> = {};
        for (const layer of LAYERS.filter((l) => l.geometry === "polygon" || l.id === 0)) {
          const res = await arcgisQuery(ctx, arcgisWhereQueryUrl(`${base}/${layer.id}`, `ListEntry = ${n}`, { resultRecordCount: 5 }));
          raw[`layer_${layer.id}`] = res;
          for (const f of res.features ?? []) rows.push(toRow(f.attributes, layer));
          if (rows.length) break;
        }
        const out = dedupe(rows);
        return {
          summary: out.length ? `List entry ${n}: ${out[0].name ?? "unnamed"} (${out[0].designation}${out[0].grade ? `, grade ${out[0].grade}` : ""}).` : `List entry ${n} not found on the NHLE service.`,
          columns: COLUMNS,
          rows: out,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "nhle", basis: out.length ? "measured" : "unavailable" }),
          links: [{ label: `List entry ${n} on the NHLE`, url: listEntryUrl(n) }],
        };
      },
    },
  ],
});
