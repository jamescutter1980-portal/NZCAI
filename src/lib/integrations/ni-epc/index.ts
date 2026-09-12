import { defineIntegration, makeProvenance } from "../framework";

/** Northern Ireland EPC register: public web search only, no API or bulk data. */

const LINKS = [
  { label: "Energy Performance Certificates (Department of Finance NI)", url: "https://www.finance-ni.gov.uk/articles/energy-performance-certificates", description: "Policy owner for EPB regulations in Northern Ireland; hosts the postcode search for lodged certificates." },
  { label: "Energy Performance Certificates (nidirect)", url: "https://www.nidirect.gov.uk/articles/energy-performance-certificates", description: "Public guidance and how to retrieve a certificate by address or by its 20-digit report reference." },
  { label: "Land & Property Services", url: "https://www.finance-ni.gov.uk/land-property-services-lps", description: "LPS holds the valuation list and property data; the EPC register is administered under Department of Finance oversight." },
];

export const definition = defineIntegration({
  id: "ni-epc",
  name: "Northern Ireland EPC register (enquiry)",
  group: "identity",
  access: "enquiry",
  territory: "Northern Ireland",
  description: "Energy Performance Certificates lodged in Northern Ireland can be viewed one at a time through the Department of Finance web search; there is no developer API and no open bulk extract.",
  docsUrl: "https://www.finance-ni.gov.uk/articles/energy-performance-certificates",
  attribution: "© Crown copyright, Department of Finance Northern Ireland. Individual certificates retrieved from the public register.",
  licence: "restricted",
  envVars: [],
  status: "reference_only",
  notes: [
    "Northern Ireland is outside both the England and Wales EPC API and the Scottish extracts. Certificates are lodged on the NI register under the Energy Performance of Buildings (Certificates and Inspections) Regulations (Northern Ireland) 2008.",
    "Access today is a public web search by postcode or by the 20-digit report reference; owners can opt out of address search. Copies are PDFs; there is no JSON API, no bulk download and no published open-data licence for the register.",
    "To obtain data at scale, submit an enquiry to the Department of Finance EPB team (via the contact on the EPC page) or a Freedom of Information / data-sharing request describing the purpose (portfolio energy analysis) and the fields needed; redistribution rights would need to be agreed. Alternatively ask clients to supply their own certificates.",
    "Portal handling: record NI assets' EPC data as client_declared from the certificate PDF until an official feed exists.",
  ],
  operations: [
    {
      id: "links",
      label: "Where to look up NI certificates",
      description: "Official pages for retrieving Northern Ireland EPCs and making a data enquiry.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "Northern Ireland EPCs are retrievable only one at a time via the Department of Finance web search; bulk or API access requires an enquiry.",
          columns: ["label", "url", "description"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS.map(({ label, url }) => ({ label, url })),
          provenance: makeProvenance(definition, ctx, { dataset: "enquiry-links", basis: "not_applicable" }),
        };
      },
    },
  ],
});
