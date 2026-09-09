import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike } from "../framework";
import { assertRange } from "../_shared/dates";

/**
 * Samsara Fleet API (telematics). Minimal, built from the published OpenAPI
 * specification (mirrored at api-evangelist/samsara): GET /fleet/vehicles
 * and GET /fleet/reports/vehicles/fuel-energy (startDate/endDate, RFC 3339
 * dates; response data.vehicleReports[]). No live call has been made from
 * this codebase.
 */

export const BASE = "https://api.samsara.com";

function headers(env: EnvLike): Record<string, string> {
  const token = env.SAMSARA_API_TOKEN?.trim();
  if (!token) throw new Error("SAMSARA_API_TOKEN is not set. Create an API token in the Samsara dashboard (Settings > API Tokens) with Read Vehicles and Read Fuel & Energy scopes.");
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

interface Vehicle {
  id?: string;
  name?: string;
  vin?: string;
  make?: string;
  model?: string;
  year?: string;
  licensePlate?: string;
  vehicleType?: string;
  externalIds?: Record<string, string>;
  tags?: { id?: string; name?: string }[];
}
interface VehiclesResponse {
  data?: Vehicle[];
  pagination?: { endCursor?: string; hasNextPage?: boolean };
}
interface FuelEnergyReport {
  vehicle?: { id?: string; name?: string; energyType?: string; externalIds?: Record<string, string> };
  distanceTraveledMeters?: number;
  efficiencyMpge?: number;
  energyUsedKwh?: number;
  fuelConsumedMl?: number;
  engineIdleTimeDurationMs?: number;
  engineRunTimeDurationMs?: number;
  estCarbonEmissionsKg?: number;
  estFuelEnergyCost?: { amount?: number; currencyCode?: string };
}
interface FuelEnergyResponse {
  data?: { vehicleReports?: FuelEnergyReport[] };
  pagination?: { endCursor?: string; hasNextPage?: boolean };
}

export function fuelRow(r: FuelEnergyReport) {
  const km = r.distanceTraveledMeters !== undefined ? Math.round(r.distanceTraveledMeters / 100) / 10 : null;
  const litres = r.fuelConsumedMl !== undefined ? Math.round(r.fuelConsumedMl / 10) / 100 : null;
  return {
    vehicle: r.vehicle?.name ?? r.vehicle?.id ?? null,
    vehicle_id: r.vehicle?.id ?? null,
    energy_type: r.vehicle?.energyType ?? null,
    distance_km: km,
    fuel_litres: litres,
    energy_kwh: r.energyUsedKwh ?? null,
    litres_per_100km: km && litres && km > 0 ? Math.round((litres / km) * 10000) / 100 : null,
    efficiency_mpge_us: r.efficiencyMpge ?? null,
    idle_hours: r.engineIdleTimeDurationMs !== undefined ? Math.round(r.engineIdleTimeDurationMs / 36000) / 100 : null,
    samsara_est_co2_kg: r.estCarbonEmissionsKg ?? null,
    est_cost: r.estFuelEnergyCost?.amount ?? null,
    currency: r.estFuelEnergyCost?.currencyCode ?? null,
  };
}

export const definition = defineIntegration({
  id: "samsara-fleet",
  name: "Samsara Fleet",
  group: "transport",
  access: "authorised",
  territory: "Global",
  description: "Client's own Samsara telematics: vehicle list and per-vehicle fuel consumed, energy used and distance for a date range, for Scope 1 fleet emissions from measured fuel rather than mileage estimates.",
  docsUrl: "https://developers.samsara.com/reference/getfuelenergyvehiclereports",
  termsUrl: "https://developers.samsara.com/docs/authentication",
  attribution: "Fleet telematics data from the client's Samsara account, used with the client's authorisation.",
  licence: "consent_based",
  envVars: [
    { name: "SAMSARA_API_TOKEN", required: true, description: "API token from the client's Samsara organisation with Read Vehicles and Read Fuel & Energy scopes; sent as a Bearer token." },
    { name: "SAMSARA_API_BASE", required: false, description: `API base URL. Default ${BASE}; EU-hosted organisations use https://api.eu.samsara.com.` },
  ],
  status: "built_unverified",
  notes: [
    "Commercial telematics: the client creates a read-only API token in their Samsara organisation and shares it under a data-sharing agreement. EU-hosted organisations use https://api.eu.samsara.com (set SAMSARA_API_BASE).",
    "The fuel-energy report takes startDate and endDate (RFC 3339; only the date part is used, inclusive) per the OpenAPI spec, not startTime/endTime. Samsara advises that the most recent 72 hours may still be processing.",
    "Fuel consumed comes from the vehicle's engine data (CAN bus) and is reported in millilitres; energy in kWh for hybrid and electric vehicles. Samsara's estCarbonEmissionsKg uses its own factors; the portal should recompute with DESNZ factors from litres and kWh.",
    "Rate limit 25 requests/second on these routes; pagination via pagination.endCursor and the after parameter (first page only fetched here).",
  ],
  healthCheck: simpleHealth((env) => buildUrl(env.SAMSARA_API_BASE?.trim() || BASE, "fleet/vehicles", { limit: 1 }), (env) => ({ headers: headers(env) })),
  operations: [
    {
      id: "vehicles",
      label: "List vehicles",
      description: "Vehicles in the Samsara organisation with make, model, year and plate.",
      params: [{ name: "limit", label: "Maximum vehicles", type: "integer", default: 100, min: 1, max: 512 }],
      async run(params, ctx) {
        const base = ctx.env.SAMSARA_API_BASE?.trim() || BASE;
        const { data } = await fetchJson<VehiclesResponse>(ctx, buildUrl(base, "fleet/vehicles", { limit: params.limit as number }), { headers: headers(ctx.env) });
        const rows = (data.data ?? []).map((v) => ({
          vehicle_id: v.id ?? null,
          name: v.name ?? null,
          plate: v.licensePlate ?? null,
          vin: v.vin ?? null,
          make: v.make ?? null,
          model: v.model ?? null,
          year: v.year ?? null,
          type: v.vehicleType ?? null,
          tags: (v.tags ?? []).map((t) => t.name).filter(Boolean).join("; ") || null,
        }));
        return {
          summary: `${rows.length} vehicles returned${data.pagination?.hasNextPage ? " (more pages available)" : ""}.`,
          columns: ["vehicle_id", "name", "plate", "vin", "make", "model", "year", "type", "tags"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "fleet/vehicles", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "fuel_energy",
      label: "Fuel and energy report for a date range",
      description: "Per-vehicle distance, fuel consumed, energy used and idle time between two dates (up to 366 days).",
      params: [
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2026-01-01" },
        { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2026-12-31" },
        { name: "vehicle_ids", label: "Vehicle ids (optional)", type: "string", placeholder: "1234,5678", help: "Comma-separated Samsara vehicle ids or externalIds." },
        { name: "energy_type", label: "Energy type", type: "select", default: "", options: [{ value: "", label: "All" }, { value: "fuel", label: "Fuel" }, { value: "hybrid", label: "Hybrid" }, { value: "electric", label: "Electric" }] },
      ],
      async run(params, ctx) {
        const start = String(params.start_date);
        const end = String(params.end_date);
        assertRange(start, end, 366, "report range");
        const base = ctx.env.SAMSARA_API_BASE?.trim() || BASE;
        const url = buildUrl(base, "fleet/reports/vehicles/fuel-energy", {
          startDate: `${start}T00:00:00Z`,
          endDate: `${end}T00:00:00Z`,
          vehicleIds: params.vehicle_ids ? String(params.vehicle_ids).replace(/\s+/g, "") : undefined,
          energyType: params.energy_type ? String(params.energy_type) : undefined,
        });
        const { data } = await fetchJson<FuelEnergyResponse>(ctx, url, { headers: headers(ctx.env) }, { timeoutMs: 60_000 });
        const rows = (data.data?.vehicleReports ?? []).map(fuelRow);
        const km = rows.reduce((s, r) => s + (r.distance_km ?? 0), 0);
        const litres = rows.reduce((s, r) => s + (r.fuel_litres ?? 0), 0);
        const kwh = rows.reduce((s, r) => s + (r.energy_kwh ?? 0), 0);
        return {
          summary: `${rows.length} vehicles ${start} to ${end}: ${Math.round(km).toLocaleString("en-GB")} km, ${Math.round(litres).toLocaleString("en-GB")} litres of fuel, ${Math.round(kwh).toLocaleString("en-GB")} kWh of electricity.`,
          columns: ["vehicle", "vehicle_id", "energy_type", "distance_km", "fuel_litres", "energy_kwh", "litres_per_100km", "efficiency_mpge_us", "idle_hours", "samsara_est_co2_kg", "est_cost", "currency"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "fleet/reports/vehicles/fuel-energy", basis: rows.length ? "measured" : "unavailable" }),
          warnings: [
            "Fuel and energy are engine-reported telematics values; compute emissions with DESNZ factors rather than Samsara's estimate.",
            "Data for the most recent 72 hours may be incomplete.",
          ],
        };
      },
    },
  ],
});
