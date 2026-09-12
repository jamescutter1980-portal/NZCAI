import { defineIntegration, makeProvenance, type OperationContext } from "../framework";
import { csvToRecords, missingColumns, parseNumericCell } from "../_shared/csv";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * UK Net Zero Carbon Buildings Standard (UK NZCBS) limits and targets, loaded
 * from user-supplied versioned files data/reference/uk-nzcbs/<version>.csv.
 *
 * Columns: version, sector, metric, year, limit_value, unit, notes.
 * Metrics follow the Standard's headings, e.g. operational_energy_eui,
 * embodied_upfront, embodied_lifecycle, onsite_renewables, refrigerant_leakage.
 *
 * This is a reference table, not a calculation API. Keep it separate from
 * CRREM pathways: the Standard sets limits per sector and year of completion
 * or reporting; CRREM models intensity trajectories.
 */

const ID = "uk-nzcbs";
const FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.csv$/;
const REQUIRED = ["version", "sector", "metric", "year", "limit_value", "unit", "notes"];

export interface LimitRow {
  version: string;
  sector: string;
  metric: string;
  year: number | null;
  limit_value: number | null;
  availability: "available" | "unavailable";
  unit: string;
  notes: string;
}

export interface VersionIndex {
  version: string;
  file: ReferenceFile;
  rows: LimitRow[];
  sectors: string[];
  metrics: string[];
}

export const COLUMNS = ["version", "sector", "metric", "year", "limit_value", "availability", "unit", "notes"];

