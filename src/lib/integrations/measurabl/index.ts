import { defineIntegration } from "../framework";

/**
 * Measurabl: a commercial ESG data-management platform used by real-estate owners. A client may already hold
 * their meter, utility bill and certification records there; access is via the client's own subscription and
 * API credentials. Reference-only.
 */

export const definition = defineIntegration({
  id: "measurabl",
  name: "Measurabl",
  group: "energy",
  access: "authorised",
  territory: "Global",
  description: "Sustainability records a client already keeps in Measurabl: site and meter inventory, monthly utility consumption and cost, emissions, waste and water, certifications and GRESB submissions. Importing them avoids re-collecting utility data the client has already validated.",
  docsUrl: "https://www.measurabl.com/",
  termsUrl: "https://www.measurabl.com/",
  attribution: "Sustainability records supplied by the client from their Measurabl account.",
  licence: "consent_based",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: the client's Measurabl subscription must include API access; credentials (API key or OAuth client) are issued by Measurabl to the client, who authorises the portal to use them. Measurabl also supports scheduled exports and data connectors if API access is not licensed.",
    "What the portal would do with it: pull the site list with floor areas and meters, monthly consumption by fuel, and any existing emissions calculations so ESOS, SECR, CRREM and NZC assessments start from the client's validated data (provenance 'client_declared' unless Measurabl marks the value as metered).",
    "Measurabl's calculated emissions use its own factor sets; the portal should re-derive Scope 1 and 2 from the underlying consumption with DESNZ factors rather than import Measurabl's totals.",
    "No public API reference was available to build against; endpoint shapes are defined in Measurabl's partner documentation.",
  ],
  operations: [],
});
