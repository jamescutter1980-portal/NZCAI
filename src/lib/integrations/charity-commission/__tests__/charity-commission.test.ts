// Fixtures follow the Charity Commission API data definition (v1.1) field names; not taken from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import details from "./fixtures/details.json";

const env = { CHARITY_COMMISSION_API_KEY: "key-123" };

describe("charity-commission", () => {
  it("sends the subscription key header and maps charity details", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(details), { status: 200 }));
    const result = await runOperation(definition, "details", { registered_number: "1234567" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.charitycommission.gov.uk/register/api/allcharitydetails/1234567/0");
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("key-123");
    expect(result.rows?.[0]).toMatchObject({ name: "EXAMPLE COMMUNITY FOUNDATION", status: "Registered", latest_income_gbp: 245000, trustees: 3, postcode: "SW1A 1AA" });
    expect(result.summary).toContain("245,000");
    expect(result.provenance).toMatchObject({ source: "charity-commission", basis: "measured", licence: "OGL" });
  });

  it("searches by name and sorts financial history latest first", async () => {
    const fetch = routedFetch([
      { match: "/searchCharityName/Example%20Foundation", body: [{ reg_charity_number: 1234567, group_subsid_suffix: 0, charity_name: "EXAMPLE COMMUNITY FOUNDATION", reg_status: "R", date_of_registration: "2016-05-10T00:00:00" }] },
      { match: "/charityfinancialhistory/1234567/0", body: [{ financial_period_end_date: "2024-03-31T00:00:00", income: 210000, expenditure: 200000 }, { financial_period_end_date: "2025-03-31T00:00:00", income: 245000, expenditure: 231500 }] },
    ]);
    const search = await runOperation(definition, "search", { name: "Example Foundation" }, testContext(fetch, env));
    expect(search.rows?.[0]).toMatchObject({ registered_number: 1234567, name: "EXAMPLE COMMUNITY FOUNDATION" });
    const history = await runOperation(definition, "financial_history", { registered_number: "1234567" }, testContext(fetch, env));
    expect(history.rows?.map((r) => r.income_gbp)).toEqual([245000, 210000]);
  });

  it("returns an empty unavailable result for a 404 and fails before the network without a key", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const result = await runOperation(definition, "details", { registered_number: "9999999" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const noKey = vi.fn();
    await expect(runOperation(definition, "search", { name: "x" }, testContext(noKey, {}))).rejects.toThrow(/CHARITY_COMMISSION_API_KEY/);
    expect(noKey).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range suffix before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "details", { registered_number: "1234567", suffix: 5000 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
