import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * Enphase Enlighten Systems API v4.
 *
 * Auth model (API key as `key` query parameter plus an OAuth 2.0 access token as
 * `Authorization: Bearer`), endpoint paths and response fields taken from two
 * open-source v4 clients (a Python collector and a TypeScript monitor). Response shapes:
 * /systems -> {total, current_page, size, count, systems: [...]}
 * /systems/{id}/summary -> {system_id, current_power, energy_today, energy_lifetime, summary_date, status, last_report_at, ...}
 * /systems/{id}/energy_lifetime -> {system_id, start_date, production: [Wh per day...], meta}
 * /systems/{id}/telemetry/production_micro -> {system_id, granularity, total_devices, start_at, end_at, intervals: [{end_at, devices_reporting, powr, enwh}]}
 * Not exercised live from this environment.
 */

const BASE = "https://api.enphaseenergy.com/api/v4";
const MAX_LIFETIME_DAYS = 366;

interface SystemItem {
  system_id: number;
  name?: string;
  public_name?: string;
  timezone?: string;
  address?: { city?: string; state?: string; postal_code?: string; country?: string };
  connection_type?: string;
  status?: string;
  last_report_at?: number;
  last_energy_at?: number;
  operational_at?: number;
  system_size?: number;
}

interface SystemsResponse {
  total: number;
  current_page: number;
  size: number;
  count: number;
  systems: SystemItem[];
}

interface Summary {
  system_id: number;
  current_power?: number;
  energy_today?: number;
  energy_lifetime?: number;
  summary_date?: string;
  source?: string;
  status?: string;
  operational_at?: number;
  last_report_at?: number;
  last_interval_end_at?: number;
  modules?: number;
  size_w?: number;
}

interface EnergyLifetime {
  system_id: number;
  start_date: string;
  production: (number | null)[];
  micro_production?: (number | null)[];
  meter_production?: (number | null)[];
  meta?: { status?: string; last_report_at?: number; last_energy_at?: number; operational_at?: number };
}

interface ProductionMicro {
  system_id: number;
  granularity?: string;
  total_devices?: number;
  start_at?: number;
  end_at?: number;
  intervals: { end_at: number; devices_reporting?: number; powr?: number; enwh?: number; wh_del?: number }[];
}

function creds(env: EnvLike): { key: string; headers: Record<string, string> } {
  const key = env.ENPHASE_API_KEY?.trim();
  const token = env.ENPHASE_ACCESS_TOKEN?.trim();
  if (!key || !token) throw new Error("ENPHASE_API_KEY and ENPHASE_ACCESS_TOKEN must be set");
  return { key, headers: { authorization: `Bearer ${token}` } };
}

function iso(unix: number | undefined): string | null {
  return typeof unix === "number" && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : null;
}

