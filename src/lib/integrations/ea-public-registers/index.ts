import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { type EaList, lastSegment, num, text, trimItems } from "../ea-flood-monitoring/ea-lda";
import { wgs84ToOsgb36 } from "./osgb";

/**
 * Environment Agency Public Registers for Environmental Information (England):
 * permits, registrations and exemptions across the waste, installations,
 * discharge, radioactive substances, waste carrier and other registers.
 * Reference: https://environment.data.gov.uk/public-register/view/api-reference
 * Routes and parameters confirmed from the published OpenAPI document:
 *   /api/search.json?easting&northing&dist&_limit&_offset   all registers
 *   /{register}/registration.json?easting&northing&dist      one register
 *   /waste-carriers-brokers/registration.json?name-search=   by holder name
 * Distance search needs OSGB36 easting/northing (dist in km). Item fields:
 * registrationNumber, register.label, holder.name, registrationType.label,
 * site.siteAddress, registrationDate, expiryDate, tier, localAuthority, distance.
 * Not exercised live from this codebase.
 */

export const BASE = "https://environment.data.gov.uk/public-register";

/** Registers that support the easting/northing/dist search (from the OpenAPI document). */
export const REGISTERS: { value: string; label: string }[] = [
  { value: "all", label: "All registers" },
  { value: "waste-operations", label: "EPR waste operations" },
  { value: "industrial-installations", label: "EPR installations (industrial emissions)" },
  { value: "water-discharges", label: "EPR water discharge consents" },
  { value: "radioactive-substance", label: "EPR radioactive substances" },
  { value: "end-of-life-vehicles", label: "EPR end-of-life vehicles" },
  { value: "waste-exemptions", label: "Waste exemptions" },
  { value: "water-discharge-exemptions", label: "Water discharge exemptions" },
  { value: "waste-carriers-brokers", label: "Waste carriers, brokers and dealers" },
  { value: "flood-risk-exemptions", label: "Flood risk activity exemptions" },
];

export interface Registration {
  "@id"?: string;
  registrationNumber?: string | number;
  register?: unknown;
  holder?: { "@id"?: string; name?: string; tradingName?: string } | { name?: string }[];
  registrationType?: unknown;
  registrationDate?: string;
  expiryDate?: string;
  effectiveDate?: string;
  tier?: unknown;
  regime?: unknown;
  localAuthority?: unknown;
  site?: { "@id"?: string; siteAddress?: { address?: unknown; postcode?: unknown; town?: unknown } ; location?: { easting?: number; northing?: number; gridReference?: string }; premises?: string };
  distance?: number;
  type?: unknown;
  status?: unknown;
}

const COLUMNS = ["registration_number", "register", "holder", "trading_name", "registration_type", "tier", "site_address", "postcode", "easting", "northing", "distance_km", "registration_date", "expiry_date", "local_authority", "url"];

function holderOf(r: Registration): { name: string | null; trading: string | null } {
  const h = Array.isArray(r.holder) ? r.holder[0] : r.holder;
  if (!h) return { name: null, trading: null };
  return { name: text((h as { name?: unknown }).name), trading: text((h as { tradingName?: unknown }).tradingName) };
}

export function registrationRow(r: Registration) {
  const holder = holderOf(r);
  const addr = r.site?.siteAddress;
  return {
    registration_number: r.registrationNumber !== undefined ? String(r.registrationNumber) : lastSegment(r["@id"]),
    register: text(r.register),
    holder: holder.name,
    trading_name: holder.trading,
    registration_type: text(r.registrationType) ?? text(r.regime),
    tier: text(r.tier),
    site_address: text(addr?.address) ?? r.site?.premises ?? null,
    postcode: text(addr?.postcode),
    easting: num(r.site?.location?.easting),
    northing: num(r.site?.location?.northing),
    distance_km: num(r.distance),
    registration_date: r.registrationDate ?? r.effectiveDate ?? null,
    expiry_date: r.expiryDate ?? null,
    local_authority: text(r.localAuthority),
    url: r["@id"] ?? null,
  };
}

