// Fixture shapes follow the published OpenAPI document for the replacement
// "Get energy performance of buildings data" API (communitiesuk/epb-data-warehouse
// api/api.yml). The certificate document shape is only described as
// "EPC document in JSON format" there, so certificate.json is a plausible
// camelCase document, not a captured response.
import { describe, expect, it, vi } from "vitest";
import { definition, epcAuthHeader } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import domesticSearch from "./fixtures/domestic-search.json";
import certificate from "./fixtures/certificate.json";

const env = { EPC_API_TOKEN: "test-token" };

describe("epc-england-wales", () => {
  it("builds the domestic search URL with a spaced postcode and a Bearer header", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(domesticSearch), { status: 200 }));
    const result = await runOperation(definition, "domestic-search", { postcode: "sw10 0aa" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.get-energy-performance-data.communities.gov.uk/api/domestic/search?postcode=SW10+0AA&page_size=50&current_page=1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ address: "1 Some Street", uprn: "100121241798", certificate_number: "0000-0000-0000-0000-0001", current_energy_efficiency_band: "B" });
    expect(result.rows?.[1].address).toBe("Flat 2, 1 Some Street");
    expect(result.summary).toContain("2 domestic certificates");
    expect(result.provenance).toMatchObject({ source: "epc-england-wales", basis: "measured", licence: "OGL" });
  });

  it("honours EPC_API_BASE and uses the uprn parameter for non-domestic search", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(domesticSearch), { status: 200 }));
    await runOperation(definition, "non-domestic-search", { uprn: "100023336956", page_size: 10 }, testContext(fetch, { ...env, EPC_API_BASE: "https://example.test/epc/" }));
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/epc/api/non-domestic/search?uprn=100023336956&page_size=10&current_page=1");
  });

  it("treats a 404 from search as an empty, unavailable result", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ error: "No certificates could be found for that query" }), { status: 404 }));
    const result = await runOperation(definition, "display-search", { postcode: "ZZ1 1ZZ" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("maps a certificate document to the detail row", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(certificate), { status: 200 }));
    const result = await runOperation(definition, "certificate", { certificate_number: "0000-0000-0000-0000-0001" }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://api.get-energy-performance-data.communities.gov.uk/api/certificate?certificate_number=0000-0000-0000-0000-0001");
    expect(result.rows?.[0]).toMatchObject({
      address: "1 Some Street, Whitbury",
      postcode: "SW10 0AA",
      current_energy_rating: "B",
      current_energy_efficiency: 84,
      potential_energy_rating: "A",
      total_floor_area_m2: 96,
      lodgement_date: "2020-05-04",
      property_type: "House",
      built_form: "Mid-Terrace",
      main_fuel: "mains gas (not community)",
    });
    expect(result.summary).toContain("rating B (84)");
    expect(result.provenance.basis).toBe("modelled");
  });

  it("extracts embedded recommendations", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(certificate), { status: 200 }));
    const result = await runOperation(definition, "recommendations", { certificate_number: "0000-0000-0000-0000-0001" }, testContext(fetch, env));
    expect(result.rows).toHaveLength(2);
    expect(result.rows?.[0]).toMatchObject({ sequence: 1, improvement: "Floor insulation (solid floor)", indicative_cost: "£4,000 - £6,000" });
  });

  it("rejects a search with no criteria and a bad certificate number before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "domestic-search", {}, testContext(fetch, env))).rejects.toThrow(/postcode, a UPRN or an address/);
    await expect(runOperation(definition, "certificate", { certificate_number: "abc" }, testContext(fetch, env))).rejects.toThrow(/Certificate number/);
    await expect(runOperation(definition, "domestic-search", { postcode: "not a postcode" }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly without a token and falls back to legacy Basic auth when only email and key are set", () => {
    expect(() => epcAuthHeader({})).toThrow(/EPC_API_TOKEN/);
    expect(epcAuthHeader({ EPC_API_EMAIL: "a@b.c", EPC_API_KEY: "k" })).toBe(`Basic ${Buffer.from("a@b.c:k").toString("base64")}`);
    expect(epcAuthHeader({ EPC_API_TOKEN: "t", EPC_API_EMAIL: "a@b.c", EPC_API_KEY: "k" })).toBe("Bearer t");
  });
});
