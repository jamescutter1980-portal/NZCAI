// Fixtures follow the QuickBooks Online query response ({QueryResponse:{Bill:[...]|Purchase:[...], startPosition, maxResults}})
// with Bill (VendorRef) and Purchase (EntityRef, PaymentType, Credit) entities, TxnTaxDetail and Line detail types from the
// Intuit reference. No live call was made.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition, netAmount, querySql } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import bills from "./fixtures/bills.json";
import purchases from "./fixtures/purchases.json";

const env = { QBO_ACCESS_TOKEN: "qbo-token", QBO_REALM_ID: "1234567890", QBO_ENV: "sandbox" };
const fixtures = () => routedFetch([{ match: "FROM+Bill", body: bills }, { match: "FROM+Purchase", body: purchases }]);

describe("quickbooks-spend", () => {
  it("queries Bill and Purchase with the SQL-like query, sandbox host, realm path and Bearer header", async () => {
    const fetch = vi.fn(fixtures());
    const result = await runOperation(definition, "purchases_and_bills", { from: "2025-05-01", to: "2025-05-31" }, testContext(fetch, env));
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0];
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://sandbox-quickbooks.api.intuit.com/v3/company/1234567890/query");
    expect(u.searchParams.get("query")).toBe("SELECT * FROM Bill WHERE TxnDate >= '2025-05-01' AND TxnDate <= '2025-05-31' ORDERBY TxnDate STARTPOSITION 1 MAXRESULTS 100");
    expect(u.searchParams.get("minorversion")).toBe("75");
    const h = init?.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer qbo-token");
    expect(h.accept).toBe("application/json");
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("query")).toMatch(/^SELECT \* FROM Purchase /);
    expect(result.rows).toHaveLength(4);
    expect(result.rows?.[0]).toEqual({ date: "2025-05-14", type: "Bill", vendor: "Acme Facilities Ltd", vendor_id: "56", doc_number: "AC-9921", txn_id: "145", payment_type: null, paid_from_account: null, expense_account: "Cleaning", expense_account_id: "62", item: null, detail_type: "AccountBasedExpenseLineDetail", description: "Cleaning contract May", line_amount: 300, txn_total_inc_tax: 600, txn_tax: 100, txn_net_ex_tax: 500, currency: "GBP", is_credit: false });
    expect(result.rows?.[2]).toMatchObject({ type: "Purchase", vendor: "Screwfix", payment_type: "CreditCard", paid_from_account: "Company Credit Card", expense_account: "Repairs and Maintenance", line_amount: 100, txn_net_ex_tax: 100 });
    expect(result.rows?.[3]).toMatchObject({ type: "Purchase", is_credit: true, item: "Fixings", line_amount: -20, txn_total_inc_tax: -24, txn_net_ex_tax: -20 });
    expect(result.summary).toContain("3 transaction(s) (1 bill(s), 2 purchase(s)) from 2 vendor(s)");
    expect(result.summary).toContain("580 GBP ex-tax across 4 line(s)");
    expect(result.provenance).toMatchObject({ source: "quickbooks-spend", basis: "measured", licence: "consent_based" });
    expect(result.warnings?.[0]).toMatch(/Scope 3 category 1/);
  });

  it("defaults to the production host, honours the entity filter and pages with STARTPOSITION", async () => {
    const page = (n: number) => ({ QueryResponse: { Purchase: Array.from({ length: n }, (_, i) => ({ Id: `p${i}`, TxnDate: "2025-05-02", TotalAmt: 10, EntityRef: { value: "1", name: "V" }, CurrencyRef: { value: "GBP" }, Line: [{ Amount: 10, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "5", name: "Office" } } }] })) } });
    const fetch = vi.fn<FetchLike>(async (url) => new Response(JSON.stringify(/STARTPOSITION\+1\+/.test(url) ? page(100) : page(3)), { status: 200 }));
    const result = await runOperation(definition, "purchases_and_bills", { from: "2025-05-01", to: "2025-05-31", entities: "Purchase" }, testContext(fetch, { QBO_ACCESS_TOKEN: "t", QBO_REALM_ID: "r1" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/r1\/query\?/);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("query")).toContain("STARTPOSITION 101 MAXRESULTS 100");
    expect(result.rows).toHaveLength(103);
  });

  it("aggregates spend by vendor and by expense account with credits netted", async () => {
    const byVendor = await runOperation(definition, "spend_by_vendor", { from: "2025-05-01", to: "2025-05-31" }, testContext(fixtures(), env));
    expect(byVendor.rows).toEqual([
      { vendor: "Acme Facilities Ltd", vendor_id: "56", currency: "GBP", transactions: 1, spend_ex_tax: 500, total_inc_tax: 600, expense_accounts: "Cleaning", share_pct: 86.2 },
      { vendor: "Screwfix", vendor_id: "77", currency: "GBP", transactions: 2, spend_ex_tax: 80, total_inc_tax: 96, expense_accounts: "Repairs and Maintenance", share_pct: 13.8 },
    ]);
    expect(byVendor.summary).toContain("2 vendor(s) with 580 ex-tax spend");
    const byAccount = await runOperation(definition, "spend_by_account", { from: "2025-05-01", to: "2025-05-31" }, testContext(fixtures(), env));
    expect(byAccount.rows).toEqual([
      { account: "Cleaning", account_id: "62", kind: "account", currency: "GBP", transactions: 1, lines: 2, spend: 500 },
      { account: "Repairs and Maintenance", account_id: "55", kind: "account", currency: "GBP", transactions: 1, lines: 1, spend: 100 },
      { account: "Item: Fixings", account_id: "9", kind: "item", currency: "GBP", transactions: 1, lines: 1, spend: -20 },
    ]);
    expect(netAmount({ Id: "x", TotalAmt: 120, TxnTaxDetail: { TotalTax: 20 }, Credit: true })).toBe(-100);
  });

  it("returns unavailable for an empty range and throws on a Fault body", async () => {
    const empty = routedFetch([{ match: "/query", body: { QueryResponse: {} } }]);
    const result = await runOperation(definition, "spend_by_vendor", { from: "2025-01-01", to: "2025-01-31" }, testContext(empty, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fault = routedFetch([{ match: "/query", body: { Fault: { Error: [{ Message: "Error parsing query", Detail: "QueryParserError: Invalid content", code: "4000" }] }, time: "x" } }]);
    await expect(runOperation(definition, "spend_by_vendor", { from: "2025-01-01", to: "2025-01-31" }, testContext(fault, env))).rejects.toThrow(/QuickBooks fault: Error parsing query/);
  });

  it("validates before the network and surfaces auth failures", async () => {
    expect(querySql("Bill", "2025-01-01", "2025-01-31", 201)).toBe("SELECT * FROM Bill WHERE TxnDate >= '2025-01-01' AND TxnDate <= '2025-01-31' ORDERBY TxnDate STARTPOSITION 201 MAXRESULTS 100");
    const fetch = vi.fn();
    await expect(runOperation(definition, "purchases_and_bills", { from: "2025-02-01", to: "2025-01-01" }, testContext(fetch, env))).rejects.toThrow(/before/);
    await expect(runOperation(definition, "purchases_and_bills", { from: "2025-01-01", to: "2025-01-31" }, testContext(fetch, { QBO_REALM_ID: "r" }))).rejects.toThrow(/QBO_ACCESS_TOKEN/);
    await expect(runOperation(definition, "purchases_and_bills", { from: "2025-01-01", to: "2025-01-31" }, testContext(fetch, { QBO_ACCESS_TOKEN: "t" }))).rejects.toThrow(/QBO_REALM_ID/);
    await expect(runOperation(definition, "purchases_and_bills", { from: "2025-01-01", to: "2025-01-31", entities: "Invoice" }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const unauthorised = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ Fault: { Error: [{ Message: "message=AuthenticationFailed", code: "3200" }] } }), { status: 401 }));
    await expect(runOperation(definition, "purchases_and_bills", { from: "2025-01-01", to: "2025-01-31" }, testContext(unauthorised, env))).rejects.toMatchObject({ status: 401 });
    expect((await definition.healthCheck!(testContext(unauthorised, env))).ok).toBe(false);
    const company = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ CompanyInfo: { CompanyName: "Sandbox Company_GB_1", Country: "GB" } }), { status: 200 }));
    expect(await definition.healthCheck!(testContext(company, env))).toMatchObject({ ok: true, detail: "Connected to Sandbox Company_GB_1 (GB)" });
    expect(new URL(String(company.mock.calls[0][0])).pathname).toBe("/v3/company/1234567890/companyinfo/1234567890");
  });
});
