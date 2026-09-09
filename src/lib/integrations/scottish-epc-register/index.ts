import { defineIntegration, makeProvenance } from "../framework";

/** Scottish EPC Register: open data extracts published quarterly by the Scottish Government; no public API. */

const LINKS = [
  { label: "Domestic EPCs (statistics.gov.scot)", url: "https://statistics.gov.scot/data/domestic-energy-performance-certificates", description: "Quarterly CSV extracts of every domestic EPC held on the Scottish EPC Register from 2015 (valid and historic files), with full address and assessment fields." },
  { label: "Non-domestic EPCs (statistics.gov.scot)", url: "https://statistics.gov.scot/data/non-domestic-energy-performance-certificates", description: "Quarterly CSV extracts of non-domestic EPCs with asset rating, floor area and recommendations report fields." },
  { label: "Scottish EPC Register data extracts page", url: "https://www.scottishepcregister.org.uk/CustomerFacingPortal/DataExtract", description: "Register operator's page listing the published extracts (valid domestic, valid non-domestic, historic domestic, historic non-domestic)." },
  { label: "Scottish EPC Register public search", url: "https://www.scottishepcregister.org.uk/", description: "Look up one certificate by postcode or report reference number (RRN)." },
];

export const definition = defineIntegration({
  id: "scottish-epc-register",
  name: "Scottish EPC Register (open data extracts)",
  group: "identity",
  access: "download",
  territory: "Scotland",
  description: "Energy Performance Certificates lodged in Scotland, published by the Scottish Government as quarterly bulk CSV extracts (domestic and non-domestic) on statistics.gov.scot; no developer API.",
  docsUrl: "https://statistics.gov.scot/data/domestic-energy-performance-certificates",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Scottish Government / Scottish EPC Register (Energy Saving Trust).",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "Scotland is not covered by the England and Wales EPC API. Scottish EPCs use SAP/RdSAP and SBEM as elsewhere but ratings, bands and the assessment regime (Energy Performance of Buildings (Scotland) Regulations, revised 2025) differ in detail; do not mix Scottish and English band thresholds in portfolio statistics without noting it.",
    "Extracts are refreshed roughly quarterly with a lag of a few months; each extract is a large CSV per period (valid and historic). The portal would import the latest 'valid' domestic and non-domestic files and match by UPRN or address to client assets.",
    "Fields include address, UPRN (where available), current and potential energy efficiency ratings, environmental impact ratings, floor area, property type, main heating and fuel, lodgement date, and recommendations report content.",
    "Third-party sites (for example epcdata.scot) re-serve this data with an API; they are not official and their terms and uptime are their own.",
    "Recorded as a reference-only source: the single operation returns the official download links.",
  ],
  operations: [
    {
      id: "links",
      label: "Download links",
      description: "Official Scottish EPC open data extracts and the register's public search.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "Scottish EPC data is available as quarterly bulk CSV extracts on statistics.gov.scot; there is no public API.",
          columns: ["label", "url", "description"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS.map(({ label, url }) => ({ label, url })),
          provenance: makeProvenance(definition, ctx, { dataset: "download-links", basis: "not_applicable" }),
        };
      },
    },
  ],
});
