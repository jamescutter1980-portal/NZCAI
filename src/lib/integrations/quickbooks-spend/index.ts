import { defineIntegration, makeProvenance } from "../framework";

const LINKS = [
  { label: "Intuit developer: OAuth 2.0 and OpenID", url: "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0" },
  { label: "QuickBooks Online Accounting API: Purchase", url: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase" },
  { label: "QuickBooks Online Accounting API: Bill", url: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill" },
  { label: "QuickBooks Online Accounting API: Vendor", url: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor" },
];

export const definition = defineIntegration({
  id: "quickbooks-spend",
  name: "QuickBooks Online purchase transactions (spend-based Scope 3)",
  group: "carbon",
  access: "authorised",
  territory: "Global",
  description: "Client-authorised read of bills, purchases and vendors from QuickBooks Online for spend-based Scope 3 category 1 screening with supplier classification.",
  docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/get-started",
  termsUrl: "https://developer.intuit.com/app/developer/qbo/docs/develop/terms-of-service",
  attribution: "Financial data from the client's QuickBooks Online company, retrieved under the client's OAuth 2.0 consent.",
  licence: "consent_based",
  envVars: [
    { name: "QBO_CLIENT_ID", required: true, description: "OAuth 2.0 client id of the portal's Intuit app (planned)." },
    { name: "QBO_CLIENT_SECRET", required: true, description: "OAuth 2.0 client secret (planned; server-side only)." },
  ],
  status: "reference_only",
  notes: [
    "Authorisation: OAuth 2.0 authorization-code flow with scope com.intuit.quickbooks.accounting; access tokens last 1 hour, refresh tokens 100 days (rotated on use). Each client company is identified by its realmId, sent in the API path. Sandbox companies are available for development; production keys require app review for public listing.",
    "Data pulled: Bill and Purchase entities with line items (AccountRef, ItemRef, TaxCodeRef) and Vendor records (DisplayName, TaxIdentifier) via the query endpoint (SELECT * FROM Purchase WHERE TxnDate >= ...), paged by STARTPOSITION/MAXRESULTS (1,000 max). Rate limit 500 requests/min per realm.",
    "Spend-based Scope 3 category 1 screening: classify each vendor (account, SIC/NACE via company match, or manual tag) and apply a spend factor (EXIOBASE-derived or Climatiq procurement) per classification, spend year and currency. Results carry basis 'estimated' and are for screening only.",
    "Consent: store the consent reference (realmId, scopes, granted-at, refresh expiry) with every imported value; purge or freeze when disconnected.",
    "Not yet built: no Intuit app is registered from this environment; the definition records the intended scopes and endpoints.",
  ],
  operations: [
    {
      id: "links",
      label: "QuickBooks authorisation and endpoints",
      description: "OAuth guidance and the Accounting API entities the portal would read.",
      params: [],
      async run(_params, ctx) {
        return { summary: "QuickBooks Online access is by per-client OAuth 2.0 consent; the portal would read bills, purchases and vendors for spend-based Scope 3 screening.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "guidance", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
