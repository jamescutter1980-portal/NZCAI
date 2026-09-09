import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "ukradon",
  name: "UKradon (UKHSA/BGS radon affected areas)",
  group: "ground",
  access: "download",
  territory: "UK",
  description: "Radon affected areas: the joint UKHSA/BGS Indicative Atlas of Radon (1 km grid, open) and the definitive radon potential dataset (licensed), used to decide whether radon protective measures are needed in new buildings and whether workplaces should be tested.",
  docsUrl: "https://www.ukradon.org/information/ukmaps",
  termsUrl: "https://www.bgs.ac.uk/datasets/radon-data-indicative-atlas-of-radon/",
  attribution: "Radon Indicative Atlas © UKHSA and BGS (UKRI), licensed under the Open Government Licence v3.0; radon potential dataset © UKHSA/BGS, licensed.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "The Indicative Atlas is an open 1 km grid classed by the highest radon potential in the square (percentage of homes estimated above the 200 Bq/m3 Action Level: <1%, 1-3%, 3-5%, 5-10%, 10-30%, >30%). It is available as a GIS download from BGS and OS Data Hub and as a hosted ArcGIS layer (maps-bgs.opendata.arcgis.com); the portal would import it and run a point query (basis 'modelled').",
    "The definitive 25 m radon potential dataset is licensed from BGS/UKHSA and is what UKradon address reports and Groundsure/Landmark reports use; a UKradon address search (paid) gives the definitive answer for a property.",
    "Being in a radon affected area does not mean a building has high radon; only measurement (3-month detectors) does. Employers must assess radon in workplaces in affected areas (Ionising Radiations Regulations 2017); Building Regulations Approved Document C / BR 211 set protective measures for new build.",
    "Northern Ireland radon mapping is also on UKradon; Scotland's is on the same atlas.",
  ],
  operations: [
    {
      id: "links",
      label: "Radon map and dataset links",
      description: "Where to view the indicative atlas, order an address report and download the open data.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Check the UKradon map for the indicative class and order an address report for a definitive answer; test the building to know its actual level.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "ukradon", basis: "not_applicable" }),
          links: [
            { label: "UK radon map (UKradon)", url: "https://www.ukradon.org/information/ukmaps" },
            { label: "Radon Indicative Atlas download (BGS)", url: "https://www.bgs.ac.uk/datasets/radon-data-indicative-atlas-of-radon/" },
            { label: "Radon Indicative Atlas on OS Data Hub", url: "https://osdatahub.os.uk/downloads/open/Radon_Indicative_Atlas" },
            { label: "Radon Indicative Atlas (BGS ArcGIS Hub)", url: "https://maps-bgs.opendata.arcgis.com/datasets/radon-indicative-atlas/explore" },
            { label: "Radon potential dataset (licensed)", url: "https://www.bgs.ac.uk/datasets/radon-data-radon-potential-dataset/" },
          ],
        };
      },
    },
  ],
});