export function parseLimits(text: string, version: string, file: ReferenceFile): VersionIndex {
  const table = csvToRecords(text, { isHeader: (row) => row.map((c) => c.toLowerCase()).includes("limit_value") });
  const missing = missingColumns(table.header, REQUIRED);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}`);
  const rows: LimitRow[] = [];
  for (const r of table.records) {
    if (!r.sector.trim() || !r.metric.trim()) continue;
    const value = parseNumericCell(r.limit_value);
    rows.push({
      version: r.version.trim() || version,
      sector: r.sector.trim(),
      metric: r.metric.trim(),
      year: parseNumericCell(r.year),
      limit_value: value,
      availability: value === null ? "unavailable" : "available",
      unit: r.unit.trim(),
      notes: r.notes,
    });
  }
  return { version, file, rows, sectors: [...new Set(rows.map((x) => x.sector))].sort(), metrics: [...new Set(rows.map((x) => x.metric))].sort() };
}

export function loadVersions(ctx: OperationContext): VersionIndex[] {
  return listReferenceFiles(ctx.env, ID, FILE_PATTERN)
    .map((file) => loadReferenceFile(file, (text) => parseLimits(text, FILE_PATTERN.exec(file.name)![1], file)))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export const LINKS = [{ label: "UK Net Zero Carbon Buildings Standard", url: "https://www.nzcbuildings.co.uk/" }];

export const definition = defineIntegration({
  id: ID,
  name: "UK Net Zero Carbon Buildings Standard limits",
  group: "pathways",
  access: "download",
  territory: "UK",
  description: "Sector limits and targets from the UK Net Zero Carbon Buildings Standard (operational energy intensity, upfront and life-cycle embodied carbon, on-site renewables and related metrics) by sector and year, loaded from a versioned local reference file.",
  docsUrl: "https://www.nzcbuildings.co.uk/",
  attribution: "Limits and targets: UK Net Zero Carbon Buildings Standard, version as stated. © UK NZCBS. Transcribed from the published Standard; verify against the current publication.",
  licence: "restricted",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: "Directory holding reference files (default data/reference). Limits are read from <dir>/uk-nzcbs/<version>.csv." }],
  status: "built_unverified",
  notes: [
    "Supply the file: transcribe the limit and target tables from the published Standard (technical document and its annexes) into data/reference/uk-nzcbs/<version>.csv (e.g. v1.0.csv) with columns version, sector, metric, year, limit_value, unit, notes. Leave limit_value blank where the Standard sets no limit for that sector/metric/year (blank is unavailable, never 0). Add a new file for each Standard version; do not edit an existing one.",
    "Suggested metric keys: operational_energy_eui (kWh/m2/yr), embodied_upfront (kgCO2e/m2, A1-A5), embodied_lifecycle (kgCO2e/m2, A-C), onsite_renewables (kWh/m2/yr), refrigerant_leakage, space_heating_demand, peak_demand. Keep the Standard's own sector names and floor-area basis in the notes column.",
    "This is a reference table, not a calculation API. Compliance with the Standard needs the full method (metering, verification, reporting) and, for certification, an approved verifier.",
    "Keep separate from CRREM: the Standard sets limits per sector and year; CRREM models decarbonisation trajectories. Do not mix the two in one chart without labelling both sources.",
    "Rows are loaded verbatim from the published tables and carry basis 'measured' (as published); the values themselves are standard limits, not measured building performance.",
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "<version>.csv"),
  operations: [
    {
      id: "limits",
      label: "Limits for a sector and year",
      description: "All limits and targets for one sector, optionally filtered by year and metric.",
      params: [
        { name: "version", label: "Standard version", type: "string", placeholder: "v1.0", help: "File name without .csv. Defaults to the newest loaded version." },
        { name: "sector", label: "Sector", type: "string", required: true, placeholder: "Office", help: "As named in the file (case-insensitive substring match)." },
        { name: "year", label: "Year", type: "integer", min: 2000, max: 2100, placeholder: "2030", help: "Optional. Matches rows for that year; rows with no year always match." },
        { name: "metric", label: "Metric", type: "string", placeholder: "operational_energy_eui", help: "Optional substring filter on the metric key." },
      ],
      async run(params, ctx) {
        const versions = loadVersions(ctx);
        const requested = params.version ? String(params.version) : undefined;
        const idx = requested ? versions.find((v) => v.version === requested) : versions[0];
        if (!idx) {
          const loaded = versions.map((v) => v.version).join(", ") || "none";
          return { summary: requested ? `NZCBS version ${requested} is not loaded (loaded: ${loaded}). Save it as ${requested}.csv in ${referenceDir(ctx.env, ID)}.` : `No NZCBS limit files loaded in ${referenceDir(ctx.env, ID)}.`, columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: "unavailable" }), links: LINKS };
        }
        const sector = String(params.sector).trim().toLowerCase();
        const year = params.year as number | undefined;
        const metric = params.metric ? String(params.metric).trim().toLowerCase() : undefined;
        const rows = idx.rows
          .filter((r) => r.sector.toLowerCase().includes(sector))
          .filter((r) => year === undefined || r.year === null || r.year === year)
          .filter((r) => !metric || r.metric.toLowerCase().includes(metric))
          .slice(0, 100);
        const version = fileVersion(idx.file, idx.version);
        if (rows.length === 0) {
          return { summary: `No NZCBS ${idx.version} limits for sector "${params.sector}"${year ? ` in ${year}` : ""}${metric ? ` (metric ${metric})` : ""}. Sectors loaded: ${idx.sectors.join(", ") || "none"}.`, columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: "unavailable", version }), links: LINKS };
        }
        const unavailable = rows.filter((r) => r.availability === "unavailable").length;
        return {
          summary: `${rows.length} NZCBS ${idx.version} limit(s) for ${rows[0].sector}${year ? ` in ${year}` : ""}: ${rows.filter((r) => r.limit_value !== null).slice(0, 3).map((r) => `${r.metric} ${r.limit_value} ${r.unit}`).join("; ")}${rows.length > 3 ? "; ..." : ""}.`,
          columns: COLUMNS,
          rows: rows.map((r) => ({ ...r })),
          provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: "measured", version }),
          warnings: [
            ...(unavailable ? [`${unavailable} row(s) have no limit set in the Standard for this sector/year; shown as unavailable, not 0.`] : []),
            "Limits are transcribed from the published Standard; verify against the current publication before use in a compliance statement.",
          ],
          links: LINKS,
        };
      },
    },
    {
      id: "versions",
      label: "Loaded Standard versions",
      description: "Which limit files are loaded, with sectors, metrics and file modification time.",
      params: [],
      async run(_params, ctx) {
        const versions = loadVersions(ctx);
        const rows = versions.map((v) => ({ version: v.version, file: v.file.name, rows: v.rows.length, sectors: v.sectors.join(", "), metrics: v.metrics.join(", "), modified_at: v.file.modifiedAt, size_bytes: v.file.sizeBytes }));
        return {
          summary: rows.length ? `${rows.length} NZCBS version(s) loaded: ${rows.map((r) => r.version).join(", ")}.` : `No NZCBS limit files loaded in ${referenceDir(ctx.env, ID)}.`,
          columns: ["version", "file", "rows", "sectors", "metrics", "modified_at", "size_bytes"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: rows.length ? "measured" : "unavailable" }),
          links: LINKS,
        };
      },
    },
  ],
});
