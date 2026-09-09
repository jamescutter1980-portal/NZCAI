import { defineIntegration, makeProvenance, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords, missingColumns, parseNumericCell } from "../_shared/csv";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * UK Government GHG Conversion Factors for Company Reporting (DESNZ, formerly
 * BEIS/DEFRA), loaded from the annual "flat file for automatic processing".
 *
 * The user exports the flat file's "Factors by Category" sheet to CSV and
 * saves it as data/reference/desnz-conversion-factors/<year>.csv. The sheet
 * carries a few preamble rows before the header, so the loader finds the
 * header by its first cell ("ID"). Expected columns (confirmed from several
 * open-source parsers of the 2022-2026 files):
 *
 *   ID | Scope | Level 1 | Level 2 | Level 3 | Level 4 | Column Text | UOM | GHG/Unit | GHG Conversion Factor <year>
 *
 * Extra columns (lookup helpers) are ignored. A blank factor means "not
 * available" and is never read as 0: DESNZ republished the 2026 flat file in
 * July 2026 precisely because some unavailable factors had been shown as 0.
 */

const ID = "desnz-conversion-factors";
const FILE_PATTERN = /^(\d{4})\.csv$/;
const REQUIRED = ["ID", "Scope", "Level 1", "Level 2", "Level 3", "Level 4", "Column Text", "UOM", "GHG/Unit"];
const FACTOR_PREFIX = "GHG Conversion Factor";

export type Availability = "available" | "unavailable";

export interface FactorRow {
  id: string;
  scope: string;
  level1: string;
  level2: string;
  level3: string;
  level4: string;
  column_text: string;
  uom: string;
  ghg_unit: string;
  factor: number | null;
  /** The cell as published (blank for unavailable). */
  factor_text: string;
  availability: Availability;
  year: number;
}

export interface YearIndex {
  year: number;
  file: ReferenceFile;
  factorColumn: string;
  rows: FactorRow[];
  byId: Map<string, FactorRow>;
  /** Lower-cased searchable text per row, same order as rows. */
  haystack: string[];
}

export const COLUMNS = ["id", "scope", "level1", "level2", "level3", "level4", "column_text", "uom", "ghg_unit", "factor", "availability", "year"];

