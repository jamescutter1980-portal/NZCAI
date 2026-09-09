import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext } from "../framework";
import { EPD_WARNINGS } from "../_shared/ilcd";

/**
 * EC3 (Embodied Carbon in Construction Calculator) by Building Transparency:
 * a free, global (US-centric) EPD database with an API.
 *
 *   GET /materials?page_number=&page_size=&mf=<material filter>&jurisdiction=&name__like=
 *   GET /epds/{id}
 *
 * Auth: Authorization: Bearer <EC3_API_TOKEN>. The "mf" parameter is EC3's
 * material-filter language, e.g.
 *   !EC3 search("ReadyMix") WHERE jurisdiction: IN("GB") AND epd__date_validity_ends: > "2026-09-09" !pragma eMF("2.0/1"), lcia("EF 3.0")
 * confirmed from public client code; the plain query filters (jurisdiction,
 * name__like) come from older EC3 API usage and are less certain.
 * Quantities are served as strings with units ("123.4 kgCO2e", "1 m3").
 */

const BASE = "https://buildingtransparency.org/api";

function headers(env: EnvLike): Record<string, string> {
  const token = env.EC3_API_TOKEN?.trim();
  if (!token) throw new Error("EC3_API_TOKEN is not set");
  return { authorization: `Bearer ${token}` };
}

/** "123.4 kgCO2e" -> { value: 123.4, unit: "kgCO2e" }; null when absent or unparseable. */
export function parseQuantity(v: unknown): { value: number; unit: string | null } | null {
  if (typeof v === "number") return Number.isFinite(v) ? { value: v, unit: null } : null;
  if (typeof v !== "string") return null;
  const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(.*)$/.exec(v);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].trim() || null };
}

