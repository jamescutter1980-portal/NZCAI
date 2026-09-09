import { defineIntegration } from "../framework";

/**
 * Xoserve (the Central Data Service Provider for GB gas) exposes several routes to MPRN-level data. None are
 * open; each is reached through Xoserve or RECCo agreements, so this is a reference-only definition.
 */

export const definition = defineIntegration({
  id: "xoserve-gas-data",
  name: "Xoserve gas supply point data",
  group: "energy",
  access: "commercial",
  territory: "GB",
  description: "MPRN-level gas supply point data held by Xoserve (CDSP): Annual Quantity and Supply Point Quantities, meter asset details, supplier and shipper, via the Supply Point Quantities API, the RECCo-run Supply Point Enquiry and Meter Asset Enquiry services, and the Gemini transmission system.",
  docsUrl: "https://www.xoserve.com/products-services/",
  termsUrl: "https://www.xoserve.com/",
  attribution: "Gas supply point data from Xoserve (Central Data Service Provider), provided under the relevant REC or Xoserve service agreement.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Supply Point Quantities (SPQ) API: Xoserve's direct API giving Annual Quantity (AQ) and Supply Point Quantities for an MPRN. Access is for parties with an Xoserve API agreement (shippers, suppliers, authorised third parties) and consent from the consumer.",
    "Supply Point Enquiry and Meter Asset Enquiry: the retail-market enquiry services (MPRN lookup, meter serial, meter type, supplier/shipper, AQ) are provided under the Retail Energy Code through RECCo's Enquiry Services (the Central Switching Service / Gas Enquiry Service), not directly by Xoserve. Brokers and TPIs register with RECCo as authorised parties.",
    "Gemini Sustain Plus: Xoserve's gateway to the National Transmission System operational and commercial systems (nominations, allocations, entry/exit capacity) for shippers. It is NOT a building or meter-level data product and is out of scope for the portal.",
    "What the portal would do with it: validate MPRNs, populate AQ where no interval or billing data exists (provenance 'estimated'), record meter type (SMETS1/2, conventional) to know whether half-hourly gas data is obtainable, and identify the supplier for consent requests.",
    "No API contract was available to build against; endpoints, authentication (typically client certificates or API keys issued by Xoserve/RECCo) and the consent evidence required are set out in each service's access agreement.",
  ],
  operations: [],
});
