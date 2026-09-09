import { defineIntegration, makeProvenance } from "../framework";

/**
 * Vehicle Certification Agency (VCA) car fuel consumption and CO2 data.
 * Reference-only: the data is published as downloadable CSV/XLSX per
 * year and Euro standard, with column names that change between releases,
 * so the portal links to the downloads rather than parsing them.
 */

export const LINKS = [
  { label: "VCA fuel consumption and CO2 databases (overview)", url: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/" },
  { label: "Car fuel data downloads (CSV per year / Euro standard)", url: "https://carfueldata.vehicle-certification-agency.gov.uk/downloads/default.aspx" },
  { label: "Car fuel data search tool", url: "https://carfueldata.vehicle-certification-agency.gov.uk/" },
  { label: "GOV.UK: car fuel and CO2 emissions data", url: "https://www.gov.uk/co2-and-vehicle-tax-tools" },
];

export const definition = defineIntegration({
  id: "vca-fuel-data",
  name: "VCA car fuel data",
  group: "transport",
  access: "download",
  territory: "UK",
  description: "Official type-approval fuel consumption, CO2 and pollutant figures for new cars sold in the UK, published by the Vehicle Certification Agency as downloadable CSV files. Use for model-level CO2 g/km when the DVLA record has none.",
  docsUrl: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/",
  termsUrl: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/car-fuel-data-co2-and-vehicle-tax-tools-disclaimer/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Vehicle Certification Agency, car fuel data.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "The downloads page publishes one CSV per model year and Euro standard (e.g. Euro_6_latest.csv); column names have changed between NEDC and WLTP releases, so files must be mapped by hand before import.",
    "Figures are laboratory type-approval values (WLTP since 2017-2020, NEDC earlier) supplied by manufacturers; real-world consumption is typically higher.",
    "For a registered vehicle prefer the DVLA VES co2Emissions field; use VCA data to fill gaps by make, model and variant, or for new-vehicle procurement comparisons.",
    "The portal does not parse these files yet; a future connector could load a user-placed CSV under data/reference/vca-fuel-data/.",
  ],
  operations: [
    {
      id: "links",
      label: "Open VCA car fuel data downloads",
      description: "Links to the VCA databases and download page; no data is fetched.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "VCA car fuel data is a manual CSV download per year and Euro standard; open the downloads page to fetch the file for the vehicles of interest.",
          columns: ["resource", "url"],
          rows: LINKS.map((l) => ({ resource: l.label, url: l.url })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "car-fuel-data", basis: "not_applicable" }),
        };
      },
    },
  ],
});
