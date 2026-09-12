import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "ecoinvent database", url: "https://ecoinvent.org/database/" },
  { label: "ecoinvent licensing", url: "https://ecoinvent.org/licenses/" },
  { label: "ecoinvent API documentation (ecoQuery)", url: "https://ecoquery.ecoinvent.org/" },
];

export const definition = defineIntegration({
  id: "ecoinvent",
  name: "ecoinvent (licensed LCI database)",
  group: "embodied",
  access: "commercial",
  territory: "Global",
  description: "Commercial life-cycle inventory database (20,000+ datasets) used as background data for embodied-carbon and whole-life carbon assessment where no EPD exists. Access is by annual licence, via ecoQuery (web/API) or data files for LCA software.",
  docsUrl: "https://ecoinvent.org/database/",
  termsUrl: "https://ecoinvent.org/licenses/",
  attribution: "ecoinvent database, version and system model as stated. © ecoinvent Association. Used under licence.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: annual licence per user/organisation (commercial, academic and developer tiers). Data is delivered through ecoQuery (web and REST API with per-user credentials) and as ecoSpold2 files for LCA tools (openLCA, SimaPro, Brightway, One Click LCA).",
    "Redistribution: licence terms prohibit publishing dataset-level values; only aggregated results of a client's own assessment may appear in reports. Do not store ecoinvent factors in a shared reference table visible to other clients.",
    "System models matter: 'cut-off', 'APOS' and 'consequential' give different results for the same activity; record the version (e.g. 3.11) and system model in provenance for every value.",
    "Prefer product-specific EPDs (ECO Portal, ÖKOBAUDAT, EC3) for foreground materials and use ecoinvent for background processes and where no EPD exists, as RICS WLCA and the UK NZCBS expect.",
    "What the portal would do with the data: pull selected activity GWP (EF 3.1 or IPCC 2021 GWP100) for background materials, transport and energy, keyed by activity UUID, version and system model, for use in embodied-carbon estimates that carry basis 'modelled'.",
  ],
  operations: [
    {
      id: "links",
      label: "Where to obtain ecoinvent",
      description: "Licensing, database and API entry points.",
      params: [],
      async run(_params, ctx) {
        return { summary: "ecoinvent is a licensed LCI database; access via ecoQuery API or data files after purchase. No values are stored in the portal without a licence.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
