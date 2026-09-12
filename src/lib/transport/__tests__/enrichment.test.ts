/**
 * Vehicle enrichment tests.
 *
 * FIXTURES ARE DOCUMENTATION-DERIVED. Every JSON file under ./fixtures was
 * hand-written to match the response shapes published for the DVLA Vehicle
 * Enquiry Service v1 and the DVSA MOT History API v1 (trade). No live call has
 * been made to either service from this codebase, and every external host is
 * blocked in this environment, so all tests run against an injected fetch.
 *
 * The registrations, makes, models, CO2 figures and odometer values are
 * invented for test purposes. They are NOT real vehicle records and must never
 * be used as reference data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache } from "@/lib/integrations/dvsa-mot-history";
import type { FetchLike } from "@/lib/integrations/framework";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { CO2_TYPE_APPROVAL_WARNING, enrichVehicle, KM_TO_MILES, MILEAGE_USE_CAVEAT } from "../enrichment";
import dvlaVehicle from "./fixtures/dvla-vehicle.json";
import motClocked from "./fixtures/mot-vehicle-clocked.json";
import motKm from "./fixtures/mot-vehicle-km.json";
import motVehicle from "./fixtures/mot-vehicle.json";

const FULL_ENV = {
  DVLA_VES_API_KEY: "dvla-test-key",
  DVSA_MOT_CLIENT_ID: "client-id",
  DVSA_MOT_CLIENT_SECRET: "client-secret",
  DVSA_MOT_API_KEY: "mot-api-key",
  DVSA_MOT_TOKEN_URL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
};

const TOKEN_ROUTE = { match: "login.microsoftonline.com", body: { access_token: "tok-1", expires_in: 3600, token_type: "Bearer" } };

/** Wraps a fetch so the test can assert on what was (or was not) requested. */
function recording(inner: FetchLike) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    return inner(url, init);
  };
  return { fetch, calls };
}

beforeEach(() => clearTokenCache());

