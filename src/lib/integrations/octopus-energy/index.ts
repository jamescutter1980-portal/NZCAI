import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { addDays, assertRange, mean, round } from "../_shared/dates";

/**
 * Octopus Energy REST API v1. Paths, parameters and response examples from the published OpenAPI document
 * (products, tariff unit rates, grid supply points, meter consumption) and open-source clients; not exercised
 * live here. Product and tariff endpoints are public; account and consumption endpoints need the customer's key.
 */

const BASE = "https://api.octopus.energy/v1";
const ENV_KEY = "OCTOPUS_API_KEY";

/** GSP group ids (the letter suffix of a tariff code) and their distribution regions. */
export const GSP_REGIONS: Record<string, string> = {
  A: "Eastern England",
  B: "East Midlands",
  C: "London",
  D: "Merseyside and Northern Wales",
  E: "West Midlands",
  F: "North Eastern England",
  G: "North Western England",
  H: "Southern England",
  J: "South Eastern England",
  K: "Southern Wales",
  L: "South Western England",
  M: "Yorkshire",
  N: "Southern Scotland",
  P: "Northern Scotland",
};

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

interface Product {
  code: string;
  direction?: string;
  full_name: string;
  display_name: string;
  description?: string;
  is_variable: boolean;
  is_green: boolean;
  is_tracker: boolean;
  is_prepay: boolean;
  is_business: boolean;
  is_restricted?: boolean;
  term: number | null;
  available_from: string | null;
  available_to: string | null;
  brand?: string;
}

interface Rate {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
  payment_method?: string | null;
}

interface Consumption {
  consumption: number;
  interval_start: string;
  interval_end: string;
}

interface Account {
  number: string;
  properties: {
    id: number;
    moved_in_at?: string | null;
    moved_out_at?: string | null;
    address_line_1?: string;
    town?: string;
    postcode?: string;
    electricity_meter_points?: { mpan: string; profile_class?: number; is_export?: boolean; meters?: { serial_number: string }[]; agreements?: { tariff_code: string; valid_from: string; valid_to: string | null }[] }[];
    gas_meter_points?: { mprn: string; meters?: { serial_number: string }[]; agreements?: { tariff_code: string; valid_from: string; valid_to: string | null }[] }[];
  }[];
}

function authHeaders(ctx: OperationContext): Record<string, string> {
  const key = ctx.env[ENV_KEY]?.trim();
  if (!key) throw new Error(`${ENV_KEY} is not configured; this operation needs the customer's Octopus API key (Basic auth, key as username, empty password).`);
  return { Authorization: `Basic ${btoa(`${key}:`)}` };
}

/** E-1R-AGILE-24-10-01-C: fuel (E/G), register count (1R single, 2R day/night), product code, GSP letter. */
export function tariffCode(fuel: "electricity" | "gas", productCode: string, gsp: string, registers: "1R" | "2R" = "1R"): string {
  const letter = gsp.replace(/^_/, "").toUpperCase();
  return `${fuel === "gas" ? "G" : "E"}-${fuel === "gas" ? "1R" : registers}-${productCode.toUpperCase()}-${letter}`;
}

const gspOption = Object.entries(GSP_REGIONS).map(([value, label]) => ({ value, label: `${value}: ${label}` }));

