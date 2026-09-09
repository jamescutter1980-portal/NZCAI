import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

/**
 * Defra strategic noise mapping (Environmental Noise (England) Regulations
 * 2006): road, rail and airport noise contours for Lden, Lnight, LAeq16h and
 * LA10 18h. Round 4 (2022) is published as downloadable GIS datasets on the
 * Defra Data Services Platform and data.gov.uk; an older ArcGIS map service
 * (DEFRA/ENDNoiseMappingRound2) exists but the Round 4 service could not be
 * confirmed, so this is a reference entry.
 */

export const LINKS = [
  { label: "Road noise - all metrics - England Round 4 (2022)", url: "https://environment.data.gov.uk/dataset/562c9d56-7c2d-4d42-83bb-578d6e97a517" },
  { label: "Rail noise - all metrics - England Round 4 (2022)", url: "https://environment.data.gov.uk/dataset/3fb3c2d7-292c-4e0a-bd5b-d8e4e1fe2947" },
  { label: "Airport noise - all metrics - England Round 4 (2022)", url: "https://environment.data.gov.uk/dataset/dac9cba4-abe7-43bd-b8e9-8a83da52edd8" },
  { label: "Explaining the 2022 noise maps (GOV.UK)", url: "https://www.gov.uk/government/publications/strategic-noise-mapping-2022/explaining-the-2022-noise-maps" },
  { label: "Extrium England Noise Map viewer", url: "https://extrium.co.uk/noiseviewer.html" },
  { label: "Legacy ArcGIS service (Round 2)", url: "https://environment.data.gov.uk/arcgis/rest/services/DEFRA/ENDNoiseMappingRound2/MapServer" },
];

export const definition = defineIntegration({
  id: "defra-noise-mapping",
  name: "Defra strategic noise mapping (England)",
  group: "ground",
  access: "gis",
  territory: "England",
  description: "Defra strategic noise maps for major roads, railways and airports (Round 4, 2022): Lden and Lnight contour bands in 5 dB classes, published as GIS downloads. Context for BREEAM Pol 05 / Hea 05 and WELL Sound concept screening, not a site noise survey.",
  docsUrl: "https://www.gov.uk/government/publications/strategic-noise-mapping-2022",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Defra strategic noise mapping data © Crown copyright and database right, licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "Bulk GIS downloads (shapefile/GeoPackage) per source and metric; the portal would import the Round 4 layers and run a point-in-polygon query to report the Lden and Lnight band. The Round 4 ArcGIS/WMS service name could not be confirmed (only a Round 2 MapServer was seen).",
    "Coverage is limited to major roads (>3 million vehicles/year), major railways (>30,000 trains/year), agglomerations above 100,000 people and major airports; silence elsewhere means unmapped, not quiet.",
    "Bands are modelled long-term averages at 4 m height and cannot substitute for a BS 7445 / BS 8233 noise survey required for BREEAM Hea 05 or WELL S02 and for planning (ProPG).",
    "Lden applies +5 dB evening and +10 dB night penalties; Lnight is 23:00-07:00. Report both and the round/year.",
  ],
  operations: [
    {
      id: "links",
      label: "Strategic noise mapping downloads",
      description: "Links to the Round 4 noise map datasets and viewer.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Strategic noise maps are bulk GIS downloads; use the Extrium viewer for a quick look and import the Round 4 layers for a point query.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "END noise mapping round 4", basis: "not_applicable" }),
          links: LINKS,
        };
      },
    },
  ],
});
