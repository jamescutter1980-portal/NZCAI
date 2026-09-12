import { defineIntegration } from "../framework";

/**
 * Perse Technology: address-level linked building, meter and energy data for around 30 million UK addresses,
 * sold as a commercial API. Reference-only; no contract to build against.
 */

export const definition = defineIntegration({
  id: "perse",
  name: "Perse",
  group: "energy",
  access: "commercial",
  territory: "UK",
  description: "Perse links UPRNs to electricity and gas meter points, EPC data, building attributes and (with consent) half-hourly consumption and carbon, offering site-level energy and net-zero analytics across roughly 30 million UK addresses.",
  docsUrl: "https://perse.io/",
  termsUrl: "https://perse.io/",
  attribution: "Address, meter and energy data from Perse Technology Ltd, used under licence.",
  licence: "commercial",
  envVars: [],
  status: "reference_only",
  notes: [
    "Access: commercial API subscription with Perse; keys are issued per client and consumption data additionally needs the meter owner's consent captured through Perse's flow.",
    "Coverage claims (about 30 million addresses, UPRN to MPAN/MPRN linkage) are Perse's marketing figures and have not been verified.",
    "What the portal would do with it: resolve a building's UPRN to its MPANs/MPRNs and EPC in one call, backfill annual consumption estimates for sites without smart data (provenance 'modelled' or 'estimated' as Perse states), and obtain half-hourly consented data as an alternative to n3rgy/Openvolt.",
    "No public API reference was available to build against; endpoint shapes, rate limits and redistribution terms come from Perse's developer documentation supplied on contract.",
  ],
  operations: [],
});
