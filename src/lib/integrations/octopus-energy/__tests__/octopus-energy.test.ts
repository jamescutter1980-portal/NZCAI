// Fixtures follow the examples in Octopus Energy's published OpenAPI document (grid-supply-points, products,
// standard-unit-rates, consumption) and open-source clients for /accounts; not captured from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, tariffCode } from "..";
import { runOperation, testContext } from "../../testing";
import gsp from "./fixtures/gsp.json";
import products from "./fixtures/products.json";
import rates from "./fixtures/rates.json";
import consumption from "./fixtures/consumption.json";
import account from "./fixtures/account.json";

describe("octopus-energy", () => {
  it("maps a postcode to its GSP group and region", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(gsp), { status: 200 }));
    const result = await runOperation(definition, "gsp_for_postcode", { postcode: "sw1a 1aa" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.octopus.energy/v1/industry/grid-supply-points/?postcode=SW1A1AA");
    expect(result.rows?.[0]).toEqual({ group_id: "_C", gsp_letter: "C", region: "London" });
    expect(result.summary).toContain("end in -C");
  });

  it("lists products without any auth header", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(products), { status: 200 }));
    const result = await runOperation(definition, "list_products", { is_green: "true" }, testContext(fetch));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.octopus.energy/v1/products/?page_size=100&is_green=true");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result.rows?.[0]).toMatchObject({ code: "AGILE-24-10-01", is_green: true });
  });

  it("builds the tariff code from product and GSP and sorts rates ascending", async () => {
    expect(tariffCode("electricity", "agile-24-10-01", "_c")).toBe("E-1R-AGILE-24-10-01-C");
    expect(tariffCode("gas", "VAR-22-11-01", "H")).toBe("G-1R-VAR-22-11-01-H");
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(rates), { status: 200 }));
    const result = await runOperation(definition, "unit_rates", { product_code: "AGILE-24-10-01", fuel: "electricity", gsp: "C", period_from: "2026-09-01", period_to: "2026-09-01" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/?period_from=2026-09-01T00%3A00%3A00Z&period_to=2026-09-02T00%3A00%3A00Z&page_size=1500");
    expect(result.rows?.map((r) => r.p_per_kwh_inc_vat)).toEqual([10.5, 21]);
    expect(result.summary).toContain("Mean 15.75 p/kWh");
  });

  it("requires a GSP letter or tariff code before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "unit_rates", { product_code: "AGILE-24-10-01", fuel: "electricity", period_from: "2026-09-01", period_to: "2026-09-01" }, testContext(fetch))).rejects.toThrow(/GSP letter/);
    await expect(runOperation(definition, "unit_rates", { product_code: "AGILE-24-10-01", fuel: "electricity", gsp: "C", period_from: "2026-09-01", period_to: "2026-10-15" }, testContext(fetch))).rejects.toThrow(/maximum is 31 days/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats an unknown tariff as empty rather than throwing", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ detail: "Not found." }), { status: 404 }));
    const result = await runOperation(definition, "unit_rates", { product_code: "NOPE", fuel: "gas", tariff_code: "G-1R-NOPE-C", period_from: "2026-09-01", period_to: "2026-09-01" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("sends Basic auth built from the API key for consumption and flags more pages", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(consumption), { status: 200 }));
    const result = await runOperation(definition, "meter_consumption", { fuel: "electricity", mpxn: "1200012345678", serial_number: "Z16N389556", period_from: "2026-08-01", period_to: "2026-08-02" }, testContext(fetch, { OCTOPUS_API_KEY: "sk_live_test" }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.octopus.energy/v1/electricity-meter-points/1200012345678/meters/Z16N389556/consumption/?period_from=2026-08-01T00%3A00%3A00Z&period_to=2026-08-03T00%3A00%3A00Z&page_size=1500&order_by=period");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("sk_live_test:")}`);
    expect(result.rows?.[0]).toMatchObject({ consumption: 0.063, unit: "kWh" });
    expect(result.provenance).toMatchObject({ basis: "measured", consentRef: "octopus-api-key:1200012345678" });
    expect(result.warnings?.some((w) => w.includes("More readings"))).toBe(true);
  });

  it("refuses authorised operations without a key and never calls the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "meter_consumption", { fuel: "gas", mpxn: "1234567890", serial_number: "G4A00123", period_from: "2026-08-01", period_to: "2026-08-02" }, testContext(fetch))).rejects.toThrow(/OCTOPUS_API_KEY/);
    await expect(runOperation(definition, "account_meter_points", { account: "A-1234ABCD" }, testContext(fetch))).rejects.toThrow(/OCTOPUS_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("flattens an account into one row per meter with the current agreement", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(account), { status: 200 }));
    const result = await runOperation(definition, "account_meter_points", { account: "a-1234abcd" }, testContext(fetch, { OCTOPUS_API_KEY: "k" }));
    expect(fetch.mock.calls[0][0]).toBe("https://api.octopus.energy/v1/accounts/A-1234ABCD/");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ fuel: "electricity", mpxn: "1200012345678", serial_number: "Z16N389556", tariff_code: "E-1R-AGILE-24-10-01-C" });
    expect(result.rows?.[1]).toMatchObject({ fuel: "gas", mpxn: "1234567890" });
    expect(result.provenance.basis).toBe("client_declared");
  });
});
