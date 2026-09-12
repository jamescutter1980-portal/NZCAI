import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext, type OperationResult, type ParamSpec } from "../framework";

/**
 * MHCLG "Get energy performance of buildings data" API (England and Wales).
 *
 * The former Energy Performance of Buildings Data service at
 * epc.opendatacommunities.org closed on 30 May 2026. Its replacement keeps a
 * developer API but with a different host, Bearer-token auth (GOV.UK One
 * Login account, token copied from "My account"), different parameter names,
 * camelCase JSON, and certificate numbers (RRN, 0000-0000-0000-0000-0000)
 * instead of LMK keys.
 *
 * Built from the published OpenAPI document
 * https://raw.githubusercontent.com/communitiesuk/epb-data-warehouse/main/api/api.yml
 * and open-source clients; no live call has been made from this codebase.
 */

export const DEFAULT_BASE = "https://api.get-energy-performance-data.communities.gov.uk";

export function epcBase(env: EnvLike): string {
  return (env.EPC_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

/** Bearer token preferred; legacy email:key Basic auth kept only for an EPC_API_BASE that still accepts it. */
export function epcAuthHeader(env: EnvLike): string {
  const token = env.EPC_API_TOKEN?.trim();
  if (token) return `Bearer ${token}`;
  const email = env.EPC_API_EMAIL?.trim();
  const key = env.EPC_API_KEY?.trim();
  if (email && key) return `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}`;
  throw new Error("EPC_API_TOKEN is not set. Sign in at https://get-energy-performance-data.communities.gov.uk and copy the token from My account.");
}

function headers(env: EnvLike): Record<string, string> {
  return { authorization: epcAuthHeader(env), accept: "application/json" };
}

/** Validated postcodes arrive without a space; the API examples use "SW10 0AA". */
function spacedPostcode(pc: string): string {
  const s = pc.replace(/\s+/g, "").toUpperCase();
  return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s;
}

interface SearchRow {
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  uprn?: number | string | null;
  certificateNumber?: string;
  constituency?: string;
  council?: string;
  currentEnergyEfficiencyBand?: string;
  postTown?: string;
  postcode?: string;
  registrationDate?: string;
  schemaType?: string;
}

interface SearchResponse {
  data?: SearchRow[];
  pagination?: { totalRecords?: number; currentPage?: number; totalPages?: number; nextPage?: number | null; prevPage?: number | null; pageSize?: number | null };
  error?: string;
}

const SEARCH_COLUMNS = ["address", "postcode", "post_town", "uprn", "certificate_number", "current_energy_efficiency_band", "registration_date", "schema_type", "council", "constituency"];

function toSearchRow(r: SearchRow) {
  return {
    address: [r.addressLine1, r.addressLine2, r.addressLine3, r.addressLine4].filter((x) => x && String(x).trim()).join(", "),
    postcode: r.postcode ?? null,
    post_town: r.postTown ?? null,
    uprn: r.uprn == null ? null : String(r.uprn),
    certificate_number: r.certificateNumber ?? null,
    current_energy_efficiency_band: r.currentEnergyEfficiencyBand ?? null,
    registration_date: r.registrationDate ? String(r.registrationDate).slice(0, 10) : null,
    schema_type: r.schemaType ?? null,
    council: r.council ?? null,
    constituency: r.constituency ?? null,
  };
}

const SEARCH_PARAMS: ParamSpec[] = [
  { name: "postcode", label: "Postcode", type: "postcode", placeholder: "SW1A 1AA", help: "Give a postcode, a UPRN or an address fragment." },
  { name: "uprn", label: "UPRN", type: "uprn", placeholder: "100023336956" },
  { name: "address", label: "Address contains", type: "string", placeholder: "9 new union", help: "Partial or full address text." },
  { name: "page_size", label: "Rows per page", type: "integer", default: 50, min: 1, max: 100 },
  { name: "current_page", label: "Page", type: "integer", default: 1, min: 1 },
];

type Family = "domestic" | "non-domestic" | "display";

async function runSearch(family: Family, params: Record<string, unknown>, ctx: OperationContext): Promise<OperationResult> {
  if (!params.postcode && !params.uprn && !params.address) {
    throw new Error("Give a postcode, a UPRN or an address fragment.");
  }
  const url = buildUrl(epcBase(ctx.env), `api/${family}/search`, {
    postcode: params.postcode ? spacedPostcode(String(params.postcode)) : undefined,
    uprn: params.uprn ? String(params.uprn).replace(/^0+/, "") || "0" : undefined,
    address: params.address ? String(params.address) : undefined,
    page_size: (params.page_size as number) ?? 50,
    current_page: (params.current_page as number) ?? 1,
  });
  const { data, status } = await fetchJson<SearchResponse>(ctx, url, { headers: headers(ctx.env) }, { acceptStatuses: [404] });
  const dataset = `${family}-search`;
  if (status === 404 || !data?.data?.length) {
    return {
      summary: `No ${family} certificates found for that query.`,
      columns: SEARCH_COLUMNS,
      rows: [],
      raw: data,
      provenance: makeProvenance(definition, ctx, { dataset, basis: "unavailable" }),
      warnings: ["Absence from the register does not mean no certificate exists: certificates opted out of public disclosure, pre-2008 assessments and Scottish or Northern Irish properties are not returned."],
    };
  }
  const rows = data.data.map(toSearchRow);
  const total = data.pagination?.totalRecords ?? rows.length;
  const bands = rows.map((r) => r.current_energy_efficiency_band).filter(Boolean);
  return {
    summary: `${total} ${family} certificate${total === 1 ? "" : "s"} matched; showing ${rows.length}${data.pagination?.totalPages && data.pagination.totalPages > 1 ? ` (page ${data.pagination.currentPage ?? 1} of ${data.pagination.totalPages})` : ""}. Bands: ${bands.length ? [...new Set(bands)].sort().join(", ") : "n/a"}.`,
    columns: SEARCH_COLUMNS,
    rows,
    raw: data,
    provenance: makeProvenance(definition, ctx, { dataset, basis: "measured" }),
    warnings: [
      "Search rows are register summaries. Use 'Certificate detail' with the certificate number for floor area, property type, fuel, ratings and other fields.",
      "A property can have several certificates; the most recent registration date is the current one only if it is still within its validity period (10 years).",
    ],
  };
}

/** Case- and punctuation-insensitive key lookup so we tolerate camelCase, snake_case or kebab-case documents. */
function norm(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function pick(obj: Record<string, unknown> | undefined, ...names: string[]): unknown {
  if (!obj) return null;
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) if (!map.has(norm(k))) map.set(norm(k), v);
  for (const n of names) {
    const v = map.get(norm(n));
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** Flatten one level of nesting into `parent.child` keys for the raw-ish row. */
export function flattenScalars(obj: Record<string, unknown>, prefix = "", depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || typeof v !== "object") out[key] = v;
    else if (!Array.isArray(v) && depth < 1) Object.assign(out, flattenScalars(v as Record<string, unknown>, key, depth + 1));
  }
  return out;
}

const DETAIL_COLUMNS = [
  "address",
  "postcode",
  "uprn",
  "certificate_number",
  "certificate_type",
  "current_energy_rating",
  "current_energy_efficiency",
  "potential_energy_rating",
  "potential_energy_efficiency",
  "asset_rating",
  "asset_rating_band",
  "total_floor_area_m2",
  "lodgement_date",
  "inspection_date",
  "expiry_date",
  "property_type",
  "built_form",
  "main_fuel",
  "main_heating",
  "building_emissions",
  "primary_energy_value",
  "local_authority",
];

export function toDetailRow(doc: Record<string, unknown>, certificateNumber: string) {
  const addr = pick(doc, "address") as Record<string, unknown> | string | null;
  const addressText =
    typeof addr === "string"
      ? addr
      : addr && typeof addr === "object"
        ? [pick(addr, "addressLine1", "line1"), pick(addr, "addressLine2", "line2"), pick(addr, "addressLine3", "line3"), pick(addr, "addressLine4", "line4"), pick(addr, "town", "postTown")].filter(Boolean).join(", ")
        : [pick(doc, "addressLine1", "address1"), pick(doc, "addressLine2", "address2"), pick(doc, "addressLine3", "address3"), pick(doc, "postTown", "town")].filter(Boolean).join(", ");
  const postcode = (typeof addr === "object" && addr ? pick(addr, "postcode") : null) ?? pick(doc, "postcode");
  return {
    address: addressText || null,
    postcode,
    uprn: pick(doc, "uprn") == null ? null : String(pick(doc, "uprn")),
    certificate_number: (pick(doc, "certificateNumber", "rrn", "assessmentId") as string | null) ?? certificateNumber,
    certificate_type: pick(doc, "typeOfAssessment", "assessmentType", "certificateType", "schemaType"),
    current_energy_rating: pick(doc, "currentEnergyEfficiencyBand", "currentEnergyRating", "energyRatingCurrent", "currentEnergyEfficiencyRating"),
    current_energy_efficiency: pick(doc, "currentEnergyEfficiencyRating", "currentEnergyEfficiency", "energyEfficiencyRating"),
    potential_energy_rating: pick(doc, "potentialEnergyEfficiencyBand", "potentialEnergyRating", "energyRatingPotential"),
    potential_energy_efficiency: pick(doc, "potentialEnergyEfficiencyRating", "potentialEnergyEfficiency"),
    asset_rating: pick(doc, "assetRating", "energyRating"),
    asset_rating_band: pick(doc, "assetRatingBand", "energyBand", "currentEnergyEfficiencyBand"),
    total_floor_area_m2: pick(doc, "totalFloorArea", "floorArea"),
    lodgement_date: pick(doc, "lodgementDate", "registrationDate", "dateOfRegistration"),
    inspection_date: pick(doc, "inspectionDate", "dateOfAssessment", "assessmentDate"),
    expiry_date: pick(doc, "expiryDate", "dateOfExpiry"),
    property_type: pick(doc, "propertyType", "dwellingType", "buildingType"),
    built_form: pick(doc, "builtForm"),
    main_fuel: pick(doc, "mainFuel", "mainFuelType", "mainHeatingFuel"),
    main_heating: pick(doc, "mainHeatingDescription", "mainHeating", "mainheatDescription"),
    building_emissions: pick(doc, "buildingEmissions", "co2EmissionsCurrent", "buildingEmissionRate"),
    primary_energy_value: pick(doc, "primaryEnergyValue", "primaryEnergy"),
    local_authority: pick(doc, "localAuthorityLabel", "localAuthority", "council"),
  };
}

async function fetchCertificate(ctx: OperationContext, certificateNumber: string) {
  const url = buildUrl(epcBase(ctx.env), "api/certificate", { certificate_number: certificateNumber });
  return fetchJson<{ data?: Record<string, unknown>; error?: string }>(ctx, url, { headers: headers(ctx.env) }, { acceptStatuses: [404] });
}

const CERT_PARAM: ParamSpec = {
  name: "certificate_number",
  label: "Certificate number",
  type: "string",
  required: true,
  placeholder: "0000-1672-0000-1732-0000",
  help: "20-digit certificate number (RRN) printed on the certificate, also returned by the search operations.",
};

function assertCertificateNumber(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{4}-\d{4}-\d{4}-\d{4}$/.test(s)) throw new Error("Certificate number must look like 0000-0000-0000-0000-0000.");
  return s;
}

export const definition = defineIntegration({
  id: "epc-england-wales",
  name: "Energy Performance of Buildings register (England and Wales)",
  group: "identity",
  access: "open_key",
  territory: "England and Wales",
  description:
    "MHCLG's 'Get energy performance of buildings data' API: domestic and non-domestic EPCs and Display Energy Certificates lodged in England and Wales, searchable by postcode, UPRN or address, with full certificate documents by certificate number.",
  docsUrl: "https://get-energy-performance-data.communities.gov.uk/api-technical-documentation",
  termsUrl: "https://get-energy-performance-data.communities.gov.uk/guidance",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Energy Performance of Buildings data © Ministry of Housing, Communities and Local Government. Address data contains Royal Mail and Ordnance Survey material subject to their own terms.",
  licence: "OGL",
  envVars: [
    { name: "EPC_API_TOKEN", required: true, description: "Bearer token from the 'My account' page after signing in with GOV.UK One Login at get-energy-performance-data.communities.gov.uk." },
    { name: "EPC_API_BASE", required: false, description: `API base URL override. Default ${DEFAULT_BASE}.` },
    { name: "EPC_API_EMAIL", required: false, description: "Legacy: email for HTTP Basic auth against the retired epc.opendatacommunities.org style API. Ignored when EPC_API_TOKEN is set." },
    { name: "EPC_API_KEY", required: false, description: "Legacy: API key paired with EPC_API_EMAIL. Ignored when EPC_API_TOKEN is set." },
  ],
  status: "built_unverified",
  notes: [
    "Covers England and Wales only. Scotland uses the Scottish EPC Register (see scottish-epc-register); Northern Ireland has no public API (see ni-epc).",
    "The old epc.opendatacommunities.org service closed to users on 30 May 2026. The replacement API uses Bearer tokens, camelCase JSON and certificate numbers (0000-0000-0000-0000-0000) instead of LMK keys; old LMK-key URLs and Basic auth no longer work.",
    "Endpoints and parameters were taken from the published OpenAPI document (communitiesuk/epb-data-warehouse api/api.yml); no live request has been made from this codebase. Search parameters: postcode, uprn, address, date_start/date_end, council[], constituency[], efficiency_rating[], page_size (max 5000), current_page.",
    "The certificate document returned by /api/certificate is described only as 'EPC document in JSON format'. Column mapping in 'Certificate detail' uses tolerant key matching and should be checked against a real response; the full document is always returned in raw.",
    "There is no per-certificate recommendations endpoint in the new API; recommendations are published as bulk files (/api/files/*-recommendations/json). The 'Recommendations' operation reads any recommendations embedded in the certificate document and otherwise returns empty.",
    "Rate limit reported by users: about 3 requests per second per token, HTTP 429 beyond that. Back off and cache.",
    "Coverage: only certificates lodged since the register began (domestic from 2008, non-domestic from 2008, DECs from 2008) and not opted out. Address data is subject to Royal Mail / OS terms even though certificate data is OGL.",
    "An EPC is a modelled asset rating (SAP/RdSAP/SBEM), not measured consumption; DECs are operational ratings from metered energy. Do not treat an EPC as evidence of actual energy use.",
  ],
  healthCheck: async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const res = await ctx.fetch(buildUrl(epcBase(ctx.env), "api/codes"), { headers: headers(ctx.env), signal: AbortSignal.timeout(15_000) });
      const latencyMs = Date.now() - started;
      return res.ok ? { ok: true, detail: `HTTP ${res.status}`, latencyMs } : { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "domestic-search",
      label: "Domestic EPCs for a postcode, UPRN or address",
      description: "Lists domestic energy performance certificates on the register that match the postcode, UPRN or address text.",
      params: SEARCH_PARAMS,
      run: (params, ctx) => runSearch("domestic", params, ctx),
    },
    {
      id: "non-domestic-search",
      label: "Non-domestic EPCs for a postcode, UPRN or address",
      description: "Lists non-domestic (commercial) energy performance certificates that match the postcode, UPRN or address text.",
      params: SEARCH_PARAMS,
      run: (params, ctx) => runSearch("non-domestic", params, ctx),
    },
    {
      id: "display-search",
      label: "Display Energy Certificates for a postcode, UPRN or address",
      description: "Lists Display Energy Certificates (operational ratings for public buildings) that match the postcode, UPRN or address text.",
      params: SEARCH_PARAMS,
      run: (params, ctx) => runSearch("display", params, ctx),
    },
    {
      id: "certificate",
      label: "Certificate detail",
      description: "Fetches the full certificate document for one certificate number and surfaces ratings, floor area, dates, property type and fuel.",
      params: [CERT_PARAM],
      async run(params, ctx) {
        const cert = assertCertificateNumber(params.certificate_number);
        const { data, status } = await fetchCertificate(ctx, cert);
        if (status === 404 || !data?.data) {
          return { summary: `Certificate ${cert} not found.`, columns: DETAIL_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "certificate", basis: "unavailable" }) };
        }
        const doc = data.data;
        const row = { ...toDetailRow(doc, cert), ...flattenScalars(doc) };
        const rating = row.current_energy_rating ?? row.asset_rating_band;
        return {
          summary: `Certificate ${cert}${row.address ? ` for ${row.address}` : ""}: rating ${rating ?? "n/a"}${row.current_energy_efficiency ? ` (${row.current_energy_efficiency})` : ""}${row.total_floor_area_m2 ? `, ${row.total_floor_area_m2} m² floor area` : ""}${row.lodgement_date ? `, lodged ${String(row.lodgement_date).slice(0, 10)}` : ""}.`,
          columns: DETAIL_COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "certificate", basis: "modelled" }),
          warnings: [
            "EPC ratings are modelled from a standardised assessment, not from metered use. Floor areas are assessor-measured or estimated and can differ from lease or VOA areas.",
            "Field names in the certificate document were mapped with tolerant matching; check raw if a column is empty.",
          ],
        };
      },
    },
    {
      id: "recommendations",
      label: "Recommendations for a certificate",
      description: "Improvement measures recorded with a certificate, where the certificate document carries them.",
      params: [CERT_PARAM],
      async run(params, ctx) {
        const cert = assertCertificateNumber(params.certificate_number);
        const { data, status } = await fetchCertificate(ctx, cert);
        const columns = ["sequence", "improvement", "description", "indicative_cost", "typical_saving", "energy_rating_after", "environmental_rating_after"];
        if (status === 404 || !data?.data) {
          return { summary: `Certificate ${cert} not found.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: "recommendations", basis: "unavailable" }) };
        }
        const list = (pick(data.data, "recommendations", "suggestedImprovements", "improvements", "recommendedImprovements") as unknown[] | null) ?? [];
        const rows = (Array.isArray(list) ? list : []).map((item, i) => {
          const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          return {
            sequence: pick(r, "sequence", "improvementNumber") ?? i + 1,
            improvement: pick(r, "improvementSummaryText", "improvementItem", "improvementType", "summary", "title", "recommendationCode"),
            description: pick(r, "improvementDescriptionText", "improvementDescription", "description", "text"),
            indicative_cost: pick(r, "indicativeCost", "cost"),
            typical_saving: pick(r, "typicalSaving", "typicalSavings", "saving"),
            energy_rating_after: pick(r, "energyPerformanceRating", "energyRatingAfter", "energyPerformanceBand"),
            environmental_rating_after: pick(r, "environmentalImpactRating", "environmentalRatingAfter"),
          };
        });
        return {
          summary: rows.length ? `${rows.length} recommended measure${rows.length === 1 ? "" : "s"} recorded on certificate ${cert}.` : `No recommendations are embedded in certificate ${cert}; the API publishes recommendations only as bulk files.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "recommendations", basis: rows.length ? "modelled" : "unavailable" }),
          warnings: ["EPC recommendations are generic assessor-selected measures with indicative cost bands; they are not a design or a survey."],
        };
      },
    },
  ],
});
