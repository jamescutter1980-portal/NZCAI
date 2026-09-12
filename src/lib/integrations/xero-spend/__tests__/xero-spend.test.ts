// Fixtures follow the Xero Accounting API Invoices response ({Invoices:[...], pagination}) with "/Date(ms+0000)/" dates and
// DateString, LineItems with AccountCode/LineAmount/TaxAmount, and the Accounts and Contacts envelopes. No live call was made.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { definition, whereClause, xeroDate } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import invoices from "./fixtures/invoices.json";

const env = { XERO_ACCESS_TOKEN: "access-token", XERO_TENANT_ID: "tenant-1" };
const accounts = { Accounts: [{ AccountID: "a1", Code: "429", Name: "General Expenses", Type: "EXPENSE", Class: "EXPENSE" }, { AccountID: "a2", Code: "461", Name: "Printing & Stationery", Type: "EXPENSE", Class: "EXPENSE" }] };

describe("xero-spend", () => {
  it("requests ACCPAY invoices with the where filter, statuses, page and tenant headers and lists line rows", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(invoices), { status: 200 }));
    const result = await runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2026-03-31" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.xero.com/api.xro/2.0/Invoices");
    expect(u.searchParams.get("where")).toBe('Type=="ACCPAY" AND Date>=DateTime(2025,4,1) AND Date<DateTime(2026,4,1)');
    expect(u.searchParams.get("Statuses")).toBe("AUTHORISED,PAID");
    expect(u.searchParams.get("page")).toBe("1");
    expect(u.searchParams.get("pageSize")).toBe("100");
    const h = init?.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer access-token");
    expect(h["xero-tenant-id"]).toBe("tenant-1");
    expect(h.accept).toBe("application/json");
    expect(h["if-modified-since"]).toBeUndefined();
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toEqual({ date: "2025-06-19", contact: "Acme Facilities Ltd", contact_id: "bd2270c3-8706-4c11-9cfb-000b551c3f51", invoice_number: "INV-4471", invoice_id: "9a8b7c6d-0000-4000-8000-000000000101", status: "PAID", account_code: "429", description: "Cleaning contract June", quantity: 1, line_amount_ex_tax: 600, line_tax: 120, tracking: "Site: Unit 4", invoice_subtotal_ex_tax: 1000, invoice_total_inc_tax: 1200, currency: "GBP" });
    expect(result.rows?.[2]).toMatchObject({ date: "2025-07-03", contact: "Beta Stationery", invoice_number: "B-77", account_code: "429", line_amount_ex_tax: 300, tracking: null });
    expect(result.summary).toContain("2 purchase invoice(s) from 2 supplier(s)");
    expect(result.summary).toContain("1,300 GBP ex-VAT");
    expect(result.provenance).toMatchObject({ source: "xero-spend", basis: "measured", licence: "consent_based" });
    expect(result.warnings?.[0]).toMatch(/Scope 3 category 1/);
  });

  it("sends If-Modified-Since and pages until a short page", async () => {
    const page = (n: number) => ({ Invoices: Array.from({ length: n }, (_, i) => ({ Type: "ACCPAY", InvoiceID: `id-${i}`, Contact: { Name: "S" }, DateString: "2025-05-01T00:00:00", SubTotal: 10, Total: 12, CurrencyCode: "GBP", LineItems: [{ AccountCode: "400", LineAmount: 10 }] })) });
    const fetch = vi.fn<FetchLike>(async (url) => new Response(JSON.stringify(new URL(url).searchParams.get("page") === "1" ? page(100) : page(1)), { status: 200 }));
    const result = await runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2025-06-30", modified_since: "2025-06-01T00:00:00" }, testContext(fetch, env));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("page")).toBe("2");
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>)["if-modified-since"]).toBe("2025-06-01T00:00:00");
    expect(result.rows).toHaveLength(101);
    const capped = vi.fn<FetchLike>(async () => new Response(JSON.stringify(page(100)), { status: 200 }));
    const truncated = await runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2025-06-30", max_pages: 2 }, testContext(capped, env));
    expect(capped).toHaveBeenCalledTimes(2);
    expect(truncated.summary).toContain("stopped after 2 pages");
    expect(truncated.warnings?.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("aggregates spend by supplier and by account code (ex-VAT), joining account names", async () => {
    const fetch = routedFetch([{ match: "/Invoices", body: invoices }, { match: "/Accounts", body: accounts }]);
    const bySupplier = await runOperation(definition, "spend_by_supplier", { from: "2025-04-01", to: "2026-03-31" }, testContext(fetch, env));
    expect(bySupplier.rows).toEqual([
      { contact: "Acme Facilities Ltd", contact_id: "bd2270c3-8706-4c11-9cfb-000b551c3f51", currency: "GBP", invoices: 1, spend_ex_tax: 1000, total_inc_tax: 1200, account_codes: "429, 461", share_pct: 76.9 },
      { contact: "Beta Stationery", contact_id: "0c1d2e3f-0000-4000-8000-000000000202", currency: "GBP", invoices: 1, spend_ex_tax: 300, total_inc_tax: 360, account_codes: "429", share_pct: 23.1 },
    ]);
    expect(bySupplier.summary).toContain("2 supplier(s) with 1,300 ex-VAT spend");
    expect(bySupplier.summary).toContain("2 supplier(s) make up 80% of spend");
    const byAccount = await runOperation(definition, "spend_by_account", { from: "2025-04-01", to: "2026-03-31" }, testContext(fetch, env));
    expect(byAccount.rows).toEqual([
      { account_code: "429", account_name: "General Expenses", account_type: "EXPENSE", account_class: "EXPENSE", currency: "GBP", invoices: 2, lines: 2, spend_ex_tax: 900 },
      { account_code: "461", account_name: "Printing & Stationery", account_type: "EXPENSE", account_class: "EXPENSE", currency: "GBP", invoices: 1, lines: 1, spend_ex_tax: 400 },
    ]);
    expect(byAccount.summary).toContain("1,300 ex-VAT purchase spend");
  });

  it("reads a contact and handles empty results", async () => {
    const fetch = routedFetch([
      { match: "/Contacts/bd2270c3", body: { Contacts: [{ ContactID: "bd2270c3-8706-4c11-9cfb-000b551c3f51", Name: "Acme Facilities Ltd", ContactStatus: "ACTIVE", TaxNumber: "GB123456789", CompanyNumber: "01234567", IsSupplier: true, Addresses: [{ AddressType: "POBOX", AddressLine1: "1 High St", City: "Reading", PostalCode: "RG1 1AA", Country: "UK" }] }] } },
      { match: "/Invoices", body: { Invoices: [] } },
    ]);
    const contact = await runOperation(definition, "contact", { contact_id: "bd2270c3-8706-4c11-9cfb-000b551c3f51" }, testContext(fetch, env));
    expect(contact.rows?.[0]).toMatchObject({ name: "Acme Facilities Ltd", tax_number: "GB123456789", company_number: "01234567", postcode: "RG1 1AA", is_supplier: true });
    expect(contact.summary).toContain("company number 01234567");
    const none = await runOperation(definition, "spend_by_supplier", { from: "2025-04-01", to: "2025-04-30" }, testContext(fetch, env));
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
  });

  it("parses Xero dates, validates before the network and surfaces auth failures", async () => {
    expect(xeroDate({ Date: "/Date(1750291200000+0000)/" })).toBe("2025-06-19");
    expect(xeroDate({ DateString: "2025-06-19T00:00:00", Date: "/Date(0)/" })).toBe("2025-06-19");
    expect(xeroDate({})).toBeNull();
    expect(whereClause("2025-12-25", "2025-12-31")).toBe('Type=="ACCPAY" AND Date>=DateTime(2025,12,25) AND Date<DateTime(2026,1,1)');
    const fetch = vi.fn();
    await expect(runOperation(definition, "purchase_invoices", { from: "2025-06-01", to: "2025-05-01" }, testContext(fetch, env))).rejects.toThrow(/before/);
    await expect(runOperation(definition, "purchase_invoices", { from: "2024-01-01", to: "2026-06-01" }, testContext(fetch, env))).rejects.toThrow(/731 days/);
    await expect(runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2025-04-30" }, testContext(fetch, { XERO_TENANT_ID: "t" }))).rejects.toThrow(/XERO_ACCESS_TOKEN/);
    await expect(runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2025-04-30" }, testContext(fetch, { XERO_ACCESS_TOKEN: "t" }))).rejects.toThrow(/XERO_TENANT_ID/);
    expect(fetch).not.toHaveBeenCalled();
    const unauthorised = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ Title: "Unauthorized", Detail: "AuthenticationUnsuccessful" }), { status: 401 }));
    await expect(runOperation(definition, "purchase_invoices", { from: "2025-04-01", to: "2025-04-30" }, testContext(unauthorised, env))).rejects.toMatchObject({ status: 401 });
    expect((await definition.healthCheck!(testContext(unauthorised, env))).ok).toBe(false);
    const org = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ Organisations: [{ Name: "Demo Company (UK)" }] }), { status: 200 }));
    expect(await definition.healthCheck!(testContext(org, env))).toMatchObject({ ok: true, detail: "Connected to Demo Company (UK)" });
    expect(new URL(org.mock.calls[0][0]).pathname).toBe("/api.xro/2.0/Organisation");
  });
});
