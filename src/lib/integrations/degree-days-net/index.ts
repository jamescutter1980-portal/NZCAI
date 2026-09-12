import { createHmac, randomUUID } from "node:crypto";
import { IntegrationHttpError, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";
import { UK_CDD_BASE_C, UK_HDD_BASE_C } from "../_shared/degree-days";

/**
 * Degree Days.net JSON API.
 *
 * Request signing reproduced from the official Python client (degreedays 1.4.1,
 * degreedays/api/_processing.py, which signs the XML API in the same way) and an
 * open-source client of the JSON endpoint. Scheme:
 *   1. Build the request JSON: {"securityInfo": {endpoint, accountKey, timestamp, random}, "request": {...}}.
 *   2. signature = HMAC-SHA256(securityKey bytes, request JSON bytes).
 *   3. POST application/x-www-form-urlencoded with request_encoding=base64url,
 *      signature_method=HmacSHA256, signature_encoding=base64url,
 *      encoded_request=<base64url(json) without padding>, encoded_signature=<base64url(sig) without padding>.
 * The securityInfo.endpoint value must equal the URL the request is posted to.
 * UNCONFIRMED (docs at degreedays.net/api/json not reachable from here): whether the
 * production JSON endpoint is https://api.degreedays.net/json (used here) or
 * http://apiv1.degreedays.net/json (used by the clients reviewed); and the exact
 * timestamp precision accepted (seconds used, as in the clients).
 */

export const ENDPOINT = "https://api.degreedays.net/json";
const MAX_DAILY_DAYS = 366;
const MAX_MONTHLY_DAYS = 366 * 5;

type Breakdown = "daily" | "monthly";

interface DatedValue {
  /** Date (first day for monthly). */
  d: string;
  /** Last day for multi-day values. */
  ld?: string;
  /** Degree-day value. */
  v: number;
  /** Percentage estimated. */
  pe?: number;
}

interface DatedDataSet {
  type: "DatedDataSet";
  percentageEstimated?: number;
  values: DatedValue[];
}

interface Failure {
  type: "Failure";
  code: string;
  message: string;
}

interface ApiResponse {
  metadata?: { rateLimit?: { requestUnitsAvailable?: number; minutesToReset?: number } };
  response:
    | {
        type: "LocationDataResponse";
        stationId?: string;
        targetLongLat?: { longitude: number; latitude: number };
        sources?: { station?: { id?: string; longLat?: { longitude: number; latitude: number }; elevation?: unknown; displayName?: string }; metresFromTarget?: number }[];
        dataSets: Record<string, DatedDataSet | Failure>;
      }
    | Failure;
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signRequest(requestJson: string, securityKey: string): { encoded_request: string; encoded_signature: string } {
  const bytes = Buffer.from(requestJson, "utf8");
  const sig = createHmac("sha256", Buffer.from(securityKey, "utf8")).update(bytes).digest();
  return { encoded_request: base64url(bytes), encoded_signature: base64url(sig) };
}

function keys(env: EnvLike) {
  const accountKey = env.DEGREE_DAYS_ACCOUNT_KEY?.trim();
  const securityKey = env.DEGREE_DAYS_SECURITY_KEY?.trim();
  if (!accountKey || !securityKey) throw new Error("DEGREE_DAYS_ACCOUNT_KEY and DEGREE_DAYS_SECURITY_KEY must be set");
  return { accountKey, securityKey };
}

function timestamp(ctx: OperationContext): string {
  return ctx.now().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function post(ctx: OperationContext, request: Record<string, unknown>): Promise<ApiResponse> {
  const { accountKey, securityKey } = keys(ctx.env);
  const envelope = { securityInfo: { endpoint: ENDPOINT, accountKey, timestamp: timestamp(ctx), random: randomUUID() }, request };
  const json = JSON.stringify(envelope);
  const signed = signRequest(json, securityKey);
  const body = new URLSearchParams({ request_encoding: "base64url", signature_method: "HmacSHA256", signature_encoding: "base64url", ...signed });
  const { data } = await fetchJson<ApiResponse>(ctx, ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, { timeoutMs: 30_000 });
  return data;
}

function failureStatus(code: string): number {
  if (code.startsWith("InvalidRequestAccount") || code.startsWith("InvalidRequestSignature") || code.startsWith("InvalidRequestTimestamp")) return 401;
  if (code.startsWith("RateLimit")) return 429;
  if (code.startsWith("InvalidRequestForAccountPlan")) return 403;
  if (code.startsWith("Service")) return 503;
  return 400;
}

function location(params: Record<string, unknown>) {
  const postcode = params.postcode ? String(params.postcode) : undefined;
  const lat = params.latitude as number | undefined;
  const lon = params.longitude as number | undefined;
  if (postcode) return { type: "PostalCodeLocation", postalCode: postcode, countryCode: "GB" };
  if (typeof lat === "number" && typeof lon === "number") return { type: "LongLatLocation", longLat: { longitude: lon, latitude: lat } };
  throw new Error("Give either a postcode or both latitude and longitude");
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000);
}

function dataSpec(kind: "Heating" | "Cooling", baseC: number, breakdown: Breakdown, first: string, last: string) {
  return {
    type: "DatedDataSpec",
    calculation: { type: `${kind}DegreeDaysCalculation`, baseTemperature: { unit: "C", value: baseC } },
    breakdown: { type: breakdown === "daily" ? "DailyBreakdown" : "MonthlyBreakdown", period: { type: "DayRangePeriod", dayRange: { first, last } } },
  };
}

export const definition = defineIntegration({
  id: "degree-days-net",
  name: "Degree Days.net",
  group: "weather",
  access: "open_key",
  territory: "Global",
  description: "Heating and cooling degree days to any base temperature, daily or monthly, calculated from weather-station records for a postcode or coordinates. The standard source for weather-normalising energy consumption.",
  docsUrl: "https://www.degreedays.net/api/json",
  termsUrl: "https://www.degreedays.net/api/terms",
  attribution: "Degree days from Degree Days.net (www.degreedays.net), calculated from weather-station data.",
  licence: "commercial",
  envVars: [
    { name: "DEGREE_DAYS_ACCOUNT_KEY", required: true, description: "API account key (sent in securityInfo.accountKey). Sign up at degreedays.net/api/signup; a heavily rate-limited test key exists for development." },
    { name: "DEGREE_DAYS_SECURITY_KEY", required: true, description: "API security key used to HMAC-SHA256 sign each request. Never sent to the server." },
  ],
  status: "built_unverified",
  notes: [
    "Paid API with per-plan request-unit limits; the response metadata carries requestUnitsAvailable and minutesToReset, surfaced in warnings.",
    "Degree days are derived from observed station temperatures, so basis is 'measured'; a percentage of values may be estimated where station records have gaps (see pct_estimated columns).",
    "Signing reproduced from the official Python client and an open-source JSON client. Unconfirmed: whether the JSON endpoint is https://api.degreedays.net/json or http://apiv1.degreedays.net/json, and timestamp precision. If the first live call fails with an InvalidRequestSignature or InvalidRequestEndpoint failure, change ENDPOINT to the URL in the JSON API docs.",
    "Station selection is automatic (nearest station with good data) for postcode and lat/lon locations; the chosen station id is reported in the summary.",
    "Daily-breakdown ranges are capped at 366 days and monthly at 5 years per request.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      keys(ctx.env);
      const data = await post(ctx, {
        type: "LocationDataRequest",
        location: { type: "PostalCodeLocation", postalCode: "SW1A1AA", countryCode: "GB" },
        dataSpecs: { hdd: { type: "DatedDataSpec", calculation: { type: "HeatingDegreeDaysCalculation", baseTemperature: { unit: "C", value: UK_HDD_BASE_C } }, breakdown: { type: "DailyBreakdown", period: { type: "LatestValuesPeriod", numberOfValues: 1 } } } },
      });
      const r = data.response;
      if (r.type === "Failure") return { ok: false, detail: `${r.code}: ${r.message}`, latencyMs: Date.now() - started };
      return { ok: true, detail: `station ${r.stationId ?? "?"}; ${data.metadata?.rateLimit?.requestUnitsAvailable ?? "?"} request units left`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "degree-days",
      label: "Heating and cooling degree days",
      description: "Daily or monthly HDD and CDD for a postcode or point over a date range, to the base temperatures you choose.",
      params: [
        { name: "postcode", label: "Postcode", type: "postcode", placeholder: "SW1A 1AA", help: "Give a postcode or a latitude and longitude." },
        { name: "latitude", label: "Latitude", type: "latitude", placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", placeholder: "-0.142" },
        { name: "breakdown", label: "Breakdown", type: "select", default: "monthly", options: [{ value: "daily", label: "Daily" }, { value: "monthly", label: "Monthly" }] },
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2025-01-01" },
        { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2025-12-31" },
        { name: "hdd_base", label: "Heating base (°C)", type: "number", default: UK_HDD_BASE_C, min: 0, max: 30, help: "UK convention 15.5 °C" },
        { name: "cdd_base", label: "Cooling base (°C)", type: "number", default: UK_CDD_BASE_C, min: 0, max: 35, help: "UK convention 22 °C" },
      ],
      async run(params, ctx) {
        const loc = location(params);
        const breakdown = (params.breakdown as Breakdown | undefined) ?? "monthly";
        const first = String(params.start_date);
        const last = String(params.end_date);
        const span = daysBetween(first, last);
        if (Number.isNaN(span) || span < 0) throw new Error("end_date must be on or after start_date");
        if (span + 1 > (breakdown === "daily" ? MAX_DAILY_DAYS : MAX_MONTHLY_DAYS)) throw new Error(`Range too long for a ${breakdown} breakdown`);
        const hddBase = Number(params.hdd_base ?? UK_HDD_BASE_C);
        const cddBase = Number(params.cdd_base ?? UK_CDD_BASE_C);
        keys(ctx.env);
        const data = await post(ctx, {
          type: "LocationDataRequest",
          location: loc,
          dataSpecs: { hdd: dataSpec("Heating", hddBase, breakdown, first, last), cdd: dataSpec("Cooling", cddBase, breakdown, first, last) },
        });
        const columns = ["period_start", "period_end", "hdd", "cdd", "hdd_pct_estimated", "cdd_pct_estimated"];
        const r = data.response;
        const warnings: string[] = [];
        const rl = data.metadata?.rateLimit;
        if (rl?.requestUnitsAvailable !== undefined) warnings.push(`${rl.requestUnitsAvailable} request units left on this plan${rl.minutesToReset !== undefined ? `; resets in ${rl.minutesToReset} min` : ""}.`);
        if (r.type === "Failure") {
          if (r.code.startsWith("Location")) {
            return { summary: `Degree Days.net could not resolve the location: ${r.message}`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "LocationDataRequest", basis: "unavailable" }), warnings };
          }
          throw new IntegrationHttpError(`Degree Days.net failure ${r.code}: ${r.message}`, failureStatus(r.code), ENDPOINT, JSON.stringify(data).slice(0, 1000));
        }
        const hdd = r.dataSets.hdd;
        const cdd = r.dataSets.cdd;
        for (const [k, ds] of Object.entries(r.dataSets)) if (ds.type === "Failure") warnings.push(`${k.toUpperCase()} data set failed: ${ds.code} ${ds.message}`);
        const hddValues = hdd?.type === "DatedDataSet" ? hdd.values : [];
        const cddValues = cdd?.type === "DatedDataSet" ? cdd.values : [];
        const byDate = new Map<string, { period_start: string; period_end: string; hdd: number | null; cdd: number | null; hdd_pct_estimated: number | null; cdd_pct_estimated: number | null }>();
        for (const v of hddValues) byDate.set(v.d, { period_start: v.d, period_end: v.ld ?? v.d, hdd: v.v, cdd: null, hdd_pct_estimated: v.pe ?? 0, cdd_pct_estimated: null });
        for (const v of cddValues) {
          const row = byDate.get(v.d) ?? { period_start: v.d, period_end: v.ld ?? v.d, hdd: null, cdd: null, hdd_pct_estimated: null, cdd_pct_estimated: null };
          row.cdd = v.v;
          row.cdd_pct_estimated = v.pe ?? 0;
          byDate.set(v.d, row);
        }
        const rows = [...byDate.values()].sort((a, b) => a.period_start.localeCompare(b.period_start));
        if (!rows.length) {
          return { summary: `No degree-day values returned for ${first} to ${last}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "LocationDataRequest", basis: "unavailable" }), warnings };
        }
        const hddTotal = rows.reduce((a, x) => a + (x.hdd ?? 0), 0);
        const cddTotal = rows.reduce((a, x) => a + (x.cdd ?? 0), 0);
        const est = Math.max(hdd?.type === "DatedDataSet" ? hdd.percentageEstimated ?? 0 : 0, cdd?.type === "DatedDataSet" ? cdd.percentageEstimated ?? 0 : 0);
        if (est > 0) warnings.push(`${est.toFixed(1)}% of values are estimated where station records had gaps.`);
        warnings.push("Degree days describe outdoor conditions only; they do not by themselves establish comfort or overheating risk inside a building.");
        const station = r.stationId ?? r.sources?.[0]?.station?.id ?? "unknown";
        return {
          summary: `${rows.length} ${breakdown} periods from ${first} to ${last} (station ${station}): ${hddTotal.toFixed(0)} heating degree days (base ${hddBase} °C) and ${cddTotal.toFixed(0)} cooling degree days (base ${cddBase} °C).`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "LocationDataRequest", basis: est > 0 ? "estimated" : "measured" }),
          warnings,
        };
      },
    },
  ],
});