/** Builds the EC3 material-filter string. Category is an EC3 category short name (ReadyMix, Insulation, StructuralSteel...). */
export function buildMaterialFilter(category: string, jurisdiction: string | undefined, validAfter: string, epdTypes: string[] = ["Product EPDs"]): string {
  const clauses = [
    ...(jurisdiction ? [`jurisdiction: IN("${jurisdiction}")`] : []),
    `epd__date_validity_ends: > "${validAfter}"`,
    `epd_types: IN(${epdTypes.map((t) => `"${t}"`).join(", ")})`,
  ];
  return `!EC3 search("${category.replace(/"/g, "")}") WHERE\n  ${clauses.join(" AND\n  ")}\n!pragma eMF("2.0/1"), lcia("EF 3.0")`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const COLUMNS = ["id", "open_xpd_uuid", "name", "gwp", "gwp_unit", "gwp_raw", "declared_unit", "gwp_per_kg", "mass_per_declared_unit", "category", "manufacturer", "plant_or_group", "jurisdiction", "date_of_issue", "date_validity_ends", "program_operator", "pcr", "epd_link"];

export function toRow(m: unknown) {
  const o = isObj(m) ? m : {};
  const gwp = parseQuantity(o.gwp);
  const gwpKg = parseQuantity(o.gwp_per_kg);
  const manufacturer = isObj(o.manufacturer) ? o.manufacturer : {};
  const plant = isObj(o.plant_or_group) ? o.plant_or_group : {};
  const category = isObj(o.category) ? o.category : {};
  const po = isObj(o.program_operator) ? o.program_operator : {};
  const pcr = isObj(o.pcr) ? o.pcr : {};
  const epd = isObj(o.epd) ? o.epd : {};
  return {
    id: str(o.id),
    open_xpd_uuid: str(o.open_xpd_uuid) ?? str(epd.open_xpd_uuid),
    name: str(o.name),
    gwp: gwp?.value ?? null,
    gwp_unit: gwp?.unit ?? null,
    gwp_raw: str(o.gwp),
    declared_unit: str(o.declared_unit),
    gwp_per_kg: gwpKg?.value ?? null,
    mass_per_declared_unit: str(o.mass_per_declared_unit),
    category: str(category.display_name) ?? str(category.name),
    manufacturer: str(manufacturer.name),
    plant_or_group: str(plant.name),
    jurisdiction: str(o.jurisdiction) ?? str(plant.country) ?? str(manufacturer.country),
    date_of_issue: str(o.date_of_issue) ?? str(epd.date_of_issue),
    date_validity_ends: str(o.date_validity_ends) ?? str(epd.date_validity_ends),
    program_operator: str(po.name),
    pcr: str(pcr.name),
    epd_link: str(o.original_ec3_link) ?? str(epd.original_ec3_link) ?? str(manufacturer.original_ec3_link),
  };
}

const WARNINGS = [
  "EC3 'gwp' is the EPD's declared GWP per declared unit, normally A1-A3 (product stage); EC3 may show uncertainty-adjusted values in its UI. Do not add A4/A5 unless the EPD states them.",
  "Coverage is strongest in North America; GB/EU hits depend on operators that publish to EC3 (also check ECO Portal and ÖKOBAUDAT).",
  ...EPD_WARNINGS.slice(1),
];

export const definition = defineIntegration({
  id: "ec3-building-transparency",
  name: "EC3 (Building Transparency)",
  group: "embodied",
  access: "open_key",
  territory: "Global (US-centric)",
  description: "Free EPD database and API from Building Transparency: search materials and EPDs by category and jurisdiction, and read an EPD's GWP, declared unit, manufacturer/plant and validity.",
  docsUrl: "https://docs.buildingtransparency.org/ec3/api-and-integrations",
  termsUrl: "https://www.buildingtransparency.org/terms-of-service/",
  attribution: "EPD data via EC3, Building Transparency (buildingtransparency.org); each EPD © its programme operator and manufacturer.",
  licence: "restricted",
  envVars: [{ name: "EC3_API_TOKEN", required: true, description: "Bearer token from an EC3 account (Settings > API & Integrations). API access needs at least a Professional account with a business email." }],
  status: "built_unverified",
  notes: [
    "Obtain a token in EC3 under Settings > API & Integrations after creating an account with a business email; tokens can be revoked and re-issued. The API documentation is behind that login.",
    "The 'mf' material-filter syntax and the category short names (ReadyMix, StructuralSteel, Insulation, ...) are confirmed from public client code; jurisdiction codes are ISO alpha-2 or UN M49 region codes ('021' = Northern America). The plain 'jurisdiction' and 'name__like' query parameters are from older API usage and unverified.",
    "Responses are bare JSON arrays of materials with string quantities ('123.4 kgCO2e', '1 m3'); the connector parses the number and unit and keeps the raw string.",
    "Values are as published in the EPD (basis 'measured'); validity, declared unit and jurisdiction are preserved in every row.",
    ...WARNINGS,
    "Rate limits apply (HTTP 429 with Retry-After); the UI should back off rather than retry immediately.",
  ],
  healthCheck: simpleHealth(
    () => buildUrl(BASE, "materials", { page_number: 1, page_size: 1 }),
    (env) => ({ headers: headers(env) }),
  ),
  operations: [
    {
      id: "search",
      label: "Search materials / EPDs",
      description: "Materials in a category and jurisdiction with valid EPDs, optionally filtered by name.",
      params: [
        { name: "category", label: "EC3 category", type: "string", placeholder: "ReadyMix", help: "EC3 category short name, e.g. ReadyMix, PrecastConcrete, StructuralSteel, RebarSteel, Insulation, Gypsum, MassTimber, AluminiumExtrusions. Blank searches by name only." },
        { name: "name", label: "Name contains", type: "string", placeholder: "C32/40" },
        { name: "jurisdiction", label: "Jurisdiction", type: "string", default: "GB", placeholder: "GB", help: "ISO alpha-2 country or UN M49 region code. Blank for worldwide." },
        { name: "page_size", label: "Results", type: "integer", default: 25, min: 1, max: 100 },
        { name: "page_number", label: "Page", type: "integer", default: 1, min: 1, max: 1000 },
      ],
      async run(params, ctx: OperationContext) {
        const category = params.category ? String(params.category).trim() : "";
        const name = params.name ? String(params.name).trim() : "";
        if (!category && !name) throw new Error("Give a category or a name");
        const jurisdiction = params.jurisdiction ? String(params.jurisdiction).trim() : undefined;
        const today = ctx.now().toISOString().slice(0, 10);
        const url = buildUrl(BASE, "materials", {
          page_number: params.page_number as number,
          page_size: params.page_size as number,
          mf: category ? buildMaterialFilter(category, jurisdiction, today) : undefined,
          jurisdiction: category ? undefined : jurisdiction,
          name__like: name || undefined,
        });
        const { data } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx.env) });
        const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.results) ? data.results : [];
        const rows = list.map(toRow);
        return {
          summary: rows.length === 0 ? `No EC3 materials match ${category || name}${jurisdiction ? ` in ${jurisdiction}` : ""}.` : `${rows.length} EC3 material(s) for ${category || name}${jurisdiction ? ` in ${jurisdiction}` : ""} (page ${params.page_number}); GWP per declared unit shown as published.`,
          columns: COLUMNS,
          rows,
          raw: list.slice(0, 100),
          provenance: makeProvenance(definition, ctx, { dataset: "materials", basis: rows.length ? "measured" : "unavailable" }),
          warnings: WARNINGS,
        };
      },
    },
    {
      id: "epd",
      label: "EPD detail",
      description: "One EPD by EC3 id: GWP, declared unit, manufacturer, plant or group, category, operator and validity.",
      params: [{ name: "id", label: "EPD id", type: "string", required: true, placeholder: "ec3abc12", help: "EC3 EPD id or open_xpd_uuid." }],
      async run(params, ctx) {
        const id = String(params.id).trim();
        if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error("id must be an EC3 identifier");
        const url = buildUrl(BASE, `epds/${encodeURIComponent(id)}`);
        const { data, status } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx.env) }, { acceptStatuses: [404] });
        if (status === 404 || !isObj(data)) {
          return { summary: `EPD ${id} not found in EC3.`, columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "epds", basis: "unavailable" }) };
        }
        const row = toRow(data);
        const expired = row.date_validity_ends && row.date_validity_ends < ctx.now().toISOString().slice(0, 10);
        return {
          summary: `${row.name ?? id}: GWP ${row.gwp ?? "n/a"} ${row.gwp_unit ?? ""} per ${row.declared_unit ?? "declared unit"} (${row.manufacturer ?? "manufacturer n/a"}, ${row.plant_or_group ?? row.jurisdiction ?? "location n/a"}, valid until ${row.date_validity_ends ?? "n/a"}).`,
          columns: COLUMNS,
          rows: [row],
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "epds", basis: row.gwp === null ? "unavailable" : "measured", version: row.open_xpd_uuid ?? row.id ?? undefined }),
          warnings: [...(expired ? [`EPD validity ended ${row.date_validity_ends}.`] : []), ...WARNINGS],
          links: row.epd_link ? [{ label: "EPD in EC3", url: row.epd_link }] : undefined,
        };
      },
    },
  ],
});
