import { buildUrl, defineIntegration, fetchText, makeProvenance, type HealthResult, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords } from "../_shared/csv";
import { assertRange, chunkDays, daysInclusive, mean, round, toDateString } from "../_shared/dates";

/**
 * National Gas Transmission data portal (data.nationalgas.com). The download endpoint, its parameters, the CSV
 * columns and the item ids below were confirmed from several open-source clients (Energy Sparks, chellow,
 * gb-analysis, gb-power-dashboard); nothing here was exercised live. Item ids are portal "publication objects"
 * and may be re-issued by National Gas.
 */

const BASE = "https://data.nationalgas.com/api";
const DOWNLOAD = "find-gas-data-download";
/** Open-source clients report the API rejects requests where days x items exceeds about 3,600. */
const MAX_DAYS_TIMES_ITEMS = 3600;
const MAX_DAYS = 366;

/** Item ids seen in open-source clients. Units are as those clients describe them and are not returned by the API. */
export const KNOWN_ITEMS = {
  demand: [
    { id: "PUBOBJ1023", name: "NTS Energy Offtaken, LDZ Offtake Total", component: "LDZ (distribution) demand", unit: "kWh" },
    { id: "PUBOBJ1025", name: "NTS Energy Offtaken, Powerstations Total", component: "Power stations", unit: "kWh" },
    { id: "PUBOBJ1026", name: "NTS Energy Offtaken, Industrial Offtake Total", component: "Industrial", unit: "kWh" },
    { id: "PUBOBJ1028", name: "NTS Energy Offtaken, Interconnector Exports Total", component: "Interconnector exports", unit: "kWh" },
    { id: "PUBOBJ1024", name: "NTS Energy Offtaken, Storage Injection Total", component: "Storage injection", unit: "kWh" },
  ],
  supply: [
    { id: "PUBOBJ1620", name: "Beach Including Norway - Daily Flow", component: "Beach incl. Norway", unit: "mcm" },
    { id: "PUBOBJ1621", name: "Aggregate LNG Importations - Daily Flow", component: "LNG", unit: "mcm" },
    { id: "PUBOB262", name: "Interconnector - Daily Flow", component: "Interconnector imports", unit: "mcm" },
    { id: "PUBOB264", name: "Storage - Daily Flow", component: "Storage withdrawal", unit: "mcm" },
  ],
  price: [{ id: "PUBOB603", name: "System Average Price (SAP), Actual Day", component: "SAP", unit: "p/kWh" }],
} as const;

/** Local Distribution Zone calorific value items (daily CV in MJ/m3), per an open-source smart-meter client. */
export const LDZ_CV_ITEMS: { value: string; label: string }[] = [
  { value: "PUBOB4507", label: "EA: East Anglia" },
  { value: "PUBOB4508", label: "EM: East Midlands" },
  { value: "PUBOB4510", label: "NE: North East" },
  { value: "PUBOB4509", label: "NO: Northern" },
  { value: "PUBOB4511", label: "NT: North Thames" },
  { value: "PUBOB4512", label: "NW: North West" },
  { value: "PUBOB4513", label: "SC: Scotland" },
  { value: "PUBOB4514", label: "SE: South East" },
  { value: "PUBOB4515", label: "SO: Southern" },
  { value: "PUBOB4516", label: "SW: South West" },
  { value: "PUBOB4517", label: "WM: West Midlands" },
  { value: "PUBOB4518", label: "WN: Wales North" },
  { value: "PUBOB4519", label: "WS: Wales South" },
];

export interface GasRow {
  gas_day: string;
  applicable_at: string;
  data_item: string;
  value: number | null;
  generated_time: string;
  quality: string;
}

/** Portal CSV dates are dd/mm/yyyy with an optional HH:MM[:SS]; convert to ISO (date or date-time without offset). */
export function parsePortalDate(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) return s.trim();
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return hh ? `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? "00"}` : `${yyyy}-${mm}-${dd}`;
}

export function parseGasCsv(text: string): GasRow[] {
  if (text.trim() === "") return [];
  const { records } = csvToRecords(text, { isHeader: (row) => row.includes("Data Item") });
  return records
    .map((r) => ({
      gas_day: parsePortalDate(r["Applicable For"] ?? ""),
      applicable_at: parsePortalDate(r["Applicable At"] ?? ""),
      data_item: r["Data Item"] ?? "",
      value: r.Value === undefined || r.Value === "" || Number.isNaN(Number(r.Value)) ? null : Number(r.Value),
      generated_time: parsePortalDate(r["Generated Time"] ?? ""),
      quality: r["Quality Indicator"] ?? "",
    }))
    .sort((a, b) => a.data_item.localeCompare(b.data_item) || a.gas_day.localeCompare(b.gas_day) || a.applicable_at.localeCompare(b.applicable_at));
}

