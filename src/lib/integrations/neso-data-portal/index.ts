import { defineIntegration, simpleHealth, type IntegrationDefinition } from "../framework";
import { ckanOperations, type CkanPortalConfig } from "../_shared/ckan";

/**
 * NESO Data Portal (CKAN 2.8). Base URL and action names from NESO's API guidance
 * (https://www.neso.energy/data-portal/api-guidance); dataset ids below are those referenced by open-source
 * code that calls package_show on this portal. Not exercised live here.
 */

const BASE = "https://api.neso.energy/api/3/action/";

const config: CkanPortalConfig = {
  base: BASE,
  warnings: ["NESO asks for at most 1 request/second to the CKAN API and 2 datastore requests/minute; cache results."],
  knownDatasets: [
    { value: "historic-demand-data", label: "Historic demand data (INDO/ND by settlement period, annual files)" },
    { value: "embedded-wind-and-solar-forecasts", label: "Embedded wind and solar forecasts (up to 14 days ahead)" },
    { value: "regional-breakdown-of-fes-data-electricity", label: "Future Energy Scenarios: regional breakdown (electricity)" },
    { value: "transmission-entry-capacity-tec-register", label: "Transmission Entry Capacity (TEC) register" },
    { value: "embedded-register", label: "Embedded (distribution-connected) generation register" },
    { value: "system-frequency-data", label: "System frequency (1-second, monthly files)" },
    { value: "thermal-constraint-costs", label: "Thermal constraint costs" },
    { value: "constraint-breakdown", label: "Constraint breakdown" },
  ],
};

export const definition: IntegrationDefinition = defineIntegration({
  id: "neso-data-portal",
  name: "NESO Data Portal",
  group: "grid",
  access: "open",
  territory: "GB",
  description: "National Energy System Operator open data (CKAN): historic and forecast demand, embedded generation forecasts, Future Energy Scenarios, connection and TEC registers, constraint costs and system data. Search datasets, list resources and query datastore tables.",
  docsUrl: "https://www.neso.energy/data-portal/api-guidance",
  termsUrl: "https://www.neso.energy/data-portal/neso-open-licence",
  attribution: "Supported by National Energy SO Open Data. Contains data licensed under the NESO Open Data Licence v1.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "NESO Open Data Licence v1.0 is derived from OGL v3.0 and stated to be CC BY 4.0 compatible; attribution 'Supported by National Energy SO Open Data' is required on redistribution.",
    "No key. Rate guidance: 1 request/second to the CKAN API, 2 datastore requests/minute.",
    "The 'well-known dataset' list contains ids referenced by open-source code that calls package_show on this portal; they have not been confirmed live and NESO renames datasets occasionally. A carbon-intensity forecast dataset id and the embedded capacity register aggregate id could not be confirmed and are omitted; use 'Search datasets'.",
    "Datastore rows are returned as published; units and column meanings come from each dataset's page.",
  ],
  healthCheck: simpleHealth(`${BASE}package_search?rows=1`),
  operations: ckanOperations(() => definition, config),
});
