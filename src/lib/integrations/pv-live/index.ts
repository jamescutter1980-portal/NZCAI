import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { addDays, assertRange, chunkDays, round } from "../_shared/dates";

/**
 * Sheffield Solar PV_Live v4: half-hourly estimates of GB solar PV outturn, nationally and by PES region or GSP.
 * URL structure, parameters and the { data: [[...]], meta: [...] } response come from the SheffieldSolar/PV_Live-API
 * Python client; not exercised live here.
 */

const BASE = "https://api.pvlive.uk/pvlive/api/v4";
const EXTRA_FIELDS = "installedcapacity_mwp,capacity_mwp";
/** The Python client requests regional ranges in 30-day windows; the same window is used for every entity here. */
const MAX_DAYS_PER_REQUEST = 30;
const MAX_HALF_HOURLY_DAYS = 31;
const MAX_DAILY_DAYS = 92;

interface PvLiveResponse {
  data: (string | number | null)[][];
  meta: string[];
}

type PvRow = Record<string, string | number | null>;

function toObjects(res: PvLiveResponse): PvRow[] {
  return (res.data ?? []).map((row) => Object.fromEntries(res.meta.map((k, i) => [k, row[i] ?? null])));
}

function entityPath(entity: "pes" | "gsp", id: number): string {
  return `${entity}/${id}`;
}

async function fetchRange(ctx: OperationContext, entity: "pes" | "gsp", id: number, from: string, to: string): Promise<PvRow[]> {
  const rows: PvRow[] = [];
  for (const c of chunkDays(from, to, MAX_DAYS_PER_REQUEST)) {
    const url = buildUrl(BASE, entityPath(entity, id), { start: `${c.from}T00:00:00Z`, end: `${addDays(c.to, 1)}T00:00:00Z`, extra_fields: EXTRA_FIELDS, period: 30 });
    const { data } = await fetchJson<PvLiveResponse>(ctx, url);
    rows.push(...toObjects(data));
  }
  // The API returns newest first; sort ascending by timestamp and drop duplicates on chunk boundaries.
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const k = String(r.datetime_gmt);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => String(a.datetime_gmt).localeCompare(String(b.datetime_gmt)));
}

const HH_COLUMNS = ["period_end_gmt", "generation_mw", "installed_capacity_mwp", "capacity_mwp", "load_factor_pct"];

function hhRow(r: PvRow) {
  const gen = typeof r.generation_mw === "number" ? r.generation_mw : null;
  const cap = typeof r.capacity_mwp === "number" ? r.capacity_mwp : typeof r.installedcapacity_mwp === "number" ? r.installedcapacity_mwp : null;
  return {
    period_end_gmt: r.datetime_gmt,
    generation_mw: gen,
    installed_capacity_mwp: r.installedcapacity_mwp ?? null,
    capacity_mwp: r.capacity_mwp ?? null,
    load_factor_pct: gen !== null && cap ? round((gen / cap) * 100) : null,
  };
}

/** Sums half-hourly MW into daily MWh (MW x 0.5 h) keyed on the UTC date of the period end. */
export function dailyTotals(rows: PvRow[]): { date: string; generation_mwh: number; peak_mw: number; peak_period_end_gmt: string | null; periods: number }[] {
  const days = new Map<string, { generation_mwh: number; peak_mw: number; peak_period_end_gmt: string | null; periods: number }>();
  for (const r of rows) {
    const gen = typeof r.generation_mw === "number" ? r.generation_mw : null;
    if (gen === null) continue;
    // A period ending at 00:00 belongs to the previous day.
    const end = new Date(String(r.datetime_gmt));
    const date = new Date(end.getTime() - 1).toISOString().slice(0, 10);
    const d = days.get(date) ?? { generation_mwh: 0, peak_mw: 0, peak_period_end_gmt: null, periods: 0 };
    d.generation_mwh += gen * 0.5;
    d.periods += 1;
    if (gen > d.peak_mw) {
      d.peak_mw = gen;
      d.peak_period_end_gmt = String(r.datetime_gmt);
    }
    days.set(date, d);
  }
  return Array.from(days.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, generation_mwh: round(d.generation_mwh, 1), peak_mw: d.peak_mw, peak_period_end_gmt: d.peak_period_end_gmt, periods: d.periods }));
}