describe("enrichVehicle", () => {
  it("merges DVLA register facts with MOT model and mileage, and records both sources", async () => {
    const { fetch, calls } = recording(
      routedFetch([
        TOKEN_ROUTE,
        { match: "vehicle-enquiry/v1/vehicles", body: dvlaVehicle },
        { match: "history.mot.api.gov.uk", body: motVehicle },
      ]),
    );
    const result = await enrichVehicle("ab12 cde", testContext(fetch, FULL_ENV));

    expect(result.registration).toBe("AB12CDE");
    expect(result.facts).toMatchObject({
      make: "FORD",
      model: "MONDEO", // only the MOT record carries a model
      fuelType: "DIESEL", // DVLA wins over the MOT record's "Diesel"
      engineCapacityCc: 1997,
      co2GPerKm: 119,
      yearOfManufacture: 2016,
      monthOfFirstRegistration: "2016-03",
      euroStatus: "EURO 6",
      typeApproval: "M1",
      taxStatus: "Taxed",
      motStatus: "Valid",
      motExpiryDate: "2027-02-14",
    });

    expect(result.sources.map((s) => [s.id, s.ok])).toEqual([
      ["dvla-ves", true],
      ["dvsa-mot-history", true],
    ]);

    expect(result.mileage?.readings).toHaveLength(4);
    expect(result.mileage?.readings[0]).toEqual({ date: "2023-02-10", value: 62150, unit: "mi", resultType: "READ" });
    expect(result.mileage?.spanDays).toBe(1091);
    // 39,050 miles over 1,091 days, annualised.
    expect(result.mileage?.annualMileageMiles).toBe(Math.round((39050 / 1091) * 365.25));
    expect(result.mileage?.detail).toContain("miles per year");
    expect(result.mileage?.detail).toContain(MILEAGE_USE_CAVEAT);

    expect(result.provenance).toHaveLength(2);
    expect(result.provenance[0]).toMatchObject({ source: "dvla-ves", basis: "measured", licence: "OGL" });
    expect(result.provenance[1]).toMatchObject({ source: "dvsa-mot-history", basis: "estimated" });
    expect(result.provenance[1].dataset).toContain("odometer");

    expect(calls.some((u) => u.includes("vehicle-enquiry"))).toBe(true);
    expect(calls.some((u) => u.includes("/vehicles/registration/AB12CDE"))).toBe(true);
  });

  it("returns MOT data with a warning when DVLA does not know the vehicle (404)", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", status: 404, body: { errors: [{ status: "404", title: "Not Found", detail: "Vehicle not found" }] } },
      { match: "history.mot.api.gov.uk", body: motVehicle },
    ]);
    const result = await enrichVehicle("AB12CDE", testContext(fetch, FULL_ENV));

    const dvla = result.sources.find((s) => s.id === "dvla-ves");
    expect(dvla?.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("DVLA has no vehicle record for AB12CDE"))).toBe(true);

    // The MOT half still came back.
    expect(result.sources.find((s) => s.id === "dvsa-mot-history")?.ok).toBe(true);
    expect(result.facts.model).toBe("MONDEO");
    expect(result.mileage?.annualMileageMiles).toBeGreaterThan(0);
    expect(result.facts.co2GPerKm).toBeUndefined();
  });

  it("warns naming DVLA_VES_API_KEY when the DVLA key is missing, and does not throw", async () => {
    const envWithoutDvlaKey = { ...FULL_ENV, DVLA_VES_API_KEY: "" };
    const { fetch, calls } = recording(routedFetch([TOKEN_ROUTE, { match: "history.mot.api.gov.uk", body: motVehicle }]));

    const result = await enrichVehicle("AB12CDE", testContext(fetch, envWithoutDvlaKey));

    expect(result.sources.find((s) => s.id === "dvla-ves")).toMatchObject({ ok: false });
    expect(result.warnings.some((w) => w.includes("DVLA_VES_API_KEY"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("not configured"))).toBe(true);
    // NotConfiguredError is raised before any request, so DVLA was never called.
    expect(calls.some((u) => u.includes("vehicle-enquiry"))).toBe(false);
    // MOT still ran.
    expect(result.mileage?.annualMileageMiles).toBeGreaterThan(0);
    expect(result.provenance.map((p) => p.source)).toEqual(["dvsa-mot-history"]);
  });

  it("keeps DVLA facts and returns mileage null when the MOT API fails with 500", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", body: dvlaVehicle },
      { match: "history.mot.api.gov.uk", status: 500, body: { message: "Internal Server Error" } },
    ]);
    const result = await enrichVehicle("AB12CDE", testContext(fetch, FULL_ENV));

    expect(result.facts.make).toBe("FORD");
    expect(result.facts.co2GPerKm).toBe(119);
    expect(result.mileage).toBeNull();
    expect(result.sources.find((s) => s.id === "dvsa-mot-history")).toMatchObject({ ok: false });
    expect(result.warnings.some((w) => w.includes("DVSA MOT History lookup failed") && w.includes("500"))).toBe(true);
    expect(result.provenance.map((p) => p.source)).toEqual(["dvla-ves"]);
  });

  it("sorts readings, warns on a non-increasing reading and estimates from the clean span", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", status: 404, body: { errors: [{ detail: "Vehicle not found" }] } },
      { match: "history.mot.api.gov.uk", body: motClocked },
    ]);
    const result = await enrichVehicle("CD34EFG", testContext(fetch, FULL_ENV));

    // NO_ODOMETER test dropped; remaining four sorted oldest first.
    expect(result.mileage?.readings.map((r) => r.date)).toEqual(["2022-05-20", "2023-05-25", "2024-05-28", "2025-06-01"]);
    expect(result.warnings.some((w) => w.includes("no genuine odometer reading"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("is not higher than") && w.includes("2025-06-01"))).toBe(true);

    // The clean run is 30,000 -> 53,200 miles over 739 days; the 12,000 reading
    // after it starts a new (too short) run and is excluded.
    expect(result.mileage?.spanDays).toBe(739);
    expect(result.mileage?.annualMileageMiles).toBe(Math.round((23200 / 739) * 365.25));
    expect(result.mileage?.detail).toContain("2022-05-20");
    expect(result.mileage?.detail).toContain("2024-05-28");
    expect(result.mileage?.detail).toContain(MILEAGE_USE_CAVEAT);
  });

  it("converts kilometre odometer readings to miles and says so", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", status: 404, body: { errors: [{ detail: "Vehicle not found" }] } },
      { match: "history.mot.api.gov.uk", body: motKm },
    ]);
    const result = await enrichVehicle("EF56GHJ", testContext(fetch, FULL_ENV));

    // Readings are preserved in the units the tester recorded.
    expect(result.mileage?.readings).toEqual([
      { date: "2024-04-01", value: 80000, unit: "km", resultType: "READ" },
      { date: "2025-04-01", value: 96000, unit: "km", resultType: "READ" },
    ]);
    expect(result.mileage?.spanDays).toBe(365);
    const expectedMiles = (96000 - 80000) * KM_TO_MILES;
    expect(result.mileage?.annualMileageMiles).toBe(Math.round((expectedMiles / 365) * 365.25));
    expect(result.warnings.some((w) => w.includes("kilometres") && w.includes("0.621371"))).toBe(true);
    expect(result.mileage?.detail).toContain("kilometres");
  });

  it("throws RangeError for an invalid registration before any fetch", async () => {
    const { fetch, calls } = recording(routedFetch([TOKEN_ROUTE]));
    const ctx = testContext(fetch, FULL_ENV);

    await expect(enrichVehicle("", ctx)).rejects.toBeInstanceOf(RangeError);
    await expect(enrichVehicle("A", ctx)).rejects.toBeInstanceOf(RangeError);
    await expect(enrichVehicle("AB12CDE!", ctx)).rejects.toBeInstanceOf(RangeError);
    await expect(enrichVehicle("TOOLONGREG9", ctx)).rejects.toThrow(/not a valid UK vehicle registration/);
    expect(calls).toEqual([]);
  });

  it("always carries the type-approval CO2 warning whenever co2GPerKm is set", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", body: dvlaVehicle },
      { match: "history.mot.api.gov.uk", body: motVehicle },
    ]);

    const withMot = await enrichVehicle("AB12CDE", testContext(fetch, FULL_ENV));
    expect(withMot.facts.co2GPerKm).toBe(119);
    expect(withMot.warnings).toContain(CO2_TYPE_APPROVAL_WARNING);
    expect(CO2_TYPE_APPROVAL_WARNING).toContain("DESNZ");
    expect(CO2_TYPE_APPROVAL_WARNING).toContain("not a real-world emission factor");

    clearTokenCache();
    const withoutMot = await enrichVehicle("AB12CDE", testContext(fetch, FULL_ENV), { includeMot: false });
    expect(withoutMot.warnings).toContain(CO2_TYPE_APPROVAL_WARNING);
    expect(withoutMot.mileage).toBeNull();
    expect(withoutMot.sources.find((s) => s.id === "dvsa-mot-history")?.ok).toBe(false);
  });

  it("returns a result rather than throwing when every source fails", async () => {
    const fetch = routedFetch([
      TOKEN_ROUTE,
      { match: "vehicle-enquiry/v1/vehicles", status: 503, body: { message: "Service Unavailable" } },
      { match: "history.mot.api.gov.uk", status: 503, body: { message: "Service Unavailable" } },
    ]);
    const result = await enrichVehicle("AB12CDE", testContext(fetch, FULL_ENV));

    expect(result.facts).toEqual({});
    expect(result.mileage).toBeNull();
    expect(result.provenance).toEqual([]);
    expect(result.sources.every((s) => !s.ok)).toBe(true);
    expect(result.warnings.some((w) => w.includes("No source returned a record"))).toBe(true);
  });
});
