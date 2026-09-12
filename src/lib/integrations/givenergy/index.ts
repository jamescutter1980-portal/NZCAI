import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";

/**
 * GivEnergy Cloud API v1.
 *
 * Endpoints and the energy-flows request body confirmed from three open-source clients
 * (an OpenAPI-generated client, givenergy-api-client on PyPI and a solar-ROI script):
 *   POST /inverter/{serial}/energy-flows  body {start_time, end_time, grouping, types}
 *   grouping: 0 = half-hourly, 1 = daily, 2 = monthly, 3 = yearly, 4 = total
 *   types: 0 PV->home, 1 PV->battery, 2 PV->grid, 3 grid->home, 4 grid->battery, 5 battery->home, 6 battery->grid
 * Two response shapes have been seen for energy-flows and both are handled:
 *   {"data": {"0": {"start_time", "end_time", "data": {"0": kWh, ...}}, ...}}  (observed by a script)
 *   {"data": [{"type": 0, "data": [{"timestamp", "value"}]}]}                   (typed client)
 * Auth is Authorization: Bearer <API token>. Not exercised live from this environment.
 */

const BASE = "https://api.givenergy.cloud/v1";
const MAX_HALF_HOURLY_DAYS = 7;
const MAX_DAILY_DAYS = 366;
const MAX_MONTHLY_DAYS = 366 * 3;

export const FLOW_TYPES: Record<number, string> = {
  0: "pv_to_home_kwh",
  1: "pv_to_battery_kwh",
  2: "pv_to_grid_kwh",
  3: "grid_to_home_kwh",
  4: "grid_to_battery_kwh",
  5: "battery_to_home_kwh",
  6: "battery_to_grid_kwh",
};

const GROUPING: Record<string, number> = { half_hourly: 0, daily: 1, monthly: 2 };

interface CommunicationDevice {
  serial_number: string;
  type?: string;
  commission_date?: string;
  inverter?: {
    serial: string;
    status?: string;
    last_online?: string;
    last_updated?: string;
    commission_date?: string;
    info?: { model?: string; max_charge_rate?: number; battery?: { nominal_capacity?: number; nominal_voltage?: number } };
    firmware_version?: { ARM?: number; DSP?: number };
    connections?: { batteries?: { serial_number?: string; capacity?: { ah?: number } }[] };
  };
}

interface Paginated<T> {
  data: T[];
  links?: { first?: string; last?: string; next?: string | null };
  meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number };
}

interface SystemData {
  data: {
    time?: string;
    solar?: { power?: number; arrays?: { array?: number; voltage?: number; current?: number; power?: number }[] };
    grid?: { voltage?: number; current?: number; power?: number; frequency?: number };
    battery?: { percent?: number; power?: number; temperature?: number };
    inverter?: { temperature?: number; power?: number; output_voltage?: number; output_frequency?: number; eps_power?: number };
    consumption?: number;
  };
}

type FlowsResponse = { data: Record<string, { start_time: string; end_time: string; data: Record<string, number> }> | { type: number; data: { timestamp: string; value: number }[] }[] };

function headers(env: EnvLike): Record<string, string> {
  const token = env.GIVENERGY_API_TOKEN?.trim();
  if (!token) throw new Error("GIVENERGY_API_TOKEN is not set");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function r(v: number | null | undefined, dp = 3): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000);
}

interface FlowRow {
  start_time: string;
  end_time: string | null;
  [k: string]: unknown;
}

/** Normalise either documented energy-flows response shape into rows keyed by period. */
export function normaliseFlows(data: FlowsResponse["data"]): FlowRow[] {
  const byStart = new Map<string, FlowRow>();
  const blank = (start: string, end: string | null): FlowRow => ({ start_time: start, end_time: end, ...Object.fromEntries(Object.values(FLOW_TYPES).map((k) => [k, null])) });
  if (Array.isArray(data)) {
    for (const series of data) {
      const key = FLOW_TYPES[series.type];
      if (!key) continue;
      for (const p of series.data ?? []) {
        const row = byStart.get(p.timestamp) ?? blank(p.timestamp, null);
        row[key] = r(p.value);
        byStart.set(p.timestamp, row);
      }
    }
  } else {
    for (const point of Object.values(data ?? {})) {
      const row = byStart.get(point.start_time) ?? blank(point.start_time, point.end_time ?? null);
      for (const [t, v] of Object.entries(point.data ?? {})) {
        const key = FLOW_TYPES[Number(t)];
        if (key) row[key] = r(v);
      }
      byStart.set(point.start_time, row);
    }
  }
  const rows = [...byStart.values()].sort((a, b) => a.start_time.localeCompare(b.start_time));
  for (const row of rows) {
    const g = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : 0);
    row.generation_kwh = r(g("pv_to_home_kwh") + g("pv_to_battery_kwh") + g("pv_to_grid_kwh"));
    row.import_kwh = r(g("grid_to_home_kwh") + g("grid_to_battery_kwh"));
    row.export_kwh = r(g("pv_to_grid_kwh") + g("battery_to_grid_kwh"));
    row.consumption_kwh = r(g("pv_to_home_kwh") + g("grid_to_home_kwh") + g("battery_to_home_kwh"));
  }
  return rows;
}

