import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { digest, parseOverrides, SCAN_COLUMNS, scanServices, type ServiceSpec } from "../ea-long-term-flood-risk/arcgis-scan";

/**
 * Environment Agency environmental constraint layers on the Defra Data
 * Services Platform ArcGIS server: historic landfill, source protection
 * zones, drinking water safeguard zones, aquifer designations, groundwater
 * flooding susceptibility, coastal erosion risk, historic flood map and
 * recorded flood outlines, flood warning areas and defence lines.
 *
 * Confirmed service paths (seen in public references): HistoricLandfill,
 * SourceProtectionZonesMerged, HistoricFloodMap, FloodWarningAreas,
 * DrinkingWaterSafeguardsGroundwater, SpatialFloodDefencesIncStandardisedAttributes.
 * Aquifer, groundwater flooding, NCERM and recorded flood outline names are
 * best guesses, flagged per row, overridable via EA_ARCGIS_SERVICES.
 */

export const DEFAULT_BASE = "https://environment.data.gov.uk/arcgis/rest/services/EA";

export const SERVICES: ServiceSpec[] = [
  { id: "historic_landfill", service: "HistoricLandfill/MapServer", label: "Historic landfill site", scenario: "historic", confirmed: true, layers: [{ id: 0, name: "Historic Landfill Sites" }], bandFields: ["site_name", "sitename", "name", "waste_type", "specified_waste"], distanceMeters: 250 },
  { id: "spz", service: "SourceProtectionZonesMerged/MapServer", label: "Groundwater source protection zone", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Source Protection Zones (merged)" }], bandFields: ["spz", "zone", "spz_zone", "name", "type"] },
  { id: "safeguard_gw", service: "DrinkingWaterSafeguardsGroundwater/FeatureServer", label: "Drinking water safeguard zone (groundwater)", scenario: "present day", confirmed: true, maxLayers: 4, bandFields: ["name", "sgz_name", "zone", "type"] },
  { id: "aquifer_bedrock", service: "AquiferDesignationMapBedrock/MapServer", label: "Aquifer designation (bedrock)", scenario: "reference", confirmed: false, maxLayers: 4, bandFields: ["aquifer", "designation", "aquifer_designation", "type", "class"] },
  { id: "aquifer_superficial", service: "AquiferDesignationMapSuperficial/MapServer", label: "Aquifer designation (superficial)", scenario: "reference", confirmed: false, maxLayers: 4, bandFields: ["aquifer", "designation", "aquifer_designation", "type", "class"] },
  { id: "gw_flooding", service: "AreasSusceptibleToGroundwaterFlooding/MapServer", label: "Area susceptible to groundwater flooding (1 km grid)", scenario: "present day", confirmed: false, maxLayers: 4, bandFields: ["class", "susceptibility", "likelihood", "category", "gwf_class"] },
  { id: "ncerm", service: "NationalCoastalErosionRiskMapping/MapServer", label: "National coastal erosion risk mapping (NCERM)", scenario: "future (climate change)", confirmed: false, maxLayers: 6, distanceMeters: 100, bandFields: ["erosion_risk", "risk", "scenario", "epoch", "cliff_or_beach", "policy"] },
  { id: "historic_flood", service: "HistoricFloodMap/MapServer", label: "Historic flood map (recorded flooding)", scenario: "historic", confirmed: true, layers: [{ id: 0, name: "Historic Flood Map" }], bandFields: ["name", "flood_src", "source", "type"] },
  { id: "recorded_outlines", service: "RecordedFloodOutlines/MapServer", label: "Recorded flood outlines (individual events)", scenario: "historic", confirmed: false, maxLayers: 4, bandFields: ["name", "flood_src", "start_date", "flood_cause", "source"] },
  { id: "flood_warning_areas", service: "FloodWarningAreas/MapServer", label: "Flood warning area", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Flood Warning Areas" }], bandFields: ["ta_name", "name", "fws_tacode", "descrip", "river_sea"] },
  { id: "defences", service: "SpatialFloodDefencesIncStandardisedAttributes/MapServer", label: "Flood defence within 100 m", scenario: "present day", confirmed: true, layers: [{ id: 0, name: "Spatial flood defences" }], distanceMeters: 100, bandFields: ["asset_type", "type", "defence_type", "sop", "standard_of_protection", "condition"] },
];

export const definition = defineIntegration({
  id: "ea-environmental-constraints",
  name: "EA environmental constraints at a point (landfill, SPZ, aquifer, groundwater, coastal erosion, historic flooding)",
  group: "ground",
  access: "gis",
  territory: "England",
  description: "Point screening against Environment Agency ArcGIS layers: historic landfill, groundwater source protection and safeguard zones, aquifer designation, groundwater flooding susceptibility, national coastal erosion risk mapping, historic flood map and recorded flood outlines, flood warning areas and flood defences.",
  docsUrl: "https://environment.data.gov.uk/arcgis/rest/services/EA",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Aquifer designation data © Environment Agency and British Geological Survey. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [
    { name: "EA_ARCGIS_BASE", required: false, description: "Override the ArcGIS services base (default https://environment.data.gov.uk/arcgis/rest/services/EA)." },
    { name: "EA_ARCGIS_SERVICES", required: false, description: "Optional JSON object mapping service ids (historic_landfill, spz, safeguard_gw, aquifer_bedrock, aquifer_superficial, gw_flooding, ncerm, historic_flood, recorded_outlines, flood_warning_areas, defences) to service paths or URLs." },
  ],
  status: "built_unverified",
  notes: [
    "Desktop screening only: a clear result is not proof that land is uncontaminated, and a historic landfill nearby is not proof that it is. A Phase 1 desk study and, where indicated, intrusive investigation are needed for contamination.",
    "Historic landfill is checked within 250 m and flood defences within 100 m; other layers are checked at the exact point (or the distance given).",
    "Confirmed service paths: HistoricLandfill, SourceProtectionZonesMerged, HistoricFloodMap, FloodWarningAreas, DrinkingWaterSafeguardsGroundwater, SpatialFloodDefencesIncStandardisedAttributes. Aquifer designation, groundwater flooding susceptibility, NCERM and recorded flood outline service names are best guesses (rows carry confirmed_service=false); set EA_ARCGIS_SERVICES to correct them.",
    "Groundwater flooding susceptibility is a 1 km summary grid and NCERM is a projection by epoch and scenario: keep epochs separate and do not read either as site-level risk.",
    "Field names differ between services; each hit row includes the first feature's attributes for inspection.",
  ],
  healthCheck: simpleHealth((env) => `${(env.EA_ARCGIS_BASE || DEFAULT_BASE).replace(/\/$/, "")}/HistoricLandfill/MapServer?f=json`),
  operations: [
    {
      id: "constraints-at-point",
      label: "Environmental constraints at a point",
      description: "One row per constraint layer with whether the point (or the search distance around it) intersects a feature, the headline class and the feature's attributes.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "distance", label: "Extra search distance (m)", type: "integer", default: 0, min: 0, max: 1000, help: "Applied to every layer when set; otherwise each layer uses its own default (0 m, 100 m for defences, 250 m for landfill)." },
        { name: "includeUnconfirmed", label: "Query unconfirmed services", type: "boolean", default: true },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.EA_ARCGIS_BASE || DEFAULT_BASE;
        const services = SERVICES.filter((s) => s.confirmed || params.includeUnconfirmed);
        const distance = (params.distance as number) > 0 ? (params.distance as number) : undefined;
        const { rows, raw, errors } = await scanServices(ctx, base, services, { latitude: params.latitude as number, longitude: params.longitude as number, distanceMeters: distance, overrides: parseOverrides(ctx.env.EA_ARCGIS_SERVICES) });
        const usable = rows.filter((r) => r.status === "hit" || r.status === "no feature");
        if (!usable.length) {
          const first = rows.find((r) => r.status === "error");
          throw new IntegrationHttpError(`Every EA constraint service failed: ${first?.message ?? "unknown"}`, 502, base, rows.map((r) => `${r.layer_group}: ${r.message}`).join("\n"));
        }
        const hits = usable.filter((r) => r.hit);
        return {
          summary: `${hits.length} of ${usable.length} constraint layers intersect the point${distance ? ` (within ${distance} m)` : ""}. ${digest(rows)}.${errors ? ` ${errors} layer(s) could not be queried.` : ""}`,
          columns: SCAN_COLUMNS,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "EA ArcGIS constraint layers", basis: "modelled" }),
          warnings: [
            "Desktop screening from mapped datasets; it is not proof that land is uncontaminated and does not replace a Phase 1 environmental desk study.",
            "Historic and future (NCERM) rows describe past events and projected scenarios respectively; do not read them as present-day exposure.",
            ...(rows.some((r) => !r.confirmed_service) ? ["Rows with confirmed_service=false come from guessed service names; verify against the EA services folder before relying on them."] : []),
          ],
          links: [
            { label: "EA ArcGIS services folder", url: base },
            { label: "DEFRA Data Services Platform datasets", url: "https://environment.data.gov.uk/" },
          ],
        };
      },
    },
  ],
});
