import { defineIntegration, makeProvenance } from "../framework";

/**
 * UK Climate Projections 2018 (UKCP18), Met Office Hadley Centre.
 * Reference-only: data is obtained through the UKCP User Interface (registration) or
 * CEDA downloads, not a per-call API the portal can wrap.
 */

const LINKS = [
  { label: "UKCP18 project page (Met Office)", url: "https://www.metoffice.gov.uk/research/approach/collaboration/ukcp" },
  { label: "UKCP User Interface (register to build and download products)", url: "https://ukclimateprojections-ui.metoffice.gov.uk/" },
  { label: "UKCP18 data on the CEDA Archive", url: "https://catalogue.ceda.ac.uk/uuid/c700e47ca45d4c43b213fe879863d589" },
  { label: "UKCP18 Guidance and science reports", url: "https://www.metoffice.gov.uk/research/approach/collaboration/ukcp/guidance-science-reports" },
  { label: "UKCP Local (2.2 km) projections summary", url: "https://www.metoffice.gov.uk/research/approach/collaboration/ukcp/summaries/local-projections" },
];

export const definition = defineIntegration({
  id: "ukcp18",
  name: "UKCP18 climate projections",
  group: "weather",
  access: "enquiry",
  territory: "UK",
  description: "Met Office UK Climate Projections 2018: probabilistic, global (60 km), regional (12 km) and local (2.2 km) projections of temperature, rainfall and other variables to 2100 under RCP2.6, RCP4.5, RCP6.0 and RCP8.5. Used for future overheating and heating-demand scenarios.",
  docsUrl: "https://www.metoffice.gov.uk/research/approach/collaboration/ukcp",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. UK Climate Projections (UKCP18) © Met Office and Crown copyright.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: the UKCP User Interface needs a free registered account to build products (maps, plumes, time series) and download CSV/NetCDF; bulk NetCDF is on the CEDA Archive (also registered). There is no per-request API the portal can call on demand; the Met Office Weather DataHub does not serve UKCP18.",
    "What the portal would do with it: derive future-period degree days, summer mean/maximum temperatures and overheating indicators (e.g. CIBSE TM49/TM59 style test years) for a site's 12 km or 2.2 km grid cell under a chosen emissions scenario and time slice (2020s, 2050s, 2080s), for NZC pathway and climate-resilience sections.",
    "The probabilistic (25 km) product gives percentile ranges; the regional/local products are 12-member ensembles. Report which product, scenario, time slice and percentile/member was used, and never present a single number without the range.",
    "CIBSE weather files (DSY/TRY, including future weather files built from UKCP09/UKCP18) are the usual route for building simulation; they are licensed from CIBSE, not free.",
    "Redistribution: OGL permits reuse with attribution; check the CEDA licence for any dataset that carries additional terms.",
  ],
  operations: [
    {
      id: "links",
      label: "How to obtain UKCP18 data",
      description: "Registration, download and guidance links; no live data.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "UKCP18 is a registered download service, not an API. Use the UKCP User Interface for products or CEDA for NetCDF, then import the extract into the portal.",
          columns: ["label", "url"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "reference", basis: "not_applicable" }),
        };
      },
    },
  ],
});