const SERIAL = { name: "serial", label: "Inverter serial", type: "string", required: true, placeholder: "CE2345G123" } as const;

export const definition = defineIntegration({
  id: "givenergy",
  name: "GivEnergy Cloud",
  group: "solar",
  access: "authorised",
  territory: "UK",
  description: "Live and historical solar, battery, import and export flows from GivEnergy inverters and batteries via the owner's GivEnergy Cloud API token.",
  docsUrl: "https://givenergy.cloud/docs/api/v1",
  termsUrl: "https://www.givenergy.co.uk/terms-and-conditions",
  attribution: "Inverter and battery data from the GivEnergy Cloud API, provided under the system owner's authorisation.",
  licence: "consent_based",
  envVars: [{ name: "GIVENERGY_API_TOKEN", required: true, description: "Personal API token created by the account holder in the GivEnergy portal (Account Settings > Manage API Tokens), sent as Authorization: Bearer. Read scopes are enough." }],
  status: "built_unverified",
  notes: [
    "The account holder creates the token and consents to the portal reading their data; record the consent reference in the provenance.",
    "Energy flows are in kWh per period. Grouping 0 = half-hourly, 1 = daily, 2 = monthly (3 yearly, 4 total not exposed). start_time/end_time are in the inverter's local time.",
    "Two response shapes for energy-flows are handled (period-keyed object and per-type series); which one the live API returns for a given token is unconfirmed.",
    "A community report suggests the inverter-level energy-flows endpoint may be superseded by a site-level equivalent; confirm against the current docs if it starts returning 404 or deprecation headers.",
    "Rate limits are not published; keep polling to a few calls per minute per token.",
    "Not exercised live from this environment.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const { data } = await fetchJson<Paginated<CommunicationDevice>>(ctx, buildUrl(BASE, "communication-device", { page: 1, pageSize: 1 }), { headers: headers(ctx.env) }, { timeoutMs: 15_000 });
      return { ok: Array.isArray(data.data), detail: `${data.meta?.total ?? data.data?.length ?? "?"} communication device(s)`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "inverters",
      label: "List inverters",
      description: "Communication devices (dongles) on the account with their inverter serials, model, status and battery count.",
      params: [{ name: "page", label: "Page", type: "integer", default: 1, min: 1 }],
      async run(params, ctx) {
        const { data } = await fetchJson<Paginated<CommunicationDevice>>(ctx, buildUrl(BASE, "communication-device", { page: Number(params.page ?? 1), pageSize: 100 }), { headers: headers(ctx.env) });
        const columns = ["dongle_serial", "inverter_serial", "model", "status", "last_online", "commission_date", "battery_count", "battery_kwh"];
        const rows = (data.data ?? []).map((d) => {
          const inv = d.inverter;
          const bat = inv?.info?.battery;
          const kwh = bat?.nominal_capacity && bat.nominal_voltage ? r((bat.nominal_capacity * bat.nominal_voltage) / 1000, 1) : null;
          return {
            dongle_serial: d.serial_number,
            inverter_serial: inv?.serial ?? null,
            model: inv?.info?.model ?? null,
            status: inv?.status ?? null,
            last_online: inv?.last_online ?? null,
            commission_date: inv?.commission_date ?? d.commission_date ?? null,
            battery_count: inv?.connections?.batteries?.length ?? 0,
            battery_kwh: kwh,
          };
        });
        return {
          summary: rows.length ? `${data.meta?.total ?? rows.length} device(s) on the account (page ${data.meta?.current_page ?? 1} of ${data.meta?.last_page ?? 1}).` : "No communication devices on this account.",
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "communication-device", basis: rows.length ? "client_declared" : "unavailable" }),
        };
      },
    },
    {
      id: "latest-system-data",
      label: "Latest system snapshot",
      description: "Most recent solar, grid, battery and consumption power readings for an inverter.",
      params: [SERIAL],
      async run(params, ctx) {
        const serial = String(params.serial).trim();
        const { data } = await fetchJson<SystemData>(ctx, buildUrl(BASE, `inverter/${encodeURIComponent(serial)}/system-data/latest`), { headers: headers(ctx.env) });
        const d = data.data;
        const columns = ["time", "solar_power_w", "grid_power_w", "battery_power_w", "battery_percent", "battery_temp_c", "consumption_w", "grid_voltage_v", "grid_frequency_hz"];
        if (!d?.time) return { summary: `No recent data for inverter ${serial}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "inverter/system-data/latest", basis: "unavailable" }) };
        const row = {
          time: d.time,
          solar_power_w: d.solar?.power ?? null,
          grid_power_w: d.grid?.power ?? null,
          battery_power_w: d.battery?.power ?? null,
          battery_percent: d.battery?.percent ?? null,
          battery_temp_c: d.battery?.temperature ?? null,
          consumption_w: d.consumption ?? null,
          grid_voltage_v: d.grid?.voltage ?? null,
          grid_frequency_hz: d.grid?.frequency ?? null,
        };
        return {
          summary: `Inverter ${serial} at ${d.time}: solar ${row.solar_power_w ?? "?"} W, consumption ${row.consumption_w ?? "?"} W, grid ${row.grid_power_w ?? "?"} W, battery ${row.battery_percent ?? "?"}% (${row.battery_power_w ?? "?"} W).`,
          columns,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "inverter/system-data/latest", basis: "measured" }),
          warnings: ["Sign conventions for grid and battery power (import/export, charge/discharge) follow GivEnergy's API and are not normalised here."],
        };
      },
    },
    {
      id: "energy-flows",
      label: "Energy flows for a range",
      description: "PV, battery and grid energy flows per period, with derived generation, consumption, import and export.",
      params: [
        SERIAL,
        { name: "start_date", label: "Start date", type: "date", required: true, placeholder: "2025-06-01" },
        { name: "end_date", label: "End date", type: "date", required: true, placeholder: "2025-06-30" },
        { name: "grouping", label: "Grouping", type: "select", default: "daily", options: [{ value: "half_hourly", label: "Half-hourly (max 7 days)" }, { value: "daily", label: "Daily (max 1 year)" }, { value: "monthly", label: "Monthly (max 3 years)" }] },
      ],
      async run(params, ctx) {
        const serial = String(params.serial).trim();
        const start = String(params.start_date);
        const end = String(params.end_date);
        const grouping = String(params.grouping ?? "daily");
        const span = daysBetween(start, end);
        if (Number.isNaN(span) || span < 0) throw new Error("end_date must be on or after start_date");
        const max = grouping === "half_hourly" ? MAX_HALF_HOURLY_DAYS : grouping === "daily" ? MAX_DAILY_DAYS : MAX_MONTHLY_DAYS;
        if (span + 1 > max) throw new Error(`${grouping} flows are limited to ${max} days per request`);
        const body = { start_time: start, end_time: end, grouping: GROUPING[grouping], types: Object.keys(FLOW_TYPES).map(Number) };
        const { data } = await fetchJson<FlowsResponse>(ctx, buildUrl(BASE, `inverter/${encodeURIComponent(serial)}/energy-flows`), { method: "POST", headers: headers(ctx.env), body: JSON.stringify(body) }, { timeoutMs: 30_000 });
        const rows = normaliseFlows(data.data);
        const columns = ["start_time", "end_time", ...Object.values(FLOW_TYPES), "generation_kwh", "consumption_kwh", "import_kwh", "export_kwh"];
        if (!rows.length) return { summary: `No energy flows for inverter ${serial} between ${start} and ${end}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "inverter/energy-flows", basis: "unavailable" }) };
        const sum = (k: string) => Math.round(rows.reduce((a, row) => a + (Number(row[k]) || 0), 0) * 10) / 10;
        return {
          summary: `Inverter ${serial}, ${start} to ${end} (${grouping.replace("_", "-")}): generation ${sum("generation_kwh")} kWh, consumption ${sum("consumption_kwh")} kWh, import ${sum("import_kwh")} kWh, export ${sum("export_kwh")} kWh over ${rows.length} periods.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "inverter/energy-flows", basis: "measured" }),
          warnings: ["Flows are the inverter's own metering, not the supplier's settlement meter; small differences from the electricity bill are normal."],
        };
      },
    },
  ],
});
