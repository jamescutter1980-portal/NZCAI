// Fixture mirrors the documented JSON API response (response.type
// "LocationDataResponse", dataSets keyed by our spec keys, values with d/ld/v/pe);
// built from client code and docs, not a live call.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ENDPOINT, base64url, definition, signRequest } from "..";
import { runOperation, testContext } from "../../testing";
import locationData from "./fixtures/location-data.json";

const env = { DEGREE_DAYS_ACCOUNT_KEY: "test-test-test", DEGREE_DAYS_SECURITY_KEY: "test-test-test-test-test-test-test-test-test-test-test-test-test" };

function decode(b64url: string): string {
  return Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("degree-days-net", () => {
  it("signs the request with HMAC-SHA256 over the JSON and posts form-encoded fields", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(locationData), { status: 200 }));
    const result = await runOperation(definition, "degree-days", { postcode: "sw1a 1aa", start_date: "2025-01-01", end_date: "2025-02-28", breakdown: "monthly" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("request_encoding")).toBe("base64url");
    expect(form.get("signature_method")).toBe("HmacSHA256");
    expect(form.get("signature_encoding")).toBe("base64url");
    const json = decode(form.get("encoded_request")!);
    const expectedSig = base64url(createHmac("sha256", env.DEGREE_DAYS_SECURITY_KEY).update(Buffer.from(json, "utf8")).digest());
    expect(form.get("encoded_signature")).toBe(expectedSig);
    expect(form.get("encoded_signature")).not.toMatch(/[+/=]/);
    const envelope = JSON.parse(json);
    expect(envelope.securityInfo).toMatchObject({ endpoint: ENDPOINT, accountKey: "test-test-test", timestamp: "2026-09-09T12:00:00Z" });
    expect(typeof envelope.securityInfo.random).toBe("string");
    expect(envelope.request).toMatchObject({
      type: "LocationDataRequest",
      location: { type: "PostalCodeLocation", postalCode: "SW1A1AA", countryCode: "GB" },
      dataSpecs: {
        hdd: { type: "DatedDataSpec", calculation: { type: "HeatingDegreeDaysCalculation", baseTemperature: { unit: "C", value: 15.5 } }, breakdown: { type: "MonthlyBreakdown", period: { type: "DayRangePeriod", dayRange: { first: "2025-01-01", last: "2025-02-28" } } } },
        cdd: { calculation: { type: "CoolingDegreeDaysCalculation", baseTemperature: { unit: "C", value: 22 } } },
      },
    });
    expect(result.rows).toEqual([
      { period_start: "2025-01-01", period_end: "2025-01-31", hdd: 310.2, cdd: 0, hdd_pct_estimated: 0.9, cdd_pct_estimated: 0 },
      { period_start: "2025-02-01", period_end: "2025-02-28", hdd: 250.7, cdd: 0, hdd_pct_estimated: 0, cdd_pct_estimated: 0 },
    ]);
    expect(result.summary).toContain("561 heating degree days");
    expect(result.summary).toContain("station EGLC");
    expect(result.provenance).toMatchObject({ source: "degree-days-net", basis: "estimated", licence: "commercial" });
    expect(result.warnings?.join(" ")).toContain("940 request units left");
  });

  it("uses a LongLatLocation and daily breakdown for coordinates", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(locationData), { status: 200 }));
    await runOperation(definition, "degree-days", { latitude: 51.5, longitude: -0.12, start_date: "2025-01-01", end_date: "2025-01-31", breakdown: "daily", hdd_base: 18 }, testContext(fetch, env));
    const form = new URLSearchParams(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const envelope = JSON.parse(decode(form.get("encoded_request")!));
    expect(envelope.request.location).toEqual({ type: "LongLatLocation", longLat: { longitude: -0.12, latitude: 51.5 } });
    expect(envelope.request.dataSpecs.hdd.breakdown.type).toBe("DailyBreakdown");
    expect(envelope.request.dataSpecs.hdd.calculation.baseTemperature.value).toBe(18);
  });

  it("reports a location failure as an empty result and throws on account failures", async () => {
    const locFail = vi.fn(async () => new Response(JSON.stringify({ response: { type: "Failure", code: "LocationNotSupported", message: "No station" } }), { status: 200 }));
    const result = await runOperation(definition, "degree-days", { postcode: "ZZ1 1ZZ", start_date: "2025-01-01", end_date: "2025-01-31" }, testContext(locFail, env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const authFail = vi.fn(async () => new Response(JSON.stringify({ response: { type: "Failure", code: "InvalidRequestAccount", message: "Bad key" } }), { status: 200 }));
    await expect(runOperation(definition, "degree-days", { postcode: "SW1A 1AA", start_date: "2025-01-01", end_date: "2025-01-31" }, testContext(authFail, env))).rejects.toMatchObject({ status: 401 });
  });

  it("validates location, keys and range before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "degree-days", { start_date: "2025-01-01", end_date: "2025-01-31" }, testContext(fetch, env))).rejects.toThrow(/postcode or both/);
    await expect(runOperation(definition, "degree-days", { postcode: "SW1A 1AA", start_date: "2025-01-01", end_date: "2025-01-31" }, testContext(fetch, {}))).rejects.toThrow(/DEGREE_DAYS/);
    await expect(runOperation(definition, "degree-days", { postcode: "SW1A 1AA", start_date: "2024-01-01", end_date: "2025-06-01", breakdown: "daily" }, testContext(fetch, env))).rejects.toThrow(/too long/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signRequest matches a hand-computed vector", () => {
    const out = signRequest("{\"a\":1}", "k");
    expect(out.encoded_request).toBe("eyJhIjoxfQ");
    expect(out.encoded_signature).toBe(base64url(createHmac("sha256", "k").update("{\"a\":1}").digest()));
  });
});
