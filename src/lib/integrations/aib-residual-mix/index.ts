import { defineIntegration, makeProvenance, type OperationContext } from "../framework";
import { csvToRecords, missingColumns, parseNumericCell } from "../_shared/csv";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * AIB European Residual Mixes: the residual-mix emission factor used for
 * market-based Scope 2 where electricity carries no contractual instrument.
 *
 * AIB publishes the results annually (PDF plus XLSX) at
 * https://www.aib-net.org/facts/european-residual-mix. The user transcribes
 * the rows needed into data/reference/aib-residual-mix/residual-mix.csv with
 * the columns below; values are loaded verbatim and carry the publication
 * and its date in every row.
 */

const ID = "aib-residual-mix";
const FILE = "residual-mix.csv";
const FILE_PATTERN = /^residual-mix\.csv$/;
const REQUIRED = ["data_year", "country_code", "country", "residual_mix_gco2_per_kwh", "direct_co2_only", "publication", "publication_date", "source_url"];

export interface ResidualMixRow {
  data_year: number;
  country_code: string;
  country: string;
  residual_mix_gco2_per_kwh: number | null;
  availability: "available" | "unavailable";
  direct_co2_only: boolean | null;
  publication: string;
  publication_date: string;
  source_url: string;
}

export const COLUMNS = ["data_year", "country_code", "country", "residual_mix_gco2_per_kwh", "availability", "direct_co2_only", "publication", "publication_date", "source_url"];

function parseBool(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(t)) return true;
  if (["false", "no", "0", "n"].includes(t)) return false;
  return null;
}

