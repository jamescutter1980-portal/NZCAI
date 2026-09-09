import { defineIntegration, makeProvenance } from "../framework";

/** OS OpenUPRN, OS Open USRN and OS Open Linked Identifiers: free OGL bulk downloads that form a UPRN spine. */

const LINKS = [
  { label: "OS Open UPRN (product page)", url: "https://www.ordnancesurvey.co.uk/products/os-open-uprn", description: "Every UPRN in Great Britain with a coordinate (BNG and lat/lon); CSV or GeoPackage, monthly. No addresses." },
  { label: "OS Open USRN (product page)", url: "https://www.ordnancesurvey.co.uk/products/os-open-usrn", description: "Every Unique Street Reference Number with street geometry; GeoPackage, monthly." },
  { label: "OS Open Linked Identifiers (product page)", url: "https://www.ordnancesurvey.co.uk/products/os-open-linked-identifiers", description: "Cross-reference tables linking UPRN to USRN, TOID (building, road link) and other identifiers; CSV, monthly." },
  { label: "OS Downloads API - OpenUPRN", url: "https://api.os.uk/downloads/v1/products/OpenUPRN", description: "Open, keyless JSON listing of the current OpenUPRN download files (also OpenUSRN and OpenLinkedIdentifiers)." },
  { label: "OS OpenData downloads (all products)", url: "https://osdatahub.os.uk/downloads/open", description: "Browser download of any OS OpenData product without a key." },
];

export const definition = defineIntegration({
  id: "os-open-uprn",
  name: "OS Open UPRN, USRN and Linked Identifiers (bulk)",
  group: "identity",
  access: "download",
  territory: "GB",
  description: "Free Ordnance Survey identifier spine: coordinates for every UPRN, street geometry for every USRN, and cross-references between UPRN, USRN and TOID, refreshed monthly.",
  docsUrl: "https://www.ordnancesurvey.co.uk/products/os-open-uprn",
  termsUrl: "https://www.ordnancesurvey.co.uk/products/os-open-uprn#licensing",
  attribution: "Contains OS data © Crown copyright and database right 2026. Contains Royal Mail data © Royal Mail copyright and database right 2026. Contains GeoPlace data © Local Government Information House Limited copyright and database right 2026. Licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "reference_only",
  notes: [
    "Why it matters: a UPRN is the key that joins EPCs, OS Places addresses, NGD building parts, planning entities and client asset lists. OS Open UPRN gives a free coordinate for any UPRN (about 40 million rows, ~1 GB CSV) without address text; OS Open Linked Identifiers joins UPRN to the building TOID and street USRN.",
    "Import plan: load OpenUPRN (uprn, x, y, lat, lon) and the UPRN-to-TOID and UPRN-to-USRN linked identifier files into indexed tables; refresh monthly from the OS Downloads API, which is open and needs no key.",
    "Limits: no addresses (use OS Places or AddressBase for those), no classification, and coordinates are the address seed point. Northern Ireland is not covered (Pointer is the NI equivalent).",
    "Recorded as a reference-only source: the operation returns product and download links.",
  ],
  operations: [
    {
      id: "links",
      label: "Product and download links",
      description: "Where to obtain OS Open UPRN, OS Open USRN and OS Open Linked Identifiers.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "OS Open UPRN, USRN and Linked Identifiers are free monthly bulk downloads under OGL that give a coordinate and cross-references for every UPRN in Great Britain.",
          columns: ["label", "url", "description"],
          rows: LINKS.map((l) => ({ ...l })),
          links: LINKS.map(({ label, url }) => ({ label, url })),
          provenance: makeProvenance(definition, ctx, { dataset: "download-links", basis: "not_applicable" }),
        };
      },
    },
  ],
});
