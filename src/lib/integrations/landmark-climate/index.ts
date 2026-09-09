import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "landmark-climate",
  name: "Landmark Information Group climate change and environmental reports",
  group: "ground",
  access: "commercial",
  territory: "GB",
  description: "Landmark Information Group commercial reports and data: Envirocheck (Phase 1 desk study data), Landmark Climate Change Report (flood, subsidence, coastal erosion and heat exposure to 2080), RiskView and Sitecheck for transactions.",
  docsUrl: "https://www.landmark.co.uk/",
  attribution: "© Landmark Information Group Ltd. Report content is licensed to the ordering client and may not be redistributed.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access is by report order or a data licence; Landmark supplies data feeds and APIs to conveyancing platforms and enterprise customers under contract. No public self-serve API was confirmed. Envirocheck reports are delivered as PDF with a data schedule; structured (machine-readable) delivery should be requested explicitly in the agreement.",
    "Landmark Climate Change Report gives property-level ratings for flood, subsidence, coastal erosion and (in some editions) heat and wildfire under climate scenarios to 2080; it is a modelled screening product, not a site assessment.",
    "What the portal would do with the data: attach the report and any structured ratings to the asset with basis 'modelled' and licence 'commercial'; map ratings to the physical climate risk section of the ESG acquisition assessment and TCFD/ISSB physical risk disclosures.",
    "Envirocheck compiles the same public datasets this portal queries directly (EA constraints, BGS geology, Coal Authority) plus licensed historical mapping and Landmark's own land use database; use it for Phase 1 desk studies where a consultant needs the full data schedule.",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain Landmark reports",
      description: "Links to Landmark products.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Landmark reports are ordered per site or licensed as data feeds under commercial terms.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "landmark", basis: "not_applicable" }),
          links: [
            { label: "Landmark Information Group", url: "https://www.landmark.co.uk/" },
            { label: "Envirocheck", url: "https://www.envirocheck.co.uk/" },
            { label: "Landmark Climate Change Report", url: "https://www.landmark.co.uk/climate-change/" },
          ],
        };
      },
    },
  ],
});