async function download(ctx: OperationContext, ids: string[], from: string, to: string, opts: { dateType: "GASDAY" | "NORMALDAY"; latest: boolean }): Promise<{ rows: GasRow[]; requests: number; csv: string }> {
  assertRange(from, to, MAX_DAYS, "date range");
  const maxDays = Math.max(1, Math.floor(MAX_DAYS_TIMES_ITEMS / ids.length));
  const chunks = chunkDays(from, to, maxDays);
  const rows: GasRow[] = [];
  const csvParts: string[] = [];
  for (const c of chunks) {
    const body = { applicableFor: "Y", dateFrom: c.from, dateTo: c.to, dateType: opts.dateType, latestFlag: opts.latest ? "Y" : "N", ids: ids.join(","), type: "CSV" };
    const { text } = await fetchText(ctx, `${BASE}/${DOWNLOAD}`, { method: "POST", headers: { "content-type": "application/json", accept: "text/csv, text/plain, */*" }, body: JSON.stringify(body) }, { timeoutMs: 60_000 });
    csvParts.push(text);
    rows.push(...parseGasCsv(text));
  }
  return { rows, requests: chunks.length, csv: csvParts.join("\n") };
}

const COLUMNS = ["gas_day", "applicable_at", "data_item", "value", "unit", "generated_time", "quality"];
const ID_WARNING = "Item ids come from open-source clients of the portal and have not been confirmed live; if a preset returns nothing, look the item up in the portal's data-item explorer and use 'Download data items by id'.";

const dateParams = [
  { name: "from", label: "From (gas day)", type: "date" as const, required: true, placeholder: "2026-08-01" },
  { name: "to", label: "To (gas day, inclusive)", type: "date" as const, required: true, placeholder: "2026-08-31", help: "Gas days run 05:00 to 05:00 UK time." },
];

function emptyResult(ctx: OperationContext, dataset: string, what: string, raw: unknown, warnings: string[]): OperationResult {
  return { summary: `No rows returned for ${what}.`, columns: COLUMNS, rows: [], raw, provenance: makeProvenance(definition, ctx, { dataset, basis: "unavailable" }), warnings };
}