export function parseFlatFile(text: string, year: number, file: ReferenceFile): YearIndex {
  const table = csvToRecords(text, { isHeader: (row) => row[0]?.trim().toUpperCase() === "ID" });
  const missing = missingColumns(table.header, REQUIRED);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}. Expected the DESNZ flat file 'Factors by Category' sheet exported as CSV.`);
  const factorColumn = table.header.find((h) => h.startsWith(FACTOR_PREFIX));
  if (!factorColumn) throw new Error(`${file.name}: no '${FACTOR_PREFIX} <year>' column found.`);
  const rows: FactorRow[] = [];
  for (const r of table.records) {
    if (!r.ID) continue;
    const factorText = r[factorColumn] ?? "";
    const factor = parseNumericCell(factorText);
    rows.push({
      id: r.ID,
      scope: r.Scope,
      level1: r["Level 1"],
      level2: r["Level 2"],
      level3: r["Level 3"],
      level4: r["Level 4"],
      column_text: r["Column Text"],
      uom: r.UOM,
      ghg_unit: r["GHG/Unit"],
      factor,
      factor_text: factorText,
      availability: factor === null ? "unavailable" : "available",
      year,
    });
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const haystack = rows.map((r) => [r.level1, r.level2, r.level3, r.level4, r.column_text, r.uom, r.ghg_unit, r.id].join(" | ").toLowerCase());
  return { year, file, factorColumn, rows, byId, haystack };
}

/** All loaded years, newest first. Each file is parsed once and cached until its mtime changes. */
export function loadYears(ctx: OperationContext): YearIndex[] {
  const files = listReferenceFiles(ctx.env, ID, FILE_PATTERN);
  return files
    .map((file) => {
      const year = Number(FILE_PATTERN.exec(file.name)![1]);
      return loadReferenceFile(file, (text) => parseFlatFile(text, year, file));
    })
    .sort((a, b) => b.year - a.year);
}

function pickYear(years: YearIndex[], requested: number | undefined): YearIndex | undefined {
  if (requested === undefined) return years[0];
  return years.find((y) => y.year === requested);
}

function noYearResult(def: IntegrationDefinition, ctx: OperationContext, requested: number | undefined, years: YearIndex[]): OperationResult {
  const dir = referenceDir(ctx.env, ID);
  const loaded = years.map((y) => y.year).join(", ") || "none";
  return {
    summary: requested === undefined ? `No DESNZ factor files loaded. Save the flat file as <year>.csv in ${dir}.` : `Reporting year ${requested} is not loaded (loaded: ${loaded}). Save the flat file as ${requested}.csv in ${dir}.`,
    columns: COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "flat-file", basis: "unavailable" }),
    links: publicationLinks(),
  };
}

export function publicationLinks() {
  return [
    { label: "Collection: Government conversion factors for company reporting", url: "https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting" },
    { label: "Conversion factors 2026 (flat file republished July 2026)", url: "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026" },
    { label: "Conversion factors 2025", url: "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025" },
    { label: "Conversion factors 2024", url: "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2024" },
  ];
}

function toRow(r: FactorRow) {
  return {
    id: r.id,
    scope: r.scope,
    level1: r.level1,
    level2: r.level2,
    level3: r.level3,
    level4: r.level4,
    column_text: r.column_text,
    uom: r.uom,
    ghg_unit: r.ghg_unit,
    factor: r.factor,
    availability: r.availability,
    year: r.year,
  };
}

const SCOPE_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "Scope 1", label: "Scope 1" },
  { value: "Scope 2", label: "Scope 2" },
  { value: "Scope 3", label: "Scope 3" },
  { value: "Outside of scopes", label: "Outside of scopes" },
];

const GHG_UNIT_OPTIONS = [
  { value: "kg CO2e", label: "kg CO2e (total)" },
  { value: "any", label: "Any (includes per-gas rows)" },
];

export const definition = defineIntegration({
  id: ID,
  name: "UK Government GHG Conversion Factors (DESNZ)",
  group: "carbon",
  access: "download",
  territory: "UK",
  description: "Annual UK Government greenhouse gas conversion factors for company reporting (Scope 1, 2 and 3 activity factors, well-to-tank, transmission and distribution). Loaded from the DESNZ flat file saved locally per reporting year.",
  docsUrl: "https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Department for Energy Security and Net Zero, UK Government GHG Conversion Factors for Company Reporting.",
  licence: "OGL",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: "Directory holding reference files (default data/reference). Factors are read from <dir>/desnz-conversion-factors/<year>.csv." }],
  status: "built_unverified",
  notes: [
    "Supply the file: download the '<year> flat file for automatic processing' (XLSX) from the gov.uk publication, export the 'Factors by Category' sheet to CSV (UTF-8) and save it as data/reference/desnz-conversion-factors/<year>.csv. Keep one file per reporting year; never overwrite a year with a different release without recording it (the 2026 flat file was republished on 31 July 2026 to correct factors shown as 0 instead of blank).",
    "Column headers expected: ID, Scope, Level 1, Level 2, Level 3, Level 4, Column Text, UOM, GHG/Unit, GHG Conversion Factor <year>. Confirmed from open-source parsers of the 2022-2026 files, not from a live download in this environment. Extra lookup columns are ignored.",
    "Blank factor = unavailable (never 0). A published 0 is a genuine zero (e.g. biogenic CO2 outside of scopes). 'Not applicable' is not a marker in the file; where a row exists but does not apply to the activity, choose a different row rather than reading the value as 0.",
    "Rows with GHG/Unit 'kg CO2e' are the totals used for reporting; per-gas rows ('kg CO2e of CO2 per unit', CH4, N2O) are shown only when the GHG unit filter is set to Any.",
    "Location-based Scope 2 for UK electricity = 'UK electricity' generation factor plus the transmission and distribution (T&D) factor (Level 1 'Transmission and distribution'), optionally with the WTT rows for Scope 3. Market-based Scope 2 uses supplier-specific factors (Fuel Mix Disclosure) or, where no contractual instrument applies, the AIB residual mix (see aib-residual-mix).",
    "The library is versioned by reporting year and file release; the provenance version carries the year, file name and file modification time. Reporting-year factors apply to activity in the matching reporting period, not the calendar year of the download.",
    "Factors are UK-specific (electricity, fuels, waste, travel) with some international rows (overseas electricity, hotel stays). Do not apply UK electricity factors to non-UK sites.",
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "<year>.csv"),
  operations: [
    {
      id: "search",
      label: "Search conversion factors",
      description: "Keyword search across Level 1-4, Column Text and unit of measure, with optional scope, Level 1 and reporting-year filters.",
      params: [
        { name: "keywords", label: "Keywords", type: "string", required: true, placeholder: "electricity generated", help: "All words must appear (case-insensitive) in the row's levels, column text, unit or ID." },
        { name: "year", label: "Reporting year", type: "integer", min: 2000, max: 2100, placeholder: "2026", help: "Defaults to the latest loaded year." },
        { name: "scope", label: "Scope", type: "select", options: SCOPE_OPTIONS, default: "any" },
        { name: "level1", label: "Level 1 contains", type: "string", placeholder: "UK electricity" },
        { name: "ghg_unit", label: "GHG unit", type: "select", options: GHG_UNIT_OPTIONS, default: "kg CO2e" },
        { name: "limit", label: "Max rows", type: "integer", default: 50, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const years = loadYears(ctx);
        const idx = pickYear(years, params.year as number | undefined);
        if (!idx) return noYearResult(definition, ctx, params.year as number | undefined, years);
        const words = String(params.keywords).toLowerCase().split(/\s+/).filter(Boolean);
        const scope = params.scope === "any" ? undefined : String(params.scope).toLowerCase();
        const level1 = params.level1 ? String(params.level1).toLowerCase() : undefined;
        const ghgUnit = params.ghg_unit === "any" ? undefined : String(params.ghg_unit).toLowerCase();
        const limit = Number(params.limit ?? 50);
        const matches: FactorRow[] = [];
        let total = 0;
        for (let i = 0; i < idx.rows.length; i++) {
          const r = idx.rows[i];
          if (scope && r.scope.toLowerCase() !== scope) continue;
          if (level1 && !r.level1.toLowerCase().includes(level1)) continue;
          if (ghgUnit && r.ghg_unit.toLowerCase() !== ghgUnit) continue;
          const h = idx.haystack[i];
          if (!words.every((w) => h.includes(w))) continue;
          total++;
          if (matches.length < limit) matches.push(r);
        }
        const unavailable = matches.filter((m) => m.availability === "unavailable").length;
        const warnings: string[] = [];
        if (unavailable) warnings.push(`${unavailable} of ${matches.length} rows have no published factor (blank in the DESNZ file). They are shown as unavailable, not 0.`);
        if (total > matches.length) warnings.push(`${total} rows matched; showing the first ${matches.length}. Add keywords or filters.`);
        return {
          summary: total === 0 ? `No ${idx.year} factors match "${params.keywords}".` : `${total} ${idx.year} factor rows match "${params.keywords}"${scope ? ` in ${params.scope}` : ""}; ${matches.length - unavailable} carry a published value.`,
          columns: COLUMNS,
          rows: matches.map(toRow),
          raw: { year: idx.year, file: idx.file.name, factorColumn: idx.factorColumn, totalMatches: total },
          provenance: makeProvenance(definition, ctx, { dataset: "flat-file", basis: total === 0 ? "unavailable" : "measured", version: fileVersion(idx.file, String(idx.year)) }),
          warnings,
          links: publicationLinks().slice(0, 1),
        };
      },
    },
    {
      id: "factor",
      label: "Get a factor by ID",
      description: "One row from the flat file by its DESNZ ID for a reporting year.",
      params: [
        { name: "id", label: "Factor ID", type: "string", required: true, placeholder: "1234", help: "The ID column of the flat file. IDs are stable across years for the same activity." },
        { name: "year", label: "Reporting year", type: "integer", min: 2000, max: 2100, help: "Defaults to the latest loaded year." },
      ],
      async run(params, ctx) {
        const years = loadYears(ctx);
        const idx = pickYear(years, params.year as number | undefined);
        if (!idx) return noYearResult(definition, ctx, params.year as number | undefined, years);
        const row = idx.byId.get(String(params.id).trim());
        const version = fileVersion(idx.file, String(idx.year));
        if (!row) {
          return { summary: `No factor with ID ${params.id} in the ${idx.year} file.`, columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "flat-file", basis: "unavailable", version }) };
        }
        const label = [row.level1, row.level2, row.level3, row.level4, row.column_text].filter(Boolean).join(" / ");
        if (row.availability === "unavailable") {
          return {
            summary: `${idx.year} factor ${row.id} (${label}) is not available: DESNZ publishes no value for this row. Do not use 0.`,
            columns: COLUMNS,
            rows: [toRow(row)],
            raw: row,
            provenance: makeProvenance(definition, ctx, { dataset: "flat-file", basis: "unavailable", version }),
            warnings: ["Blank factor in the DESNZ flat file. Treat as unavailable, not zero."],
          };
        }
        return {
          summary: `${idx.year} factor ${row.id}: ${label} = ${row.factor} ${row.ghg_unit} per ${row.uom} (${row.scope}).`,
          columns: COLUMNS,
          rows: [toRow(row)],
          raw: row,
          provenance: makeProvenance(definition, ctx, { dataset: "flat-file", basis: "measured", version }),
        };
      },
    },
    {
      id: "years",
      label: "Loaded reporting years",
      description: "Which flat files are loaded, with row counts and file modification time.",
      params: [],
      async run(_params, ctx) {
        const years = loadYears(ctx);
        const rows = years.map((y) => ({
          year: y.year,
          file: y.file.name,
          rows: y.rows.length,
          available: y.rows.filter((r) => r.availability === "available").length,
          unavailable: y.rows.filter((r) => r.availability === "unavailable").length,
          factor_column: y.factorColumn,
          modified_at: y.file.modifiedAt,
          size_bytes: y.file.sizeBytes,
        }));
        return {
          summary: rows.length === 0 ? `No factor files loaded from ${referenceDir(ctx.env, ID)}.` : `${rows.length} reporting year(s) loaded: ${rows.map((r) => `${r.year} (${r.rows} rows)`).join(", ")}.`,
          columns: ["year", "file", "rows", "available", "unavailable", "factor_column", "modified_at", "size_bytes"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "flat-file", basis: rows.length ? "measured" : "unavailable" }),
          links: publicationLinks(),
        };
      },
    },
    {
      id: "links",
      label: "Publication pages",
      description: "Links to the gov.uk publication pages for the 2024, 2025 and 2026 factor sets.",
      params: [],
      async run(_params, ctx) {
        const links = publicationLinks();
        return {
          summary: "gov.uk publication pages for the conversion factors. Download the flat file for automatic processing and save it per reporting year.",
          columns: ["label", "url"],
          rows: links.map((l) => ({ label: l.label, url: l.url })),
          provenance: makeProvenance(definition, ctx, { dataset: "publications", basis: "not_applicable" }),
          links,
        };
      },
    },
  ],
});
