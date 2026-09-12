import { defineIntegration, makeProvenance } from "../framework";

/** Valuation Office Agency non-domestic rating lists: bulk downloads only, restricted licence. */

const LINKS = [
  { label: "VOA rating list and summary valuation downloads (rlidata.htm)", url: "https://voaratinglists.blob.core.windows.net/html/rlidata.htm", description: "Compiled list entries and summary valuation (SMV) files for the 2023 and 2017 lists, England and Wales, refreshed periodically." },
  { label: "Find a business rates valuation (individual lookup)", url: "https://www.tax.service.gov.uk/business-rates-find/search", description: "Public search for one property's rateable value, description and summary valuation." },
  { label: "VOA data specifications and licence terms", url: "https://www.gov.uk/government/organisations/valuation-office-agency", description: "Publication schedule, file layouts and the licence that governs reuse of list data." },
];

export const definition = defineIntegration({
  id: "voa-rating-list",
  name: "VOA non-domestic rating lists (bulk download)",
  group: "identity",
  access: "download",
  territory: "England and Wales",
  description: "Valuation Office Agency rating list entries (rateable value, property description, address, billing authority) and summary valuations with floor areas by floor and use, published as bulk files.",
  docsUrl: "https://voaratinglists.blob.core.windows.net/html/rlidata.htm",
  termsUrl: "https://www.gov.uk/government/organisations/valuation-office-agency",
  attribution: "Contains Valuation Office Agency data © Crown copyright. Reused under the VOA's published terms, not the Open Government Licence.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "Two file families per list (2023 and 2017): compiled list entries (one row per hereditament: UARN, BA reference, description, address, rateable value, effective date, scat code) and summary valuations (SMV: per-floor lines with floor level, description, area in m², price per m² and value, plus adjustments and car parking). SMV floor areas are the VOA's measured basis (NIA/GIA per RICS code of measuring practice) and are the best public floor-area evidence for offices, shops and industrial units.",
    "Licence: the VOA data is not OGL. Use is permitted for the licensee's own purposes; redistribution, republishing or building a competing product with the raw data is restricted; check the current licence text on the download page before importing. The portal should store derived values (floor area, description, rateable value) against a client asset, cite the source, and not re-serve the bulk files.",
    "The compiled lists are hundreds of megabytes of pipe-delimited text; the portal would import them into a table keyed by UARN and BA reference and match to assets by address or UPRN (files do not carry UPRN).",
    "Not covered: Scotland (Scottish Assessors, https://www.saa.gov.uk) and Northern Ireland (LPS valuation list). Rateable values are the VOA's opinion of annual rental value at the antecedent valuation date, not market rent.",
    "Recorded as a reference-only source: no API; the single operation returns the download links.",
  ],
  operations: [
    {
      id: "links",
      label: "Download links and what they contain",
      description: "Where to obtain the rating list and summary valuation files, and how the portal would use them.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "VOA rating list and summary valuation files are bulk downloads under a restricted licence; summary valuations carry floor areas by floor.",
          columns: ["label", "url", "description"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS.map(({ label, url }) => ({ label, url })),
          provenance: makeProvenance(definition, ctx, { dataset: "download-links", basis: "not_applicable" }),
          warnings: ["Check the licence on the download page before importing; VOA data is not OGL."],
        };
      },
    },
  ],
});