export const definition = defineIntegration({
  id: "national-gas-data",
  name: "National Gas data portal",
  group: "grid",
  access: "open",
  territory: "GB",
  description: "National Gas Transmission operational data: NTS gas demand by offtake type, supply by source, daily LDZ calorific values (for m3 to kWh conversion) and the System Average Price, downloaded as CSV by publication-object id.",
  docsUrl: "https://data.nationalgas.com/",
  termsUrl: "https://www.nationalgas.com/legal",
  attribution: "Contains data from the National Gas Transmission data portal (data.nationalgas.com), © National Gas Transmission plc.",
  licence: "restricted",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The portal is public but National Gas does not publish an OGL-style reuse licence for this API; recorded as 'restricted' until redistribution terms are confirmed.",
    "Endpoint: POST /api/find-gas-data-download with a JSON body {applicableFor, dateFrom, dateTo, dateType, latestFlag, ids, type:'CSV'}; open-source clients also use it as a GET with the same parameters. Responses are CSV with columns Applicable At, Applicable For, Data Item, Value, Generated Time, Quality Indicator and dd/mm/yyyy dates.",
    "Open-source clients report a limit of roughly 3,600 (days x items) per request and a ~2 MB response cap; requests are chunked accordingly and capped at 366 days.",
    "Units are not in the response. Per those clients, the 'NTS Energy Offtaken' demand items are kWh, 'Daily Flow' supply items are mcm/day, SAP is p/kWh and LDZ CV is MJ/m3. Verify against the portal before relying on them.",
    ID_WARNING,
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    const day = toDateString(new Date(ctx.now().getTime() - 2 * 86_400_000));
    const url = buildUrl(BASE, DOWNLOAD, { applicableFor: "Y", dateFrom: day, dateTo: day, dateType: "GASDAY", latestFlag: "Y", ids: KNOWN_ITEMS.price[0].id, type: "CSV" });
    try {
      const res = await ctx.fetch(url, { signal: AbortSignal.timeout(15_000) });
      const latencyMs = Date.now() - started;
      return res.ok ? { ok: true, detail: `HTTP ${res.status}`, latencyMs } : { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "download_items",
      label: "Download data items by id",
      description: "Any publication objects (PUBOBJ ids) for a gas-day range as tidy rows. Find ids in the portal's data-item explorer.",
      params: [
        { name: "ids", label: "Item ids", type: "text", required: true, placeholder: "PUBOBJ1023,PUBOBJ1025", help: "Comma or newline separated PUBOBJ/PUBOB ids." },
        ...dateParams,
        { name: "date_type", label: "Date type", type: "select", required: false, default: "GASDAY", options: [{ value: "GASDAY", label: "Gas day (05:00-05:00)" }, { value: "NORMALDAY", label: "Calendar day" }] },
        { name: "latest_only", label: "Latest revision only", type: "boolean", required: false, default: true },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const ids = String(params.ids).split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (ids.length === 0) throw new Error("At least one item id is required.");
        if (ids.some((id) => !/^PUBOBJ?\d+$/.test(id))) throw new Error("Item ids must look like PUBOBJ1023 or PUBOB603.");
        const from = String(params.from);
        const to = String(params.to);
        const { rows, requests, csv } = await download(ctx, ids, from, to, { dateType: params.date_type === "NORMALDAY" ? "NORMALDAY" : "GASDAY", latest: params.latest_only !== false });
        if (rows.length === 0) return emptyResult(ctx, "find-gas-data-download", `${ids.join(", ")} from ${from} to ${to}`, csv, [ID_WARNING]);
        const items = new Set(rows.map((r) => r.data_item));
        return {
          summary: `${rows.length} rows for ${items.size} data item${items.size === 1 ? "" : "s"} from ${from} to ${to} (${requests} request${requests === 1 ? "" : "s"}).`,
          columns: COLUMNS,
          rows: rows.map((r) => ({ ...r, unit: null })),
          raw: csv,
          provenance: makeProvenance(definition, ctx, { dataset: `find-gas-data-download:${ids.join(",")}`, basis: "measured" }),
          warnings: ["Units are not returned by the API; check the item's description on the portal.", ID_WARNING],
        };
      },
    },
    {
      id: "system_demand",
      label: "NTS gas demand by offtake type",
      description: "Daily National Transmission System demand split into LDZ (distribution), power stations, industrial, interconnector exports and storage injection. Values reported in kWh with a GWh convenience column.",
      params: dateParams,
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const ids = KNOWN_ITEMS.demand.map((i) => i.id);
        const { rows, csv, requests } = await download(ctx, ids, from, to, { dateType: "GASDAY", latest: true });
        if (rows.length === 0) return emptyResult(ctx, "nts-demand", `NTS demand from ${from} to ${to}`, csv, [ID_WARNING]);
        const byName = new Map<string, { component: string }>(KNOWN_ITEMS.demand.map((i) => [i.name, i]));
        const out = rows.map((r) => ({ gas_day: r.gas_day, component: byName.get(r.data_item)?.component ?? r.data_item, data_item: r.data_item, value_kwh: r.value, value_gwh: r.value === null ? null : round(r.value / 1e6, 2), generated_time: r.generated_time, quality: r.quality }));
        const totalsByDay = new Map<string, number>();
        for (const r of out) if (r.value_gwh !== null) totalsByDay.set(r.gas_day, (totalsByDay.get(r.gas_day) ?? 0) + r.value_gwh);
        const dailyTotals = Array.from(totalsByDay.values());
        return {
          summary: `${totalsByDay.size} gas days from ${from} to ${to}: mean NTS demand ${round(mean(dailyTotals) ?? 0, 0)} GWh/day (${daysInclusive(from, to)} days requested, ${requests} request${requests === 1 ? "" : "s"}).`,
          columns: ["gas_day", "component", "data_item", "value_kwh", "value_gwh", "generated_time", "quality"],
          rows: out,
          raw: csv,
          provenance: makeProvenance(definition, ctx, { dataset: "nts-demand", basis: "measured" }),
          warnings: ["kWh units are as described by open-source clients, not by the API; confirm on the portal before use in reports.", ID_WARNING],
        };
      },
    },
    {
      id: "system_supply",
      label: "NTS gas supply by source",
      description: "Daily gas supply into the NTS from beach terminals (incl. Norway), LNG, interconnector imports and storage, in million cubic metres per day.",
      params: dateParams,
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const { rows, csv } = await download(ctx, KNOWN_ITEMS.supply.map((i) => i.id), from, to, { dateType: "GASDAY", latest: true });
        if (rows.length === 0) return emptyResult(ctx, "nts-supply", `NTS supply from ${from} to ${to}`, csv, [ID_WARNING]);
        const byName = new Map<string, { component: string }>(KNOWN_ITEMS.supply.map((i) => [i.name, i]));
        const out = rows.map((r) => ({ gas_day: r.gas_day, component: byName.get(r.data_item)?.component ?? r.data_item, data_item: r.data_item, value_mcm: r.value, generated_time: r.generated_time, quality: r.quality }));
        const days = new Set(out.map((r) => r.gas_day)).size;
        return {
          summary: `${out.length} rows over ${days} gas days from ${from} to ${to}; mean daily flow per source ${round(mean(out.map((r) => r.value_mcm).filter((v): v is number => v !== null)) ?? 0, 1)} mcm.`,
          columns: ["gas_day", "component", "data_item", "value_mcm", "generated_time", "quality"],
          rows: out,
          raw: csv,
          provenance: makeProvenance(definition, ctx, { dataset: "nts-supply", basis: "measured" }),
          warnings: ["mcm/day units are as described by open-source clients, not by the API (1 mcm is roughly 11 GWh).", ID_WARNING],
        };
      },
    },
    {
      id: "ldz_calorific_value",
      label: "Daily calorific value for a gas distribution zone",
      description: "Published daily calorific value (MJ/m3) for one LDZ, used to convert metered gas volume to kWh: kWh = m3 x volume correction (1.02264) x CV / 3.6.",
      params: [{ name: "ldz", label: "Local Distribution Zone", type: "select", required: true, options: LDZ_CV_ITEMS }, ...dateParams],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const id = String(params.ldz);
        const label = LDZ_CV_ITEMS.find((i) => i.value === id)?.label ?? id;
        const { rows, csv } = await download(ctx, [id], from, to, { dateType: "GASDAY", latest: true });
        if (rows.length === 0) return emptyResult(ctx, `ldz-cv:${id}`, `${label} CV from ${from} to ${to}`, csv, [ID_WARNING]);
        const out = rows.map((r) => ({ gas_day: r.gas_day, ldz: label, data_item: r.data_item, cv_mj_m3: r.value, generated_time: r.generated_time, quality: r.quality }));
        const vals = out.map((r) => r.cv_mj_m3).filter((v): v is number => v !== null);
        return {
          summary: `${label}: ${out.length} daily calorific values from ${from} to ${to}; mean ${round(mean(vals) ?? 0, 2)} MJ/m3 (range ${Math.min(...vals)} to ${Math.max(...vals)}).`,
          columns: ["gas_day", "ldz", "data_item", "cv_mj_m3", "generated_time", "quality"],
          rows: out,
          raw: csv,
          provenance: makeProvenance(definition, ctx, { dataset: `ldz-cv:${id}`, basis: "measured" }),
          warnings: ["Suppliers bill on the CV published for the LDZ and gas day; for a monthly bill reconciliation use the average CV over the billing period.", ID_WARNING],
        };
      },
    },
    {
      id: "system_average_price",
      label: "System Average Price (SAP)",
      description: "Daily actual-day System Average Price of gas traded at the NBP, in p/kWh, with a GBP/MWh convenience column.",
      params: dateParams,
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const { rows, csv } = await download(ctx, [KNOWN_ITEMS.price[0].id], from, to, { dateType: "GASDAY", latest: true });
        if (rows.length === 0) return emptyResult(ctx, "sap", `SAP from ${from} to ${to}`, csv, [ID_WARNING]);
        const out = rows.map((r) => ({ gas_day: r.gas_day, data_item: r.data_item, sap_p_per_kwh: r.value, sap_gbp_per_mwh: r.value === null ? null : round(r.value * 10, 2), generated_time: r.generated_time, quality: r.quality }));
        const vals = out.map((r) => r.sap_p_per_kwh).filter((v): v is number => v !== null);
        return {
          summary: `${out.length} gas days from ${from} to ${to}: mean SAP ${round(mean(vals) ?? 0, 3)} p/kWh (${round((mean(vals) ?? 0) * 10, 2)} GBP/MWh), range ${Math.min(...vals)} to ${Math.max(...vals)} p/kWh.`,
          columns: ["gas_day", "data_item", "sap_p_per_kwh", "sap_gbp_per_mwh", "generated_time", "quality"],
          rows: out,
          raw: csv,
          provenance: makeProvenance(definition, ctx, { dataset: "sap", basis: "measured" }),
          warnings: ["SAP is a wholesale balancing price; a supply contract adds transportation, metering and supplier margin. Do not use it as a tariff.", ID_WARNING],
        };
      },
    },
  ],
});

