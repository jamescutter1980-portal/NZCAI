import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext, type ParamSpec } from "../framework";
import { assertRange } from "../_shared/dates";

/**
 * QuickBooks Online Accounting API: Purchase and Bill transactions for
 * spend-based Scope 3 category 1 screening.
 *
 * Built from the Intuit developer reference (query endpoint, Purchase, Bill,
 * Vendor, CompanyInfo): Bearer token, realmId in the path, SQL-like query with
 * TxnDate filters and STARTPOSITION/MAXRESULTS paging, Accept application/json,
 * response {QueryResponse:{Purchase:[...], startPosition, maxResults}}. The
 * OAuth 2.0 flow that produces the token is out of scope (see notes). Not
 * exercised live from this codebase.
 */

export const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";
export const PRODUCTION_BASE = "https://quickbooks.api.intuit.com";
const MINOR_VERSION = 75;
const PAGE_SIZE = 100;

export function apiBase(env: EnvLike): string {
  const explicit = env.QBO_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return (env.QBO_ENV?.trim().toLowerCase() || "production") === "sandbox" ? SANDBOX_BASE : PRODUCTION_BASE;
}

export function realmId(env: EnvLike): string {
  const r = env.QBO_REALM_ID?.trim();
  if (!r) throw new Error("QBO_REALM_ID is not set");
  return r;
}

export function headers(env: EnvLike): Record<string, string> {
  const token = env.QBO_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("QBO_ACCESS_TOKEN is not set");
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

export interface QboRef {
  value?: string;
  name?: string;
  type?: string;
}

export interface QboLine {
  Id?: string;
  Amount?: number;
  DetailType?: string;
  Description?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QboRef; TaxCodeRef?: QboRef; CustomerRef?: QboRef };
  ItemBasedExpenseLineDetail?: { ItemRef?: QboRef; Qty?: number; UnitPrice?: number; TaxCodeRef?: QboRef };
}

export interface QboTxn {
  Id: string;
  TxnDate?: string;
  DocNumber?: string;
  TotalAmt?: number;
  PaymentType?: string;
  Credit?: boolean;
  /** Purchase: payee. */
  EntityRef?: QboRef;
  /** Bill: supplier. */
  VendorRef?: QboRef;
  /** Purchase: bank/credit-card account paid from. */
  AccountRef?: QboRef;
  CurrencyRef?: QboRef;
  ExchangeRate?: number;
  TxnTaxDetail?: { TotalTax?: number };
  GlobalTaxCalculation?: string;
  PrivateNote?: string;
  Line?: QboLine[];
  MetaData?: { LastUpdatedTime?: string };
}

interface QueryResponse {
  QueryResponse?: { Purchase?: QboTxn[]; Bill?: QboTxn[]; startPosition?: number; maxResults?: number; totalCount?: number };
  Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] };
  time?: string;
}

export type Entity = "Purchase" | "Bill";

