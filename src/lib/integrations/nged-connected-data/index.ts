import { defineIntegration, simpleHealth, type IntegrationDefinition } from "../framework";
import { ckanOperations, type CkanPortalConfig } from "../_shared/ckan";

/**
 * National Grid Electricity Distribution "Connected Data" portal (CKAN). Base URL and the raw-key
 * Authorization header style are from open-source clients of this portal; not exercised live here.
 */

const BASE = "https://connecteddata.nationalgrid.co.uk/api/3/action/";

function headers(env: Record<string, string | undefined>): Record<string, string> {
  const key = env.NGED_API_KEY?.trim();
  return key ? { Authorization: key } : {};
}

const config: CkanPortalConfig = {
  base: BASE,
  headers,
  warnings: ["Many NGED datasets are only listed or downloadable with a registered account API key; without NGED_API_KEY results may be limited to fully public datasets."],
  knownDatasets: [
    { value: "connection-queue", label: "Connection queue" },
    { value: "asset-limits-pre-event-transmission-distribution-limits", label: "Asset limits: pre-event transmission/distribution limits" },
    { value: "aggregated-smart-meter-data-lv-feeder", label: "Aggregated smart meter data by LV feeder (key required)" },
  ],
};

export const definition: IntegrationDefinition = defineIntegration({
  id: "nged-connected-data",
  name: "NGED Connected Data portal",
  group: "grid",
  access: "open_key",
  territory: "England and Wales (East and West Midlands, South West, South Wales)",
  description: "National Grid Electricity Distribution open data (CKAN): network capacity and headroom, connection queue, substation and feeder data, aggregated LV smart meter data. Search datasets, list resources and query datastore tables.",
  docsUrl: "https://connecteddata.nationalgrid.co.uk/",
  termsUrl: "https://connecteddata.nationalgrid.co.uk/pages/licence",
  attribution: "Contains data from National Grid Electricity Distribution's Connected Data portal, © National Grid Electricity Distribution plc, used under its open data licence.",
  licence: "OGL",
  envVars: [{ name: "NGED_API_KEY", required: false, description: "API key from a registered Connected Data account (profile page). Sent as the raw value of the Authorization header. Optional; unlocks datasets that are not fully public." }],
  status: "built_unverified",
  notes: [
    "Register at connecteddata.nationalgrid.co.uk to obtain a key; open-source clients send the key as the bare Authorization header value (no 'Bearer'). Unverified here.",
    "Licence recorded as OGL bucket: NGED publishes most datasets under its own open licence (based on OGL/CC BY); a few are restricted. Check each dataset's licence field before redistribution.",
    "Capacity and headroom datasets are indicative planning views; they are never a connection offer. Formal capacity is confirmed only by a connection application.",
    "Known dataset ids come from open-source code calling package_show on this portal and have not been confirmed live.",
  ],
  healthCheck: simpleHealth(`${BASE}package_search?rows=1`, (env) => ({ headers: headers(env) })),
  operations: ckanOperations(() => definition, config),
});
