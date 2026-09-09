import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "Xero developer: OAuth 2.0", url: "https://developer.xero.com/documentation/guides/oauth2/overview/" },
  { label: "Xero Accounting API: Invoices (ACCPAY bills)", url: "https://developer.xero.com/documentation/api/accounting/invoices" },
  { label: "Xero Accounting API: Bank Transactions", url: "https://developer.xero.com/documentation/api/accounting/banktransactions" },
  { label: "Xero Accounting API: Contacts", url: "https://developer.xero.com/documentation/api/accounting/contacts" },
];

export const definition = defineIntegration({
  id: "xero-spend",
  name: "Xero purchase transactions (spend-based Scope 3)",
  group: "carbon",
  access: "authorised",
  territory: "Global",
  description: "Client-authorised read of purchase invoices (bills), spend-money bank transactions and supplier contacts from Xero, for spend-based Scope 3 category 1 (purchased goods and services) screening with supplier classification.",
  docsUrl: "https://developer.xero.com/documentation/",
  termsUrl: "https://developer.xero.com/xero-developer-platform-terms-conditions/",
  attribution: "Financial data from the client's Xero organisation, retrieved under the client's OAuth 2.0 consent.",
  licence: "consent_based",
  envVars: [
    { name: "XERO_CLIENT_ID", required: true, description: "OAuth 2.0 client id of the portal's Xero app (planned)." },
    { name: "XERO_CLIENT_SECRET", required: true, description: "OAuth 2.0 client secret (planned; server-side only)." },
  ],
  status: "reference_only",
  notes: [
    "Authorisation: OAuth 2.0 authorization-code flow with PKCE; scopes accounting.transactions.read, accounting.contacts.read, offline_access (refresh tokens, 60-day rolling expiry). Each client organisation (tenant) is connected separately and the tenant id is sent as the xero-tenant-id header. Uncertified apps are limited to 25 connected tenants; the Xero App Store certification lifts this.",
    "Data pulled: ACCPAY invoices (bills) and SPEND bank transactions with line items (account code, tracking categories, tax), supplier contacts (name, tax number for company matching) for the reporting period; rate limits 60 calls/min and 5,000/day per tenant.",
    "Spend-based Scope 3 category 1 screening: classify each supplier (by account code, SIC/NACE via Companies House match, or manual tag) and apply a spend factor (EXIOBASE-derived or Climatiq procurement) per classification, spend year and GBP. Results carry basis 'estimated' and are for screening and hotspot identification, to be replaced by supplier-specific data.",
    "Consent: store the consent reference (tenant id, scopes, granted-at, expiry) with every imported value and purge or freeze when the connection is removed, per the provenance model.",
    "Not yet built: no client is registered with Xero from this environment; the definition records the intended scopes and endpoints.",
  ],
  operations: [
    {
      id: "links",
      label: "Xero authorisation and endpoints",
      description: "OAuth guidance and the Accounting API endpoints the portal would read.",
      params: [],
      async run(_params, ctx) {
        return { summary: "Xero access is by per-client OAuth 2.0 consent; the portal would read bills, spend transactions and contacts for spend-based Scope 3 screening.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