export function querySql(entity: Entity, from: string, to: string, start: number): string {
  return `SELECT * FROM ${entity} WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ORDERBY TxnDate STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
}

export function queryUrl(env: EnvLike, sql: string): string {
  return buildUrl(apiBase(env), `v3/company/${encodeURIComponent(realmId(env))}/query`, { query: sql, minorversion: MINOR_VERSION });
}

export async function fetchTransactions(ctx: OperationContext, entities: Entity[], from: string, to: string, maxPages = 10): Promise<{ txns: (QboTxn & { entity: Entity })[]; requests: number; truncated: boolean }> {
  const h = headers(ctx.env);
  const txns: (QboTxn & { entity: Entity })[] = [];
  let requests = 0;
  let truncated = false;
  for (const entity of entities) {
    let start = 1;
    for (let page = 1; ; page++) {
      const { data } = await fetchJson<QueryResponse>(ctx, queryUrl(ctx.env, querySql(entity, from, to, start)), { headers: h }, { timeoutMs: 30_000 });
      requests += 1;
      if (data?.Fault?.Error?.length) throw new Error(`QuickBooks fault: ${data.Fault.Error.map((e) => `${e.Message ?? ""} ${e.Detail ?? ""}`.trim()).join("; ")}`);
      const batch = (data?.QueryResponse?.[entity] ?? []) as QboTxn[];
      txns.push(...batch.map((t) => ({ ...t, entity })));
      if (batch.length < PAGE_SIZE) break;
      if (page >= maxPages) {
        truncated = true;
        break;
      }
      start += PAGE_SIZE;
    }
  }
  return { txns, requests, truncated };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function counterparty(t: QboTxn): QboRef | undefined {
  return t.VendorRef ?? t.EntityRef;
}

/** Sign-aware total excluding tax: TotalAmt minus TxnTaxDetail.TotalTax, negative for purchase credits (refunds). */
export function netAmount(t: QboTxn): number {
  const gross = t.TotalAmt ?? 0;
  const tax = t.TxnTaxDetail?.TotalTax ?? 0;
  const net = gross - tax;
  return t.Credit ? -net : net;
}

export function lineRows(txns: (QboTxn & { entity: Entity })[]) {
  return txns.flatMap((t) => {
    const cp = counterparty(t);
    const sign = t.Credit ? -1 : 1;
    const lines = t.Line?.filter((l) => l.DetailType !== "SubTotalLineDetail")?.length ? t.Line.filter((l) => l.DetailType !== "SubTotalLineDetail") : [{} as QboLine];
    return lines.map((l) => ({
      date: t.TxnDate ?? null,
      type: t.entity,
      vendor: cp?.name ?? null,
      vendor_id: cp?.value ?? null,
      doc_number: t.DocNumber ?? null,
      txn_id: t.Id,
      payment_type: t.PaymentType ?? null,
      paid_from_account: t.entity === "Purchase" ? (t.AccountRef?.name ?? null) : null,
      expense_account: l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? null,
      expense_account_id: l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null,
      item: l.ItemBasedExpenseLineDetail?.ItemRef?.name ?? null,
      detail_type: l.DetailType ?? null,
      description: l.Description ?? null,
      line_amount: l.Amount !== undefined ? round2(sign * l.Amount) : null,
      txn_total_inc_tax: t.TotalAmt !== undefined ? round2(sign * t.TotalAmt) : null,
      txn_tax: t.TxnTaxDetail?.TotalTax !== undefined ? round2(sign * t.TxnTaxDetail.TotalTax) : null,
      txn_net_ex_tax: round2(netAmount(t)),
      currency: t.CurrencyRef?.value ?? null,
      is_credit: Boolean(t.Credit),
    }));
  });
}

const RANGE_PARAMS: ParamSpec[] = [
  { name: "from", label: "From", type: "date", required: true, placeholder: "2025-04-01" },
  { name: "to", label: "To (inclusive)", type: "date", required: true, placeholder: "2026-03-31" },
  { name: "entities", label: "Transaction types", type: "select", default: "both", options: [{ value: "both", label: "Bills and purchases (expenses, cheques, card)" }, { value: "Bill", label: "Bills only" }, { value: "Purchase", label: "Purchases only" }] },
  { name: "max_pages", label: "Max pages per type (100 each)", type: "integer", default: 10, min: 1, max: 50 },
];

function entitiesFor(v: unknown): Entity[] {
  return v === "Bill" ? ["Bill"] : v === "Purchase" ? ["Purchase"] : ["Bill", "Purchase"];
}

const SCOPE3_WARNING = "Spend is ex-VAT accounting data, not emissions: Scope 3 category 1 screening needs each vendor classified (SIC/NACE or account-based sector) and a spend-based factor (EXIOBASE or Climatiq procurement, in the spend currency and year). This connector does not classify. Bill payments are not counted (they would double count bills); purchase credits are negative.";

export const definition = defineIntegration({
  id: "quickbooks-spend",
  name: "QuickBooks Online purchases and bills (spend-based Scope 3)",
  group: "carbon",
  access: "authorised",
  territory: "Global",
  description: "Client-authorised read of bills and purchase transactions from a QuickBooks Online company, listed by line and aggregated by vendor and by expense account (ex-VAT), as the input to spend-based Scope 3 category 1 screening.",
  docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase",
  termsUrl: "https://developer.intuit.com/app/developer/qbo/docs/develop/terms-of-service",
  attribution: "Financial data from the client's QuickBooks Online company, retrieved under the client's OAuth 2.0 consent.",
  licence: "consent_based",
  envVars: [
    { name: "QBO_ACCESS_TOKEN", required: true, description: "OAuth 2.0 access token (Bearer) for the connected company, scope com.intuit.quickbooks.accounting; expires after 1 hour, refresh tokens last 100 days." },
    { name: "QBO_REALM_ID", required: true, description: "Company (realm) id returned with the OAuth callback; used in the API path." },
    { name: "QBO_ENV", required: false, description: "sandbox or production (default production): selects sandbox-quickbooks.api.intuit.com or quickbooks.api.intuit.com." },
    { name: "QBO_API_BASE", required: false, description: "Explicit API base override (takes precedence over QBO_ENV)." },
  ],
  status: "built_unverified",
  notes: [
    "OAuth is out of scope here: the portal's Intuit app must run the authorization-code flow (scope com.intuit.quickbooks.accounting), store the refresh token per realm and rotate it; this connector consumes the access token and realmId from the environment. Production keys require Intuit app review for public listing.",
    "Endpoints: GET /v3/company/{realmId}/query?query=SELECT * FROM Purchase WHERE TxnDate >= 'yyyy-mm-dd' AND TxnDate <= 'yyyy-mm-dd' STARTPOSITION n MAXRESULTS 100 (Accept: application/json, minorversion 75) and the same for Bill; GET /v3/company/{realmId}/companyinfo/{realmId} for health. Shapes follow the Intuit reference; not called live from this environment.",
    "Rate limits: 500 requests per minute per realm and 10 concurrent requests per realm; MAXRESULTS may be up to 1,000 but 100 is used here to keep responses small.",
    "Amounts: TotalAmt includes VAT where the company tracks tax; the ex-tax figure is TotalAmt minus TxnTaxDetail.TotalTax. Line Amounts are ex-tax when GlobalTaxCalculation is TaxExcluded (the UK default) and include tax when TaxInclusive; check the company's setting before summing lines. Multi-currency transactions are reported in their own currency (CurrencyRef) with ExchangeRate in raw.",
    "Purchase covers cash, cheque and credit-card expenses (PaymentType); Bill covers supplier invoices. BillPayment, VendorCredit and JournalEntry are not read: bill payments would double count and vendor credits need separate treatment. Purchases with Credit=true are refunds and are shown negative.",
    "Scope 3 category 1 screening: classify each vendor (SIC/NACE via Companies House match, or by expense account) and apply a spend-based factor (EXIOBASE or Climatiq procurement for the spend year and currency); results carry basis 'estimated' and are for hotspot identification. Fixed-asset account lines belong to category 2 (capital goods).",
    "Consent: store the consent reference (realmId, scopes, granted-at, refresh expiry) with every imported value; purge or freeze when disconnected.",
  ],
  healthCheck: async (ctx): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const realm = realmId(ctx.env);
      const { data } = await fetchJson<{ CompanyInfo?: { CompanyName?: string; Country?: string } }>(ctx, buildUrl(apiBase(ctx.env), `v3/company/${encodeURIComponent(realm)}/companyinfo/${encodeURIComponent(realm)}`, { minorversion: MINOR_VERSION }), { headers: headers(ctx.env) }, { timeoutMs: 15_000 });
      const name = data?.CompanyInfo?.CompanyName;
      return { ok: Boolean(name), detail: name ? `Connected to ${name}${data?.CompanyInfo?.Country ? ` (${data.CompanyInfo.Country})` : ""}` : "No company info returned", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "purchases_and_bills",
      label: "Purchases and bills in a date range",
      description: "One row per transaction line with date, vendor, document number, expense account, description and amounts (ex-tax transaction total alongside).",
      params: [...RANGE_PARAMS],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Transaction range");
        const { txns, requests, truncated } = await fetchTransactions(ctx, entitiesFor(params.entities), from, to, Number(params.max_pages ?? 10));
        const rows = lineRows(txns);
        const columns = ["date", "type", "vendor", "vendor_id", "doc_number", "txn_id", "payment_type", "paid_from_account", "expense_account", "expense_account_id", "item", "detail_type", "description", "line_amount", "txn_total_inc_tax", "txn_tax", "txn_net_ex_tax", "currency", "is_credit"];
        if (!txns.length) return { summary: `No purchases or bills between ${from} and ${to}.`, columns, rows: [], raw: { requests, txns }, provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill query", basis: "unavailable" }) };
        const byCurrency = new Map<string, number>();
        for (const t of txns) byCurrency.set(t.CurrencyRef?.value ?? "?", (byCurrency.get(t.CurrencyRef?.value ?? "?") ?? 0) + netAmount(t));
        const totals = [...byCurrency.entries()].map(([c, v]) => `${round2(v).toLocaleString("en-GB")} ${c}`).join(", ");
        const bills = txns.filter((t) => t.entity === "Bill").length;
        return {
          summary: `${txns.length} transaction(s) (${bills} bill(s), ${txns.length - bills} purchase(s)) from ${new Set(txns.map((t) => counterparty(t)?.value ?? counterparty(t)?.name)).size} vendor(s) between ${from} and ${to}: ${totals} ex-tax across ${rows.length} line(s)${truncated ? ` (stopped at the page cap after ${requests} requests; raise max_pages)` : ""}.`,
          columns,
          rows,
          raw: { requests, truncated, txns: txns.slice(0, 500) },
          provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill query", basis: "measured" }),
          warnings: [SCOPE3_WARNING, ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
    {
      id: "spend_by_vendor",
      label: "Spend by vendor in a date range",
      description: "Ex-tax spend aggregated per vendor and currency, largest first: the list to classify for Scope 3 category 1.",
      params: [...RANGE_PARAMS],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Transaction range");
        const { txns, requests, truncated } = await fetchTransactions(ctx, entitiesFor(params.entities), from, to, Number(params.max_pages ?? 10));
        const agg = new Map<string, { vendor: string | null; vendor_id: string | null; currency: string | null; transactions: number; spend_ex_tax: number; total_inc_tax: number; accounts: Set<string> }>();
        for (const t of txns) {
          const cp = counterparty(t);
          const key = `${cp?.value ?? cp?.name ?? "?"}|${t.CurrencyRef?.value ?? "?"}`;
          const a = agg.get(key) ?? { vendor: cp?.name ?? null, vendor_id: cp?.value ?? null, currency: t.CurrencyRef?.value ?? null, transactions: 0, spend_ex_tax: 0, total_inc_tax: 0, accounts: new Set<string>() };
          a.transactions += 1;
          a.spend_ex_tax += netAmount(t);
          a.total_inc_tax += (t.Credit ? -1 : 1) * (t.TotalAmt ?? 0);
          for (const l of t.Line ?? []) if (l.AccountBasedExpenseLineDetail?.AccountRef?.name) a.accounts.add(l.AccountBasedExpenseLineDetail.AccountRef.name);
          agg.set(key, a);
        }
        const rows = [...agg.values()]
          .map((a) => ({ vendor: a.vendor, vendor_id: a.vendor_id, currency: a.currency, transactions: a.transactions, spend_ex_tax: round2(a.spend_ex_tax), total_inc_tax: round2(a.total_inc_tax), expense_accounts: [...a.accounts].sort().join(", ") || null, share_pct: 0 }))
          .sort((x, y) => y.spend_ex_tax - x.spend_ex_tax);
        const grand = rows.reduce((s, r) => s + r.spend_ex_tax, 0);
        for (const r of rows) r.share_pct = grand ? Math.round((r.spend_ex_tax / grand) * 1000) / 10 : 0;
        const columns = ["vendor", "vendor_id", "currency", "transactions", "spend_ex_tax", "total_inc_tax", "expense_accounts", "share_pct"];
        if (!rows.length) return { summary: `No purchases or bills between ${from} and ${to}.`, columns, rows: [], raw: { requests }, provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill by vendor", basis: "unavailable" }) };
        const eighty = rows.reduce<{ n: number; acc: number }>((s, r) => (s.acc < 80 ? { n: s.n + 1, acc: s.acc + r.share_pct } : s), { n: 0, acc: 0 }).n;
        return {
          summary: `${rows.length} vendor(s) with ${round2(grand).toLocaleString("en-GB")} ex-tax spend between ${from} and ${to}; ${eighty} vendor(s) make up 80% of spend. Largest: ${rows.slice(0, 3).map((r) => `${r.vendor ?? "unnamed"} ${r.spend_ex_tax.toLocaleString("en-GB")} ${r.currency ?? ""} (${r.share_pct}%)`).join("; ")}.`,
          columns,
          rows,
          raw: { requests, truncated, transactionCount: txns.length },
          provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill by vendor", basis: "measured" }),
          warnings: [SCOPE3_WARNING, "Share is meaningful only when all transactions are in one currency; check the currency column.", ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
    {
      id: "spend_by_account",
      label: "Spend by expense account in a date range",
      description: "Line amounts aggregated per expense account (AccountBasedExpenseLineDetail.AccountRef) or item, largest first.",
      params: [...RANGE_PARAMS],
      async run(params, ctx) {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 731, "Transaction range");
        const { txns, requests, truncated } = await fetchTransactions(ctx, entitiesFor(params.entities), from, to, Number(params.max_pages ?? 10));
        const agg = new Map<string, { account: string | null; account_id: string | null; kind: string; currency: string | null; lines: number; transactions: Set<string>; spend: number }>();
        for (const t of txns) {
          const sign = t.Credit ? -1 : 1;
          for (const l of t.Line ?? []) {
            if (l.DetailType === "SubTotalLineDetail") continue;
            const acc = l.AccountBasedExpenseLineDetail?.AccountRef;
            const item = l.ItemBasedExpenseLineDetail?.ItemRef;
            const name = acc?.name ?? (item ? `Item: ${item.name ?? item.value ?? "?"}` : null);
            const key = `${acc?.value ?? item?.value ?? "?"}|${t.CurrencyRef?.value ?? "?"}`;
            const a = agg.get(key) ?? { account: name, account_id: acc?.value ?? item?.value ?? null, kind: acc ? "account" : item ? "item" : "unknown", currency: t.CurrencyRef?.value ?? null, lines: 0, transactions: new Set<string>(), spend: 0 };
            a.lines += 1;
            a.transactions.add(t.Id);
            a.spend += sign * (l.Amount ?? 0);
            agg.set(key, a);
          }
        }
        const rows = [...agg.values()].map((a) => ({ account: a.account, account_id: a.account_id, kind: a.kind, currency: a.currency, transactions: a.transactions.size, lines: a.lines, spend: round2(a.spend) })).sort((x, y) => y.spend - x.spend);
        const columns = ["account", "account_id", "kind", "currency", "transactions", "lines", "spend"];
        if (!rows.length) return { summary: `No purchase or bill lines between ${from} and ${to}.`, columns, rows: [], raw: { requests }, provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill by account", basis: "unavailable" }) };
        const grand = round2(rows.reduce((s, r) => s + r.spend, 0));
        return {
          summary: `${rows.length} expense account(s)/item(s) with ${grand.toLocaleString("en-GB")} line spend between ${from} and ${to}. Largest: ${rows.slice(0, 3).map((r) => `${r.account ?? "?"} ${r.spend.toLocaleString("en-GB")}`).join("; ")}.`,
          columns,
          rows,
          raw: { requests, truncated, transactionCount: txns.length },
          provenance: makeProvenance(definition, ctx, { dataset: "Purchase + Bill by account", basis: "measured" }),
          warnings: [SCOPE3_WARNING, "Line amounts follow the company's GlobalTaxCalculation setting (ex-tax when TaxExcluded, the UK default); confirm before treating them as ex-VAT.", ...(truncated ? ["Result truncated at the page cap; totals are incomplete."] : [])],
        };
      },
    },
  ],
});
