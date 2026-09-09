import { defineIntegration, makeProvenance } from "../framework";

/**
 * ENCORE (Exploring Natural Capital Opportunities, Risks and Exposure) by
 * the ENCORE Partnership (Global Canopy, UNEP FI, UNEP-WCMC). The knowledge
 * base (sector dependencies and pressures on nature with materiality
 * ratings, by ISIC class) is downloadable from the site by registered users;
 * reference-only until the download format is confirmed.
 */

export const LINKS = [
  { label: "ENCORE tool", url: "https://encorenature.org/" },
  { label: "Methodology and downloads", url: "https://encorenature.org/en/data-and-methodology/methodology" },
  { label: "Materiality ratings explained", url: "https://encorenature.org/en/data-and-methodology/materiality" },
  { label: "Data and methodology limitations", url: "https://encorenature.org/en/data-and-methodology/limitations" },
  { label: "Using ENCORE for the TNFD LEAP approach (Global Canopy)", url: "https://globalcanopy.org/wp-content/uploads/2026/01/GC-Using-ENCORE-for-TNFD-LEAP-Approach.pdf" },
];

export const definition = defineIntegration({
  id: "encore",
  name: "ENCORE sector dependencies and impacts",
  group: "nature",
  access: "download",
  territory: "Global",
  description: "Knowledge base of how economic activities (ISIC classes) depend on ecosystem services and exert pressures on nature, with five-point materiality ratings. Used for the TNFD LEAP 'Evaluate' step and sector-level nature risk screening of suppliers and tenants.",
  docsUrl: "https://encorenature.org/en/data-and-methodology/methodology",
  termsUrl: "https://encorenature.org/en/about/about-encore",
  attribution: "ENCORE Partnership (Global Canopy, UNEP FI and UNEP-WCMC), ENCORE knowledge base (July 2024 update). Reproduction subject to the ENCORE terms of use.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "The July 2024 knowledge base follows ISIC Rev. 4 sectors and SEEA-EA ecosystem service categories, with Very High to Very Low materiality ratings for dependencies and pressures reviewed by industry experts.",
    "Downloads are provided as spreadsheets to registered users on the ENCORE site; there is no public API and the download file layout has not been confirmed offline, so no parser is built. A future connector could load a user-placed CSV under data/reference/encore/ keyed by ISIC class.",
    "ENCORE is sector-level and generic: it says what a typical activity depends on, not what a specific site or supplier depends on. Site-level assessment needs location data (Natural England, NBN Atlas, IBAT) and company engagement.",
    "Map UK SIC 2007 codes to ISIC Rev. 4 (they share the first four digits at class level in most cases) before looking up a supplier's sector.",
  ],
  operations: [
    {
      id: "links",
      label: "Open the ENCORE tool and downloads",
      description: "Links to ENCORE, its methodology and download page; no data is fetched.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "ENCORE is a registered-user spreadsheet download with no API; open the methodology page for the current knowledge base download.",
          columns: ["resource", "url"],
          rows: LINKS.map((l) => ({ resource: l.label, url: l.url })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "encore-knowledge-base", basis: "not_applicable" }),
        };
      },
    },
  ],
});
