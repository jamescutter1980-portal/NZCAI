import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "EXIOBASE 3 on Zenodo (latest release)", url: "https://zenodo.org/communities/exiobase/" },
  { label: "EXIOBASE project site", url: "https://www.exiobase.eu/" },
  { label: "pymrio (Python MRIO toolkit that parses EXIOBASE)", url: "https://github.com/IndEcol/pymrio" },
];

export const definition = defineIntegration({
  id: "exiobase",
  name: "EXIOBASE 3 (spend-based factors)",
  group: "carbon",
  access: "download",
  territory: "Global (49 regions incl. GB)",
  description: "Open multi-regional environmentally extended input-output database giving kgCO2e per unit of spend for around 200 products across 44 countries and 5 rest-of-world regions. The basis for Climatiq's procurement (spend) endpoint and for in-house Scope 3 category 1 screening.",
  docsUrl: "https://www.exiobase.eu/",
  termsUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "EXIOBASE 3 (Stadler et al.), licensed under CC BY-SA 4.0. Version and release as stated.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "Licence: CC BY-SA 4.0. Derived factor tables must carry attribution and be shared under the same licence; check this fits client deliverables before publishing derived tables.",
    "Obtain: download the product-by-product (pxp) or industry-by-industry (ixi) release from Zenodo (several GB per year). Compute product-level emission intensities (kgCO2e per EUR of output at basic prices) from the satellite accounts (GHG extensions) and the Leontief inverse, e.g. with pymrio. Cache the resulting 200-product x 49-region table as a versioned reference file.",
    "Currency and price basis: factors are per EUR (or MEUR) of producer output in the release's base year at basic prices. Spend in GBP must be converted at the base-year exchange rate, deflated from the spend year to the base year, and stripped of tax, trade and transport margins to move from purchaser to basic prices. Climatiq's procurement endpoint applies these adjustments; an in-house loader must do the same or state that it has not.",
    "Coverage: GB is a distinct region. Product resolution (200 products) is coarse; spend-based factors are for screening and hotspots, not supplier-specific reporting. Replace with supplier or product data as it becomes available.",
    "What the portal would do with the data: map supplier spend (from Xero/QuickBooks purchase transactions) to EXIOBASE products via a classification (NACE/UNSPSC) and apply the GB factor for the spend year, with the release version, base year, exchange rate and deflator recorded in provenance.",
  ],
  operations: [
    {
      id: "links",
      label: "Where to obtain EXIOBASE",
      description: "Download location, licence and tooling.",
      params: [],
      async run(_params, ctx) {
        return { summary: "EXIOBASE 3 is a free Zenodo download under CC BY-SA 4.0; product-level spend factors must be derived from the release and versioned locally.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
