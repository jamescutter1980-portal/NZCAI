// price-paid.json follows the Linked Data API JSON view documented at
// landregistry.data.gov.uk/app/doc/ppd (values may be plain or wrapped); the
// transactions are illustrative. ukhpi-month.json mirrors a published
// north-east 2024-09 record found in an open-source project; ratios and
// figures are as found there and not independently checked.
import { describe, expect, it, vi } from "vitest";
import { definition, val } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import pricePaid from "./fixtures/price-paid.json";
import ukhpi from "./fixtures/ukhpi-month.json";

describe("land-registry", () => {
  it("builds the price paid URL with a spaced postcode, page size and newest-first sort", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(pricePaid), { status: 200 }));
    const result = await runOperation(definition, "price-paid-by-postcode", { postcode: "sw1a1aa", page_size: 50 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=SW1A+1AA&_pageSize=50&_sort=-transactionDate");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({
      transaction_date: "2024-06-14",
      price_paid_gbp: 850000,
      address: "FLAT 3, 10, EXAMPLE STREET",
      postcode: "SW1A 1AA",
      district: "CITY OF WESTMINSTER",
      property_type: "Flat-maisonette",
      estate_type: "Leasehold",
      new_build: false,
      transaction_category: "Standard price paid transaction",
      transaction_id: "9C7A3E1D-0000-4000-8000-000000000001",
    });
    // unlabelled resources fall back to the URI's last segment
    expect(result.rows?.[1]).toMatchObject({ property_type: "terraced", estate_type: "freehold", new_build: true, transaction_date: "2019-11-01" });
    expect(result.summary).toContain("2 transactions for SW1A 1AA");
    expect(result.summary).toContain("£850,000");
    expect(result.provenance).toMatchObject({ source: "land-registry", basis: "measured", licence: "OGL" });
  });

  it("adds a min-transactionDate filter when a from date is given", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ result: { items: [] } }), { status: 200 }));
    const result = await runOperation(definition, "price-paid-by-postcode", { postcode: "SW1A 1AA", min_date: "2020-01-01" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("min-transactionDate")).toBe("2020-01-01");
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("fetches a UK HPI month for a region", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(ukhpi), { status: 200 }));
    const result = await runOperation(definition, "hpi-region-month", { region: "North East", month: "2024-09" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://landregistry.data.gov.uk/data/ukhpi/region/north-east/month/2024-09.json");
    expect(result.rows?.[0]).toMatchObject({ region: "north-east", month: "2024-09", average_price_gbp: 170644, house_price_index: 145.7, annual_change_pct: 4.1, sales_volume: 2687, average_price_detached: 289802 });
    expect(result.summary).toContain("£170,644");
    expect(result.provenance.basis).toBe("modelled");
  });

  it("treats a 404 HPI month as unavailable", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("Not found", { status: 404 }));
    const result = await runOperation(definition, "hpi-region-month", { region: "england", month: "2099-01" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects invalid input before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "price-paid-by-postcode", { postcode: "nope" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "hpi-region-month", { region: "england", month: "2024-13" }, testContext(fetch))).rejects.toThrow(/YYYY-MM/);
    await expect(runOperation(definition, "hpi-region-month", { region: "../x", month: "2024-01" }, testContext(fetch))).rejects.toThrow(/Region slug/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("val unwraps Linked Data API value shapes", () => {
    expect(val(5)).toBe(5);
    expect(val({ _value: "2024-01-01", _datatype: "date" })).toBe("2024-01-01");
    expect(val({ _about: "http://x/def/common/freehold", prefLabel: [{ _value: "Freehold" }] })).toBe("Freehold");
    expect(val({ _about: "http://x/def/common/freehold" })).toBe("freehold");
    expect(val(null)).toBeNull();
  });
});
