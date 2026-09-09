import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";

/**
 * Charity Commission for England and Wales, Register of Charities API
 * (Azure API Management; key in the Ocp-Apim-Subscription-Key header).
 *
 * Built from the developer hub's operation list as mirrored by open-source
 * clients (drkane/charity-account-fetch, cabinetoffice/GCGS): route names
 * are confirmed there, but response field names are taken from the API
 * data definition and have not been checked against a live call, so the
 * mapping below reads fields case-insensitively and keeps the raw payload.
 */

export const BASE = "https://api.charitycommission.gov.uk/register/api";

function headers(env: EnvLike): Record<string, string> {
  const key = env.CHARITY_COMMISSION_API_KEY?.trim();
  if (!key) throw new Error("CHARITY_COMMISSION_API_KEY is not set. Register at https://api-portal.charitycommission.gov.uk/ and subscribe to the Register of Charities product.");
  return { "Ocp-Apim-Subscription-Key": key, accept: "application/json" };
}

type Obj = Record<string, unknown>;

/** Case-insensitive field read; the API's casing is not confirmed. */
export function field(o: Obj | undefined, ...names: string[]): unknown {
  if (!o) return null;
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase().replace(/_/g, ""), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase().replace(/_/g, ""));
    if (k !== undefined && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function regParams(params: Record<string, unknown>) {
  const regno = String(params.registered_number).replace(/\D/g, "");
  const suffix = Number(params.suffix ?? 0);
  if (!regno) throw new Error("Registered charity number is required");
  return { regno, suffix };
}

const REG_PARAMS = [
  { name: "registered_number", label: "Registered charity number", type: "string" as const, required: true, placeholder: "1234567" },
  { name: "suffix", label: "Group / subsidiary suffix", type: "integer" as const, default: 0, min: 0, max: 999, help: "0 for the main charity; linked charities have their own suffix." },
];

async function get<T>(ctx: OperationContext, url: string) {
  return fetchJson<T>(ctx, url, { headers: headers(ctx.env) }, { acceptStatuses: [404], timeoutMs: 20_000 });
}

export const definition = defineIntegration({
  id: "charity-commission",
  name: "Charity Commission register",
  group: "company",
  access: "open_key",
  territory: "England and Wales",
  description: "Register of Charities: search by name, full charity details (status, objects, income and expenditure, trustees count, contact) and financial history by year.",
  docsUrl: "https://api-portal.charitycommission.gov.uk/",
  termsUrl: "https://register-of-charities.charitycommission.gov.uk/en/documentation-on-the-api",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Charity Commission for England and Wales, Register of Charities.",
  licence: "OGL",
  envVars: [{ name: "CHARITY_COMMISSION_API_KEY", required: true, description: "Subscription key from the Charity Commission developer hub, sent as Ocp-Apim-Subscription-Key." }],
  status: "built_unverified",
  notes: [
    "Routes confirmed from open-source clients: /searchCharityName/{name}, /allcharitydetails/{regno}/{suffix}, /charityoverview/{regno}/{suffix}, /charityfinancialhistory/{regno}/{suffix}. Response field names follow the published API data definition (v1.1) but have not been checked live; the raw payload is always returned.",
    "Covers England and Wales only. Scottish charities are on the OSCR register and Northern Irish charities on the CCNI register.",
    "Income and expenditure are as reported in the charity's annual return; charities under GBP 25k income file less detail and small charities may be exempt or excepted from registration.",
  ],
  healthCheck: simpleHealth(`${BASE}/sectoroverview`, (env) => ({ headers: headers(env) })),
  operations: [
    {
      id: "search",
      label: "Search charities by name",
      description: "Charities whose name contains the search text.",
      params: [{ name: "name", label: "Charity name", type: "string", required: true, placeholder: "Example Foundation" }],
      async run(params, ctx) {
        const url = `${BASE}/searchCharityName/${encodeURIComponent(String(params.name))}`;
        const { data, status } = await get<Obj[] | Obj>(ctx, url);
        const items: Obj[] = Array.isArray(data) ? data : status === 404 ? [] : ((field(data as Obj, "results", "items", "value") as Obj[] | null) ?? []);
        const rows = items.slice(0, 100).map((c) => ({
          registered_number: field(c, "reg_charity_number", "registered_charity_number", "charity_number"),
          suffix: field(c, "group_subsid_suffix", "suffix") ?? 0,
          name: field(c, "charity_name", "name"),
          status: field(c, "reg_status", "charity_registration_status", "status"),
          registered: field(c, "date_of_registration", "registration_date"),
          removed: field(c, "date_of_removal"),
          organisation_number: field(c, "organisation_number"),
        }));
        return {
          summary: `${rows.length} charit${rows.length === 1 ? "y" : "ies"} match "${params.name}".`,
          columns: ["registered_number", "suffix", "name", "status", "registered", "removed", "organisation_number"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "searchCharityName", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "details",
      label: "Charity details",
      description: "Status, registration, objects, latest income and expenditure, contact and governance for one charity.",
      params: REG_PARAMS,
      async run(params, ctx) {
        const { regno, suffix } = regParams(params);
        const { data, status } = await get<Obj>(ctx, buildUrl(BASE, `allcharitydetails/${regno}/${suffix}`));
        if (status === 404 || !data || (Array.isArray(data) && data.length === 0)) {
          return { summary: `No charity ${regno}/${suffix} on the register.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "allcharitydetails", basis: "unavailable" }) };
        }
        const c = (Array.isArray(data) ? data[0] : data) as Obj;
        const trustees = field(c, "trustee_names", "trustees");
        const row = {
          registered_number: field(c, "reg_charity_number", "registered_charity_number") ?? regno,
          name: field(c, "charity_name"),
          status: field(c, "reg_status", "charity_registration_status"),
          type: field(c, "charity_type"),
          registered: field(c, "date_of_registration"),
          removed: field(c, "date_of_removal"),
          reporting_status: field(c, "charity_reporting_status"),
          latest_period_end: field(c, "latest_acc_fin_period_end_date", "latest_fin_period_end_date"),
          latest_income_gbp: num(field(c, "latest_income")),
          latest_expenditure_gbp: num(field(c, "latest_expenditure")),
          company_number: field(c, "charity_company_registration_number", "company_number"),
          trustees: Array.isArray(trustees) ? trustees.length : num(trustees),
          web: field(c, "charity_contact_web", "web"),
          email: field(c, "charity_contact_email", "email"),
          postcode: field(c, "charity_contact_postcode", "postcode"),
          objects: typeof field(c, "charitable_objects", "objects") === "string" ? String(field(c, "charitable_objects", "objects")).slice(0, 500) : null,
        };
        return {
          summary: `${row.name ?? regno} is ${row.status ?? "of unknown status"} (registered ${row.registered ?? "n/a"}). Latest income GBP ${row.latest_income_gbp?.toLocaleString("en-GB") ?? "n/a"}, expenditure GBP ${row.latest_expenditure_gbp?.toLocaleString("en-GB") ?? "n/a"}.`,
          columns: Object.keys(row),
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "allcharitydetails", basis: "measured" }),
        };
      },
    },
    {
      id: "financial_history",
      label: "Financial history",
      description: "Income and expenditure by financial year as returned to the Commission.",
      params: REG_PARAMS,
      async run(params, ctx) {
        const { regno, suffix } = regParams(params);
        const { data, status } = await get<Obj[] | Obj>(ctx, buildUrl(BASE, `charityfinancialhistory/${regno}/${suffix}`));
        const items: Obj[] = Array.isArray(data) ? data : status === 404 ? [] : ((field(data as Obj, "financial_history", "items", "value") as Obj[] | null) ?? []);
        const rows = items
          .map((y) => ({
            period_end: field(y, "financial_period_end_date", "fin_period_end_date", "period_end"),
            income_gbp: num(field(y, "income", "total_gross_income")),
            expenditure_gbp: num(field(y, "expenditure", "total_gross_expenditure")),
            accounts_received: field(y, "accounts_received_date", "ar_received_date"),
            reporting_status: field(y, "reporting_status", "ar_status"),
          }))
          .sort((a, b) => String(b.period_end ?? "").localeCompare(String(a.period_end ?? "")));
        const latest = rows[0];
        return {
          summary: latest
            ? `${rows.length} financial year(s); latest period ending ${latest.period_end}: income GBP ${latest.income_gbp?.toLocaleString("en-GB") ?? "n/a"}, expenditure GBP ${latest.expenditure_gbp?.toLocaleString("en-GB") ?? "n/a"}.`
            : `No financial history for charity ${regno}/${suffix}.`,
          columns: ["period_end", "income_gbp", "expenditure_gbp", "accounts_received", "reporting_status"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "charityfinancialhistory", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
  ],
});