export const definition = defineIntegration({
  id: "octopus-energy",
  name: "Octopus Energy API",
  group: "energy",
  access: "authorised",
  territory: "GB",
  description: "Octopus Energy's public tariff data (products, half-hourly unit rates such as Agile, grid supply point lookup) and, with the customer's API key, their account meter points and half-hourly smart meter consumption.",
  docsUrl: "https://developer.octopus.energy/rest/guides/endpoints",
  termsUrl: "https://octopus.energy/policies/terms/",
  attribution: "Tariff and consumption data from the Octopus Energy API (api.octopus.energy).",
  licence: "open_other",
  envVars: [{ name: ENV_KEY, required: false, description: "The customer's Octopus API key (Developer settings in their account). Required for 'Account meter points' and 'Meter consumption'; sent as HTTP Basic auth with an empty password. Not needed for products, rates or GSP lookup." }],
  status: "built_unverified",
  notes: [
    "Product, tariff and grid-supply-point endpoints are public with no key. Account and consumption endpoints need the account holder's API key, so treat them as consent-based: the client is authorising the portal to read their own data.",
    "Tariff codes are built as E-1R-<PRODUCT>-<GSP letter> (electricity, single register) or G-1R-<PRODUCT>-<GSP letter> (gas); e.g. AGILE-24-10-01 in London is E-1R-AGILE-24-10-01-C. Use 'Grid supply point for a postcode' to find the letter.",
    "Unit rates are p/kWh, exclusive and inclusive of VAT; interval and rate timestamps are ISO 8601 with an offset, and consumption intervals are stamped in local British time by Octopus.",
    "Half-hourly consumption is only available for smart meters; gas consumption is in m3 for SMETS2 meters and kWh for SMETS1. Only the first page is returned per call (the response says whether more pages exist).",
    "Octopus does not publish a redistribution licence for API data; treat as restricted to the client's own use.",
    "Built from the published OpenAPI document and open-source clients without a live call; the products list page_size parameter is assumed from other list endpoints.",
  ],
  healthCheck: simpleHealth(`${BASE}/products/?page_size=1`),
  operations: [
    {
      id: "gsp_for_postcode",
      label: "Grid supply point for a postcode",
      description: "The GSP group (distribution region letter) that determines which regional tariff rates apply.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SW1A 1AA" }],
      async run(params, ctx): Promise<OperationResult> {
        const { data } = await fetchJson<Paginated<{ group_id: string }>>(ctx, buildUrl(BASE, "industry/grid-supply-points/", { postcode: String(params.postcode) }));
        const rows = (data.results ?? []).map((r) => {
          const letter = r.group_id.replace(/^_/, "");
          return { group_id: r.group_id, gsp_letter: letter, region: GSP_REGIONS[letter] ?? "unknown" };
        });
        if (rows.length === 0) return { summary: `Octopus could not map ${params.postcode} to a grid supply point.`, columns: ["group_id", "gsp_letter", "region"], rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "industry/grid-supply-points", basis: "unavailable" }) };
        return {
          summary: `${params.postcode} is in GSP group ${rows[0].group_id} (${rows[0].region}); tariff codes for this postcode end in -${rows[0].gsp_letter}.`,
          columns: ["group_id", "gsp_letter", "region"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "industry/grid-supply-points", basis: "measured" }),
        };
      },
    },
    {
      id: "list_products",
      label: "List current products",
      description: "Energy products currently available for new agreements, with flags for variable, green, tracker and business.",
      params: [
        { name: "is_business", label: "Business products only", type: "boolean", required: false, default: false },
        { name: "is_green", label: "Green products only", type: "boolean", required: false, default: false },
        { name: "page_size", label: "Max products", type: "integer", default: 100, min: 1, max: 100 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "products/", { page_size: Number(params.page_size ?? 100), is_business: params.is_business ? "true" : undefined, is_green: params.is_green ? "true" : undefined });
        const { data } = await fetchJson<Paginated<Product>>(ctx, url);
        const columns = ["code", "display_name", "full_name", "direction", "is_variable", "is_green", "is_tracker", "is_business", "term_months", "available_from", "available_to", "brand"];
        const rows = (data.results ?? []).map((p) => ({ code: p.code, display_name: p.display_name, full_name: p.full_name, direction: p.direction ?? null, is_variable: p.is_variable, is_green: p.is_green, is_tracker: p.is_tracker, is_business: p.is_business, term_months: p.term, available_from: p.available_from, available_to: p.available_to, brand: p.brand ?? null }));
        if (rows.length === 0) return { summary: "No products returned.", columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "products", basis: "unavailable" }) };
        return {
          summary: `${data.count} products available; showing ${rows.length} (${rows.filter((r) => r.is_variable).length} variable, ${rows.filter((r) => r.is_green).length} green, ${rows.filter((r) => r.is_business).length} business).`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "products", basis: "measured" }),
          warnings: data.next ? ["More products exist beyond this page."] : undefined,
        };
      },
    },
    {
      id: "unit_rates",
      label: "Unit rates for a product and tariff",
      description: "Half-hourly or flat unit rates (p/kWh) for a tariff over a period. Give a full tariff code, or a product code plus GSP letter and the code is built for you.",
      params: [
        { name: "product_code", label: "Product code", type: "string", required: true, placeholder: "AGILE-24-10-01" },
        { name: "fuel", label: "Fuel", type: "select", required: true, default: "electricity", options: [{ value: "electricity", label: "Electricity" }, { value: "gas", label: "Gas" }] },
        { name: "gsp", label: "GSP letter", type: "select", required: false, options: gspOption, help: "Needed unless a full tariff code is given. Find it with 'Grid supply point for a postcode'." },
        { name: "tariff_code", label: "Tariff code (optional)", type: "string", required: false, placeholder: "E-1R-AGILE-24-10-01-C", help: "Overrides product code + GSP letter." },
        { name: "period_from", label: "From (date)", type: "date", required: true, placeholder: "2026-09-01" },
        { name: "period_to", label: "To (date, inclusive)", type: "date", required: true, placeholder: "2026-09-07", help: "Up to 31 days per call." },
        { name: "page_size", label: "Max rates", type: "integer", default: 1500, min: 1, max: 1500, help: "1,500 half-hourly rates is about a month." },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const from = String(params.period_from);
        const to = String(params.period_to);
        assertRange(from, to, 31, "period");
        const fuel = params.fuel === "gas" ? "gas" : "electricity";
        const product = String(params.product_code).toUpperCase();
        let code = params.tariff_code ? String(params.tariff_code).toUpperCase() : "";
        if (!code) {
          if (!params.gsp) throw new Error("Give either a tariff code or a GSP letter so the tariff code can be built.");
          code = tariffCode(fuel, product, String(params.gsp));
        }
        const url = buildUrl(BASE, `products/${encodeURIComponent(product)}/${fuel}-tariffs/${encodeURIComponent(code)}/standard-unit-rates/`, { period_from: `${from}T00:00:00Z`, period_to: `${addDays(to, 1)}T00:00:00Z`, page_size: Number(params.page_size ?? 1500) });
        const { data, status } = await fetchJson<Paginated<Rate>>(ctx, url, {}, { acceptStatuses: [404] });
        const columns = ["valid_from", "valid_to", "p_per_kwh_exc_vat", "p_per_kwh_inc_vat", "payment_method"];
        if (status === 404 || !data?.results?.length) return { summary: `No unit rates found for ${code} between ${from} and ${to}${status === 404 ? " (product or tariff code not recognised)" : ""}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: `standard-unit-rates:${code}`, basis: "unavailable" }) };
        const rows = [...data.results].sort((a, b) => a.valid_from.localeCompare(b.valid_from)).map((r) => ({ valid_from: r.valid_from, valid_to: r.valid_to, p_per_kwh_exc_vat: r.value_exc_vat, p_per_kwh_inc_vat: r.value_inc_vat, payment_method: r.payment_method ?? null }));
        const inc = rows.map((r) => r.p_per_kwh_inc_vat);
        return {
          summary: `${code}: ${rows.length} rate periods from ${from} to ${to}. Mean ${round(mean(inc) ?? 0, 2)} p/kWh inc VAT, range ${Math.min(...inc)} to ${Math.max(...inc)} p/kWh.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `standard-unit-rates:${code}`, basis: "measured" }),
          warnings: [
            "Unit rates exclude the standing charge and apply to the GSP region in the tariff code. Agile and tracker rates are published day-ahead, so future periods beyond tomorrow are absent.",
            ...(data.next ? ["More rates exist beyond this page; narrow the period."] : []),
          ],
        };
      },
    },
    {
      id: "account_meter_points",
      label: "Account meter points (authorised)",
      description: "Properties, MPANs/MPRNs, meter serial numbers and current tariff agreements for an Octopus account. Needs the account holder's API key.",
      params: [{ name: "account", label: "Account number", type: "string", required: true, placeholder: "A-1234ABCD" }],
      async run(params, ctx): Promise<OperationResult> {
        const headers = authHeaders(ctx);
        const account = String(params.account).toUpperCase();
        const { data, status } = await fetchJson<Account>(ctx, `${BASE}/accounts/${encodeURIComponent(account)}/`, { headers }, { acceptStatuses: [404] });
        const columns = ["property", "postcode", "fuel", "mpxn", "serial_number", "is_export", "tariff_code", "agreement_from", "agreement_to"];
        if (status === 404 || !data?.properties) return { summary: `Account ${account} not found or not accessible with this key.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "accounts", basis: "unavailable" }) };
        const rows: Record<string, unknown>[] = [];
        for (const p of data.properties) {
          const property = [p.address_line_1, p.town].filter(Boolean).join(", ");
          for (const mp of p.electricity_meter_points ?? []) {
            const current = (mp.agreements ?? []).find((a) => !a.valid_to) ?? (mp.agreements ?? []).at(-1);
            for (const m of mp.meters?.length ? mp.meters : [{ serial_number: null as string | null }]) rows.push({ property, postcode: p.postcode ?? null, fuel: "electricity", mpxn: mp.mpan, serial_number: m.serial_number, is_export: Boolean(mp.is_export), tariff_code: current?.tariff_code ?? null, agreement_from: current?.valid_from ?? null, agreement_to: current?.valid_to ?? null });
          }
          for (const mp of p.gas_meter_points ?? []) {
            const current = (mp.agreements ?? []).find((a) => !a.valid_to) ?? (mp.agreements ?? []).at(-1);
            for (const m of mp.meters?.length ? mp.meters : [{ serial_number: null as string | null }]) rows.push({ property, postcode: p.postcode ?? null, fuel: "gas", mpxn: mp.mprn, serial_number: m.serial_number, is_export: false, tariff_code: current?.tariff_code ?? null, agreement_from: current?.valid_from ?? null, agreement_to: current?.valid_to ?? null });
          }
        }
        return {
          summary: `Account ${account}: ${data.properties.length} propert${data.properties.length === 1 ? "y" : "ies"}, ${rows.filter((r) => r.fuel === "electricity").length} electricity and ${rows.filter((r) => r.fuel === "gas").length} gas meters.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "accounts", basis: "client_declared", consentRef: `octopus-api-key:${account}` }),
          warnings: ["Retrieved with the account holder's API key; store only what the client has authorised the portal to hold."],
        };
      },
    },
    {
      id: "meter_consumption",
      label: "Meter consumption (authorised)",
      description: "Half-hourly (or aggregated) smart meter consumption for one meter over a period. Needs the account holder's API key.",
      params: [
        { name: "fuel", label: "Fuel", type: "select", required: true, default: "electricity", options: [{ value: "electricity", label: "Electricity (MPAN)" }, { value: "gas", label: "Gas (MPRN)" }] },
        { name: "mpxn", label: "MPAN / MPRN", type: "mpxn", required: true, placeholder: "1200012345678" },
        { name: "serial_number", label: "Meter serial number", type: "string", required: true, placeholder: "Z16N389556" },
        { name: "period_from", label: "From (date)", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "period_to", label: "To (date, inclusive)", type: "date", required: true, placeholder: "2026-08-31", help: "Up to 31 days of half-hourly data per call; use daily grouping for longer ranges (up to 366 days)." },
        { name: "group_by", label: "Grouping", type: "select", required: false, default: "half_hourly", options: [{ value: "half_hourly", label: "Half-hourly" }, { value: "hour", label: "Hourly" }, { value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }] },
        { name: "page_size", label: "Max readings", type: "integer", default: 1500, min: 1, max: 1500 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const headers = authHeaders(ctx);
        const from = String(params.period_from);
        const to = String(params.period_to);
        const group = String(params.group_by ?? "half_hourly");
        assertRange(from, to, group === "half_hourly" ? 31 : 366, "period");
        const fuel = params.fuel === "gas" ? "gas" : "electricity";
        const path = `${fuel}-meter-points/${encodeURIComponent(String(params.mpxn))}/meters/${encodeURIComponent(String(params.serial_number))}/consumption/`;
        const url = buildUrl(BASE, path, { period_from: `${from}T00:00:00Z`, period_to: `${addDays(to, 1)}T00:00:00Z`, page_size: Number(params.page_size ?? 1500), order_by: "period", group_by: group === "half_hourly" ? undefined : group });
        const { data, status } = await fetchJson<Paginated<Consumption>>(ctx, url, { headers }, { acceptStatuses: [404] });
        const unit = fuel === "gas" ? "m3 (SMETS2) or kWh (SMETS1)" : "kWh";
        const columns = ["interval_start", "interval_end", "consumption", "unit"];
        if (status === 404 || !data?.results?.length) return { summary: `No consumption for ${fuel} meter ${params.mpxn}/${params.serial_number} between ${from} and ${to}${status === 404 ? " (meter point not found for this key)" : " (non-smart meters return nothing)"}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: `${fuel} consumption`, basis: "unavailable" }) };
        const rows = data.results.map((r) => ({ interval_start: r.interval_start, interval_end: r.interval_end, consumption: r.consumption, unit }));
        const total = rows.reduce((a, r) => a + (r.consumption ?? 0), 0);
        return {
          summary: `${rows.length} ${group === "half_hourly" ? "half-hour" : group} readings for ${fuel} meter ${params.serial_number} from ${from} to ${to}: total ${round(total, 2)} ${fuel === "gas" ? "units (see unit column)" : "kWh"}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: `${fuel} consumption`, basis: "measured", consentRef: `octopus-api-key:${params.mpxn}` }),
          warnings: [
            "Intervals are stamped in local British time by Octopus (e.g. +01:00 in summer); convert to UTC before joining to carbon intensity or PV data.",
            ...(fuel === "gas" ? ["Gas consumption is in cubic metres for SMETS2 meters and kWh for SMETS1; convert m3 to kWh with the calorific value and volume correction factor (x 1.02264 x CV / 3.6)."] : []),
            ...(data.next ? ["More readings exist beyond this page; narrow the period or use a coarser grouping."] : []),
          ],
        };
      },
    },
  ],
});
