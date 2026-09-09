// CSV fixtures follow the column set reported by open-source clients of data.nationalgas.com (Applicable At,
// Applicable For, Data Item, Value, Generated Time, Quality Indicator with dd/mm/yyyy dates); values are illustrative.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { definition, parseGasCsv, parsePortalDate } from "..";
import { runOperation, testContext } from "../../testing";

const demandCsv = readFileSync(new URL("./fixtures/demand.csv", import.meta.url), "utf8");
const cvCsv = readFileSync(new URL("./fixtures/cv.csv", import.meta.url), "utf8");

describe("national-gas-data", () => {
  it("parses portal dates and CSV rows", () => {
    expect(parsePortalDate("02/08/2026 05:00:00")).toBe("2026-08-02T05:00:00");
    expect(parsePortalDate("01/08/2026")).toBe("2026-08-01");
    const rows = parseGasCsv(demandCsv);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ gas_day: "2026-08-01", applicable_at: "2026-08-02T05:00:00", data_item: "NTS Energy Offtaken, LDZ Offtake Total", value: 900000000, generated_time: "2026-08-02T09:00:00", quality: "" });
    expect(parseGasCsv("")).toEqual([]);
  });

  it("POSTs the JSON body for the demand preset and adds GWh", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(demandCsv, { status: 200, headers: { "content-type": "text/csv" } }));
    const result = await runOperation(definition, "system_demand", { from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://data.nationalgas.com/api/find-gas-data-download");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ applicableFor: "Y", dateFrom: "2026-08-01", dateTo: "2026-08-02", dateType: "GASDAY", latestFlag: "Y", ids: "PUBOBJ1023,PUBOBJ1025,PUBOBJ1026,PUBOBJ1028,PUBOBJ1024", type: "CSV" });
    expect(result.rows?.[0]).toMatchObject({ gas_day: "2026-08-01", component: "LDZ (distribution) demand", value_gwh: 900 });
    expect(result.summary).toContain("mean NTS demand 1300 GWh/day");
    expect(result.provenance).toMatchObject({ source: "national-gas-data", basis: "measured", licence: "restricted" });
  });

  it("chunks long ranges so days x items stays under the portal limit", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(demandCsv, { status: 200 }));
    await runOperation(definition, "download_items", { ids: "PUBOBJ1023, pubobj1025\nPUBOBJ1026,PUBOBJ1028,PUBOBJ1024,PUBOBJ1620,PUBOBJ1621,PUBOB262,PUBOB264,PUBOB603", from: "2025-09-01", to: "2026-08-31" }, testContext(fetch));
    // 10 ids -> 360 days per request; 365 days -> 2 requests
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(first.dateTo).toBe("2026-08-26");
    expect(first.ids).toContain("PUBOBJ1025");
  });

  it("returns the LDZ calorific value series with the zone label", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(cvCsv, { status: 200 }));
    const result = await runOperation(definition, "ldz_calorific_value", { ldz: "PUBOB4516", from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).ids).toBe("PUBOB4516");
    expect(result.rows?.[1]).toMatchObject({ gas_day: "2026-08-02", ldz: "SW: South West", cv_mj_m3: 39.6 });
    expect(result.summary).toContain("mean 39.5 MJ/m3");
  });

  it("treats an empty CSV as unavailable rather than an error", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const result = await runOperation(definition, "system_average_price", { from: "2026-08-01", to: "2026-08-02" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates ids and ranges before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "download_items", { ids: "not-an-id", from: "2026-08-01", to: "2026-08-02" }, testContext(fetch))).rejects.toThrow(/PUBOBJ/);
    await expect(runOperation(definition, "system_demand", { from: "2024-01-01", to: "2026-08-02" }, testContext(fetch))).rejects.toThrow(/maximum is 366 days/);
    await expect(runOperation(definition, "ldz_calorific_value", { ldz: "PUBOB9999", from: "2026-08-01", to: "2026-08-02" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
