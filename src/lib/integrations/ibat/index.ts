import { defineIntegration, makeProvenance } from "../framework";

/**
 * IBAT (Integrated Biodiversity Assessment Tool) by the IBAT Alliance
 * (BirdLife International, Conservation International, IUCN, UNEP-WCMC).
 * Commercial subscription; reference-only.
 */

export const LINKS = [
  { label: "IBAT services overview", url: "https://www.ibat-alliance.org/services" },
  { label: "IBAT pricing and subscriptions", url: "https://www.ibat-alliance.org/subscriptions" },
  { label: "IBAT tutorials and FAQs (API access)", url: "https://www.ibat-alliance.org/tutorials_and_faqs" },
  { label: "TNFD LEAP locate tools (IBAT listed)", url: "https://tnfd.global/assessment-guidance/locate-assessment-tools/" },
];

export const definition = defineIntegration({
  id: "ibat",
  name: "IBAT (Integrated Biodiversity Assessment Tool)",
  group: "nature",
  access: "commercial",
  territory: "Global",
  description: "Proximity reports and data extracts against the World Database on Protected Areas, Key Biodiversity Areas and the IUCN Red List, used for TNFD LEAP 'Locate' screening and lender biodiversity due diligence. Subscription or pay-as-you-go, with an API on paid plans.",
  docsUrl: "https://www.ibat-alliance.org/",
  termsUrl: "https://www.ibat-alliance.org/terms",
  attribution: "IBAT Alliance (BirdLife International, Conservation International, IUCN, UNEP-WCMC). Reports and data are licensed to the subscriber and cannot be redistributed without permission.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access is by subscription (Enterprise / Enterprise Plus, multi-year available) or pay-as-you-go per report; contact ibat@ibat-alliance.org for API access and pricing. No public free API.",
    "What the portal would do with a subscription: run a proximity report (protected areas, KBAs, Red List species within a radius) per site and attach it to the TNFD LEAP locate step and lender ESG due diligence packs.",
    "Free alternatives with less coverage: Protected Planet (WDPA) downloads, GBIF and NBN Atlas for occurrences, and Natural England open data for England designations (all built as separate connectors).",
    "IBAT outputs are desktop screening, not a survey; species lists are potential presence based on range maps.",
  ],
  operations: [
    {
      id: "links",
      label: "About IBAT access",
      description: "Links to IBAT services, pricing and API guidance; no data is fetched.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "IBAT is a commercial subscription service; the portal can integrate its API once a subscription with API access is in place.",
          columns: ["resource", "url"],
          rows: LINKS.map((l) => ({ resource: l.label, url: l.url })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "ibat", basis: "not_applicable" }),
        };
      },
    },
  ],
});
