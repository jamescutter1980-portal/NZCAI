import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { digest, parseOverrides, SCAN_COLUMNS, scanServices, type ServiceSpec } from "./arcgis-scan";

/**
 * Environment Agency long-term flood risk layers on the Defra Data Services
 * Platform ArcGIS server (https://environment.data.gov.uk/arcgis/rest/services/EA/):
 * Flood Map for Planning (Flood Zones 2 and 3, Areas Benefiting from
 * Defences), NaFRA2 Risk of Flooding from Rivers and Sea and from Surface
 * Water (present day and climate change), reservoir maximum extents.
 *
 * Service paths marked confirmed were seen in public references (the EA
 * services folder is indexed by search engines and used by defra-design
 * prototypes). Climate-change services are best guesses and are flagged as
 * such on every row. Not exercised live from this codebase.
 */

export const DEFAULT_BASE = "https://environment.data.gov.uk/arcgis/rest/services/EA";

export const SERVICES: ServiceSpec[] = [
  { id: "fz3", service: "FloodMapForPlanningRiversAndSeaFloodZone3/MapServer", label: "Flood Zone 3 (rivers and sea, 1% / 0.5% AEP, undefended)", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Flood Zone 3" }], bandFields: ["type", "layer", "flood_zone"] },
  { id: "fz2", service: "FloodMapForPlanningRiversAndSeaFloodZone2/MapServer", label: "Flood Zone 2 (rivers and sea, 0.1% AEP, undefended)", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Flood Zone 2" }], bandFields: ["type", "layer", "flood_zone"] },
  { id: "abd", service: "FloodMapForPlanningRiversandSeaAreasBenefitingfromFloodDefences/MapServer", label: "Areas benefiting from flood defences", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Areas Benefiting from Flood Defences" }] },
  { id: "rofrs", service: "RiskOfFloodingFromRiversAndSea/MapServer", label: "Risk of flooding from rivers and sea (NaFRA, defended)", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Risk of Flooding from Rivers and Sea" }], bandFields: ["prob_4band", "risk_band", "risk"] },
  { id: "rofrs_cc", service: "RiskOfFloodingFromRiversAndSeaClimateChange/MapServer", label: "Risk of flooding from rivers and sea, climate change scenario (NaFRA2)", scenario: "future (climate change)", confirmed: false, maxLayers: 6, bandFields: ["prob_4band", "risk_band", "risk"] },
  { id: "rofsw", service: "RiskOfFloodingFromSurfaceWater/MapServer", label: "Risk of flooding from surface water", scenario: "present day", confirmed: true, maxLayers: 8, bandFields: ["prob_4band", "risk_band", "risk", "likelihood"] },
  { id: "rofsw_cc", service: "RiskOfFloodingFromSurfaceWaterClimateChange/MapServer", label: "Risk of flooding from surface water, climate change scenario (NaFRA2)", scenario: "future (climate change)", confirmed: false, maxLayers: 8, bandFields: ["prob_4band", "risk_band", "risk", "likelihood"] },
  { id: "reservoir", service: "RiskOfFloodingFromReservoirsMaximumFloodExtent/MapServer", label: "Risk of flooding from reservoirs (maximum extent)", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Reservoir maximum flood extent" }] },
];

export const definition = defineIntegration({
  id: "ea-long-term-flood-risk",
  name: "EA long-term flood risk (Flood Zones, NaFRA2 rivers, sea and surface water)",
  group: "flood_water",
  access: "gis",
  territory: "England",
  description: "Point screening against the Environment Agency's mapped flood risk: Flood Map for Planning Flood Zones 2 and 3 and areas benefiting from defences, NaFRA2 Risk of Flooding from Rivers and Sea and from Surface Water for the present day and climate change scenarios, and reservoir maximum extents, served as ArcGIS REST layers.",
  docsUrl: "https://environment.data.gov.uk/dataset/04532375-a198-476e-985e-0579a0a11b47",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [
    { name: "EA_FLOOD_ARCGIS_BASE", required: false, description: "Override the ArcGIS services base (default https://environment.data.gov.uk/arcgis/rest/services/EA). The newer host path /server/rest/services/EA also exists." },
    { name: "EA_FLOOD_ARCGIS_SERVICES", required: false, description: "Optional JSON object mapping service ids (fz3, fz2, abd, rofrs, rofrs_cc, rofsw, rofsw_cc, reservoir) to service paths or full URLs, to correct a guessed name without a code change." },
  ],
  status: "built_unverified",
  notes: [
    "A desktop point check is not a flood risk assessment. Flood Zones ignore defences and climate change; NaFRA2 accounts for defences and gives a likelihood band (High, Medium, Low, Very Low). Present-day and climate-change results are reported as separate rows and must not be merged.",
    "Service paths for Flood Zones 2 and 3, Areas Benefiting from Defences, Risk of Flooding from Rivers and Sea, Risk of Flooding from Surface Water and reservoir extents were confirmed from public references; the two climate-change service names are best guesses (rows carry confirmed_service=false) and can be corrected with EA_FLOOD_ARCGIS_SERVICES. The DEFRA Data Services Platform WMS feeds (e.g. /spatialdata/nafra2-risk-of-flooding-from-rivers-and-sea-climate-change/wms) exist if the ArcGIS names differ.",
    "Surface water services carry several layers (extent by annual chance, depth bands); every leaf layer is queried and reported, so read the layer name with the band.",
    "Field names (prob_4band etc.) vary between NaFRA versions; the first feature's attributes are included in each row for inspection.",
    "The EA updated these products on 28 January 2025 (NaFRA2) and 25 March 2025 (Flood Map for Planning). Results reflect whatever the service currently publishes.",
  ],
  healthCheck: simpleHealth((env) => `${(env.EA_FLOOD_ARCGIS_BASE || DEFAULT_BASE).replace(/\/$/, "")}/FloodMapForPlanningRiversAndSeaFloodZone3/MapServer?f=json`),
  operations: [
    {
      id: "risk-at-point",
      label: "Long-term flood risk at a point",
      description: "One row per flood risk layer at the point: Flood Zones 2/3, areas benefiting from defences, NaFRA2 rivers and sea and surface water (present day and climate change), reservoir extents.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "distance", label: "Search distance (m)", type: "integer", default: 0, min: 0, max: 500, help: "0 checks the exact point; a small distance (e.g. 25 m) catches a building footprint edge." },
        { name: "includeUnconfirmed", label: "Query unconfirmed climate-change services", type: "boolean", default: true },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.EA_FLOOD_ARCGIS_BASE || DEFAULT_BASE;
        const services = SERVICES.filter((s) => s.confirmed || params.includeUnconfirmed);
        const { rows, raw, errors } = await scanServices(ctx, base, services, { latitude: params.latitude as number, longitude: params.longitude as number, distanceMeters: params.distance as number, overrides: parseOverrides(ctx.env.EA_FLOOD_ARCGIS_SERVICES) });
        const usable = rows.filter((r) => r.status === "hit" || r.status === "no feature");
        if (!usable.length) {
          const first = rows.find((r) => r.status === "error");
          throw new IntegrationHttpError(`Every EA flood service failed: ${first?.message ?? "unknown"}`, 502, base, rows.map((r) => `${r.layer_group}: ${r.message}`).join("\n"));
        }
        const hits = usable.filter((r) => r.hit);
        const fz3 = rows.find((r) => r.layer_group.startsWith("Flood Zone 3"));
        const fz2 = rows.find((r) => r.layer_group.startsWith("Flood Zone 2"));
        const zone = fz3?.hit ? "Flood Zone 3" : fz2?.hit ? "Flood Zone 2" : fz3?.status === "no feature" && fz2?.status === "no feature" ? "Flood Zone 1 (outside Zones 2 and 3)" : "Flood Zone undetermined";
        return {
          summary: `${zone}. ${digest(rows)}.${errors ? ` ${errors} layer(s) could not be queried.` : ""}`,
          columns: SCAN_COLUMNS,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "EA ArcGIS flood risk layers", basis: hits.length ? "modelled" : "modelled" }),
          warnings: [
            "Mapped flood risk is modelled; a point check is desktop screening, not a site-specific flood risk assessment (FRA) and does not consider surface water drainage, groundwater or sewer flooding beyond the layers listed.",
            "Present-day and climate-change rows are separate scenarios; do not combine them into one rating.",
            ...(rows.some((r) => !r.confirmed_service) ? ["Rows with confirmed_service=false come from guessed service names; verify against the EA services folder before relying on them."] : []),
          ],
          links: [
            { label: "Flood map for planning (GOV.UK)", url: "https://flood-map-for-planning.service.gov.uk/" },
            { label: "Check your long term flood risk (GOV.UK)", url: "https://check-long-term-flood-risk.service.gov.uk/" },
            { label: "EA ArcGIS services folder", url: base },
            { label: "DEFRA Data Services Platform", url: "https://environment.data.gov.uk/" },
          ],
        };
      },
    },
  ],
});
