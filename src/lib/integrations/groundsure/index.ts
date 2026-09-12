import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "groundsure",
  name: "Groundsure environmental and climate reports",
  group: "ground",
  access: "commercial",
  territory: "GB",
  description: "Groundsure commercial environmental due diligence: contaminated land, flood, ground stability, energy and infrastructure and ClimateIndex reports for residential and commercial property, ordered per site.",
  docsUrl: "https://www.groundsure.com/",
  attribution: "© Groundsure Ltd. Report content is licensed to the ordering client and may not be redistributed.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access is by report order (per site) through Groundsure or a search provider; API integration is offered to conveyancing platforms and data partners under contract, and no public self-serve developer API was confirmed. Structured data (risk ratings, distances, data sources) is delivered within the report; whether it is available as machine-readable fields depends on the product and agreement.",
    "Products relevant to ESG and acquisition screening: Groundsure Enviro/Geo (contaminated land, geology, ground stability), Flood, Energy and Infrastructure, ClimateIndex (5- and 30-year physical risk ratings for flood, subsidence and coastal erosion), Avista (all-in-one residential).",
    "What the portal would do with the data: store the report PDF and any structured risk ratings against the asset, with provenance basis 'modelled' (risk ratings) and licence 'commercial'; use it to evidence the ground-conditions and contamination questions in the ESG acquisition assessment.",
    "Much of the underlying data is the open EA, BGS and Coal Authority data already wired up in this portal (ea-environmental-constraints, ea-long-term-flood-risk, bgs-geology, coal-authority); Groundsure adds interpretation, professional opinion and licensed layers (GeoSure, radon potential, historical mapping).",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain a Groundsure report",
      description: "Links to Groundsure products and ordering.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Groundsure reports are ordered per site under commercial terms; upload the report to the asset record when received.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "groundsure", basis: "not_applicable" }),
          links: [
            { label: "Groundsure", url: "https://www.groundsure.com/" },
            { label: "Groundsure commercial reports", url: "https://www.groundsure.com/commercial/" },
            { label: "ClimateIndex", url: "https://www.groundsure.com/climateindex/" },
          ],
        };
      },
    },
  ],
});
