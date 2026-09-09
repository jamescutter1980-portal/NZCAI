import { defineIntegration } from "../framework";

/**
 * ElectraLink QuoteRight: consented MPAN-level supply details (meter technical details, profile class, EAC,
 * supplier and agent history) from the DTN. Commercial API for brokers, suppliers and their authorised
 * partners; no client is built because access is contractual. Details from ElectraLink's public product pages.
 */

export const definition = defineIntegration({
  id: "electralink-quoteright",
  name: "ElectraLink QuoteRight",
  group: "energy",
  access: "commercial",
  territory: "GB",
  description: "MPAN lookup service returning the supply point's technical details, profile class, current and historic supplier, meter details and Estimated Annual Consumption (EAC) with the customer's consent. Used by brokers and suppliers to quote and validate sites.",
  docsUrl: "https://www.electralink.co.uk/services/quoteright/",
  termsUrl: "https://www.electralink.co.uk/",
  attribution: "Supply point data from ElectraLink QuoteRight, provided under licence with the customer's consent.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: a commercial agreement with ElectraLink and DTN accreditation. QuoteRight is sold to energy brokers, suppliers and third-party intermediaries; an end client cannot self-serve. The portal would integrate through a broker partner or by contracting ElectraLink directly.",
    "Consent: each lookup requires a Letter of Authority or equivalent consent from the customer named on the supply, held by the requesting party. Returned data is confidential to that customer.",
    "What the portal would do with it: confirm MPANs and meter serials for a site before requesting smart meter or DCDA data, populate profile class, measurement class and EAC for buildings without interval data, and check the supplier and contract end dates for tariff-switching or green-tariff work.",
    "The EAC is a settlement estimate, not metered consumption; treat it as 'estimated' provenance if imported.",
    "No API contract was available to build against; the request/response shape and rate limits must be taken from ElectraLink's onboarding pack.",
  ],
  operations: [],
});
