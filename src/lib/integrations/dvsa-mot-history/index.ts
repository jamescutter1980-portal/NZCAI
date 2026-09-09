import { defineIntegration, fetchJson, IntegrationHttpError, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * DVSA MOT History API (trade access, OAuth2 client credentials via Azure AD).
 *
 * Built from the DVSA documentation and open-source clients that call
 * history.mot.api.gov.uk; no live call has been made from this codebase.
 */

export const BASE = "https://history.mot.api.gov.uk/v1/trade";
export const SCOPE = "https://tapi.dvsa.gov.uk/.default";

export function normaliseRegistration(raw: string): string {
  const reg = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (reg.length < 2 || reg.length > 7) throw new Error("Registration number must be 2 to 7 letters and digits");
  return reg;
}

function config(env: EnvLike) {
  const missing = ["DVSA_MOT_CLIENT_ID", "DVSA_MOT_CLIENT_SECRET", "DVSA_MOT_API_KEY", "DVSA_MOT_TOKEN_URL"].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Register for the MOT History API at https://documentation.history.mot.api.gov.uk/ to receive these from DVSA.`);
  return {
    clientId: env.DVSA_MOT_CLIENT_ID!.trim(),
    clientSecret: env.DVSA_MOT_CLIENT_SECRET!.trim(),
    apiKey: env.DVSA_MOT_API_KEY!.trim(),
    tokenUrl: env.DVSA_MOT_TOKEN_URL!.trim(),
    scope: env.DVSA_MOT_SCOPE?.trim() || SCOPE,
  };
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenEntry>();

/** Clears cached access tokens (tests). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

export async function getAccessToken(ctx: OperationContext): Promise<string> {
  const cfg = config(ctx.env);
  const key = `${cfg.tokenUrl}|${cfg.clientId}`;
  const hit = tokenCache.get(key);
  const now = ctx.now().getTime();
  if (hit && hit.expiresAt > now + 60_000) return hit.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: cfg.scope });
  const { data } = await fetchJson<{ access_token?: string; expires_in?: number; token_type?: string }>(ctx, cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!data?.access_token) throw new IntegrationHttpError("Token endpoint returned no access_token", 200, cfg.tokenUrl, JSON.stringify(data).slice(0, 500));
  tokenCache.set(key, { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

export interface MotTest {
  completedDate?: string;
  testResult?: string;
  expiryDate?: string;
  odometerValue?: string | number;
  odometerUnit?: string;
  odometerResultType?: string;
  motTestNumber?: string;
  dataSource?: string;
  defects?: { text?: string; type?: string; dangerous?: boolean }[];
}
export interface MotVehicle {
  registration?: string;
  make?: string;
  model?: string;
  firstUsedDate?: string;
  fuelType?: string;
  primaryColour?: string;
  registrationDate?: string;
  manufactureDate?: string;
  engineSize?: string;
  hasOutstandingRecall?: string;
  motTests?: MotTest[];
  motTestDueDate?: string;
}

async function fetchVehicle(ctx: OperationContext, registration: string) {
  const token = await getAccessToken(ctx);
  const cfg = config(ctx.env);
  return fetchJson<MotVehicle & { errorMessage?: string; errors?: unknown[] }>(ctx, `${BASE}/vehicles/registration/${encodeURIComponent(registration)}`, { headers: { authorization: `Bearer ${token}`, "x-api-key": cfg.apiKey } }, { acceptStatuses: [404] });
}

export interface Reading {
  date: string;
  miles: number;
}

/** Odometer readings in miles, oldest first, from READ (not NO_ODOMETER / NOT_READABLE) results. */
export function odometerReadings(tests: MotTest[]): Reading[] {
  const out: Reading[] = [];
  for (const t of tests) {
    const type = (t.odometerResultType ?? "READ").toUpperCase();
    const raw = Number(String(t.odometerValue ?? "").replace(/[^0-9.]/g, ""));
    if (!t.completedDate || type !== "READ" || !Number.isFinite(raw) || raw <= 0) continue;
    const miles = (t.odometerUnit ?? "MI").toUpperCase().startsWith("K") ? raw / 1.609344 : raw;
    out.push({ date: t.completedDate.slice(0, 10), miles: Math.round(miles) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface MileageEstimate {
  from: string;
  to: string;
  days: number;
  miles: number;
  miles_per_year: number;
}

/** Annualised mileage between consecutive readings; ignores gaps under 30 days and non-increasing readings. */
export function annualMileage(readings: Reading[]): MileageEstimate[] {
  const out: MileageEstimate[] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const days = Math.round((Date.parse(b.date) - Date.parse(a.date)) / 86_400_000);
    const miles = b.miles - a.miles;
    if (days < 30 || miles < 0) continue;
    out.push({ from: a.date, to: b.date, days, miles, miles_per_year: Math.round((miles / days) * 365.25) });
  }
  return out;
}

const REG_PARAM = { name: "registration", label: "Registration number", type: "string" as const, required: true, placeholder: "AB12 CDE" };

export const definition = defineIntegration({
  id: "dvsa-mot-history",
  name: "DVSA MOT History",
  group: "transport",
  access: "open_key",
  territory: "GB and NI",
  description: "MOT test history for a registration: results, expiry, defects and odometer readings, from which annual mileage is estimated for fleet and grey-fleet emissions.",
  docsUrl: "https://documentation.history.mot.api.gov.uk/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Driver and Vehicle Standards Agency, MOT History API.",
  licence: "OGL",
  envVars: [
    { name: "DVSA_MOT_CLIENT_ID", required: true, description: "Azure AD application (client) id from DVSA onboarding." },
    { name: "DVSA_MOT_CLIENT_SECRET", required: true, description: "Client secret from DVSA onboarding." },
    { name: "DVSA_MOT_API_KEY", required: true, description: "API key from DVSA onboarding, sent as X-API-Key." },
    { name: "DVSA_MOT_TOKEN_URL", required: true, description: "Azure AD token endpoint from onboarding (https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token)." },
    { name: "DVSA_MOT_SCOPE", required: false, description: `OAuth scope; default ${SCOPE}.` },
  ],
  status: "built_unverified",
  notes: [
    "Access requires registration with DVSA (trade API); credentials arrive by email and the client secret expires periodically. Tokens are cached in memory until shortly before expiry.",
    "Odometer readings are taken at MOT tests only (annually from the vehicle's third or fourth year), so mileage estimates are between test dates and cannot separate business from private use; ask the driver or use telematics for the split.",
    "Vehicles under three years old, and some exempt vehicles, have no MOT record. Northern Ireland tests are included since 2024 but odometer history may be shorter.",
    "Rate limits: DVSA quotas per client (documented as requests per second and per day); HTTP 429 when exceeded.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    try {
      await getAccessToken(ctx);
      return { ok: true, detail: "Access token obtained", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "history",
      label: "MOT history for a registration",
      description: "Every MOT test on record with result, expiry, odometer and defect count; latest first.",
      params: [REG_PARAM],
      async run(params, ctx) {
        const registration = normaliseRegistration(String(params.registration));
        const { data, status } = await fetchVehicle(ctx, registration);
        if (status === 404 || !data?.registration) {
          return { summary: `${registration}: no MOT record found (vehicle under 3 years old, exempt, or unknown).`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "vehicles/registration", basis: "unavailable" }) };
        }
        const tests = [...(data.motTests ?? [])].sort((a, b) => (b.completedDate ?? "").localeCompare(a.completedDate ?? ""));
        const rows = tests.map((t) => ({
          test_date: t.completedDate ?? null,
          result: t.testResult ?? null,
          expiry: t.expiryDate ?? null,
          odometer: t.odometerValue ?? null,
          odometer_unit: t.odometerUnit ?? null,
          odometer_type: t.odometerResultType ?? null,
          defects: (t.defects ?? []).length,
          dangerous_defects: (t.defects ?? []).filter((d) => d.dangerous).length,
          test_number: t.motTestNumber ?? null,
        }));
        const latestReading = odometerReadings(tests).at(-1);
        return {
          summary: `${data.registration}: ${data.make ?? ""} ${data.model ?? ""} (${data.fuelType ?? "unknown fuel"}), ${tests.length} MOT test(s); latest ${rows[0]?.result ?? "n/a"} on ${rows[0]?.test_date?.slice(0, 10) ?? "n/a"}${latestReading ? `, odometer ${latestReading.miles.toLocaleString("en-GB")} miles` : ""}.`,
          columns: ["test_date", "result", "expiry", "odometer", "odometer_unit", "odometer_type", "defects", "dangerous_defects", "test_number"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "vehicles/registration", basis: "measured" }),
        };
      },
    },
    {
      id: "mileage",
      label: "Annual mileage estimate from MOT odometer readings",
      description: "Miles between consecutive MOT tests, annualised, plus the latest reading.",
      params: [REG_PARAM],
      async run(params, ctx) {
        const registration = normaliseRegistration(String(params.registration));
        const { data, status } = await fetchVehicle(ctx, registration);
        if (status === 404 || !data?.registration) {
          return { summary: `${registration}: no MOT record found.`, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "vehicles/registration", basis: "unavailable" }) };
        }
        const readings = odometerReadings(data.motTests ?? []);
        const estimates = annualMileage(readings);
        const latest = readings.at(-1);
        const recent = estimates.at(-1);
        const overall = readings.length >= 2 ? annualMileage([readings[0], readings[readings.length - 1]])[0] : undefined;
        return {
          summary: latest
            ? `${data.registration}: latest odometer ${latest.miles.toLocaleString("en-GB")} miles on ${latest.date}.${recent ? ` Most recent interval ${recent.miles_per_year.toLocaleString("en-GB")} miles/year (${recent.from} to ${recent.to}).` : ""}${overall ? ` Average since first reading ${overall.miles_per_year.toLocaleString("en-GB")} miles/year.` : ""}`
            : `${data.registration}: no usable odometer readings on the MOT record.`,
          columns: ["from", "to", "days", "miles", "miles_per_year"],
          rows: estimates,
          raw: { registration: data.registration, make: data.make, model: data.model, fuelType: data.fuelType, readings, latest, overall },
          provenance: makeProvenance(definition, ctx, { dataset: "vehicles/registration (odometer)", basis: estimates.length ? "estimated" : "unavailable" }),
          warnings: [
            "Mileage is between MOT test dates only and cannot separate business from private use.",
            "Odometer readings are as entered by the tester; clocking, unit changes and replacement instruments produce gaps that are skipped here.",
          ],
        };
      },
    },
  ],
});
