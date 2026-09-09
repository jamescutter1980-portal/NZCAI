import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext, type ParamSpec } from "../framework";
import { addDays, assertRange } from "../_shared/dates";

/**
 * Xero Accounting API: purchase invoices (bills, Type ACCPAY) for spend-based
 * Scope 3 category 1 screening.
 *
 * Built from the Xero Accounting API reference (Invoices, Contacts, Accounts,
 * Organisation): Bearer token plus xero-tenant-id header, `where` filter with
 * Type=="ACCPAY" and Date>=DateTime(yyyy,mm,dd), `page` of 100 invoices, JSON
 * dates as "/Date(ms+0000)/" with a DateString companion, and the LineItems
 * array with AccountCode, LineAmount, TaxAmount. SubTotal is exclusive of tax.
 * The OAuth 2.0 authorisation-code flow that produces the access token is out
 * of scope here (see notes). Not exercised live from this codebase.
 */

export const DEFAULT_BASE = "https://api.xero.com/api.xro/2.0";
const PAGE_SIZE = 100;

export function apiBase(env: EnvLike): string {
  return (env.XERO_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

export function headers(env: EnvLike): Record<string, string> {
  const token = env.XERO_ACCESS_TOKEN?.trim();
  const tenant = env.XERO_TENANT_ID?.trim();
  if (!token) throw new Error("XERO_ACCESS_TOKEN is not set");
  if (!tenant) throw new Error("XERO_TENANT_ID is not set");
  return { authorization: `Bearer ${token}`, "xero-tenant-id": tenant, accept: "application/json" };
}

export interface XeroLineItem {
  LineItemID?: string;
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  AccountCode?: string;
  AccountID?: string;
  ItemCode?: string;
  TaxType?: string;
  TaxAmount?: number;
  LineAmount?: number;
  Tracking?: { Name?: string; Option?: string }[];
}

export interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  Date?: string;
  DateString?: string;
  DueDate?: string;
  LineAmountTypes?: string;
  LineItems?: XeroLineItem[];
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  CurrencyCode?: string;
  CurrencyRate?: number;
  Reference?: string;
  UpdatedDateUTC?: string;
}

interface InvoicesResponse {
  Invoices?: XeroInvoice[];
  pagination?: { page?: number; pageSize?: number; pageCount?: number; itemCount?: number };
}

interface ContactsResponse {
  Contacts?: { ContactID: string; Name?: string; ContactStatus?: string; TaxNumber?: string; EmailAddress?: string; CompanyNumber?: string; IsSupplier?: boolean; DefaultCurrency?: string; Addresses?: { AddressType?: string; AddressLine1?: string; City?: string; PostalCode?: string; Country?: string }[]; Website?: string }[];
}

interface AccountsResponse {
  Accounts?: { AccountID?: string; Code?: string; Name?: string; Type?: string; Class?: string; TaxType?: string; Status?: string }[];
}

/** Xero JSON dates: "/Date(1518685950940+0000)/" or DateString "2018-02-15T00:00:00". */
export function xeroDate(invoice: { Date?: string; DateString?: string }): string | null {
  if (invoice.DateString && /^\d{4}-\d{2}-\d{2}/.test(invoice.DateString)) return invoice.DateString.slice(0, 10);
  const m = invoice.Date ? /\/Date\((-?\d+)/.exec(invoice.Date) : null;
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return invoice.Date && /^\d{4}-\d{2}-\d{2}/.test(invoice.Date) ? invoice.Date.slice(0, 10) : null;
}

function dateTimeLiteral(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
}

/** Xero `where` for purchase invoices in [from, to] inclusive. */
export function whereClause(from: string, to: string): string {
  return `Type=="ACCPAY" AND Date>=${dateTimeLiteral(from)} AND Date<${dateTimeLiteral(addDays(to, 1))}`;
}

export interface FetchInvoicesOptions {
  from: string;
  to: string;
  statuses?: string;
  modifiedSince?: string;
  maxPages?: number;
}

export async function fetchInvoices(ctx: OperationContext, opts: FetchInvoicesOptions): Promise<{ invoices: XeroInvoice[]; pages: number; truncated: boolean }> {
  const h = headers(ctx.env);
  if (opts.modifiedSince) h["if-modified-since"] = opts.modifiedSince;
  const invoices: XeroInvoice[] = [];
  const maxPages = opts.maxPages ?? 10;
  let page = 1;
  let truncated = false;
  for (;;) {
    const url = buildUrl(apiBase(ctx.env), "Invoices", { where: whereClause(opts.from, opts.to), Statuses: opts.statuses && opts.statuses !== "all" ? opts.statuses : undefined, page, pageSize: PAGE_SIZE, order: "Date ASC" });
    const { data } = await fetchJson<InvoicesResponse>(ctx, url, { headers: h }, { timeoutMs: 30_000 });
    const batch = data?.Invoices ?? [];
    invoices.push(...batch);
    const pageCount = data?.pagination?.pageCount;
    if (batch.length < PAGE_SIZE || (pageCount !== undefined && page >= pageCount)) break;
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { invoices, pages: page, truncated };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function invoiceLineRows(invoices: XeroInvoice[]) {
  return invoices.flatMap((inv) => {
    const lines = inv.LineItems?.length ? inv.LineItems : [{} as XeroLineItem];
    return lines.map((li) => ({
      date: xeroDate(inv),
      contact: inv.Contact?.Name ?? null,
      contact_id: inv.Contact?.ContactID ?? null,
      invoice_number: inv.InvoiceNumber ?? null,
      invoice_id: inv.InvoiceID,
      status: inv.Status ?? null,
      account_code: li.AccountCode ?? null,
      description: li.Description ?? null,
      quantity: li.Quantity ?? null,
      line_amount_ex_tax: li.LineAmount !== undefined ? round2(li.LineAmount) : null,
      line_tax: li.TaxAmount !== undefined ? round2(li.TaxAmount) : null,
      tracking: li.Tracking?.length ? li.Tracking.map((t) => `${t.Name ?? ""}: ${t.Option ?? ""}`).join("; ") : null,
      invoice_subtotal_ex_tax: inv.SubTotal !== undefined ? round2(inv.SubTotal) : null,
      invoice_total_inc_tax: inv.Total !== undefined ? round2(inv.Total) : null,
      currency: inv.CurrencyCode ?? null,
    }));
  });
}

const RANGE_PARAMS: ParamSpec[] = [
  { name: "from", label: "From", type: "date", required: true, placeholder: "2025-04-01" },
  { name: "to", label: "To (inclusive)", type: "date", required: true, placeholder: "2026-03-31" },
  { name: "statuses", label: "Invoice statuses", type: "select", default: "AUTHORISED,PAID", options: [{ value: "AUTHORISED,PAID", label: "Approved and paid bills (excludes drafts, voided, deleted)" }, { value: "PAID", label: "Paid only" }, { value: "all", label: "All statuses" }] },
  { name: "max_pages", label: "Max pages (100 bills each)", type: "integer", default: 10, min: 1, max: 50 },
];

const SCOPE3_WARNING = "Spend is ex-VAT accounting data, not emissions: Scope 3 category 1 screening needs each supplier classified (SIC/NACE or account-based sector) and a spend-based factor (EXIOBASE or Climatiq procurement, GBP for the spend year). This connector does not classify. Credit notes and overpayments are not netted off.";

export const definition = defineIntegration({
  id: "xero-spend",
  name: "Xero purchase invoices (spend-based Scope 3)",
  group: "carbon",
  access: "authorised",
  territory: "Global",
  description: "Client-authorised read of purchase invoices (bills) from a Xero organisation, listed by line item and aggregated by supplier and by account code (ex-VAT), as the input to spend-based Scope 3 category 1 screening.",
  docsUrl: "https://developer.xero.com/documentation/api/accounting/invoices",
  termsUrl: "https://developer.xero.com/xero-developer-platform-terms-conditions/",
  attribution: "Financial data from the client's Xero organisation, retrieved under the client's OAuth 2.0 consent.",
  licence: "consent_based",
  envVars: [
    { name: "XERO_ACCESS_TOKEN", required: true, description: "OAuth 2.0 access token (Bearer) for the connected organisation, obtained by the portal's authorisation-code flow with scopes accounting.transactions.read, accounting.contacts.read, accounting.settings.read; expires after 30 minutes, refresh with offline_access." },
    { name: "XERO_TENANT_ID", required: true, description: "Tenant (organisation) id from GET https://api.xero.com/connections, sent as the xero-tenant-id header." },
    { name: "XERO_API_BASE", required: false, description: `Override the Accounting API base (default ${DEFAULT_BASE}).` },
  ],
  status: "built_unverified",
  notes: [
    "OAuth is out of scope here: the portal's Xero app must run the authorization-code flow with PKCE (scopes accounting.transactions.read, accounting.contacts.read, accounting.settings.read, offline_access) and store the refresh token (60-day rolling expiry) per tenant; this connector consumes the resulting access token and tenant id from the environment. Uncertified apps are limited to 25 connected tenants.",
    "Endpoints: GET /Invoices?where=Type==\"ACCPAY\" AND Date>=DateTime(y,m,d) AND Date<DateTime(y,m,d)&page=N (100 per page, Statuses filter, If-Modified-Since supported), GET /Contacts/{id}, GET /Accounts, GET /Organisation (health). Shapes follow the Xero Accounting API reference; not called live from this environment.",
    "Rate limits: 60 calls per minute and 5,000 per day per tenant (plus a 10,000 per minute app limit). A year of bills for a small company is a handful of pages; use max_pages and the modified_since parameter for incremental pulls.",
    "Amounts: SubTotal and LineAmount are exclusive of tax whatever the invoice's LineAmountTypes, so aggregations exclude VAT as spend-based methods require; Total includes tax and is shown for reconciliation. Multi-currency bills are reported in their own currency (CurrencyCode); convert to the base currency before applying factors.",
    "Scope 3 category 1 screening: classify each supplier by SIC/NACE (Companies House match on name or company number from the contact) or by account code, apply a spend-based factor (EXIOBASE or Climatiq procurement for the spend year and currency) and record basis 'estimated'. Spend-based results are for hotspot identification and should be replaced by supplier-specific or activity data for material suppliers. Capital items (account class Asset) belong to category 2, not 1.",
    "Consent: store the consent reference (tenant id, scopes, granted-at, refresh expiry) with every imported value and purge or freeze when the connection is removed.",
  ],
  healthCheck: async (ctx): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const { data } = await fetchJson<{ Organisations?: { Name?: string }[] }>(ctx, buildUrl(apiBase(ctx.env), "Organisation"), { headers: headers(ctx.env) }, { timeoutMs: 15_000 });
      const name = data?.Organisations?.[0]?.Name;
      return { ok: Boolean(name), detail: name ? `Connected to ${name}` : "No organisation returned", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "purchase_invoices",
      label: "Purchase invoices (bills) in a date range",
      description: "One row per bill line item with date, supplier, invoice number, account code, description and ex-VAT amounts.",
      params: [...RANGE_PARAMS, { name: "modified_since", label: "Modified since (optional)", type: "datetime", placeholder: "2026-01-01T00:00:00", help: "Sent as If-Modified-Since for incremental pulls." }],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Invoice range");
        const { invoices, pages, truncated } = await fetchInvoices(ctx, { from, to, statuses: String(params.statuses ?? "AUTHORISED,PAID"), modifiedSince: params.modified_since ? String(params.modified_since) : undefined, maxPages: Number(params.max_pages ?? 10) });
        const rows = invoiceLineRows(invoices);
        const columns = ["date", "contact", "contact_id", "invoice_number", "invoice_id", "status", "account_code", "description", "quantity", "line_amount_ex_tax", "line_tax", "tracking", "invoice_subtotal_ex_tax", "invoice_total_inc_tax", "currency"];
        if (!invoices.length) return { summary: `No purchase invoices between ${from} and ${to} for the selected statuses.`, columns, rows: [], raw: { pages, invoices }, provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY)", basis: "unavailable" }) };
        const byCurrency = new Map<string, number>();
        for (const inv of invoices) byCurrency.set(inv.CurrencyCode ?? "?", (byCurrency.get(inv.CurrencyCode ?? "?") ?? 0) + (inv.SubTotal ?? 0));
        const totals = [...byCurrency.entries()].map(([c, v]) => `${round2(v).toLocaleString("en-GB")} ${c}`).join(", ");
        const suppliers = new Set(invoices.map((i) => i.Contact?.ContactID ?? i.Contact?.Name)).size;
        return {
          summary: `${invoices.length} purchase invoice(s) from ${suppliers} supplier(s) between ${from} and ${to}: ${totals} ex-VAT across ${rows.length} line item(s)${truncated ? ` (stopped after ${pages} pages; raise max_pages)` : ""}.`,
          columns,
          rows,
          raw: { pages, truncated, invoices: invoices.slice(0, 500) },
          provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY)", basis: "measured" }),
          warnings: [SCOPE3_WARNING, ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
    {
      id: "spend_by_supplier",
      label: "Spend by supplier in a date range",
      description: "Ex-VAT purchase spend aggregated per supplier contact and currency, largest first: the list to classify for Scope 3 category 1.",
      params: [...RANGE_PARAMS],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Invoice range");
        const { invoices, pages, truncated } = await fetchInvoices(ctx, { from, to, statuses: String(params.statuses ?? "AUTHORISED,PAID"), maxPages: Number(params.max_pages ?? 10) });
        const agg = new Map<string, { contact: string | null; contact_id: string | null; currency: string | null; invoices: number; spend_ex_tax: number; total_inc_tax: number; account_codes: Set<string> }>();
        for (const inv of invoices) {
          const key = `${inv.Contact?.ContactID ?? inv.Contact?.Name ?? "?"}|${inv.CurrencyCode ?? "?"}`;
          const a = agg.get(key) ?? { contact: inv.Contact?.Name ?? null, contact_id: inv.Contact?.ContactID ?? null, currency: inv.CurrencyCode ?? null, invoices: 0, spend_ex_tax: 0, total_inc_tax: 0, account_codes: new Set<string>() };
          a.invoices += 1;
          a.spend_ex_tax += inv.SubTotal ?? 0;
          a.total_inc_tax += inv.Total ?? 0;
          for (const li of inv.LineItems ?? []) if (li.AccountCode) a.account_codes.add(li.AccountCode);
          agg.set(key, a);
        }
        const rows = [...agg.values()]
          .map((a) => ({ contact: a.contact, contact_id: a.contact_id, currency: a.currency, invoices: a.invoices, spend_ex_tax: round2(a.spend_ex_tax), total_inc_tax: round2(a.total_inc_tax), account_codes: [...a.account_codes].sort().join(", ") || null, share_pct: 0 }))
          .sort((x, y) => y.spend_ex_tax - x.spend_ex_tax);
        const grand = rows.reduce((s, r) => s + r.spend_ex_tax, 0);
        for (const r of rows) r.share_pct = grand ? Math.round((r.spend_ex_tax / grand) * 1000) / 10 : 0;
        const columns = ["contact", "contact_id", "currency", "invoices", "spend_ex_tax", "total_inc_tax", "account_codes", "share_pct"];
        if (!rows.length) return { summary: `No purchase invoices between ${from} and ${to}.`, columns, rows: [], raw: { pages }, provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY) by supplier", basis: "unavailable" }) };
        const top = rows.slice(0, 3).map((r) => `${r.contact ?? "unnamed"} ${r.spend_ex_tax.toLocaleString("en-GB")} ${r.currency ?? ""} (${r.share_pct}%)`).join("; ");
        const eighty = rows.reduce<{ n: number; acc: number }>((s, r) => (s.acc < 80 ? { n: s.n + 1, acc: s.acc + r.share_pct } : s), { n: 0, acc: 0 }).n;
        return {
          summary: `${rows.length} supplier(s) with ${round2(grand).toLocaleString("en-GB")} ex-VAT spend between ${from} and ${to}; ${eighty} supplier(s) make up 80% of spend. Largest: ${top}.`,
          columns,
          rows,
          raw: { pages, truncated, invoiceCount: invoices.length },
          provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY) by supplier", basis: "measured" }),
          warnings: [SCOPE3_WARNING, "Share is within the currencies mixed together only when all bills are in one currency; check the currency column.", ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
    {
      id: "spend_by_account",
      label: "Spend by account code in a date range",
      description: "Ex-VAT purchase line amounts aggregated per chart-of-accounts code, with the account name and type from the chart of accounts where readable.",
      params: [...RANGE_PARAMS],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Invoice range");
        const { invoices, pages, truncated } = await fetchInvoices(ctx, { from, to, statuses: String(params.statuses ?? "AUTHORISED,PAID"), maxPages: Number(params.max_pages ?? 10) });
        const warnings: string[] = [SCOPE3_WARNING];
        let accounts = new Map<string, { name?: string; type?: string; class?: string }>();
        try {
          const { data } = await fetchJson<AccountsResponse>(ctx, buildUrl(apiBase(ctx.env), "Accounts"), { headers: headers(ctx.env) }, { timeoutMs: 20_000 });
          accounts = new Map((data?.Accounts ?? []).filter((a) => a.Code).map((a) => [String(a.Code), { name: a.Name, type: a.Type, class: a.Class }]));
        } catch (e) {
          warnings.push(`Chart of accounts could not be read (${e instanceof Error ? e.message : String(e)}); account names are blank.`);
        }
        const agg = new Map<string, { account_code: string | null; currency: string | null; lines: number; invoices: Set<string>; spend_ex_tax: number }>();
        for (const inv of invoices) {
          for (const li of inv.LineItems ?? []) {
            const key = `${li.AccountCode ?? "?"}|${inv.CurrencyCode ?? "?"}`;
            const a = agg.get(key) ?? { account_code: li.AccountCode ?? null, currency: inv.CurrencyCode ?? null, lines: 0, invoices: new Set<string>(), spend_ex_tax: 0 };
            a.lines += 1;
            a.invoices.add(inv.InvoiceID);
            a.spend_ex_tax += li.LineAmount ?? 0;
            agg.set(key, a);
          }
        }
        const rows = [...agg.values()]
          .map((a) => {
            const acc = a.account_code ? accounts.get(a.account_code) : undefined;
            return { account_code: a.account_code, account_name: acc?.name ?? null, account_type: acc?.type ?? null, account_class: acc?.class ?? null, currency: a.currency, invoices: a.invoices.size, lines: a.lines, spend_ex_tax: round2(a.spend_ex_tax) };
          })
          .sort((x, y) => y.spend_ex_tax - x.spend_ex_tax);
        const columns = ["account_code", "account_name", "account_type", "account_class", "currency", "invoices", "lines", "spend_ex_tax"];
        if (!rows.length) return { summary: `No purchase invoice lines between ${from} and ${to}.`, columns, rows: [], raw: { pages }, provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY) by account", basis: "unavailable" }) };
        const grand = round2(rows.reduce((s, r) => s + r.spend_ex_tax, 0));
        const capital = rows.filter((r) => r.account_class === "ASSET").reduce((s, r) => s + r.spend_ex_tax, 0);
        return {
          summary: `${rows.length} account code(s) with ${grand.toLocaleString("en-GB")} ex-VAT purchase spend between ${from} and ${to}. Largest: ${rows.slice(0, 3).map((r) => `${r.account_code ?? "?"} ${r.account_name ?? ""} ${r.spend_ex_tax.toLocaleString("en-GB")}`).join("; ")}.${capital ? ` ${round2(capital).toLocaleString("en-GB")} is coded to asset accounts (Scope 3 category 2, capital goods).` : ""}`,
          columns,
          rows,
          raw: { pages, truncated, invoiceCount: invoices.length },
          provenance: makeProvenance(definition, ctx, { dataset: "Invoices (ACCPAY) by account", basis: "measured" }),
          warnings: [...warnings, ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
    {
      id: "contact",
      label: "Supplier contact details",
      description: "Name, tax number, company number and address for one contact, for SIC/NACE matching.",
      params: [{ name: "contact_id", label: "Contact ID", type: "string", required: true, placeholder: "bd2270c3-8706-4c11-9cfb-000b551c3f51" }],
      async run(params, ctx) {
        const id = String(params.contact_id);
        const { data } = await fetchJson<ContactsResponse>(ctx, buildUrl(apiBase(ctx.env), `Contacts/${encodeURIComponent(id)}`), { headers: headers(ctx.env) }, { timeoutMs: 15_000 });
        const c = data?.Contacts?.[0];
        const columns = ["contact_id", "name", "status", "is_supplier", "tax_number", "company_number", "email", "website", "address", "postcode", "country", "currency"];
        if (!c) return { summary: `Contact ${id} not found.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "Contacts", basis: "unavailable" }) };
        const addr = c.Addresses?.find((a) => a.AddressType === "POBOX" || a.AddressType === "STREET") ?? c.Addresses?.[0];
        const row = { contact_id: c.ContactID, name: c.Name ?? null, status: c.ContactStatus ?? null, is_supplier: c.IsSupplier ?? null, tax_number: c.TaxNumber ?? null, company_number: c.CompanyNumber ?? null, email: c.EmailAddress ?? null, website: c.Website ?? null, address: [addr?.AddressLine1, addr?.City].filter(Boolean).join(", ") || null, postcode: addr?.PostalCode ?? null, country: addr?.Country ?? null, currency: c.DefaultCurrency ?? null };
        return {
          summary: `${row.name ?? id}${row.company_number ? `, company number ${row.company_number}` : ""}${row.tax_number ? `, VAT ${row.tax_number}` : ""}${row.postcode ? `, ${row.postcode}` : ""}.`,
          columns,
          rows: [row],
          raw: c,
          provenance: makeProvenance(definition, ctx, { dataset: "Contacts", basis: "client_declared" }),
        };
      },
    },
  ],
});
