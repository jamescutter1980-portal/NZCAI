import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "Ofgem Renewable Electricity Register (REGO)", url: "https://www.ofgem.gov.uk/environmental-and-social-schemes/renewable-energy-guarantees-origin-rego" },
  { label: "Ofgem Fuel Mix Disclosure guidance", url: "https://www.ofgem.gov.uk/environmental-and-social-schemes/fuel-mix-disclosure" },
  { label: "GHG Protocol Scope 2 Guidance (quality criteria for contractual instruments)", url: "https://ghgprotocol.org/scope-2-guidance" },
];

export const definition = defineIntegration({
  id: "ofgem-renewable-electricity-register",
  name: "Ofgem Renewable Electricity Register (REGO evidence)",
  group: "carbon",
  access: "enquiry",
  territory: "GB",
  description: "Evidence that a green tariff or PPA is backed by Renewable Energy Guarantees of Origin: REGO issue and cancellation records held on Ofgem's Renewable Electricity Register, which replaced the Renewables and CHP Register in May 2025.",
  docsUrl: "https://www.ofgem.gov.uk/environmental-and-social-schemes/renewable-energy-guarantees-origin-rego",
  attribution: "Source: Ofgem, Renewable Electricity Register. Contains public sector information licensed under the Open Government Licence v3.0 where published as open reports.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "The Renewables and CHP Register was replaced by the Renewable Electricity Register in May 2025. Public reports (accredited stations, certificates issued, certificates cancelled/redeemed by supplier) are only partly restored on the new service; check the register site for what is currently published.",
    "Extracts not available as public reports are provided on request: email renewable.enquiry@ofgem.gov.uk stating the supplier, the compliance period and the report needed. Ofgem has circulated extracts via SharePoint links; record the extract date and file name as the evidence reference.",
    "What the portal would do with the data: for a REGO-backed tariff, confirm the supplier redeemed REGOs for the compliance period (1 April to 31 March) covering the client's volume, and store the redemption evidence against the market-based Scope 2 figure. Without it the supply falls back to the residual mix (see aib-residual-mix).",
    "Fuel Mix Disclosure (FMD): suppliers publish their fuel mix and CO2 intensity annually under the Electricity (Fuel Mix Disclosure) Regulations 2005. The supplier's FMD figure is the market-based factor for standard (non-green) tariffs; the FMD 'residual fuel mix' published by Ofgem/DESNZ is the GB reference for unmatched supply.",
    "GHG Protocol Scope 2 Quality Criteria: the instrument must convey the attributes, be unique and tracked, be retired/cancelled on behalf of the consumer, be issued and redeemed close to the consumption period, and come from the same market. REGO redemption on this register is how those criteria are evidenced for GB supply.",
    "No API. Redistribution of register extracts to clients should be limited to the client's own supplier evidence.",
  ],
  operations: [
    {
      id: "links",
      label: "Where to obtain REGO evidence",
      description: "Register, guidance and enquiry route for REGO and Fuel Mix Disclosure evidence.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "REGO issue and cancellation evidence is obtained from the Ofgem Renewable Electricity Register public reports or by extract request to renewable.enquiry@ofgem.gov.uk.",
          columns: ["label", "url"],
          rows: LINKS.map((l) => ({ ...l })),
          provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }),
          links: LINKS,
        };
      },
    },
  ],
});