export const definition = defineIntegration({
  id: "ea-public-registers",
  name: "EA public registers (permits and registrations)",
  group: "ground",
  access: "open",
  territory: "England",
  description: "Environment Agency public registers: environmental permits for waste operations, industrial installations, water discharges and radioactive substances, plus waste and flood-risk exemptions and the waste carrier, broker and dealer register. Used to screen what regulated activities sit near a site and to check a contractor's waste carrier registration.",
  docsUrl: "https://environment.data.gov.uk/public-register/view/api-reference",
  termsUrl: "https://environment.data.gov.uk/public-register/view/licence",
  attribution: "Contains Environment Agency public register data © Environment Agency and database right, used under the Environment Agency Conditional Licence. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. Data is provided under the Environment Agency Conditional Licence (attribution required; do not imply EA endorsement). Page size is capped at 100.",
    "Distance search needs OSGB36 easting/northing; latitude/longitude are converted here with a Helmert transform (about 5 m). postcodes.io also returns eastings/northings for a postcode.",
    "Scrap metal dealers and enforcement actions do not support distance search and are excluded; enforcement actions have their own endpoint.",
    "A permit near a site indicates a regulated activity nearby, not contamination. This is desktop screening, not a Phase 1 environmental assessment.",
    "Response field names follow the published OpenAPI schema (registrationNumber, holder.name, register.label, site.siteAddress.address, distance); not exercised live from this codebase.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "waste-carriers-brokers/registration.json", { _limit: 1 })),
  operations: [
    {
      id: "near-point",
      label: "Permits and registrations near a point",
      description: "Registered sites within a radius of the point, across all registers or one register. Give latitude/longitude or OSGB36 easting/northing.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: false, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: false, placeholder: "-0.142" },
        { name: "easting", label: "Easting (OSGB36)", type: "integer", required: false, placeholder: "529090", min: 0, max: 700000 },
        { name: "northing", label: "Northing (OSGB36)", type: "integer", required: false, placeholder: "179645", min: 0, max: 1300000 },
        { name: "dist", label: "Radius (km)", type: "number", default: 1, min: 0.1, max: 10 },
        { name: "register", label: "Register", type: "select", default: "all", options: REGISTERS },
      ],
      async run(params, ctx): Promise<OperationResult> {
        let easting = params.easting as number | undefined;
        let northing = params.northing as number | undefined;
        let converted = false;
        if ((easting === undefined || northing === undefined) && params.latitude !== undefined && params.longitude !== undefined) {
          ({ easting, northing } = wgs84ToOsgb36(params.latitude as number, params.longitude as number));
          converted = true;
        }
        if (easting === undefined || northing === undefined) throw new Error("give latitude and longitude, or easting and northing");
        const register = String(params.register ?? "all");
        const path = register === "all" ? "api/search.json" : `${register}/registration.json`;
        const url = buildUrl(BASE, path, { easting, northing, dist: params.dist as number, _limit: 100 });
        const { data } = await fetchJson<EaList<Registration>>(ctx, url, {}, { timeoutMs: 30_000 });
        const rows = (data.items ?? []).map(registrationRow).sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
        const byRegister = new Map<string, number>();
        for (const r of rows) byRegister.set(r.register ?? "unknown register", (byRegister.get(r.register ?? "unknown register") ?? 0) + 1);
        return {
          summary: rows.length ? `${rows.length} registrations within ${params.dist} km${rows.length === 100 ? " (capped at 100)" : ""}: ${Array.from(byRegister.entries()).map(([k, n]) => `${n} ${k}`).join("; ")}. Nearest: ${rows[0].holder ?? rows[0].registration_number} at ${rows[0].distance_km ?? "?"} km.` : `No public register entries within ${params.dist} km.`,
          columns: COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: register === "all" ? "public-register/search" : `public-register/${register}`, basis: rows.length ? "measured" : "unavailable" }),
          warnings: [
            "Nearby permits show regulated activity, not contamination or nuisance; check permit status and conditions on the register before drawing conclusions.",
            ...(converted ? [`Point converted to OSGB36 easting ${easting}, northing ${northing} (Helmert, about 5 m).`] : []),
          ],
        };
      },
    },
    {
      id: "waste-carrier",
      label: "Waste carrier, broker or dealer lookup by name",
      description: "Registrations on the waste carriers, brokers and dealers register whose holder name contains the search text.",
      params: [{ name: "name", label: "Company or holder name", type: "string", required: true, placeholder: "Biffa", help: "Substring match on the registered name." }],
      async run(params, ctx): Promise<OperationResult> {
        const name = String(params.name).trim();
        if (name.length < 3) throw new Error("enter at least 3 characters");
        const url = buildUrl(BASE, "waste-carriers-brokers/registration.json", { "name-search": name, _limit: 50 });
        const { data } = await fetchJson<EaList<Registration>>(ctx, url);
        const rows = (data.items ?? []).map(registrationRow);
        const upper = rows.filter((r) => /upper/i.test(`${r.tier ?? ""} ${r.registration_type ?? ""}`)).length;
        return {
          summary: rows.length ? `${rows.length} waste carrier/broker/dealer registrations matching "${name}"${rows.length === 50 ? " (capped at 50)" : ""}, ${upper} upper tier.` : `No waste carrier, broker or dealer registration matching "${name}".`,
          columns: COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "public-register/waste-carriers-brokers", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Check the expiry date and tier: upper tier is required to carry other people's waste as a business."],
        };
      },
    },
  ],
});