function kwh(wh: number | null | undefined): number | null {
  return typeof wh === "number" && Number.isFinite(wh) ? Math.round(wh) / 1000 : null;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

const SYSTEM_ID = { name: "system_id", label: "System ID", type: "integer", required: true, placeholder: "1234567", min: 1 } as const;

export const definition = defineIntegration({
  id: "enphase",
  name: "Enphase Enlighten API v4",
  group: "solar",
  access: "authorised",
  territory: "Global",
  description: "Metered production from Enphase microinverter systems (and consumption where an Enphase meter is fitted) via the Enlighten Systems API v4 with the owner's OAuth authorisation.",
  docsUrl: "https://developer-v4.enphase.com/docs.html",
  termsUrl: "https://developer-v4.enphase.com/terms",
  attribution: "System energy data from the Enphase Enlighten API, provided under the system owner's authorisation.",
  licence: "consent_based",
  envVars: [
    { name: "ENPHASE_API_KEY", required: true, description: "Developer application API key from developer-v4.enphase.com, sent as the `key` query parameter." },
    { name: "ENPHASE_ACCESS_TOKEN", required: true, description: "OAuth 2.0 access token for the homeowner/installer account, sent as Authorization: Bearer. Tokens expire (about a day) and must be refreshed with the refresh token; obtaining and refreshing tokens is outside this connector." },
  ],
  status: "built_unverified",
  notes: [
    "OAuth 2.0 authorisation-code flow is required: the system owner logs in at Enphase and grants the portal's developer app access; the resulting access/refresh tokens must be stored and refreshed by a separate process (not built here).",
    "Free 'Watt' developer plan: 10 requests/minute and 1,000/month, and some endpoints (consumption telemetry, consumption_lifetime) return 405 on the free plan. Paid plans lift this.",
    "energy_lifetime returns one Wh value per day from start_date; days with no data are null. It is the cheapest way to backfill daily production (one call per range).",
    "Telemetry intervals are 15-minute (or 5-minute where configured) and limited to one day per call; times are Unix epoch seconds in the system's time zone.",
    "Not exercised live from this environment.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const c = creds(ctx.env);
      const { data } = await fetchJson<SystemsResponse>(ctx, buildUrl(BASE, "systems", { size: 1, key: c.key }), { headers: c.headers }, { timeoutMs: 15_000 });
      return { ok: typeof data.total === "number", detail: `${data.total ?? "?"} systems authorised`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "systems",
      label: "List systems",
      description: "Systems the authorised account can see, with status and last report time.",
      params: [],
      async run(_params, ctx) {
        const c = creds(ctx.env);
        const { data } = await fetchJson<SystemsResponse>(ctx, buildUrl(BASE, "systems", { size: 100, key: c.key }), { headers: c.headers });
        const columns = ["system_id", "name", "status", "size_kw", "timezone", "city", "postcode", "last_report_at", "operational_at"];
        const rows = (data.systems ?? []).map((s) => ({
          system_id: s.system_id,
          name: s.name ?? s.public_name ?? null,
          status: s.status ?? null,
          size_kw: typeof s.system_size === "number" ? s.system_size / 1000 : null,
          timezone: s.timezone ?? null,
          city: s.address?.city ?? null,
          postcode: s.address?.postal_code ?? null,
          last_report_at: iso(s.last_report_at),
          operational_at: iso(s.operational_at),
        }));
        return {
          summary: rows.length ? `${data.total} system(s) authorised, ${rows.length} listed.` : "No systems authorised for this token.",
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "systems", basis: rows.length ? "client_declared" : "unavailable" }),
        };
      },
    },
    {
      id: "system-summary",
      label: "System summary",
      description: "Current power, energy today, lifetime energy and status for one system.",
      params: [SYSTEM_ID],
      async run(params, ctx) {
        const c = creds(ctx.env);
        const id = Number(params.system_id);
        const { data } = await fetchJson<Summary>(ctx, buildUrl(BASE, `systems/${id}/summary`, { key: c.key }), { headers: c.headers });
        const columns = ["system_id", "summary_date", "status", "current_power_kw", "energy_today_kwh", "energy_lifetime_kwh", "modules", "size_kw", "last_report_at"];
        if (!data || typeof data.system_id !== "number") return { summary: `No summary for system ${id}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "systems/summary", basis: "unavailable" }) };
        const row = {
          system_id: data.system_id,
          summary_date: data.summary_date ?? null,
          status: data.status ?? null,
          current_power_kw: typeof data.current_power === "number" ? data.current_power / 1000 : null,
          energy_today_kwh: kwh(data.energy_today),
          energy_lifetime_kwh: kwh(data.energy_lifetime),
          modules: data.modules ?? null,
          size_kw: typeof data.size_w === "number" ? data.size_w / 1000 : null,
          last_report_at: iso(data.last_report_at),
        };
        return {
          summary: `System ${id} (${row.status ?? "status unknown"}): ${row.energy_today_kwh ?? "?"} kWh today, ${row.energy_lifetime_kwh ?? "?"} kWh lifetime, ${row.current_power_kw ?? "?"} kW now; last report ${row.last_report_at ?? "unknown"}.`,
          columns,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "systems/summary", basis: "measured" }),
        };
      },
    },
    {
      id: "daily-production",
      label: "Daily production for a range",
      description: "Production in kWh for each day between two dates (up to one year).",
      params: [SYSTEM_ID, { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2025-01-01" }, { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2025-12-31" }],
      async run(params, ctx) {
        const c = creds(ctx.env);
        const id = Number(params.system_id);
        const start = String(params.start_date);
        const end = String(params.end_date);
        const span = Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000);
        if (Number.isNaN(span) || span < 0) throw new Error("end_date must be on or after start_date");
        if (span + 1 > MAX_LIFETIME_DAYS) throw new Error(`Range is limited to ${MAX_LIFETIME_DAYS} days per request`);
        const { data } = await fetchJson<EnergyLifetime>(ctx, buildUrl(BASE, `systems/${id}/energy_lifetime`, { start_date: start, end_date: end, key: c.key }), { headers: c.headers }, { timeoutMs: 30_000 });
        const columns = ["date", "production_kwh"];
        const values = data.production ?? [];
        if (!values.length) return { summary: `No daily production for system ${id} between ${start} and ${end}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "systems/energy_lifetime", basis: "unavailable" }) };
        const rows = values.map((wh, i) => ({ date: addDays(data.start_date, i), production_kwh: kwh(wh) }));
        const total = rows.reduce((a, r) => a + (r.production_kwh ?? 0), 0);
        const missing = rows.filter((r) => r.production_kwh === null).length;
        return {
          summary: `System ${id}: ${Math.round(total)} kWh over ${rows.length} days from ${rows[0].date}${missing ? `, ${missing} day(s) with no data` : ""}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "systems/energy_lifetime", basis: "measured" }),
          warnings: missing ? ["Null days are reporting gaps, not zero generation."] : undefined,
        };
      },
    },
    {
      id: "production-intervals",
      label: "15-minute production for one day",
      description: "Microinverter production per interval for a single day.",
      params: [SYSTEM_ID, { name: "date", label: "Date", type: "date", required: true, placeholder: "2025-06-21" }],
      async run(params, ctx) {
        const c = creds(ctx.env);
        const id = Number(params.system_id);
        const startAt = Math.floor(Date.parse(String(params.date) + "T00:00:00Z") / 1000);
        if (!Number.isFinite(startAt)) throw new Error("date must be YYYY-MM-DD");
        const { data } = await fetchJson<ProductionMicro>(ctx, buildUrl(BASE, `systems/${id}/telemetry/production_micro`, { start_at: startAt, granularity: "day", key: c.key }), { headers: c.headers });
        const columns = ["interval_end", "power_w", "energy_wh", "devices_reporting"];
        const intervals = data.intervals ?? [];
        if (!intervals.length) return { summary: `No production intervals for system ${id} on ${params.date}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "systems/telemetry/production_micro", basis: "unavailable" }) };
        const rows = intervals.map((iv) => ({ interval_end: iso(iv.end_at), power_w: iv.powr ?? null, energy_wh: iv.enwh ?? iv.wh_del ?? null, devices_reporting: iv.devices_reporting ?? null }));
        const total = rows.reduce((a, r) => a + (r.energy_wh ?? 0), 0) / 1000;
        const peak = Math.max(...rows.map((r) => r.power_w ?? 0));
        return {
          summary: `System ${id} on ${params.date}: ${rows.length} intervals, ${Math.round(total * 10) / 10} kWh, peak ${peak} W.`,
          columns,
          rows,
          raw: { ...data, intervals: undefined, interval_count: rows.length },
          provenance: makeProvenance(definition, ctx, { dataset: "systems/telemetry/production_micro", basis: "measured" }),
          warnings: ["start_at is sent as midnight UTC; Enphase interprets it in the system's local time zone, so the day boundary may shift by the UTC offset."],
        };
      },
    },
  ],
});