export function parseResidualMix(text: string, file: ReferenceFile): ResidualMixRow[] {
  const table = csvToRecords(text, { isHeader: (row) => row.map((c) => c.toLowerCase()).includes("country_code") });
  const missing = missingColumns(table.header, REQUIRED);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}`);
  const rows: ResidualMixRow[] = [];
  for (const r of table.records) {
    const year = parseNumericCell(r.data_year);
    if (year === null) continue;
    const value = parseNumericCell(r.residual_mix_gco2_per_kwh);
    rows.push({
      data_year: year,
      country_code: r.country_code.trim().toUpperCase(),
      country: r.country,
      residual_mix_gco2_per_kwh: value,
      availability: value === null ? "unavailable" : "available",
      direct_co2_only: parseBool(r.direct_co2_only),
      publication: r.publication,
      publication_date: r.publication_date,
      source_url: r.source_url,
    });
  }
  return rows;
}

function load(ctx: OperationContext): { file?: ReferenceFile; rows: ResidualMixRow[] } {
  const file = listReferenceFiles(ctx.env, ID, FILE_PATTERN)[0];
  if (!file) return { rows: [] };
  return { file, rows: loadReferenceFile(file, (text) => parseResidualMix(text, file)) };
}

export const LINKS = [
  { label: "AIB European Residual Mix (all years)", url: "https://www.aib-net.org/facts/european-residual-mix" },
  { label: "GHG Protocol Scope 2 Guidance", url: "https://ghgprotocol.org/scope-2-guidance" },
];

const MARKET_BASED_NOTE = "Market-based Scope 2: use supplier-specific factors (Fuel Mix Disclosure) or contractual instruments (REGO-backed tariffs, PPAs) that meet the GHG Protocol Scope 2 Quality Criteria; apply the residual mix only to electricity with no contractual instrument.";

export const definition = defineIntegration({
  id: ID,
  name: "AIB European Residual Mixes",
  group: "carbon",
  access: "download",
  territory: "Europe incl. GB",
  description: "Annual residual-mix emission factors (gCO2/kWh) published by the Association of Issuing Bodies for European countries including Great Britain, used for the market-based Scope 2 method where no contractual instrument applies.",
  docsUrl: "https://www.aib-net.org/facts/european-residual-mix",
  attribution: "Source: Association of Issuing Bodies (AIB), European Residual Mixes. Reproduced from the AIB publication for the data year shown.",
  licence: "restricted",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: "Directory holding reference files (default data/reference). Rows are read from <dir>/aib-residual-mix/residual-mix.csv." }],
  status: "built_unverified",
  notes: [
    `Supply the file: transcribe the rows you need from the AIB results (XLSX/PDF per data year) into data/reference/aib-residual-mix/${FILE} with columns data_year, country_code, country, residual_mix_gco2_per_kwh, direct_co2_only, publication, publication_date, source_url. Leave residual_mix_gco2_per_kwh blank where AIB publishes no value; blank is unavailable, never 0.`,
    "AIB publishes the residual mix for year N around May/June of year N+1 (the 2025 results were published in May 2026). Record the publication and its date in each row so a restatement can be traced.",
    "Values are gCO2/kWh; AIB gives direct CO2 (and in some tables CO2e incl. upstream or radioactive waste). Set direct_co2_only=true when the transcribed figure is direct CO2 only, so it is not mixed with CO2e factors.",
    MARKET_BASED_NOTE,
    "REGO-backed supply must be evidenced by REGO cancellation on the Ofgem Renewable Electricity Register for the supply period and volume (see ofgem-renewable-electricity-register); a supplier's marketing claim is not evidence.",
    "AIB terms: the publication is free to read; check AIB's terms before redistributing tables in client-facing outputs, and always show the AIB attribution.",
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, FILE),
  operations: [
    {
      id: "residual_mix",
      label: "Residual mix for a country and year",
      description: "The residual-mix factor for one country and data year (defaults to the latest year loaded for that country).",
      params: [
        { name: "country_code", label: "Country code", type: "string", required: true, placeholder: "GB", help: "ISO 3166-1 alpha-2 as used by AIB (GB for Great Britain)." },
        { name: "data_year", label: "Data year", type: "integer", min: 2000, max: 2100, placeholder: "2025", help: "The year the electricity was consumed. Defaults to the latest loaded year for the country." },
      ],
      async run(params, ctx) {
        const { file, rows } = load(ctx);
        const code = String(params.country_code).trim().toUpperCase();
        const requested = params.data_year as number | undefined;
        const candidates = rows.filter((r) => r.country_code === code && (requested === undefined || r.data_year === requested)).sort((a, b) => b.data_year - a.data_year);
        const row = candidates[0];
        if (!file || !row) {
          return {
            summary: !file ? `No residual-mix file loaded. Save ${FILE} in ${referenceDir(ctx.env, ID)}.` : `No residual mix loaded for ${code}${requested ? ` in ${requested}` : ""}.`,
            columns: COLUMNS,
            rows: [],
            provenance: makeProvenance(definition, ctx, { dataset: "residual-mix", basis: "unavailable", version: file ? fileVersion(file) : undefined }),
            links: LINKS,
          };
        }
        const version = fileVersion(file, `${row.publication} (${row.publication_date})`);
        if (row.availability === "unavailable") {
          return { summary: `AIB publishes no residual mix for ${row.country} in ${row.data_year}. Do not use 0.`, columns: COLUMNS, rows: [{ ...row }], provenance: makeProvenance(definition, ctx, { dataset: "residual-mix", basis: "unavailable", version }), links: LINKS };
        }
        const warnings = [MARKET_BASED_NOTE];
        if (row.direct_co2_only) warnings.push("Figure is direct CO2 only, not CO2e; do not combine with CO2e factors without stating the basis.");
        return {
          summary: `${row.country} ${row.data_year} residual mix: ${row.residual_mix_gco2_per_kwh} gCO2/kWh (${row.publication}, ${row.publication_date}).`,
          columns: COLUMNS,
          rows: [{ ...row }],
          raw: row,
          provenance: makeProvenance(definition, ctx, { dataset: "residual-mix", basis: "measured", version }),
          warnings,
          links: [{ label: row.publication, url: row.source_url }, ...LINKS],
        };
      },
    },
    {
      id: "list",
      label: "Loaded residual-mix rows",
      description: "All rows in the local file, newest data year first.",
      params: [{ name: "country_code", label: "Country code", type: "string", placeholder: "GB", help: "Optional filter." }],
      async run(params, ctx) {
        const { file, rows } = load(ctx);
        const code = params.country_code ? String(params.country_code).trim().toUpperCase() : undefined;
        const out = rows.filter((r) => !code || r.country_code === code).sort((a, b) => b.data_year - a.data_year || a.country_code.localeCompare(b.country_code)).slice(0, 100);
        return {
          summary: !file ? `No residual-mix file loaded from ${referenceDir(ctx.env, ID)}.` : `${out.length} row(s) loaded from ${file.name}${code ? ` for ${code}` : ""}.`,
          columns: COLUMNS,
          rows: out.map((r) => ({ ...r })),
          provenance: makeProvenance(definition, ctx, { dataset: "residual-mix", basis: out.length ? "measured" : "unavailable", version: file ? fileVersion(file) : undefined }),
          links: LINKS,
        };
      },
    },
    {
      id: "links",
      label: "AIB publication pages",
      description: "Where to obtain the residual mix results and the GHG Protocol Scope 2 guidance.",
      params: [],
      async run(_params, ctx) {
        return { summary: "AIB residual-mix publications and Scope 2 guidance.", columns: ["label", "url"], rows: LINKS.map((l) => ({ ...l })), provenance: makeProvenance(definition, ctx, { dataset: "publications", basis: "not_applicable" }), links: LINKS };
      },
    },
  ],
});
