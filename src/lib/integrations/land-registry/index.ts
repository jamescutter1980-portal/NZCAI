import { buildUrl, defineIntegration, fetchJson, IntegrationHttpError, makeProvenance, simpleHealth, type OperationContext } from "../framework";

/**
 * HM Land Registry open linked data (landregistry.data.gov.uk): Price Paid
 * Data transactions and the UK House Price Index, via the Linked Data API
 * JSON views. Built from the published API docs (app/doc/ppd, app/ukhpi/doc)
 * and open-source clients; not exercised live from this codebase.
 */

export const BASE = "https://landregistry.data.gov.uk";

/** Linked Data API values may be plain, {_value,_datatype}, or {_about, prefLabel:[{_value}]} */
export function val(x: unknown): string | number | boolean | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") return x as string | number | boolean;
  const o = x as Record<string, unknown>;
  if ("_value" in o) return o._value as string | number | boolean;
  if (Array.isArray(o.prefLabel) && o.prefLabel.length) return val(o.prefLabel[0]);
  if (typeof o.label === "string") return o.label;
  if (typeof o._about === "string") return o._about.split(/[/#]/).pop() ?? o._about;
  return null;
}

function spacedPostcode(pc: string): string {
  const s = pc.replace(/\s+/g, "").toUpperCase();
  return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s;
}

interface PpiItem {
  _about?: string;
  transactionId?: unknown;
  pricePaid?: unknown;
  transactionDate?: unknown;
  newBuild?: unknown;
  propertyType?: unknown;
  estateType?: unknown;
  transactionCategory?: unknown;
  recordStatus?: unknown;
  propertyAddress?: { paon?: unknown; saon?: unknown; street?: unknown; locality?: unknown; town?: unknown; district?: unknown; county?: unknown; postcode?: unknown };
}
interface PpiResponse {
  result?: { items?: PpiItem[]; itemsPerPage?: number; page?: number; startIndex?: number };
}

const PPI_COLUMNS = ["transaction_date", "price_paid_gbp", "address", "postcode", "town", "district", "county", "property_type", "estate_type", "new_build", "transaction_category", "transaction_id"];

export function toPpiRow(it: PpiItem) {
  const a = it.propertyAddress ?? {};
  const address = [val(a.saon), val(a.paon), val(a.street), val(a.locality)].filter(Boolean).join(", ");
  const price = Number(val(it.pricePaid));
  const date = val(it.transactionDate);
  return {
    transaction_date: date ? String(date).slice(0, 10) : null,
    price_paid_gbp: Number.isFinite(price) ? price : null,
    address: address || null,
    postcode: val(a.postcode),
    town: val(a.town),
    district: val(a.district),
    county: val(a.county),
    property_type: val(it.propertyType),
    estate_type: val(it.estateType),
    new_build: val(it.newBuild),
    transaction_category: val(it.transactionCategory),
    transaction_id: val(it.transactionId) ?? (it._about ? it._about.split("/").pop() : null),
  };
}

interface HpiTopic {
  _about?: string;
  refMonth?: unknown;
  refRegion?: unknown;
  averagePrice?: number;
  housePriceIndex?: number;
  percentageChange?: number;
  percentageAnnualChange?: number;
  salesVolume?: number;
  averagePriceDetached?: number;
  averagePriceSemiDetached?: number;
  averagePriceTerraced?: number;
  averagePriceFlatMaisonette?: number;
  averagePriceNewBuild?: number;
  averagePriceExistingProperty?: number;
  housePriceIndexDetached?: number;
  housePriceIndexSemiDetached?: number;
  housePriceIndexTerraced?: number;
  housePriceIndexFlatMaisonette?: number;
  [k: string]: unknown;
}
interface HpiResponse {
  result?: { primaryTopic?: HpiTopic };
}

const HPI_COLUMNS = ["region", "month", "average_price_gbp", "house_price_index", "monthly_change_pct", "annual_change_pct", "sales_volume", "average_price_detached", "average_price_semi_detached", "average_price_terraced", "average_price_flat", "average_price_new_build", "average_price_existing"];

export const definition = defineIntegration({
  id: "land-registry",
  name: "HM Land Registry open data (Price Paid, UK HPI)",
  group: "identity",
  access: "open",
  territory: "England and Wales",
  description: "Residential sale prices recorded by HM Land Registry since 1995 for a postcode, and the UK House Price Index for a region and month. Useful for asset context, MEES cost-cap tests and transaction history.",
  docsUrl: "https://landregistry.data.gov.uk/app/doc/ppd",
  termsUrl: "https://www.gov.uk/guidance/about-the-price-paid-data#licence",
  attribution: "Contains HM Land Registry data © Crown copyright and database right 2026. This data is licensed under the Open Government Licence v3.0. UK House Price Index © HM Land Registry, Registers of Scotland, Land & Property Services and the Office for National Statistics.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Price Paid Data covers residential sales in England and Wales sold for value and lodged for registration since January 1995; it excludes commercial transactions except 'other' category, transfers not for value, and right-to-buy in some periods. Prices are as declared, not valuations.",
    "Query form: /data/ppi/transaction-record.json?propertyAddress.postcode=SW1A 1AA&_pageSize=100&_sort=-transactionDate (Linked Data API; max page size 200). Field values can be plain or wrapped ({_value}, {_about,prefLabel}); both are handled. The SPARQL endpoint https://landregistry.data.gov.uk/landregistry/query is the fallback for anything the JSON view cannot filter.",
    "UK HPI: /data/ukhpi/region/{region-slug}/month/{YYYY-MM}.json. Region slugs are lower-case hyphenated names such as united-kingdom, england, wales, london, north-east, south-west, or a local authority such as westminster; the month must be a published month (the index lags about six weeks).",
    "Related datasets not wrapped here: INSPIRE Index Polygons (free, OGL with OS conditions, bulk GML per authority); National Polygon Service, CCOD (UK companies that own property) and OCOD (overseas companies) are free-to-registered-user downloads with their own licence; title register documents are paid via Business Gateway.",
    "No key and no documented rate limit; be polite. Built from documentation and open-source clients, not exercised live from this codebase.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "data/ppi/transaction-record.json", { _pageSize: 1 })),
  operations: [
    {
      id: "price-paid-by-postcode",
      label: "Sale prices for a postcode",
      description: "Price Paid transactions for every address in a postcode, newest first.",
      params: [
        { name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SW1A 1AA" },
        { name: "page_size", label: "Max transactions", type: "integer", default: 50, min: 1, max: 100 },
        { name: "min_date", label: "From date", type: "date", placeholder: "2015-01-01", help: "Optional lower bound on transaction date." },
      ],
      async run(params, ctx: OperationContext) {
        const postcode = spacedPostcode(String(params.postcode));
        const url = buildUrl(BASE, "data/ppi/transaction-record.json", {
          "propertyAddress.postcode": postcode,
          _pageSize: params.page_size as number,
          _sort: "-transactionDate",
          "min-transactionDate": params.min_date ? String(params.min_date) : undefined,
        });
        const { data } = await fetchJson<PpiResponse>(ctx, url, {}, { acceptStatuses: [404] });
        const rows = (data?.result?.items ?? []).map(toPpiRow);
        if (!rows.length) {
          return { summary: `No Price Paid transactions for ${postcode}.`, columns: PPI_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "price-paid", basis: "unavailable" }), warnings: ["No records can mean no qualifying sales since 1995, a commercial-only postcode, or a postcode that has changed."] };
        }
        const prices = rows.map((r) => r.price_paid_gbp).filter((p): p is number => p !== null);
        const latest = rows[0];
        return {
          summary: `${rows.length} transaction${rows.length === 1 ? "" : "s"} for ${postcode}${latest.transaction_date ? `, latest ${latest.transaction_date} at £${latest.price_paid_gbp?.toLocaleString("en-GB")}` : ""}${prices.length ? `; range £${Math.min(...prices).toLocaleString("en-GB")} to £${Math.max(...prices).toLocaleString("en-GB")}` : ""}.`,
          columns: PPI_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "price-paid", basis: "measured" }),
          warnings: ["Price paid is the declared consideration at the time of sale, not a current valuation. Residential sales only; 'other' property type may include mixed-use."],
        };
      },
    },
    {
      id: "hpi-region-month",
      label: "House price index for a region and month",
      description: "UK HPI average price, index and change figures for a region or local authority in one month.",
      params: [
        { name: "region", label: "Region slug", type: "string", required: true, default: "england", placeholder: "england", help: "Lower-case hyphenated, e.g. united-kingdom, england, wales, london, north-west, westminster, city-of-bristol." },
        { name: "month", label: "Month (YYYY-MM)", type: "string", required: true, placeholder: "2026-03" },
      ],
      async run(params, ctx) {
        const region = String(params.region).trim().toLowerCase().replace(/\s+/g, "-");
        const month = String(params.month).trim();
        if (!/^[a-z0-9-]+$/.test(region)) throw new Error("Region slug must be lower-case letters, digits and hyphens.");
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Month must be YYYY-MM.");
        const url = `${BASE}/data/ukhpi/region/${encodeURIComponent(region)}/month/${month}.json`;
        let data: HpiResponse | null = null;
        let status = 200;
        try {
          ({ data, status } = await fetchJson<HpiResponse>(ctx, url, {}, { acceptStatuses: [404] }));
        } catch (e) {
          // An unknown region or unpublished month returns a 404 page, not JSON.
          if (e instanceof IntegrationHttpError && e.status === 404) status = 404;
          else throw e;
        }
        const t = data?.result?.primaryTopic;
        if (status === 404 || !t || t.averagePrice === undefined) {
          return { summary: `No UK HPI record for ${region} in ${month}.`, columns: HPI_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "ukhpi", basis: "unavailable" }), warnings: ["Check the region slug and that the month has been published (the index lags about six weeks)."] };
        }
        const row = {
          region,
          month,
          average_price_gbp: t.averagePrice ?? null,
          house_price_index: t.housePriceIndex ?? null,
          monthly_change_pct: t.percentageChange ?? null,
          annual_change_pct: t.percentageAnnualChange ?? null,
          sales_volume: t.salesVolume ?? null,
          average_price_detached: t.averagePriceDetached ?? null,
          average_price_semi_detached: t.averagePriceSemiDetached ?? null,
          average_price_terraced: t.averagePriceTerraced ?? null,
          average_price_flat: t.averagePriceFlatMaisonette ?? null,
          average_price_new_build: t.averagePriceNewBuild ?? null,
          average_price_existing: t.averagePriceExistingProperty ?? null,
        };
        return {
          summary: `${region} ${month}: average price £${Number(t.averagePrice).toLocaleString("en-GB")}, index ${t.housePriceIndex ?? "n/a"}${t.percentageAnnualChange !== undefined ? `, ${t.percentageAnnualChange}% year on year` : ""}${t.salesVolume !== undefined ? `, ${t.salesVolume} sales` : ""}.`,
          columns: HPI_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "ukhpi", basis: "modelled" }),
          warnings: ["UK HPI is a hedonic index modelled from completed sales; recent months are revised as late registrations arrive."],
        };
      },
    },
  ],
});
