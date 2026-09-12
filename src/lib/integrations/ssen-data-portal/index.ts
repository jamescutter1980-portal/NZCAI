import { defineIntegration, simpleHealth, type IntegrationDefinition } from "../framework";
import { ckanOperations, type CkanPortalConfig } from "../_shared/ckan";

/**
 * SSEN Distribution open data portal (CKAN). The human portal is data.ssen.co.uk; open-source clients and an
 * August 2026 probe record the API host as data-api.ssen.co.uk (data.ssen.co.uk/api/3/action returned 404), and
 * that host applies User-Agent bot filtering. Not exercised live here.
 */

const DEFAULT_BASE = "https://data-api.ssen.co.uk/api/3/action/";

function base(env: Record<string, string | undefined>): string {
  const override = env.SSEN_DATA_PORTAL_BASE?.trim();
  return override ? (override.endsWith("/") ? override : override + "/") : DEFAULT_BASE;
}

/** The API host rejects default library user agents; send an identifiable browser-style agent. */
export const SSEN_USER_AGENT = "Mozilla/5.0 (compatible; NZCPortal/1.0; +https://github.com/jamescutter1980-portal/nzcai)";

function headers(): Record<string, string> {
  return { "User-Agent": SSEN_USER_AGENT };
}

const config: CkanPortalConfig = {
  base: DEFAULT_BASE,
  headers: () => headers(),
  warnings: ["SSEN capacity and headroom datasets are indicative planning views and never a connection offer."],
  knownDatasets: [
    { value: "generation-availability-and-network-capacity", label: "Generation availability and network capacity (headroom)" },
    { value: "ssen-substation-data", label: "SSEN substation data" },
  ],
};

export const definition: IntegrationDefinition = defineIntegration({
  id: "ssen-data-portal",
  name: "SSEN Distribution open data portal",
  group: "grid",
  access: "open",
  territory: "GB (central southern England and north of Scotland)",
  description: "Scottish and Southern Electricity Networks distribution open data (CKAN): network capacity and generation availability, substation data, LV feeder smart meter aggregates. Search datasets, list resources and query datastore tables.",
  docsUrl: "https://data.ssen.co.uk/",
  attribution: "Contains data from the SSEN Distribution open data portal, © Scottish and Southern Electricity Networks, used under its open data licence terms.",
  licence: "OGL",
  envVars: [{ name: "SSEN_DATA_PORTAL_BASE", required: false, description: "Override the CKAN action base URL (default https://data-api.ssen.co.uk/api/3/action/). Set to https://data.ssen.co.uk/api/3/action/ if SSEN moves the API back to the portal host." }],
  status: "built_unverified",
  notes: [
    "API host: the brief listed data.ssen.co.uk, but open-source clients and a 2026-08 probe show the CKAN API at data-api.ssen.co.uk (the portal host returned 404 for package_search). The default here is data-api.ssen.co.uk; override with SSEN_DATA_PORTAL_BASE.",
    "The API host returns HTTP 403 to default library user agents (WAF bot filtering, not authentication). An identifiable browser-style User-Agent is sent.",
    "Licence bucket OGL: SSEN publishes datasets under OGL v3.0 or its own open licence; check each dataset's licence field.",
    "Known dataset ids come from open-source code calling package_show on this portal and have not been confirmed live.",
  ],
  healthCheck: simpleHealth((env) => `${base(env)}package_search?rows=1`, { headers: headers() }),
  operations: ckanOperations(() => definition, config).map((op) => ({
    ...op,
    run(params, ctx) {
      // Respect the env override without rebuilding the operation set.
      const b = base(ctx.env);
      if (b === DEFAULT_BASE) return op.run(params, ctx);
      const rewriting = { ...ctx, fetch: (input: string, init?: RequestInit) => ctx.fetch(input.replace(DEFAULT_BASE, b), init) };
      return op.run(params, rewriting);
    },
  })),
});
