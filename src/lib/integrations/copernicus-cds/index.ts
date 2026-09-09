import { defineIntegration, makeProvenance } from "../framework";

/**
 * Copernicus Climate Data Store (CDS), ECMWF. Reference-only: the CDS API is an
 * asynchronous, dataset-specific retrieval service (submit a request, poll, download
 * GRIB/NetCDF) driven by the cdsapi client, with per-dataset licences a user must
 * accept. Not a synchronous point query the portal can wrap generically.
 */

const LINKS = [
  { label: "Climate Data Store", url: "https://cds.climate.copernicus.eu/" },
  { label: "CDS API how-to (cdsapi client, ~/.cdsapirc with url and key)", url: "https://cds.climate.copernicus.eu/how-to-api" },
  { label: "ERA5 hourly data on single levels (reanalysis-era5-single-levels)", url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels" },
  { label: "ERA5-Land hourly data (reanalysis-era5-land)", url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land" },
  { label: "Climate indicators for Europe from 1940 to 2100 derived from reanalysis and climate projections", url: "https://cds.climate.copernicus.eu/datasets/sis-ecde-climate-indicators" },
  { label: "Copernicus licence", url: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=download#manage-licences" },
];

export const definition = defineIntegration({
  id: "copernicus-cds",
  name: "Copernicus Climate Data Store (ECMWF)",
  group: "weather",
  access: "open_key",
  territory: "Global",
  description: "ECMWF's Climate Data Store: ERA5 and ERA5-Land reanalysis (1940 to present), seasonal forecasts, CMIP6/CORDEX projections and derived climate indicators, retrieved asynchronously with the cdsapi client under a personal access token.",
  docsUrl: "https://cds.climate.copernicus.eu/how-to-api",
  termsUrl: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=download#manage-licences",
  attribution: "Contains modified Copernicus Climate Change Service information; neither the European Commission nor ECMWF is responsible for any use that may be made of the information it contains.",
  licence: "restricted",
  envVars: [{ name: "CDS_API_KEY", required: false, description: "Personal access token from the CDS profile page (used by cdsapi as `key`, with url https://cds.climate.copernicus.eu/api). Not used by the portal yet; reserved for a batch retrieval job." }],
  status: "reference_only",
  notes: [
    "Access: free ECMWF/CDS account; each dataset has its own licence that must be accepted in the web UI before the API will serve it (ERA5 uses the Licence to Use Copernicus Products; some derived datasets add terms).",
    "The API is asynchronous and queued: requests can take minutes to hours and return GRIB or NetCDF, so it belongs in a scheduled batch job (Python cdsapi), not a synchronous portal call. Use Open-Meteo's archive (also ERA5-based) for on-demand point history.",
    "What the portal would do with it: build long-run hourly climate baselines and typical years for sites, compute heating/cooling degree days directly from ERA5-Land 2 m temperature, and pull CORDEX/CMIP6 projections where UKCP18 is not required.",
    "Attribution wording for Copernicus products is mandatory and is set as this connector's attribution string.",
    "Redistribution of derived products is allowed under the Copernicus licence with attribution; the raw datasets must not be re-served as if they were the portal's own.",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain Copernicus CDS data",
      description: "Account, API and dataset links; no live data.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "The Climate Data Store is an asynchronous retrieval API (cdsapi) with per-dataset licences. Retrieve ERA5 or projections in a batch job and import the extract into the portal.",
          columns: ["label", "url"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "reference", basis: "not_applicable" }),
        };
      },
    },
  ],
});
