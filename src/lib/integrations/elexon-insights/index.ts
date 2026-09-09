import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { addDays, assertRange, mean, round } from "../_shared/dates";

/**
 * Elexon Insights Solution (BMRS) open data. Paths, parameters and response schemas were taken from the
 * published OpenAPI documents for the Insights API (Generation, Demand, Market Index, Indicative Imbalance
 * Settlement and System groups), not from a live call.
 */

const BASE = "https://data.elexon.co.uk/bmrs/api/v1";

/** Insights wraps most responses as { data: [...] , metadata }, but a few summary endpoints return a bare array. */
function unwrap<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) return (body as { data: T[] }).data;
  return [];
}

/** Power System Resource types (Commission Regulation (EU) 543/2013 categories) as used by AGPT/B1620. */
const RENEWABLE_PSR = new Set(["Wind Onshore", "Wind Offshore", "Solar", "Hydro Run-of-river and poundage", "Biomass", "Other renewable"]);
const LOW_CARBON_EXTRA = new Set(["Nuclear"]);

interface PerTypePeriod {
  startTime: string;
  settlementPeriod: number;
  data: { psrType: string; quantity: number; businessType?: string }[];
}

interface AgptSummary {
  psrType: string;
  halfHourUsage: number;
  halfHourPercentage: number;
  twentyFourHourUsage: number;
  twentyFourHourPercentage: number;
}

interface IndoRow {
  publishTime?: string;
  startTime: string;
  settlementDate: string;
  settlementPeriod: number;
  initialDemandOutturn: number | null;
  initialTransmissionSystemDemandOutturn: number | null;
}

interface IndodRow {
  publishTime?: string;
  settlementDate: string;
  demand: number | null;
}

interface SystemPrice {
  settlementDate: string;
  settlementPeriod: number;
  startTime: string;
  createdDateTime?: string;
  systemSellPrice: number;
  systemBuyPrice: number;
  netImbalanceVolume?: number | null;
  priceDerivationCode?: string | null;
  reserveScarcityPrice?: number | null;
}

interface MarketIndex {
  startTime: string;
  dataProvider: string;
  settlementDate: string;
  settlementPeriod: number;
  price: number;
  volume: number;
}

const ATTRIBUTION_WARNING = "Display 'Contains BMRS data © Elexon Limited copyright and database right' wherever these figures are shown.";

