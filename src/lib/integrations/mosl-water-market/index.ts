import { defineIntegration, makeProvenance, type OperationResult } from "../framework";

export const definition = defineIntegration({
  id: "mosl-water-market",
  name: "MOSL non-household water market data (CMOS)",
  group: "energy",
  access: "authorised",
  territory: "England",
  description: "Market Operator Services Ltd (MOSL) runs the Central Market Operating System (CMOS) for England's non-household water market: supply point identifiers (SPIDs), meter details and meter reads / consumption for every business water and sewerage supply point. Access for third parties is through MOSL's Third Party Data Request service with customer consent, not a public API.",
  docsUrl: "https://mosl.co.uk/documents-publications/11006-third-party-data-request-guidance/file",
  termsUrl: "https://mosl.co.uk/documents-publications/10994-third-party-data-request-policy/file",
  attribution: "Data provided by MOSL from CMOS under a Third Party Data Sharing Agreement; not for onward disclosure.",
  licence: "consent_based",
  envVars: [],
  status: "reference_only",
  notes: [
    "MOSL's Third Party Data Request service (policy and guidance v1.0, May 2026) lets a third party request consumption data held in CMOS on behalf of customers, limited to what Market Terms section 1.2.7(e) permits, with a Data Sharing Agreement and evidenced customer consent for a defined purpose. The application requires the organisation, use case, specific data, purpose, UK GDPR lawful basis and controls.",
    "Delivery is by file under the agreement (no public REST API). The portal would treat SPID-level reads and consumption as basis 'measured' with licence 'consent_based' and a consent reference per customer, mirroring the n3rgy smart-meter consent flow.",
    "Alternatives: the customer's retailer portal or bills (client_declared), or AMR/smart water meter data from the retailer. The MOSL data standard for sharing granular consumption data from non-households (Nov 2023) defines the interval-data format retailers should use.",
    "England only; Scotland's market is run by CMA (Central Market Agency) and Wales is largely outside the competitive market.",
  ],
  operations: [
    {
      id: "links",
      label: "How to request MOSL market data",
      description: "Links to the MOSL third party data request policy, guidance and agreement template.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        return {
          summary: "Non-household water consumption from CMOS is obtained through MOSL's Third Party Data Request service with customer consent and a data sharing agreement; there is no public API.",
          rows: [],
          provenance: makeProvenance(definition, ctx, { dataset: "mosl-cmos", basis: "not_applicable" }),
          links: [
            { label: "MOSL third party data request guidance", url: "https://mosl.co.uk/documents-publications/11006-third-party-data-request-guidance/file" },
            { label: "MOSL third party data request policy", url: "https://mosl.co.uk/documents-publications/10994-third-party-data-request-policy/file" },
            { label: "Data sharing agreement template", url: "https://mosl.co.uk/documents-publications/10991-third-party-data-sharing-agreement-template/file" },
            { label: "CMOS", url: "https://mosl.co.uk/cmos" },
          ],
        };
      },
    },
  ],
});
