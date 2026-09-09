// Fixture mirrors the VES OpenAPI response schema; not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, normaliseRegistration } from "..";
import { runOperation, testContext } from "../../testing";
import vehicle from "./fixtures/vehicle.json";

const env = { DVLA_VES_API_KEY: "ves-key" };

describe("dvla-ves", () => {
  it("POSTs the registration with the x-api-key header and maps the record", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(vehicle), { status: 200 }));
    const result = await runOperation(definition, "lookup", { registration: "ab12 cde" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ves-key");
    expect(JSON.parse(String(init.body))).toEqual({ registrationNumber: "AB12CDE" });
    expect(result.rows?.[0]).toMatchObject({ registration: "AB12CDE", make: "FORD", fuel_type: "DIESEL", co2_g_km: 133, euro_status: "EURO6", first_registered: "2019-06" });
    expect(result.summary).toContain("133 g/km CO2");
    expect(result.provenance).toMatchObject({ source: "dvla-ves", basis: "measured", licence: "OGL" });
  });

  it("uses the UAT base when configured and warns when CO2 is missing", async () => {
    const { co2Emissions: _omit, ...older } = vehicle;
    void _omit;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...older, yearOfManufacture: 1998 }), { status: 200 }));
    const result = await runOperation(definition, "lookup", { registration: "R123ABC" }, testContext(fetch, { ...env, DVLA_VES_BASE: "https://uat.driver-vehicle-licensing.api.gov.uk/" }));
    expect(fetch.mock.calls[0][0]).toBe("https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles");
    expect(result.rows?.[0].co2_g_km).toBeNull();
    expect(result.warnings?.[0]).toMatch(/No CO2 figure/);
  });

  it("returns an empty unavailable result for a 404", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ status: "404", code: "404", title: "Vehicle Not Found", detail: "Record for vehicle not found" }] }), { status: 404 }));
    const result = await runOperation(definition, "lookup", { registration: "ZZ99ZZZ" }, testContext(fetch, env));
    expect(result.rows).toEqual([]);
    expect(result.summary).toContain("Record for vehicle not found");
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("validates before the network", async () => {
    const fetch = vi.fn();
    expect(() => normaliseRegistration("A")).toThrow();
    await expect(runOperation(definition, "lookup", { registration: "TOOLONGREG99" }, testContext(fetch, env))).rejects.toThrow();
    await expect(runOperation(definition, "lookup", { registration: "AB12CDE" }, testContext(fetch, {}))).rejects.toThrow(/DVLA_VES_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
