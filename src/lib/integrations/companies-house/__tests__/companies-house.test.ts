// Fixtures mirror the documented Companies House Public Data API resource shapes
// (companyProfile, officerList); they were not taken from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, normaliseCompanyNumber } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";
import { SIC_2007, sicDescription } from "../sic-codes";
import profile from "./fixtures/profile.json";
import officers from "./fixtures/officers.json";

const env = { COMPANIES_HOUSE_API_KEY: "abc123" };

describe("companies-house", () => {
  it("sends the key as a Basic username and zero-pads the company number", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(profile), { status: 200 }));
    const result = await runOperation(definition, "profile", { company_number: "12345678" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.company-information.service.gov.uk/company/12345678");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("abc123:").toString("base64")}`);
    expect(result.rows?.[0]).toMatchObject({ company_name: "FOCUS GREEN LIMITED", status: "active", postcode: "SW1A 1AA" });
    expect(String(result.rows?.[0].sic_codes)).toContain("74901 Environmental consulting activities");
    expect(result.warnings?.[0]).toContain("00000");
    expect(result.provenance).toMatchObject({ source: "companies-house", basis: "measured", licence: "OGL" });
  });

  it("normalises company numbers", () => {
    expect(normaliseCompanyNumber("6")).toBe("00000006");
    expect(normaliseCompanyNumber(" sc123456 ")).toBe("SC123456");
  });

  it("bundles the condensed SIC 2007 list", () => {
    expect(Object.keys(SIC_2007).length).toBe(731);
    expect(sicDescription("1110")).toBe("Growing of cereals (except rice), leguminous crops and oil seeds");
    expect(sicDescription("99999")).toBe("Dormant Company");
  });

  it("maps officers and counts active versus resigned", async () => {
    const fetch = routedFetch([{ match: "/officers", body: officers }]);
    const result = await runOperation(definition, "officers", { company_number: "12345678" }, testContext(fetch, env));
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ name: "CUTTER, James", role: "director", born: "1980-06" });
    expect(result.summary).toContain("1 active officers, 1 resigned");
  });

  it("returns an empty unavailable result for a 404", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ errors: [{ error: "company-profile-not-found" }] }), { status: 404 }));
    const result = await runOperation(definition, "profile", { company_number: "99999999" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("fails before the network when the key is missing", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "search", { q: "x" }, testContext(fetch, {}))).rejects.toThrow(/COMPANIES_HOUSE_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty search before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "search", { items_per_page: 500 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
