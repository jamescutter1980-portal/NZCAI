import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "wri-aqueduct",
  name: "WRI Aqueduct water risk atlas",
  group: "flood_water",
  access: "download",
  territory: "Global",
  description: "World Resources Institute Aqueduct 4.0: global sub-basin indicators of baseline water stress, depletion, interannual and seasonal variability, groundwater decline, riverine and coastal flood risk and drought risk, with future projections for 2030, 2050 and 2080 under climate scenarios.",
  docsUrl: "https://www.wri.org/aqueduct",
  termsUrl: "https://github.com/wri/Aqueduct40",
  attribution: "Aqueduct 4.0 © World Resources Institute, licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).",
  licence: "CC_BY",
  envVars: [],
  status: "reference_only",
  notes: [
    "Open data (CC BY 4.0, attribution required; recorded here as 'restricted' because it is not OGL). Available as a geodatabase/CSV download from WRI, in Google Earth Engine (WRI/Aqueduct_Water_Risk/V4) and as an ArcGIS Living Atlas layer; the portal would import the baseline annual layer and join sites by sub-basin (PFAF id) to report baseline water stress and the flood/drought indicators with basis 'modelled'.",
    "Aqueduct is a global screening tool at HydroBASINS level 6 (sub-basins of thousands of km2). For England, the Environment Agency's Water Stressed Areas classification (used for water company metering decisions) is the preferable national reference; Aqueduct is for portfolios with sites outside the UK and for GRESB/CDP-style water risk screening.",
    "Report the indicator name, scenario (baseline or business-as-usual/optimistic/pessimistic) and year; do not merge baseline and projected values.",
  ],
  operations: [
    {
      id: "links",
      label: "Aqueduct data and viewer links",
      description: "Where to view the Aqueduct atlas and download the data.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Aqueduct 4.0 is an open global water risk atlas; for England prefer the EA water stressed areas classification.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "aqueduct-4.0", basis: "not_applicable" }),
          links: [
            { label: "Aqueduct Water Risk Atlas", url: "https://www.wri.org/applications/aqueduct/water-risk-atlas/" },
            { label: "Aqueduct 4.0 data download and dictionary", url: "https://github.com/wri/Aqueduct40" },
            { label: "Aqueduct 4.0 in Google Earth Engine", url: "https://developers.google.com/earth-engine/datasets/catalog/WRI_Aqueduct_Water_Risk_V4_baseline_annual" },
            { label: "EA water stressed areas classification", url: "https://www.gov.uk/government/publications/water-stressed-areas-2021-classification" },
          ],
        };
      },
    },
  ],
});
