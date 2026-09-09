import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";
import { sicDescription } from "./sic-codes";

/**
 * Companies House Public Data API.
 *
 * Built from the published REST reference
 * (https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference)
 * and open-source clients; no live call has been made from this codebase.
 * Auth is HTTP Basic with the API key as the username and an empty password.
 */

export const BASE = "https://api.company-information.service.gov.uk";

export function authHeader(env: EnvLike): string {
  const key = env.COMPANIES_HOUSE_API_KEY?.trim();
  if (!key) throw new Error("COMPANIES_HOUSE_API_KEY is not set. Create a REST API key at https://developer.company-information.service.gov.uk/");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

function headers(env: EnvLike): Record<string, string> {
  return { authorization: authHeader(env), accept: "application/json" };
}

/** Companies House numbers are 8 characters; numeric ones are zero-padded, prefixed ones (SC, NI, OC...) are not. */
export function normaliseCompanyNumber(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

interface Address {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  premises?: string;
}

function formatAddress(a?: Address | null): string {
  if (!a) return "";
  return [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country].filter(Boolean).join(", ");
}

interface SearchItem {
  title: string;
  company_number: string;
  company_status?: string;
  company_type?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  address_snippet?: string;
}

interface Profile {
  company_name: string;
  company_number: string;
  company_status?: string;
  company_status_detail?: string;
  type?: string;
  jurisdiction?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  registered_office_address?: Address;
  sic_codes?: string[];
  has_charges?: boolean;
  has_insolvency_history?: boolean;
  accounts?: { next_due?: string; overdue?: boolean; last_accounts?: { made_up_to?: string; type?: string; period_end_on?: string }; accounting_reference_date?: { day?: string; month?: string } };
  confirmation_statement?: { next_due?: string; last_made_up_to?: string; overdue?: boolean };
}

interface Officer {
  name: string;
  officer_role?: string;
  appointed_on?: string;
  resigned_on?: string;
  nationality?: string;
  country_of_residence?: string;
  occupation?: string;
  date_of_birth?: { month?: number; year?: number };
}

interface Psc {
  name?: string;
  kind?: string;
  notified_on?: string;
  ceased_on?: string;
  nationality?: string;
  country_of_residence?: string;
  natures_of_control?: string[];
  identification?: { registration_number?: string; legal_form?: string; country_registered?: string };
}

interface Filing {
  date?: string;
  type?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  description_values?: Record<string, string>;
  transaction_id?: string;
  paper_filed?: boolean;
}

interface Charge {
  charge_code?: string;
  charge_number?: number;
  status?: string;
  created_on?: string;
  delivered_on?: string;
  satisfied_on?: string;
  classification?: { description?: string; type?: string };
  persons_entitled?: { name: string }[];
  secured_details?: { description?: string; type?: string };
}

interface List<T> {
  items?: T[];
  total_results?: number;
  items_per_page?: number;
  start_index?: number;
  active_count?: number;
  resigned_count?: number;
  ceased_count?: number;
}

const COMPANY_NUMBER_PARAM = { name: "company_number", label: "Company number", type: "string" as const, required: true, placeholder: "00000006", help: "8 characters; numeric numbers are zero-padded automatically (e.g. 6 becomes 00000006)." };

const NOT_FOUND_STATUSES = [404];

async function getJson<T>(ctx: OperationContext, url: string) {
  return fetchJson<T>(ctx, url, { headers: headers(ctx.env) }, { acceptStatuses: NOT_FOUND_STATUSES, timeoutMs: 20_000 });
}

export const definition = defineIntegration({
  id: "companies-house",
  name: "Companies House",
  group: "company",
  access: "open_key",
  territory: "UK",
  description: "Official register of UK companies: profile, registered office, SIC codes, filing and accounts status, officers, persons with significant control, filing history and charges.",
  docsUrl: "https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference",
  termsUrl: "https://developer.company-information.service.gov.uk/terms-of-use",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Companies House.",
  licence: "OGL",
  envVars: [{ name: "COMPANIES_HOUSE_API_KEY", required: true, description: "REST API key from the Companies House developer hub, sent as the HTTP Basic username with an empty password." }],
  status: "built_unverified",
  notes: [
    "Rate limit: 600 requests per 5 minutes per key; the API returns HTTP 429 when exceeded.",
    "SIC descriptions come from the Companies House condensed SIC 2007 list bundled with the portal (OGL); codes outside the condensed list are shown without a description.",
    "Register data is what the company filed. It does not verify beneficial ownership beyond the PSC register, and dormant or recently incorporated companies may have no accounts yet.",
    "Officer and PSC lists are paginated to 100 per call; larger boards need repeated calls with start_index (not exposed here).",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "search/companies", { q: "test", items_per_page: 1 }), (env) => ({ headers: headers(env) })),
  operations: [
    {
      id: "search",
      label: "Search companies by name",
      description: "Free-text search across company names and numbers.",
      params: [
        { name: "q", label: "Search text", type: "string", required: true, placeholder: "Focus Green" },
        { name: "items_per_page", label: "Results", type: "integer", default: 20, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "search/companies", { q: String(params.q), items_per_page: params.items_per_page as number });
        const { data } = await getJson<List<SearchItem>>(ctx, url);
        const rows = (data.items ?? []).map((i) => ({
          company_name: i.title,
          company_number: i.company_number,
          status: i.company_status ?? null,
          type: i.company_type ?? null,
          incorporated: i.date_of_creation ?? null,
          ceased: i.date_of_cessation ?? null,
          address: i.address_snippet ?? null,
        }));
        return {
          summary: `${data.total_results ?? rows.length} companies match "${params.q}"; showing ${rows.length}.`,
          columns: ["company_name", "company_number", "status", "type", "incorporated", "ceased", "address"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "search/companies", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "profile",
      label: "Company profile",
      description: "Registered name, status, type, incorporation date, registered office, SIC codes and accounts / confirmation statement status.",
      params: [COMPANY_NUMBER_PARAM],
      async run(params, ctx) {
        const number = normaliseCompanyNumber(String(params.company_number));
        const { data, status } = await getJson<Profile>(ctx, buildUrl(BASE, `company/${encodeURIComponent(number)}`));
        if (status === 404 || !data?.company_number) {
          return { summary: `Company ${number} not found on the register.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "company", basis: "unavailable" }) };
        }
        const sic = (data.sic_codes ?? []).map((c) => ({ code: c, description: sicDescription(c) ?? null }));
        const row = {
          company_name: data.company_name,
          company_number: data.company_number,
          status: data.company_status ?? null,
          status_detail: data.company_status_detail ?? null,
          type: data.type ?? null,
          jurisdiction: data.jurisdiction ?? null,
          incorporated: data.date_of_creation ?? null,
          ceased: data.date_of_cessation ?? null,
          registered_office: formatAddress(data.registered_office_address),
          postcode: data.registered_office_address?.postal_code ?? null,
          sic_codes: sic.map((s) => (s.description ? `${s.code} ${s.description}` : s.code)).join("; "),
          last_accounts_made_up_to: data.accounts?.last_accounts?.made_up_to ?? null,
          last_accounts_type: data.accounts?.last_accounts?.type ?? null,
          accounts_next_due: data.accounts?.next_due ?? null,
          accounts_overdue: data.accounts?.overdue ?? null,
          confirmation_statement_next_due: data.confirmation_statement?.next_due ?? null,
          confirmation_statement_overdue: data.confirmation_statement?.overdue ?? null,
          has_charges: data.has_charges ?? null,
          has_insolvency_history: data.has_insolvency_history ?? null,
        };
        const warnings: string[] = [];
        const unknownSic = sic.filter((s) => !s.description).map((s) => s.code);
        if (unknownSic.length) warnings.push(`No description in the condensed SIC 2007 list for: ${unknownSic.join(", ")}.`);
        if (data.accounts?.overdue || data.confirmation_statement?.overdue) warnings.push("Accounts or confirmation statement are recorded as overdue.");
        return {
          summary: `${data.company_name} (${data.company_number}) is ${data.company_status ?? "of unknown status"}, a ${data.type ?? "company"} incorporated ${data.date_of_creation ?? "on an unknown date"}. ${sic.length} SIC code(s).`,
          columns: Object.keys(row),
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "company", basis: "measured" }),
          warnings,
        };
      },
    },
    {
      id: "officers",
      label: "Officers",
      description: "Current and resigned directors and secretaries.",
      params: [COMPANY_NUMBER_PARAM, { name: "items_per_page", label: "Results", type: "integer", default: 50, min: 1, max: 100 }],
      async run(params, ctx) {
        const number = normaliseCompanyNumber(String(params.company_number));
        const { data, status } = await getJson<List<Officer>>(ctx, buildUrl(BASE, `company/${encodeURIComponent(number)}/officers`, { items_per_page: params.items_per_page as number }));
        if (status === 404) return { summary: `Company ${number} not found.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "officers", basis: "unavailable" }) };
        const rows = (data.items ?? []).map((o) => ({
          name: o.name,
          role: o.officer_role ?? null,
          appointed: o.appointed_on ?? null,
          resigned: o.resigned_on ?? null,
          nationality: o.nationality ?? null,
          country_of_residence: o.country_of_residence ?? null,
          occupation: o.occupation ?? null,
          born: o.date_of_birth?.year ? `${o.date_of_birth.year}-${String(o.date_of_birth.month ?? "").padStart(2, "0")}` : null,
        }));
        return {
          summary: `${data.active_count ?? rows.filter((r) => !r.resigned).length} active officers, ${data.resigned_count ?? rows.filter((r) => r.resigned).length} resigned (${data.total_results ?? rows.length} on record).`,
          columns: ["name", "role", "appointed", "resigned", "nationality", "country_of_residence", "occupation", "born"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "officers", basis: "measured" }),
        };
      },
    },
    {
      id: "pscs",
      label: "Persons with significant control",
      description: "Beneficial owners and controlling entities on the PSC register, with natures of control.",
      params: [COMPANY_NUMBER_PARAM],
      async run(params, ctx) {
        const number = normaliseCompanyNumber(String(params.company_number));
        const { data, status } = await getJson<List<Psc>>(ctx, buildUrl(BASE, `company/${encodeURIComponent(number)}/persons-with-significant-control`, { items_per_page: 100 }));
        if (status === 404) return { summary: `No PSC register entries for ${number} (or company not found).`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "persons-with-significant-control", basis: "unavailable" }) };
        const rows = (data.items ?? []).map((p) => ({
          name: p.name ?? null,
          kind: p.kind ?? null,
          notified: p.notified_on ?? null,
          ceased: p.ceased_on ?? null,
          nationality: p.nationality ?? null,
          country_of_residence: p.country_of_residence ?? null,
          registration_number: p.identification?.registration_number ?? null,
          legal_form: p.identification?.legal_form ?? null,
          natures_of_control: (p.natures_of_control ?? []).join("; "),
        }));
        return {
          summary: `${rows.filter((r) => !r.ceased).length} active PSC entries (${data.ceased_count ?? rows.filter((r) => r.ceased).length} ceased).`,
          columns: ["name", "kind", "notified", "ceased", "nationality", "country_of_residence", "registration_number", "legal_form", "natures_of_control"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "persons-with-significant-control", basis: "measured" }),
          warnings: ["The PSC register is self-declared by the company; it is not an independently verified beneficial ownership record."],
        };
      },
    },
    {
      id: "filing_history",
      label: "Filing history",
      description: "Most recent filings (accounts, confirmation statements, officer changes, charges).",
      params: [COMPANY_NUMBER_PARAM, { name: "items_per_page", label: "Results", type: "integer", default: 25, min: 1, max: 100 }],
      async run(params, ctx) {
        const number = normaliseCompanyNumber(String(params.company_number));
        const { data, status } = await getJson<List<Filing>>(ctx, buildUrl(BASE, `company/${encodeURIComponent(number)}/filing-history`, { items_per_page: params.items_per_page as number }));
        if (status === 404) return { summary: `Company ${number} not found.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "filing-history", basis: "unavailable" }) };
        const rows = (data.items ?? []).map((f) => ({
          date: f.date ?? null,
          category: f.category ?? null,
          type: f.type ?? null,
          description: f.description ?? null,
          made_up_date: f.description_values?.made_up_date ?? null,
          transaction_id: f.transaction_id ?? null,
        }));
        return {
          summary: `${data.total_results ?? rows.length} filings on record; showing ${rows.length}, latest ${rows[0]?.date ?? "n/a"}.`,
          columns: ["date", "category", "type", "description", "made_up_date", "transaction_id"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "filing-history", basis: "measured" }),
        };
      },
    },
    {
      id: "charges",
      label: "Charges (secured debt)",
      description: "Registered mortgages and charges with status and persons entitled.",
      params: [COMPANY_NUMBER_PARAM],
      async run(params, ctx) {
        const number = normaliseCompanyNumber(String(params.company_number));
        const { data, status } = await getJson<List<Charge> & { satisfied_count?: number; part_satisfied_count?: number; total_count?: number }>(ctx, buildUrl(BASE, `company/${encodeURIComponent(number)}/charges`));
        if (status === 404) return { summary: `No charges registered for ${number} (or company not found).`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "charges", basis: "unavailable" }) };
        const rows = (data.items ?? []).map((c) => ({
          charge_code: c.charge_code ?? c.charge_number ?? null,
          status: c.status ?? null,
          created: c.created_on ?? null,
          delivered: c.delivered_on ?? null,
          satisfied: c.satisfied_on ?? null,
          classification: c.classification?.description ?? null,
          persons_entitled: (c.persons_entitled ?? []).map((p) => p.name).join("; "),
        }));
        return {
          summary: `${data.total_count ?? rows.length} charges registered, ${rows.filter((r) => r.status === "outstanding").length} outstanding.`,
          columns: ["charge_code", "status", "created", "delivered", "satisfied", "classification", "persons_entitled"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "charges", basis: "measured" }),
        };
      },
    },
  ],
});
