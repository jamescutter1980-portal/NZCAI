import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { digest, SCAN_COLUMNS, scanServices, type ServiceSpec } from "../ea-long-term-flood-risk/arcgis-scan";

/**
 * SEPA Flood Maps (Scotland) served as an open ArcGIS MapServer:
 * https://map.sepa.org.uk/server/rest/services/Open/Flood_Maps/MapServer
 * Layer ids 0-9 and 11 were confirmed from the Open Data Scotland catalogue
 * (which links each dataset to its layer id) and an open-source client; layer
 * 10 is inferred to be the coastal climate-change layer by elimination.
 * Not exercised live from this codebase.
 */

export const DEFAULT_BASE = "https://map.sepa.org.uk/server/rest/services/Open";

export const LAYERS = {
  present: [
    { id: 0, name: "River flooding, high likelihood (10-year return period)" },
    { id: 1, name: "River flooding, medium likelihood (200-year)" },
    { id: 2, name: "River flooding, low likelihood (1000-year)" },
    { id: 3, name: "Surface water and small watercourses, high likelihood (10-year)" },
    { id: 4, name: "Surface water and small watercourses, medium likelihood (200-year)" },
    { id: 5, name: "Surface water and small watercourses, low likelihood (1000-year)" },
    { id: 6, name: "Coastal flooding, high likelihood (10-year)" },
    { id: 7, name: "Coastal flooding, medium likelihood (200-year)" },
    { id: 8, name: "Coastal flooding, low likelihood (1000-year)" },
  ],
  future: [
    { id: 9, name: "Future: river flooding, medium likelihood with climate change" },
    { id: 10, name: "Future: coastal flooding, medium likelihood with climate change (layer id inferred)" },
    { id: 11, name: "Future: surface water, medium likelihood with climate change" },
  ],
};

export const SERVICES: ServiceSpec[] = [
  { id: "present", service: "Flood_Maps/MapServer", label: "SEPA flood map", scenario: "present day", confirmed: true, layers: LAYERS.present, bandFields: ["likelihood", "probability", "return_period", "depth", "type", "name"] },
  { id: "future", service: "Flood_Maps/MapServer", label: "SEPA future flood map", scenario: "future (climate change)", confirmed: true, layers: LAYERS.future, bandFields: ["likelihood", "probability", "return_period", "depth", "scenario", "type", "name"] },
];

export const definition = defineIntegration({
  id: "sepa-flood-maps",
  name: "SEPA flood maps (Scotland)",
  group: "flood_water",
  access: "gis",
  territory: "Scotland",
  description: "Point screening against SEPA's flood hazard maps for river, coastal and surface water flooding at high, medium and low likelihood, plus the medium-likelihood climate change scenarios, served as an open ArcGIS map service.",
  docsUrl: "https://map.sepa.org.uk/floodmaps",
  termsUrl: "https://www.sepa.org.uk/flood-map-help-pages/help/",
  attribution: "Contains SEPA data © Scottish Environment Protection Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [{ name: "SEPA_FLOOD_ARCGIS_BASE", required: false, description: "Override the SEPA open ArcGIS services base (default https://map.sepa.org.uk/server/rest/services/Open)." }],
  status: "built_unverified",
  notes: [
    "Likelihood bands: high = 10-year return period (10% annual chance), medium = 200-year (0.5%), low = 1000-year (0.1%). Scottish planning policy uses the medium likelihood (200-year) extent as the functional floodplain.",
    "Layer ids 0-9 and 11 were confirmed from Open Data Scotland catalogue entries that link to this service; layer 10 (coastal climate change) is inferred and labelled as such.",
    "SEPA's maps are strategic (long-term) and not site specific; they are not a flood risk assessment and do not show live flooding. Live warnings are on SEPA Floodline, which has no public API here.",
    "Present-day and climate-change layers are reported separately; do not merge them.",
  ],
  healthCheck: simpleHealth((env) => `${(env.SEPA_FLOOD_ARCGIS_BASE || DEFAULT_BASE).replace(/\/$/, "")}/Flood_Maps/MapServer?f=json`),
  operations: [
    {
      id: "risk-at-point",
      label: "SEPA flood map layers at a point",
      description: "One row per SEPA flood map layer (river, coastal, surface water by likelihood, and climate change) stating whether the point falls within the mapped extent.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "55.953" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-3.188" },
        { name: "distance", label: "Search distance (m)", type: "integer", default: 0, min: 0, max: 500 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.SEPA_FLOOD_ARCGIS_BASE || DEFAULT_BASE;
        const { rows, raw, errors } = await scanServices(ctx, base, SERVICES, { latitude: params.latitude as number, longitude: params.longitude as number, distanceMeters: params.distance as number });
        const usable = rows.filter((r) => r.status === "hit" || r.status === "no feature");
        if (!usable.length) {
          const first = rows.find((r) => r.status === "error");
          throw new IntegrationHttpError(`SEPA flood map service failed: ${first?.message ?? "unknown"}`, 502, base, rows.map((r) => `${r.layer}: ${r.message}`).join("\n"));
        }
        const hits = usable.filter((r) => r.hit);
        const medium = hits.find((r) => /medium likelihood/i.test(r.layer) && r.scenario === "present day");
        return {
          summary: `${hits.length} of ${usable.length} SEPA flood map layers include the point${medium ? ` (within the medium-likelihood extent: ${medium.layer})` : ""}. ${digest(rows)}.${errors ? ` ${errors} layer(s) could not be queried.` : ""}`,
          columns: SCAN_COLUMNS,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "SEPA Open/Flood_Maps", basis: "modelled" }),
          warnings: [
            "Strategic flood hazard mapping, not a site-specific flood risk assessment.",
            "Present-day and climate-change rows are separate scenarios.",
          ],
          links: [
            { label: "SEPA flood maps", url: "https://map.sepa.org.uk/floodmaps" },
            { label: "SEPA Floodline (live warnings)", url: "https://floodline.sepa.org.uk/" },
          ],
        };
      },
    },
  ],
});
