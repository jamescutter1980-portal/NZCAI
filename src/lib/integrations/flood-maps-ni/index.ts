import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

/**
 * Northern Ireland flood hazard mapping is published by DfI Rivers through the
 * Flood Maps (NI) viewer and Spatial NI (OpenData NI) as WMS and file
 * geodatabase downloads; no point-query API is documented, so this is a
 * reference entry with links and guidance.
 */

export const LINKS = [
  { label: "Flood Maps (NI) viewer (DfI Rivers)", url: "https://www.infrastructure-ni.gov.uk/articles/what-flood-maps-ni" },
  { label: "Check the risk of flooding in your area (nidirect)", url: "https://www.nidirect.gov.uk/articles/check-the-risk-of-flooding-in-your-area" },
  { label: "DfI Rivers flood hazard and risk maps (2nd cycle)", url: "https://www.infrastructure-ni.gov.uk/articles/2nd-cycle-flood-hazard-and-flood-risk-maps" },
  { label: "OpenData NI (Spatial NI datasets, WMS and downloads)", url: "https://www.opendatani.gov.uk/" },
  { label: "DfI Rivers flood maps product sheets", url: "https://mappingportal.infrastructure-ni.gov.uk/PDFs/ProductSheets/" },
];

export const definition = defineIntegration({
  id: "flood-maps-ni",
  name: "Flood Maps (NI) - DfI Rivers",
  group: "flood_water",
  access: "gis",
  territory: "Northern Ireland",
  description: "Strategic flood maps for Northern Ireland (rivers, sea, surface water, historic flooding and flood defences) published by DfI Rivers through the Flood Maps (NI) viewer and Spatial NI as WMS and geodatabase downloads.",
  docsUrl: "https://www.infrastructure-ni.gov.uk/articles/what-flood-maps-ni",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains DfI Rivers (Department for Infrastructure, Northern Ireland) flood mapping data © Crown copyright and database right, licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "No documented point-query API. Layers are available as OGC WMS and ESRI file geodatabase downloads via Spatial NI / OpenData NI; the portal would need to import the geodatabase or configure the WMS endpoint (GetFeatureInfo) once the current service URL is confirmed.",
    "The Strategic Flood Map (NI) shows river, sea and surface water flood extents for present-day and climate change scenarios plus historical flood events; it is strategic and not site specific.",
    "Live flood warnings for Northern Ireland are not published as a warning-area feed comparable to the EA/NRW services; the Met Office and DfI publish alerts.",
  ],
  operations: [
    {
      id: "links",
      label: "Where to check flood risk in Northern Ireland",
      description: "Links to the DfI Rivers flood map viewer and open data downloads.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Northern Ireland flood mapping is viewed on Flood Maps (NI) or imported from Spatial NI; no point query is available from this portal yet.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "flood-maps-ni", basis: "not_applicable" }),
          links: LINKS,
        };
      },
    },
  ],
});
