import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { assertRange, addDays, mean, round } from "../_shared/dates";

/**
 * Openvolt: consented half-hourly electricity meter data for GB business sites. Base URL, the x-api-key header,
 * the /meters/{id} and /interval-data endpoints and the interval row shape were confirmed from open-source clients
 * built against docs.openvolt.com; the list-meters response shape was not confirmed. Not exercised live here.
 */

const BASE = "https://api.openvolt.com/v1";
const ENV_KEY = "OPENVOLT_API_KEY";

interface Interval {
  start_interval: string;
  end_interval?: string;
  meter_id?: string;
  meter_number?: string;
  customer_id?: string;
  consumption: string | number | null;
  consumption_units?: string;
}

interface IntervalData {
  startInterval?: string;
  endInterval?: string;
  granularity?: string;
  data: Interval[];
}

interface Meter {
  _id?: string;
  id?: string;
  meter_number?: string;
  meter_type?: string;
  status?: string;
  data_source?: string;
  address?: string | { line1?: string; postcode?: string };
  postcode?: string;
  customer?: { _id?: string; name?: string; account?: string } | string;
  customer_id?: string;
  created_at?: string;
}

function headers(ctx: OperationContext): Record<string, string> {
  const key = ctx.env[ENV_KEY]?.trim();
  if (!key) throw new Error(`${ENV_KEY} is not configured; Openvolt requires an API key on every request.`);
  return { "x-api-key": key };
}

function meterRow(m: Meter) {
  const customer = typeof m.customer === "object" && m.customer ? m.customer : null;
  const address = typeof m.address === "object" && m.address ? [m.address.line1, m.address.postcode].filter(Boolean).join(", ") : (m.address ?? null);
  return {
    meter_id: m._id ?? m.id ?? null,
    meter_number: m.meter_number ?? null,
    meter_type: m.meter_type ?? null,
    status: m.status ?? null,
    data_source: m.data_source ?? null,
    address,
    postcode: m.postcode ?? (typeof m.address === "object" ? (m.address?.postcode ?? null) : null),
    customer: customer?.name ?? (typeof m.customer === "string" ? m.customer : null),
    customer_id: customer?._id ?? m.customer_id ?? null,
    created_at: m.created_at ?? null,
  };
}

const METER_COLUMNS = ["meter_id", "meter_number", "meter_type", "status", "data_source", "address", "postcode", "customer", "customer_id", "created_at"];

/** The list endpoint's envelope is unconfirmed: accept a bare array, { data: [...] } or { meters: [...] }. */
function unwrapList(body: unknown): Meter[] {
  if (Array.isArray(body)) return body as Meter[];
  if (body && typeof body === "object") {
    const o = body as { data?: unknown; meters?: unknown };
    if (Array.isArray(o.data)) return o.data as Meter[];
    if (Array.isArray(o.meters)) return o.meters as Meter[];
  }
  return [];
}

