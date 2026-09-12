import { defineIntegration, makeProvenance } from "../framework";

/**
 * HadUK-Grid gridded climate observations (Met Office National Climate Information
 * Centre), distributed through the CEDA Archive. Reference-only: bulk NetCDF download
 * with a registered CEDA account, not a per-call API.
 */

const LINKS = [
  { label: "HadUK-Grid overview (Met Office)", url: "https://www.metoffice.gov.uk/research/climate/maps-and-data/data/haduk-grid/haduk-grid" },
  { label: "HadUK-Grid on the CEDA Archive (latest version)", url: "https://catalogue.ceda.ac.uk/uuid/4dc8450d889a491ebb20e724debe2dfb" },
  { label: "CEDA account registration", url: "https://services.ceda.ac.uk/cedasite/register/info/" },
  { label: "CEDA OPeNDAP / HTTP data access guide", url: "https://help.ceda.ac.uk/article/4442-ceda-opendap-scripted-interactions" },
  { label: "Met Office UK climate averages (1991-2020) by station", url: "https://www.metoffice.gov.uk/research/climate/maps-and-data/uk-climate-averages" },
];

export const definition = defineIntegration({
  id: "haduk-grid-ceda",
  name: "HadUK-Grid (CEDA)",
  group: "weather",
  access: "download",
  territory: "UK",
  description: "Met Office HadUK-Grid: daily, monthly, seasonal and annual gridded observations (1 km to 60 km) of temperature, rainfall, sunshine and derived variables from 1836/1960 to the latest complete year, built from station records. The observational baseline for climate normals and long-run degree days.",
  docsUrl: "https://www.metoffice.gov.uk/research/climate/maps-and-data/data/haduk-grid/haduk-grid",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. HadUK-Grid © Met Office and Crown copyright, via the CEDA Archive.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: register for a free CEDA account, then download NetCDF files by HTTP, FTP or OPeNDAP (scripted access needs a CEDA access token). Updated annually, usually mid-year for the previous calendar year; monthly updates lag by a few months.",
    "What the portal would do with it: extract the 1 km or 5 km grid cell for each site to give 1991-2020 climate normals, long-run monthly mean temperature and heating/cooling degree days for weather normalisation baselines, and to sanity-check reanalysis-derived history from Open-Meteo.",
    "HadUK-Grid is interpolated from station observations (basis 'measured' for the underlying data, but grid values are derived); coastal and upland cells are less reliable where stations are sparse.",
    "Variables: tas, tasmax, tasmin, rainfall, sun, sfcWind, hurs, psl, groundfrost, snowLying and more; daily temperature and rainfall at 1 km from 1960.",
    "Redistribution under OGL with attribution; cite the dataset version (e.g. v1.3.0.ceda) in provenance.",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain HadUK-Grid data",
      description: "Registration and download links; no live data.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "HadUK-Grid is a bulk NetCDF download from CEDA (free registration). Extract the site's grid cell and import the series into the portal.",
          columns: ["label", "url"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "reference", basis: "not_applicable" }),
        };
      },
    },
  ],
});