function slug(psr: string): string {
  return psr.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export const definition = defineIntegration({
  id: "elexon-insights",
  name: "Elexon Insights (BMRS)",
  group: "grid",
  access: "open",
  territory: "GB",
  description: "Elexon's open Balancing Mechanism Reporting Service: half-hourly GB generation by fuel type, national demand outturn, imbalance (system) prices and market index (wholesale) prices. No key required.",
  docsUrl: "https://bmrs.elexon.co.uk/api-documentation",
  termsUrl: "https://www.elexon.co.uk/data/balancing-mechanism-reporting-agent/copyright-licence-bmrs-data/",
  attribution: "Contains BMRS data © Elexon Limited copyright and database right",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Licence is Elexon's BMRS data licence (free reuse with the attribution above), recorded in the OGL bucket as the closest open category; it is not the Open Government Licence.",
    "No key. Elexon returns HTTP 429 when throttled; keep ranges short and cache. Each operation here caps its range.",
    "Timestamps are UTC; settlement periods are half hours numbered 1-48 (46 or 50 on clock-change days) in the GB settlement day.",
    "/generation/actual/per-type is documented as a down-sampled visualisation endpoint: for ranges beyond a few days Elexon may average to hourly or daily. Use /datasets/AGPT for full fidelity bulk pulls.",
    "Built from the published OpenAPI documents without a live call; the bare-array shape of /generation/actual/per-type/day-total and the { data } wrapper elsewhere are both handled.",
  ],
  healthCheck: simpleHealth(`${BASE}/generation/actual/per-type/day-total`),
  operations: [
    {
      id: "generation_by_fuel",
      label: "Generation by fuel type for a date range",
      description: "Half-hourly GB generation (MW) per fuel type (AGPT/B1620) as a wide table with total, renewable share and low-carbon share. Up to 7 days per call.",
      params: [
        { name: "from", label: "From (UTC date)", type: "date", required: true, placeholder: "2026-09-01" },
        { name: "to", label: "To (UTC date, inclusive)", type: "date", required: true, placeholder: "2026-09-02", help: "Maximum 7 days; longer ranges are down-sampled by Elexon." },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 7, "date range");
        const url = buildUrl(BASE, "generation/actual/per-type", { from: `${from}T00:00Z`, to: `${addDays(to, 1)}T00:00Z`, format: "json" });
        const { data } = await fetchJson<unknown>(ctx, url);
        const periods = unwrap<PerTypePeriod>(data);
        const fuels = Array.from(new Set(periods.flatMap((p) => p.data.map((d) => d.psrType)))).sort();
        const fuelCols = fuels.map(slug);
        const columns = ["start_time", "settlement_period", ...fuelCols, "total_mw", "renewable_pct", "low_carbon_pct"];
        if (periods.length === 0) return { summary: `No generation data for ${from} to ${to}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "AGPT (B1620)", basis: "unavailable" }) };
        const rows = periods.map((p) => {
          const row: Record<string, unknown> = { start_time: p.startTime, settlement_period: p.settlementPeriod };
          let total = 0;
          let renewable = 0;
          let lowCarbon = 0;
          for (const f of fuels) row[slug(f)] = null;
          for (const d of p.data) {
            row[slug(d.psrType)] = d.quantity;
            if (d.quantity > 0) total += d.quantity;
            if (RENEWABLE_PSR.has(d.psrType)) renewable += Math.max(d.quantity, 0);
            if (RENEWABLE_PSR.has(d.psrType) || LOW_CARBON_EXTRA.has(d.psrType)) lowCarbon += Math.max(d.quantity, 0);
          }
          row.total_mw = round(total, 0);
          row.renewable_pct = total > 0 ? round((renewable / total) * 100) : null;
          row.low_carbon_pct = total > 0 ? round((lowCarbon / total) * 100) : null;
          return row;
        });
        const avgRenewable = mean(rows.map((r) => r.renewable_pct).filter((v): v is number => typeof v === "number"));
        const avgTotal = mean(rows.map((r) => r.total_mw as number));
        return {
          summary: `${rows.length} periods from ${from} to ${to} across ${fuels.length} fuel types. Mean generation ${round(avgTotal ?? 0, 0)} MW; mean renewable share ${round(avgRenewable ?? 0)}% (wind, solar, hydro, biomass and other renewable).`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "AGPT (B1620)", basis: "measured" }),
          warnings: [
            ATTRIBUTION_WARNING,
            "Quantities are transmission-metered MW per settlement period by PSR type; embedded generation is not included. Negative values (pumping, storage charging) are excluded from the share denominators.",
            "Renewable share counts biomass as renewable (as in UK energy statistics); low-carbon share adds nuclear. Neither is a Scope 2 factor.",
          ],
        };
      },
    },
    {
      id: "generation_day_total",
      label: "Generation mix for the last 24 hours",
      description: "Snapshot of generation by fuel type for the last half hour and the last 24 hours, with percentages.",
      params: [],
      async run(_params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<unknown>(ctx, buildUrl(BASE, "generation/actual/per-type/day-total", { format: "json" }));
        const items = unwrap<AgptSummary>(data);
        const columns = ["fuel", "last_half_hour_mwh", "last_half_hour_pct", "last_24h_mwh", "last_24h_pct"];
        if (items.length === 0) return { summary: "No day-total generation data returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "AGPT day total", basis: "unavailable" }) };
        const rows = items.map((i) => ({ fuel: i.psrType, last_half_hour_mwh: i.halfHourUsage, last_half_hour_pct: i.halfHourPercentage, last_24h_mwh: i.twentyFourHourUsage, last_24h_pct: i.twentyFourHourPercentage }));
        const renewable24 = items.filter((i) => RENEWABLE_PSR.has(i.psrType)).reduce((a, i) => a + i.twentyFourHourPercentage, 0);
        const top = [...items].sort((a, b) => b.twentyFourHourPercentage - a.twentyFourHourPercentage)[0];
        return {
          summary: `Last 24 hours: ${round(renewable24)}% renewable; largest source ${top.psrType} at ${round(top.twentyFourHourPercentage)}%.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "AGPT day total", basis: "measured" }),
          warnings: [ATTRIBUTION_WARNING],
        };
      },
    },
    {
      id: "demand_outturn",
      label: "National demand outturn",
      description: "Initial National Demand outturn (INDO): half-hourly MW for up to 7 days, or daily MWh totals (INDOD) for up to 366 days.",
      params: [
        { name: "resolution", label: "Resolution", type: "select", required: true, default: "daily", options: [{ value: "daily", label: "Daily energy (MWh)" }, { value: "half_hourly", label: "Half-hourly demand (MW)" }] },
        { name: "from", label: "From (settlement date)", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "to", label: "To (settlement date, inclusive)", type: "date", required: true, placeholder: "2026-08-31", help: "Daily: up to 366 days. Half-hourly: up to 7 days." },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        const daily = params.resolution === "daily";
        assertRange(from, to, daily ? 366 : 7, "date range");
        const url = buildUrl(BASE, daily ? "demand/outturn/daily" : "demand/outturn", { settlementDateFrom: from, settlementDateTo: to, format: "json" });
        const { data } = await fetchJson<unknown>(ctx, url);
        if (daily) {
          const items = unwrap<IndodRow>(data).sort((a, b) => a.settlementDate.localeCompare(b.settlementDate));
          const columns = ["settlement_date", "demand_mwh", "published"];
          if (items.length === 0) return { summary: `No daily demand outturn for ${from} to ${to}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "INDOD", basis: "unavailable" }) };
          const rows = items.map((i) => ({ settlement_date: i.settlementDate, demand_mwh: i.demand, published: i.publishTime ?? null }));
          const vals = items.map((i) => i.demand).filter((v): v is number => typeof v === "number");
          return {
            summary: `${rows.length} days from ${from} to ${to}: mean ${round((mean(vals) ?? 0) / 1000, 1)} GWh/day, total ${round(vals.reduce((a, b) => a + b, 0) / 1000, 0)} GWh.`,
            columns,
            rows,
            raw: data,
            provenance: makeProvenance(definition, ctx, { dataset: "INDOD", basis: "measured" }),
            warnings: [ATTRIBUTION_WARNING, "INDO excludes station load, pumped storage pumping and interconnector exports, and is transmission-level demand net of embedded generation; it is not total GB electricity consumption."],
          };
        }
        const items = unwrap<IndoRow>(data).sort((a, b) => a.startTime.localeCompare(b.startTime));
        const columns = ["start_time", "settlement_date", "settlement_period", "indo_mw", "itsdo_mw"];
        if (items.length === 0) return { summary: `No half-hourly demand outturn for ${from} to ${to}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "INDO", basis: "unavailable" }) };
        const rows = items.map((i) => ({ start_time: i.startTime, settlement_date: i.settlementDate, settlement_period: i.settlementPeriod, indo_mw: i.initialDemandOutturn, itsdo_mw: i.initialTransmissionSystemDemandOutturn }));
        const vals = items.map((i) => i.initialDemandOutturn).filter((v): v is number => typeof v === "number");
        const peak = items.reduce((b, i) => ((i.initialDemandOutturn ?? -1) > (b.initialDemandOutturn ?? -1) ? i : b), items[0]);
        return {
          summary: `${rows.length} half hours from ${from} to ${to}: mean INDO ${round(mean(vals) ?? 0, 0)} MW, peak ${peak.initialDemandOutturn} MW at ${peak.startTime}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "INDO", basis: "measured" }),
          warnings: [ATTRIBUTION_WARNING, "INDO is transmission-metered national demand (net of embedded generation); ITSDO adds station load, pumping and interconnector exports."],
        };
      },
    },
    {
      id: "system_prices",
      label: "Imbalance (system) prices for a settlement day",
      description: "System Buy and Sell Price (£/MWh) and net imbalance volume for each settlement period of one day, from the latest settlement run.",
      params: [{ name: "settlement_date", label: "Settlement date", type: "date", required: true, placeholder: "2026-09-01" }],
      async run(params, ctx): Promise<OperationResult> {
        const date = String(params.settlement_date);
        const { data } = await fetchJson<unknown>(ctx, buildUrl(BASE, `balancing/settlement/system-prices/${date}`, { format: "json" }));
        const items = unwrap<SystemPrice>(data).sort((a, b) => a.settlementPeriod - b.settlementPeriod);
        const columns = ["settlement_period", "start_time", "system_sell_price_gbp_mwh", "system_buy_price_gbp_mwh", "net_imbalance_volume_mwh", "price_derivation_code", "reserve_scarcity_price", "created"];
        if (items.length === 0) return { summary: `No system prices published yet for ${date}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "DISEBSP", basis: "unavailable" }) };
        const rows = items.map((i) => ({ settlement_period: i.settlementPeriod, start_time: i.startTime, system_sell_price_gbp_mwh: i.systemSellPrice, system_buy_price_gbp_mwh: i.systemBuyPrice, net_imbalance_volume_mwh: i.netImbalanceVolume ?? null, price_derivation_code: i.priceDerivationCode ?? null, reserve_scarcity_price: i.reserveScarcityPrice ?? null, created: i.createdDateTime ?? null }));
        const prices = items.map((i) => i.systemBuyPrice);
        return {
          summary: `${rows.length} settlement periods on ${date}: system price mean £${round(mean(prices) ?? 0, 2)}/MWh, range £${Math.min(...prices)} to £${Math.max(...prices)}/MWh.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "DISEBSP", basis: "measured" }),
          warnings: [ATTRIBUTION_WARNING, "Imbalance prices are what parties pay or receive for being out of balance; they are not a retail tariff and are revised through later settlement runs (initial to final reconciliation)."],
        };
      },
    },
    {
      id: "market_index_prices",
      label: "Market index (wholesale) prices",
      description: "Half-hourly Market Index Data price (£/MWh) and traded volume from the APX and/or N2EX providers, up to 7 days. A proxy for short-term wholesale electricity prices.",
      params: [
        { name: "from", label: "From (UTC date)", type: "date", required: true, placeholder: "2026-09-01" },
        { name: "to", label: "To (UTC date, inclusive)", type: "date", required: true, placeholder: "2026-09-07", help: "Maximum 7 days." },
        { name: "provider", label: "Data provider", type: "select", required: false, default: "APXMIDP", options: [{ value: "APXMIDP", label: "APX (EPEX Spot)" }, { value: "N2EXMIDP", label: "N2EX (Nord Pool)" }, { value: "both", label: "Both" }] },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.from);
        const to = String(params.to);
        assertRange(from, to, 7, "date range");
        const provider = String(params.provider ?? "APXMIDP");
        const url = buildUrl(BASE, "balancing/pricing/market-index", { from: `${from}T00:00Z`, to: `${addDays(to, 1)}T00:00Z`, dataProviders: provider === "both" ? undefined : provider, format: "json" });
        const { data } = await fetchJson<unknown>(ctx, url);
        const items = unwrap<MarketIndex>(data).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.dataProvider.localeCompare(b.dataProvider));
        const columns = ["start_time", "settlement_date", "settlement_period", "provider", "price_gbp_mwh", "volume_mwh"];
        if (items.length === 0) return { summary: `No market index data for ${from} to ${to}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "MID", basis: "unavailable" }) };
        const rows = items.map((i) => ({ start_time: i.startTime, settlement_date: i.settlementDate, settlement_period: i.settlementPeriod, provider: i.dataProvider, price_gbp_mwh: i.price, volume_mwh: i.volume }));
        const traded = items.filter((i) => i.volume > 0);
        const vwap = traded.length ? traded.reduce((a, i) => a + i.price * i.volume, 0) / traded.reduce((a, i) => a + i.volume, 0) : null;
        return {
          summary: `${rows.length} price points from ${from} to ${to} (${provider === "both" ? "APX and N2EX" : provider}). Volume-weighted average £${vwap === null ? "n/a" : round(vwap, 2)}/MWh; range £${Math.min(...items.map((i) => i.price))} to £${Math.max(...items.map((i) => i.price))}/MWh.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "MID", basis: "measured" }),
          warnings: [ATTRIBUTION_WARNING, "Market index prices reflect short-term traded wholesale electricity. A supply contract adds network, policy and supplier costs; do not use these as a tariff."],
        };
      },
    },
  ],
});

export { unwrap, slug, RENEWABLE_PSR };
