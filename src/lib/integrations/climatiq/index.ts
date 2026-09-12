import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";

/**
 * Climatiq: commercial emission-factor search and estimation API.
 *
 * Endpoints (documented; not exercised live from this environment):
 *   GET  /data/v1/search?query=&data_version=&region=&year=&source=&unit_type=&page=&results_per_page=
 *   POST /data/v1/estimate  {emission_factor:{activity_id,data_version,region,year,source}, parameters:{...}}
 *   POST /procurement/v1/spend {activity:{activity_id}|{classification_code,classification_type}, spend_year, spend_region, money, money_unit, tax_margin?}
 *
 * Auth: Authorization: Bearer <CLIMATIQ_API_KEY>. data_version is required by
 * the current API; "^N" tracks minor updates of data release N.
 */

const BASE = "https://api.climatiq.io";
/** Latest data release at build time: Data Release 36 (31 July 2026). Override with CLIMATIQ_DATA_VERSION or per call. */
export const DEFAULT_DATA_VERSION = "^36";

function headers(env: EnvLike): Record<string, string> {
  const key = env.CLIMATIQ_API_KEY?.trim();
  if (!key) throw new Error("CLIMATIQ_API_KEY is not set");
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function dataVersion(env: EnvLike, override: unknown): string {
  return (typeof override === "string" && override.trim()) || env.CLIMATIQ_DATA_VERSION?.trim() || DEFAULT_DATA_VERSION;
}

export interface EmissionFactor {
  activity_id: string;
  id: string;
  name: string;
  category?: string;
  sector?: string;
  source: string;
  source_link?: string;
  source_dataset?: string;
  year: number;
  year_released?: number;
  region: string;
  region_name?: string;
  description?: string;
  unit_type?: string;
  unit?: string;
  source_lca_activity?: string;
  data_quality_flags?: string[];
  access_type?: string;
  factor?: number | null;
  factor_calculation_method?: string;
  factor_calculation_origin?: string;
  constituent_gases?: Record<string, number | null>;
}

interface SearchResponse {
  current_page: number;
  last_page: number;
  total_results: number;
  results: EmissionFactor[];
  possible_filters?: unknown;
}

export interface EstimateResponse {
  co2e: number;
  co2e_unit: string;
  co2e_calculation_method?: string;
  co2e_calculation_origin?: string;
  emission_factor: EmissionFactor;
  constituent_gases?: { co2e_total?: number | null; co2e_other?: number | null; co2?: number | null; ch4?: number | null; n2o?: number | null };
  activity_data?: { activity_value: number; activity_unit: string };
  audit_trail?: string;
  notices?: { severity: string; message: string; code?: string }[];
}

interface ProcurementResponse {
  estimate: EstimateResponse;
  calculation_details?: { tax_margin?: number; trade_margin?: number; transport_margin?: number; inflation_applied?: number } | null;
  notices?: { severity: string; message: string; code?: string }[];
  source_trail?: { name: string; source: string; source_dataset?: string | null; year?: string | number | null; region: string; region_name?: string }[];
}

export const SEARCH_COLUMNS = ["activity_id", "name", "factor", "unit", "unit_type", "source", "source_dataset", "region", "year", "category", "sector", "access_type", "data_quality_flags", "factor_id", "data_version"];

function factorRow(f: EmissionFactor, version: string) {
  return {
    activity_id: f.activity_id,
    name: f.name,
    factor: f.factor ?? null,
    unit: f.unit ?? null,
    unit_type: f.unit_type ?? null,
    source: f.source,
    source_dataset: f.source_dataset ?? null,
    region: f.region,
    year: f.year,
    category: f.category ?? null,
    sector: f.sector ?? null,
    access_type: f.access_type ?? null,
    data_quality_flags: (f.data_quality_flags ?? []).join(", "),
    factor_id: f.id,
    data_version: version,
  };
}

export const ESTIMATE_COLUMNS = ["co2e_kg", "co2e_unit", "activity_value", "activity_unit", "calculation_method", "activity_id", "factor_name", "source", "source_dataset", "region", "year", "factor_id", "data_version", "co2", "ch4", "n2o", "data_quality_flags"];

function estimateRow(e: EstimateResponse, version: string) {
  const f = e.emission_factor;
  return {
    co2e_kg: e.co2e_unit === "kg" ? e.co2e : null,
    co2e: e.co2e,
    co2e_unit: e.co2e_unit,
    activity_value: e.activity_data?.activity_value ?? null,
    activity_unit: e.activity_data?.activity_unit ?? null,
    calculation_method: e.co2e_calculation_method ?? null,
    activity_id: f.activity_id,
    factor_name: f.name,
    source: f.source,
    source_dataset: f.source_dataset ?? null,
    region: f.region,
    year: f.year,
    factor_id: f.id,
    data_version: version,
    co2: e.constituent_gases?.co2 ?? null,
    ch4: e.constituent_gases?.ch4 ?? null,
    n2o: e.constituent_gases?.n2o ?? null,
    data_quality_flags: (f.data_quality_flags ?? []).join(", "),
  };
}

function noticeWarnings(notices?: { severity: string; message: string }[]): string[] {
  return (notices ?? []).map((n) => `${n.severity}: ${n.message}`);
}

const PARAM_TYPES = [
  { value: "energy", label: "Energy (kWh, MWh, GJ ...)" },
  { value: "money", label: "Money (gbp, eur, usd ...)" },
  { value: "distance", label: "Distance (km, mi ...)" },
  { value: "weight", label: "Weight (kg, t ...)" },
];

const VERSION_PARAM = { name: "data_version", label: "Data version", type: "string" as const, placeholder: DEFAULT_DATA_VERSION, help: `Climatiq data release, e.g. ${DEFAULT_DATA_VERSION} (auto-updating minor releases) or 36 (pinned). Defaults to CLIMATIQ_DATA_VERSION or ${DEFAULT_DATA_VERSION}.` };

export const definition = defineIntegration({
  id: "climatiq",
  name: "Climatiq emission factors",
  group: "carbon",
  access: "commercial",
  territory: "Global",
  description: "Commercial API over a curated library of emission factors (DESNZ, EPA, IPCC, AIB, EXIOBASE and others) with search, activity-based estimation and spend-based (EXIOBASE) procurement estimates.",
  docsUrl: "https://www.climatiq.io/docs",
  termsUrl: "https://www.climatiq.io/legal/terms",
  attribution: "Emission factors via Climatiq (climatiq.io); underlying source, region, year and data version as recorded per value.",
  licence: "commercial",
  envVars: [
    { name: "CLIMATIQ_API_KEY", required: true, description: "API key from app.climatiq.io, sent as a Bearer token." },
    { name: "CLIMATIQ_DATA_VERSION", required: false, description: `Default data_version for all calls (default ${DEFAULT_DATA_VERSION}).` },
  ],
  status: "built_unverified",
  notes: [
    "Endpoints and parameter names follow the Climatiq API reference (search, estimate, procurement) and public client code; no live call was made from this environment.",
    `data_version is required by the current API. Default ${DEFAULT_DATA_VERSION} tracks Data Release 36 (31 July 2026, which added DEFRA/DESNZ 2026 and AIB 2026 factors). Pin a fixed version (e.g. 36) for a reporting year so results are reproducible, and record it in provenance.`,
    "Provenance: every row carries emission_factor.source, source_dataset, region, year, factor id and data_version. Store these with the value; a Climatiq co2e without its source factor is not auditable.",
    "Search results show the factor value only for public-access factors; premium sources need the matching plan. Estimates carry basis 'estimated' (activity data x published factor).",
    "Spend-based (procurement) estimates use EXIOBASE with Climatiq's inflation, currency and margin adjustments; they are for Scope 3 category 1 screening, not supplier-specific reporting.",
    "Rate limits and quotas depend on the plan; cache search results and avoid per-keystroke searches.",
  ],
  healthCheck: simpleHealth(
    (env) => buildUrl(BASE, "data/v1/search", { query: "electricity", data_version: dataVersion(env, undefined), results_per_page: 1 }),
    (env) => ({ headers: headers(env) }),
  ),
  operations: [
    {
      id: "search",
      label: "Search emission factors",
      description: "Find factors by keyword with optional region, year, source and unit-type filters; returns activity ids for estimation.",
      params: [
        { name: "query", label: "Search text", type: "string", required: true, placeholder: "electricity grid" },
        { name: "region", label: "Region", type: "string", default: "GB", placeholder: "GB", help: "Climatiq region code (ISO alpha-2 or Climatiq sub-region). Blank for all." },
        { name: "year", label: "Year", type: "integer", min: 1990, max: 2100 },
        { name: "source", label: "Source", type: "string", placeholder: "DESNZ", help: "e.g. DESNZ, BEIS, EPA, AIB, EXIOBASE." },
        { name: "unit_type", label: "Unit type", type: "string", placeholder: "Energy", help: "e.g. Energy, Money, Distance, Weight, Number." },
        VERSION_PARAM,
        { name: "results_per_page", label: "Results", type: "integer", default: 25, min: 1, max: 100 },
        { name: "page", label: "Page", type: "integer", default: 1, min: 1, max: 1000 },
      ],
      async run(params, ctx: OperationContext) {
        const version = dataVersion(ctx.env, params.data_version);
        const url = buildUrl(BASE, "data/v1/search", {
          query: String(params.query),
          data_version: version,
          region: params.region as string | undefined,
          year: params.year as number | undefined,
          source: params.source as string | undefined,
          unit_type: params.unit_type as string | undefined,
          results_per_page: params.results_per_page as number,
          page: params.page as number,
        });
        const { data } = await fetchJson<SearchResponse>(ctx, url, { headers: headers(ctx.env) });
        const rows = (data.results ?? []).map((f) => factorRow(f, version));
        const hidden = rows.filter((r) => r.factor === null).length;
        return {
          summary: `${data.total_results ?? rows.length} factor(s) match "${params.query}"${params.region ? ` in ${params.region}` : ""} (page ${data.current_page ?? 1} of ${data.last_page ?? 1}, data version ${version}).`,
          columns: SEARCH_COLUMNS,
          rows,
          raw: { ...data, possible_filters: undefined },
          provenance: makeProvenance(definition, ctx, { dataset: "data/v1/search", basis: rows.length ? "measured" : "unavailable", version }),
          warnings: hidden ? [`${hidden} result(s) do not expose the factor value on this plan; use the activity id with the estimate operation.`] : undefined,
        };
      },
    },
    {
      id: "estimate",
      label: "Estimate emissions from an activity id",
      description: "co2e for a quantity of energy, money, distance or weight against a chosen activity id, region and year.",
      params: [
        { name: "activity_id", label: "Activity id", type: "string", required: true, placeholder: "electricity-supply_grid-source_residual_mix" },
        { name: "parameter_type", label: "Quantity type", type: "select", required: true, options: PARAM_TYPES, default: "energy" },
        { name: "quantity", label: "Quantity", type: "number", required: true, min: 0, placeholder: "1000" },
        { name: "unit", label: "Unit", type: "string", required: true, placeholder: "kWh", help: "Climatiq unit for the quantity type: kWh/MWh/GJ, gbp/eur/usd, km/mi, kg/t." },
        { name: "region", label: "Region", type: "string", default: "GB", placeholder: "GB" },
        { name: "year", label: "Factor year", type: "integer", min: 1990, max: 2100, help: "Optional; Climatiq picks the closest available year when region/year fallback applies." },
        { name: "source", label: "Source", type: "string", placeholder: "DESNZ" },
        VERSION_PARAM,
      ],
      async run(params, ctx) {
        const version = dataVersion(ctx.env, params.data_version);
        const type = String(params.parameter_type);
        const parameters: Record<string, unknown> = { [type]: params.quantity, [`${type}_unit`]: String(params.unit) };
        const body = {
          emission_factor: {
            activity_id: String(params.activity_id),
            data_version: version,
            ...(params.region ? { region: String(params.region) } : {}),
            ...(params.year ? { year: params.year } : {}),
            ...(params.source ? { source: String(params.source) } : {}),
          },
          parameters,
        };
        const { data } = await fetchJson<EstimateResponse>(ctx, `${BASE}/data/v1/estimate`, { method: "POST", headers: headers(ctx.env), body: JSON.stringify(body) });
        const row = estimateRow(data, version);
        const f = data.emission_factor;
        return {
          summary: `${params.quantity} ${params.unit} of ${f.name} (${f.source}, ${f.region}, ${f.year}) = ${data.co2e} ${data.co2e_unit} CO2e.`,
          columns: ESTIMATE_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "data/v1/estimate", basis: "estimated", version: `${version}; factor ${f.id} (${f.source} ${f.region} ${f.year})` }),
          warnings: [...noticeWarnings(data.notices), "Estimate = activity quantity x published factor; the factor's source, region, year and data version are in the row and must be stored with the value."],
        };
      },
    },
    {
      id: "spend",
      label: "Spend-based estimate (procurement)",
      description: "Scope 3 category 1 screening estimate from an amount of money, its currency, year and region, classified by industry code or EXIOBASE activity id.",
      params: [
        { name: "classification_type", label: "Classification", type: "select", required: true, default: "nace2", options: [
          { value: "nace2", label: "NACE Rev. 2" }, { value: "isic4", label: "ISIC Rev. 4" }, { value: "naics2017", label: "NAICS 2017" }, { value: "unspsc", label: "UNSPSC" }, { value: "mcc", label: "MCC" }, { value: "activity_id", label: "Climatiq/EXIOBASE activity id" },
        ] },
        { name: "code", label: "Code or activity id", type: "string", required: true, placeholder: "41.20", help: "Industry classification code, or an activity id when Classification is set to activity id." },
        { name: "money", label: "Amount", type: "number", required: true, min: 0, placeholder: "12500" },
        { name: "money_unit", label: "Currency", type: "string", required: true, default: "gbp", placeholder: "gbp", help: "Lower-case ISO 4217 code." },
        { name: "spend_year", label: "Spend year", type: "integer", required: true, min: 1995, max: 2100, placeholder: "2025" },
        { name: "spend_region", label: "Spend region", type: "string", required: true, default: "GB", placeholder: "GB" },
        { name: "tax_margin", label: "Tax margin (0-1)", type: "number", min: 0, max: 1, help: "Optional VAT share included in the amount, e.g. 0.2." },
      ],
      async run(params, ctx) {
        const type = String(params.classification_type);
        const activity = type === "activity_id" ? { activity_id: String(params.code) } : { classification_code: String(params.code), classification_type: type };
        const body = {
          activity,
          money: params.money,
          money_unit: String(params.money_unit).toLowerCase(),
          spend_year: params.spend_year,
          spend_region: String(params.spend_region).toUpperCase(),
          ...(params.tax_margin !== undefined ? { tax_margin: params.tax_margin } : {}),
        };
        const { data } = await fetchJson<ProcurementResponse>(ctx, `${BASE}/procurement/v1/spend`, { method: "POST", headers: headers(ctx.env), body: JSON.stringify(body) });
        const e = data.estimate;
        const version = e.emission_factor?.source_dataset ?? "procurement";
        const row = { ...estimateRow(e, version), inflation_applied: data.calculation_details?.inflation_applied ?? null, tax_margin: data.calculation_details?.tax_margin ?? null, trade_margin: data.calculation_details?.trade_margin ?? null, transport_margin: data.calculation_details?.transport_margin ?? null };
        return {
          summary: `${params.money} ${String(params.money_unit).toUpperCase()} (${params.spend_year}, ${String(params.spend_region).toUpperCase()}) on ${e.emission_factor.name} ≈ ${e.co2e} ${e.co2e_unit} CO2e (spend-based, ${e.emission_factor.source}).`,
          columns: [...ESTIMATE_COLUMNS, "inflation_applied", "tax_margin", "trade_margin", "transport_margin"],
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "procurement/v1/spend", basis: "estimated", version: `factor ${e.emission_factor.id} (${e.emission_factor.source} ${e.emission_factor.region} ${e.emission_factor.year})` }),
          warnings: [...noticeWarnings(data.notices), "Spend-based screening estimate (EXIOBASE EEIO factor with currency, inflation and margin adjustments). Suitable for hotspot screening; replace with supplier-specific data for reporting."],
        };
      },
    },
  ],
});