export const definition = defineIntegration({
  id: "openvolt",
  name: "Openvolt",
  group: "energy",
  access: "authorised",
  territory: "GB",
  description: "Openvolt aggregates consented half-hourly electricity consumption for business meters (via the smart meter network and data collectors). List meters connected to the portal's Openvolt account and pull interval data per meter.",
  docsUrl: "https://docs.openvolt.com/",
  termsUrl: "https://www.openvolt.com/",
  attribution: "Meter data supplied by Openvolt with the meter owner's consent.",
  licence: "consent_based",
  envVars: [{ name: ENV_KEY, required: true, description: "Openvolt API key from the Openvolt dashboard, sent as the x-api-key header. A test key returns sample meters." }],
  status: "built_unverified",
  notes: [
    "Commercial service: the portal needs an Openvolt account and a per-meter connection. Consent from the site's energy account holder is captured in Openvolt's own onboarding flow (their consent form, LOA or supplier authorisation); this connector only reads data for meters already connected.",
    "Endpoints: GET /meters (list; envelope unconfirmed), GET /meters/{id}, GET /interval-data?meter_id=&granularity=hh|day|month&start_date=&end_date=&type=consumption. Interval rows carry start_interval, consumption and consumption_units.",
    "Half-hourly calls are capped at 62 days, daily at 366 days and monthly at 5 years per call.",
    "Built from open-source clients of docs.openvolt.com without a live call; the meter list shape, pagination and the units of consumption (assumed kWh) need confirming on the first live run.",
  ],
  healthCheck: simpleHealth(`${BASE}/meters`, (env) => ({ headers: { "x-api-key": env[ENV_KEY] ?? "" } })),
  operations: [
    {
      id: "list_meters",
      label: "List connected meters",
      description: "Meters connected to the portal's Openvolt account, with status and data source.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<unknown>(ctx, `${BASE}/meters`, { headers: headers(ctx) });
        const rows = unwrapList(data).map(meterRow);
        if (rows.length === 0) return { summary: "No meters connected to this Openvolt account.", columns: METER_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "meters", basis: "unavailable" }) };
        return {
          summary: `${rows.length} meters connected; ${rows.filter((r) => String(r.status).toLowerCase() === "active").length} active.`,
          columns: METER_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "meters", basis: "client_declared" }),
          warnings: ["List envelope and pagination are unconfirmed; if a large account returns fewer meters than expected, check the Openvolt dashboard."],
        };
      },
    },
    {
      id: "meter",
      label: "Meter details",
      description: "One meter's details, status and customer.",
      params: [{ name: "meter_id", label: "Openvolt meter id", type: "string", required: true, placeholder: "6514167223e3d1424bf82742" }],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.meter_id);
        const { data, status } = await fetchJson<Meter>(ctx, `${BASE}/meters/${encodeURIComponent(id)}`, { headers: headers(ctx) }, { acceptStatuses: [404] });
        if (status === 404 || !data) return { summary: `Meter ${id} not found on this account.`, columns: METER_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "meters/{id}", basis: "unavailable" }) };
        const row = meterRow({ ...data, _id: data._id ?? data.id ?? id });
        return {
          summary: `Meter ${row.meter_number ?? id}: ${row.status ?? "status unknown"}, data source ${row.data_source ?? "unknown"}${row.customer ? `, customer ${row.customer}` : ""}.`,
          columns: METER_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "meters/{id}", basis: "client_declared" }),
        };
      },
    },
    {
      id: "interval_data",
      label: "Interval consumption for a meter",
      description: "Half-hourly, daily or monthly consumption (kWh) for one meter between two dates.",
      params: [
        { name: "meter_id", label: "Openvolt meter id", type: "string", required: true, placeholder: "6514167223e3d1424bf82742" },
        { name: "granularity", label: "Granularity", type: "select", required: true, default: "hh", options: [{ value: "hh", label: "Half-hourly (max 62 days)" }, { value: "day", label: "Daily (max 366 days)" }, { value: "month", label: "Monthly (max 5 years)" }] },
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "end_date", label: "End date (inclusive)", type: "date", required: true, placeholder: "2026-08-31" },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const h = headers(ctx);
        const from = String(params.start_date);
        const to = String(params.end_date);
        const granularity = String(params.granularity ?? "hh");
        assertRange(from, to, granularity === "hh" ? 62 : granularity === "day" ? 366 : 1827, "date range");
        const url = buildUrl(BASE, "interval-data", { meter_id: String(params.meter_id), granularity, start_date: `${from}T00:00:00Z`, end_date: `${addDays(to, 1)}T00:00:00Z`, type: "consumption" });
        const { data, status } = await fetchJson<IntervalData>(ctx, url, { headers: h }, { acceptStatuses: [404] });
        const columns = ["interval_start", "interval_end", "kwh", "units", "meter_number"];
        const intervals = data?.data ?? [];
        if (status === 404 || intervals.length === 0) return { summary: `No ${granularity} interval data for meter ${params.meter_id} between ${from} and ${to}${status === 404 ? " (meter not found)" : ""}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "interval-data", basis: "unavailable" }) };
        const rows = intervals.map((i) => {
          const kwh = i.consumption === null || i.consumption === undefined || i.consumption === "" ? null : Number(i.consumption);
          return { interval_start: i.start_interval, interval_end: i.end_interval ?? null, kwh: kwh !== null && Number.isNaN(kwh) ? null : kwh, units: i.consumption_units ?? "kWh", meter_number: i.meter_number ?? null };
        });
        const vals = rows.map((r) => r.kwh).filter((v): v is number => v !== null);
        const total = vals.reduce((a, b) => a + b, 0);
        const peak = rows.reduce((b, r) => ((r.kwh ?? -1) > (b.kwh ?? -1) ? r : b), rows[0]);
        return {
          summary: `${rows.length} ${granularity === "hh" ? "half-hour" : granularity === "day" ? "daily" : "monthly"} intervals for meter ${peak.meter_number ?? params.meter_id} from ${from} to ${to}: total ${round(total, 1)} kWh, mean ${round(mean(vals) ?? 0, 2)} kWh per interval, peak ${peak.kwh} kWh at ${peak.interval_start}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "interval-data", basis: "measured", consentRef: `openvolt-meter:${params.meter_id}` }),
          warnings: [
            "Interval timestamps are UTC; consumption is as supplied by the data collector and may include estimated reads flagged by Openvolt. Units are taken from the response (assumed kWh when absent).",
            ...(rows.some((r) => r.kwh === null) ? [`${rows.filter((r) => r.kwh === null).length} intervals have no reading.`] : []),
          ],
        };
      },
    },
  ],
});