const ESTIMATE_WARNING = "PV_Live is a statistical estimate of total GB PV outturn built from a sample of metered systems and the installed-capacity register; it is not metered generation and is revised as data arrive.";
const TIMESTAMP_WARNING = "datetime_gmt is the END of the half-hour period (UTC) in the PV_Live convention; align accordingly when joining to meter data that stamps the period start.";

export const definition = defineIntegration({
  id: "pv-live",
  name: "Sheffield Solar PV_Live",
  group: "solar",
  access: "open",
  territory: "GB",
  description: "University of Sheffield's PV_Live: half-hourly estimates of GB solar PV generation (MW) and installed capacity, nationally and by Grid Supply Point or PES region. Use to benchmark site PV output, estimate embedded solar, and support time-of-use analysis.",
  docsUrl: "https://www.solar.sheffield.ac.uk/api/",
  termsUrl: "https://www.solar.sheffield.ac.uk/pvlive/",
  attribution: "PV_Live data © University of Sheffield (Sheffield Solar), used under CC BY 4.0. Source: https://www.solar.sheffield.ac.uk/pvlive/",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Licence: Sheffield Solar publishes PV_Live under CC BY 4.0 with attribution required (recorded in the OGL bucket as the closest open category). Confirm current terms on the PV_Live page before commercial redistribution.",
    "No key. The Python client chunks requests into 30-day windows; this connector does the same and caps half-hourly calls at 31 days and daily totals at 92 days.",
    "Entity ids: pes/0 and gsp/0 are both national; PES ids 10-23 are the former Public Electricity Supplier regions; GSP ids follow the NESO GSP list (endpoint /gsp_list). Ids are not validated here because the id lists are not fetched.",
    "Values: generation_mw is the estimated outturn for the half hour ending at datetime_gmt; installedcapacity_mwp and capacity_mwp are the modelled installed capacity fields. The alias host api.solar.sheffield.ac.uk serves the same API.",
    "Built from the SheffieldSolar/PV_Live-API client without a live call.",
  ],
  healthCheck: simpleHealth(`${BASE}/pes/0`),
  operations: [
    {
      id: "national_latest",
      label: "Latest national PV outturn",
      description: "The most recent half-hour estimate of GB solar generation with installed capacity and load factor.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<PvLiveResponse>(ctx, buildUrl(BASE, entityPath("pes", 0), { extra_fields: EXTRA_FIELDS }));
        const first = toObjects(data)[0];
        if (!first) return { summary: "No PV_Live data returned.", columns: HH_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "pes/0 latest", basis: "unavailable" }) };
        const row = hhRow(first);
        return {
          summary: `GB solar PV at ${row.period_end_gmt} (period end): ${row.generation_mw ?? "n/a"} MW from ${row.installed_capacity_mwp ?? "n/a"} MWp installed (${row.load_factor_pct ?? "n/a"}% of capacity).`,
          columns: HH_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "pes/0 latest", basis: "estimated" }),
          warnings: [ESTIMATE_WARNING, TIMESTAMP_WARNING],
        };
      },
    },
    {
      id: "national_range",
      label: "National PV outturn for a date range",
      description: "Half-hourly GB solar generation for up to 31 days, or daily MWh totals with the daily peak for up to 92 days.",
      params: [
        { name: "resolution", label: "Resolution", type: "select", required: true, default: "half_hourly", options: [{ value: "half_hourly", label: "Half-hourly MW (max 31 days)" }, { value: "daily", label: "Daily MWh totals (max 92 days)" }] },
        { name: "from", label: "From (UTC date)", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "to", label: "To (UTC date, inclusive)", type: "date", required: true, placeholder: "2026-08-31" },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const daily = params.resolution === "daily";
        assertRange(from, to, daily ? MAX_DAILY_DAYS : MAX_HALF_HOURLY_DAYS, "date range");
        const rows = await fetchRange(ctx, "pes", 0, from, to);
        if (rows.length === 0) return { summary: `No PV_Live data for ${from} to ${to}.`, columns: daily ? ["date", "generation_mwh", "peak_mw", "peak_period_end_gmt", "periods"] : HH_COLUMNS, rows: [], raw: rows, provenance: makeProvenance(definition, ctx, { dataset: "pes/0", basis: "unavailable" }) };
        if (daily) {
          const totals = dailyTotals(rows);
          const total = totals.reduce((a, d) => a + d.generation_mwh, 0);
          const best = totals.reduce((b, d) => (d.generation_mwh > b.generation_mwh ? d : b), totals[0]);
          return {
            summary: `${totals.length} days from ${from} to ${to}: ${round(total / 1000, 1)} GWh of estimated GB solar generation, averaging ${round(total / totals.length / 1000, 2)} GWh/day; best day ${best.date} at ${round(best.generation_mwh / 1000, 2)} GWh (peak ${best.peak_mw} MW).`,
            columns: ["date", "generation_mwh", "peak_mw", "peak_period_end_gmt", "periods"],
            rows: totals,
            raw: rows,
            provenance: makeProvenance(definition, ctx, { dataset: "pes/0", basis: "estimated" }),
            warnings: [ESTIMATE_WARNING, "Daily totals sum half-hourly MW x 0.5 h; days with fewer than 48 periods are incomplete (see the periods column)."],
          };
        }
        const hh = rows.map(hhRow);
        const gens = hh.map((r) => r.generation_mw).filter((v): v is number => typeof v === "number");
        const peak = hh.reduce((b, r) => ((r.generation_mw ?? -1) > (b.generation_mw ?? -1) ? r : b), hh[0]);
        return {
          summary: `${hh.length} half hours from ${from} to ${to}: ${round(gens.reduce((a, b) => a + b, 0) * 0.5 / 1000, 1)} GWh estimated; peak ${peak.generation_mw} MW at ${peak.period_end_gmt} (period end).`,
          columns: HH_COLUMNS,
          rows: hh,
          raw: rows,
          provenance: makeProvenance(definition, ctx, { dataset: "pes/0", basis: "estimated" }),
          warnings: [ESTIMATE_WARNING, TIMESTAMP_WARNING],
        };
      },
    },
    {
      id: "regional_range",
      label: "Regional PV outturn by PES or GSP id",
      description: "Half-hourly solar generation for one PES region (ids 10-23) or Grid Supply Point for up to 31 days.",
      params: [
        { name: "entity", label: "Region type", type: "select", required: true, default: "pes", options: [{ value: "pes", label: "PES region" }, { value: "gsp", label: "Grid Supply Point" }] },
        { name: "id", label: "Region id", type: "integer", required: true, min: 0, max: 400, placeholder: "12", help: "PES ids run 10-23 (e.g. 12 = South Western). GSP ids follow the PV_Live gsp_list." },
        { name: "from", label: "From (UTC date)", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "to", label: "To (UTC date, inclusive)", type: "date", required: true, placeholder: "2026-08-07" },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, MAX_HALF_HOURLY_DAYS, "date range");
        const entity = params.entity === "gsp" ? "gsp" : "pes";
        const id = Number(params.id);
        const rows = await fetchRange(ctx, entity, id, from, to);
        const columns = [`${entity}_id`, ...HH_COLUMNS];
        if (rows.length === 0) return { summary: `No PV_Live data for ${entity} ${id} from ${from} to ${to}.`, columns, rows: [], raw: rows, provenance: makeProvenance(definition, ctx, { dataset: `${entity}/${id}`, basis: "unavailable" }) };
        const hh = rows.map((r) => ({ [`${entity}_id`]: r[`${entity}_id`] ?? id, ...hhRow(r) }));
        const gens = rows.map((r) => r.generation_mw).filter((v): v is number => typeof v === "number");
        return {
          summary: `${entity.toUpperCase()} ${id}: ${hh.length} half hours from ${from} to ${to}, ${round(gens.reduce((a, b) => a + b, 0) * 0.5, 0)} MWh estimated, peak ${Math.max(...gens)} MW.`,
          columns,
          rows: hh,
          raw: rows,
          provenance: makeProvenance(definition, ctx, { dataset: `${entity}/${id}`, basis: "estimated" }),
          warnings: [ESTIMATE_WARNING, TIMESTAMP_WARNING, "Regional estimates carry more uncertainty than the national figure because the metered sample per region is smaller."],
        };
      },
    },
  ],
});
