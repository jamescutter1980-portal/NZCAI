import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "Built Environment Carbon Database (BECD)", url: "https://www.becd.co.uk/" },
  { label: "RICS Whole Life Carbon Assessment (2nd edition)", url: "https://www.rics.org/profession-standards/rics-standards-and-guidance/sector-standards/construction-standards/whole-life-carbon-assessment" },
];

export const definition = defineIntegration({
  id: "becd",
  name: "Built Environment Carbon Database (BECD)",
  group: "embodied",
  access: "download",
  territory: "UK",
  description: "UK industry database of product-level (EPD-derived) and building/asset-level embodied carbon data, run by BCIS with RICS and industry partners. Around 28,000 product datasets plus contributed building assessments, for benchmarking and material selection.",
  docsUrl: "https://www.becd.co.uk/",
  attribution: "Source: Built Environment Carbon Database (BECD). Used under the BECD terms of use; dataset version and access date as stated.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: free registration for product data; building-level data is contributed by assessors and available to registered users. There is no public API; data is browsed online and exported (CSV/XLSX) for registered accounts. Check the current terms for bulk export and redistribution before loading a copy.",
    "Product data is drawn from EPDs (EN 15804) with declared units and module breakdowns; asset data is RICS WLCA-structured (A1-A5, B, C, D by building element). Preserve declared unit, standard version (+A1/+A2) and validity in provenance and never mix A1-A3 with A1-A5 totals.",
    "What the portal would do with the data: import a registered user's export as a versioned reference file for UK product benchmarks and building-level comparators, complementing ECO Portal and ÖKOBAUDAT EPDs; contribute completed assessments back where the client consents.",
    "ICE database: the free ICE v4.1 licence is educational-only after 30 September 2026; do not build commercial embodied-carbon calculations on it (roadmap §2).",
  ],
  operations: [
    {
      id: "links",
      label: "Where to obtain BECD data",
      description: "Registration and standards references.",
      params: [],
      async run(_params, ctx) {
        return { summary: "BECD is a registered-download database with no API; product and building carbon data would be imported as a versioned reference file.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
