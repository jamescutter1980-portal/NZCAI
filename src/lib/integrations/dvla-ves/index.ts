import { defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult } from "../framework";

/**
 * DVLA Vehicle Enquiry Service (VES) API v1.
 *
 * Built from the published OpenAPI document (mirrored in
 * microsoft/PowerPlatformConnectors) and open-source clients; no live call
 * has been made from this codebase.
 */

export const DEFAULT_BASE = "https://driver-vehicle-licensing.api.gov.uk";
export const UAT_BASE = "https://uat.driver-vehicle-licensing.api.gov.uk";

export function vesBase(env: EnvLike): string {
  return (env.DVLA_VES_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

function apiKey(env: EnvLike): string {
  const key = env.DVLA_VES_API_KEY?.trim();
  if (!key) throw new Error("DVLA_VES_API_KEY is not set. Apply for access at https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/");
  return key;
}

export function normaliseRegistration(raw: string): string {
  const reg = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (reg.length < 2 || reg.length > 7) throw new Error("Registration number must be 2 to 7 letters and digits");
  return reg;
}

export interface Vehicle {
  registrationNumber: string;
  make?: string;
  colour?: string;
  fuelType?: string;
  engineCapacity?: number;
  co2Emissions?: number;
  yearOfManufacture?: number;
  monthOfFirstRegistration?: string;
  monthOfFirstDvlaRegistration?: string;
  taxStatus?: string;
  taxDueDate?: string;
  artEndDate?: string;
  motStatus?: string;
  motExpiryDate?: string;
  euroStatus?: string;
  realDrivingEmissions?: string;
  typeApproval?: string;
  wheelplan?: string;
  markedForExport?: boolean;
  revenueWeight?: number;
  dateOfLastV5CIssued?: string;
  automatedVehicle?: boolean;
}

export const COLUMNS = ["registration", "make", "colour", "fuel_type", "engine_cc", "co2_g_km", "year_of_manufacture", "first_registered", "tax_status", "tax_due", "mot_status", "mot_expiry", "euro_status", "type_approval", "wheelplan", "revenue_weight_kg", "marked_for_export"];

export function toRow(v: Vehicle) {
  return {
    registration: v.registrationNumber,
    make: v.make ?? null,
    colour: v.colour ?? null,
    fuel_type: v.fuelType ?? null,
    engine_cc: v.engineCapacity ?? null,
    co2_g_km: v.co2Emissions ?? null,
    year_of_manufacture: v.yearOfManufacture ?? null,
    first_registered: v.monthOfFirstRegistration ?? v.monthOfFirstDvlaRegistration ?? null,
    tax_status: v.taxStatus ?? null,
    tax_due: v.taxDueDate ?? null,
    mot_status: v.motStatus ?? null,
    mot_expiry: v.motExpiryDate ?? null,
    euro_status: v.euroStatus ?? null,
    type_approval: v.typeApproval ?? null,
    wheelplan: v.wheelplan ?? null,
    revenue_weight_kg: v.revenueWeight ?? null,
    marked_for_export: v.markedForExport ?? null,
  };
}

export const definition = defineIntegration({
  id: "dvla-ves",
  name: "DVLA Vehicle Enquiry Service",
  group: "transport",
  access: "open_key",
  territory: "UK",
  description: "Registered vehicle details from a registration number: make, fuel type, engine size, official CO2 g/km, year, Euro status, tax and MOT status. Used to build fleet and grey-fleet emission profiles.",
  docsUrl: "https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html",
  termsUrl: "https://developer-portal.driver-vehicle-licensing.api.gov.uk/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Driver and Vehicle Licensing Agency, Vehicle Enquiry Service.",
  licence: "OGL",
  envVars: [
    { name: "DVLA_VES_API_KEY", required: true, description: "API key issued after application and review on the DVLA developer portal; sent as x-api-key." },
    { name: "DVLA_VES_BASE", required: false, description: `Base URL override. Default ${DEFAULT_BASE}; use ${UAT_BASE} with a test key.` },
  ],
  status: "built_unverified",
  notes: [
    "Access is by application on the DVLA developer portal and is reviewed; keys are issued for a stated purpose and the terms restrict bulk use. A UAT environment with fixed test registrations is available for development.",
    "co2Emissions is the type-approval figure (NEDC or WLTP depending on age) and is absent for many vehicles registered before 2001 and for some imports; treat a missing value as unknown, not zero.",
    "Fuel type and engine size are DVLA records, not measured consumption; combine with mileage (MOT history) and DESNZ factors for emissions.",
    "The API rate limit is enforced per key (HTTP 429); no published figure.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    try {
      const key = apiKey(ctx.env);
      const res = await ctx.fetch(`${vesBase(ctx.env)}/vehicle-enquiry/v1/vehicles`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ registrationNumber: "AA19AAA" }),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (res.ok || res.status === 404) return { ok: true, detail: `HTTP ${res.status} (key accepted)`, latencyMs };
      return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "lookup",
      label: "Vehicle lookup by registration",
      description: "DVLA record for one registration number.",
      params: [{ name: "registration", label: "Registration number", type: "string", required: true, placeholder: "AB12 CDE" }],
      async run(params, ctx) {
        const registrationNumber = normaliseRegistration(String(params.registration));
        const key = apiKey(ctx.env);
        const url = `${vesBase(ctx.env)}/vehicle-enquiry/v1/vehicles`;
        const { data, status } = await fetchJson<Vehicle & { errors?: { status?: string; title?: string; detail?: string }[] }>(
          ctx,
          url,
          { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ registrationNumber }) },
          { acceptStatuses: [400, 404] },
        );
        if (status === 404 || status === 400 || !data?.registrationNumber) {
          const detail = data?.errors?.[0]?.detail ?? data?.errors?.[0]?.title ?? (status === 404 ? "Vehicle not found" : "Bad request");
          return { summary: `${registrationNumber}: ${detail}.`, rows: [], columns: COLUMNS, raw: data, provenance: makeProvenance(definition, ctx, { dataset: "vehicle-enquiry", basis: "unavailable" }) };
        }
        const row = toRow(data);
        const warnings: string[] = [];
        if (row.co2_g_km === null) warnings.push("No CO2 figure on the DVLA record (common for pre-2001 vehicles and imports); use fuel type and engine size with a DESNZ average factor instead.");
        if (row.fuel_type && /electric/i.test(row.fuel_type) && row.co2_g_km === 0) warnings.push("Tailpipe CO2 is 0 for a battery-electric vehicle; charging electricity is Scope 2.");
        return {
          summary: `${row.registration}: ${row.year_of_manufacture ?? "unknown year"} ${row.make ?? "unknown make"}, ${row.fuel_type ?? "unknown fuel"}${row.engine_cc ? ` ${row.engine_cc} cc` : ""}, ${row.co2_g_km !== null ? `${row.co2_g_km} g/km CO2` : "no CO2 figure"}. Tax ${row.tax_status ?? "n/a"}, MOT ${row.mot_status ?? "n/a"}.`,
          columns: COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "vehicle-enquiry", basis: "measured" }),
          warnings,
        };
      },
    },
  ],
});
