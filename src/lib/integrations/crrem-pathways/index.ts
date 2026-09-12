import { defineIntegration, makeProvenance, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords, missingColumns, parseNumericCell } from "../_shared/csv";
import { fileVersion, listReferenceFiles, loadReferenceFile, parseYearSeries, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * CRREM (Carbon Risk Real Estate Monitor) decarbonisation pathways, loaded
 * from user-supplied versioned files data/reference/crrem-pathways/<version>.csv.
 *
 * Columns: version, country_code, property_type, pathway_type (ghg|energy),
 * scenario (1.5C|2C), year, value, unit (kgCO2e/m2 or kWh/m2).
 *
 * Pathway values are model outputs (SDA-derived targets), so they carry
 * basis "modelled". Versions are immutable: a new CRREM release is a new
 * file, never an edit of an existing one.
 */

const ID = "crrem-pathways";
const FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.csv$/;
const REQUIRED = ["version", "country_code", "property_type", "pathway_type", "scenario", "year", "value", "unit"];

export interface PathwayPoint {
  version: string;
  country_code: string;
  property_type: string;
  pathway_type: "ghg" | "energy";
  scenario: "1.5C" | "2C";
  year: number;
  value: number | null;
  unit: string;
}

export interface VersionIndex {
  version: string;
  file: ReferenceFile;
  points: PathwayPoint[];
  countries: string[];
  propertyTypes: string[];
}

export const COLUMNS = ["version", "country_code", "property_type", "pathway_type", "scenario", "year", "value", "unit"];

function normScenario(s: string): "1.5C" | "2C" | null {
  const t = s.replace(/\s+/g, "").replace("°", "").toUpperCase();
  if (["1.5C", "1.5", "1.5DEGC", "1,5C"].includes(t)) return "1.5C";
  if (["2C", "2", "2.0C", "2DEGC"].includes(t)) return "2C";
  return null;
}

export function parsePathways(text: string, version: string, file: ReferenceFile): VersionIndex {
  const table = csvToRecords(text, { isHeader: (row) => row.map((c) => c.toLowerCase()).includes("property_type") });
  const missing = missingColumns(table.header, REQUIRED);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}`);
  const points: PathwayPoint[] = [];
  for (const r of table.records) {
    const year = parseNumericCell(r.year);
    const scenario = normScenario(r.scenario);
    const pt = r.pathway_type.trim().toLowerCase();
    if (year === null || !scenario || (pt !== "ghg" && pt !== "energy")) continue;
    points.push({
      version: r.version.trim() || version,
      country_code: r.country_code.trim().toUpperCase(),
      property_type: r.property_type.trim(),
      pathway_type: pt,
      scenario,
      year,
      value: parseNumericCell(r.value),
      unit: r.unit.trim(),
    });
  }
  points.sort((a, b) => a.year - b.year);
  return {
    version,
    file,
    points,
    countries: [...new Set(points.map((p) => p.country_code))].sort(),
    propertyTypes: [...new Set(points.map((p) => p.property_type))].sort(),
  };
}

/** Loaded versions, newest file name first (versions sort lexically, e.g. v2.04 > v2.03). */
export function loadVersions(ctx: OperationContext): VersionIndex[] {
  return listReferenceFiles(ctx.env, ID, FILE_PATTERN)
    .map((file) => loadReferenceFile(file, (text) => parsePathways(text, FILE_PATTERN.exec(file.name)![1], file)))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function selectSeries(idx: VersionIndex, country: string, propertyType: string, pathwayType: string, scenario: string): PathwayPoint[] {
  const c = country.trim().toUpperCase();
  const p = propertyType.trim().toLowerCase();
  return idx.points.filter((x) => x.country_code === c && x.property_type.toLowerCase() === p && x.pathway_type === pathwayType && x.scenario === scenario);
}

export interface MisalignmentResult {
  misalignmentYear: number | null;
  firstYear: number;
  lastYear: number;
  rows: { year: number; asset_value: number; pathway_value: number | null; excess: number | null; status: "aligned" | "misaligned" | "no_pathway_value" }[];
  assetConstant: boolean;
}

/**
 * First year in which the asset intensity exceeds the pathway. A single-value
 * asset series is held constant across the pathway years (a static
 * projection, which ignores grid decarbonisation and any planned measures).
 */
export function computeMisalignment(pathway: PathwayPoint[], asset: { year: number; value: number }[]): MisalignmentResult {
  const byYear = new Map(pathway.map((p) => [p.year, p.value]));
  const years = pathway.map((p) => p.year);
  const assetConstant = asset.length === 1;
  const series = assetConstant ? years.map((year) => ({ year, value: asset[0].value })) : asset;
  const rows: MisalignmentResult["rows"] = [];
  let misalignmentYear: number | null = null;
  for (const a of series) {
    if (!byYear.has(a.year)) continue;
    const pv = byYear.get(a.year) ?? null;
    if (pv === null) {
      rows.push({ year: a.year, asset_value: a.value, pathway_value: null, excess: null, status: "no_pathway_value" });
      continue;
    }
    const excess = a.value - pv;
    const misaligned = excess > 0;
    if (misaligned && misalignmentYear === null) misalignmentYear = a.year;
    rows.push({ year: a.year, asset_value: a.value, pathway_value: pv, excess: Number(excess.toFixed(6)), status: misaligned ? "misaligned" : "aligned" });
  }
  return { misalignmentYear, firstYear: years[0], lastYear: years[years.length - 1], rows, assetConstant };
}

const SELECTOR_PARAMS = [
  { name: "version", label: "CRREM version", type: "string" as const, placeholder: "v2.04", help: "File name without .csv. Defaults to the newest loaded version." },
  { name: "country_code", label: "Country", type: "string" as const, required: true, default: "GB", placeholder: "GB" },
  { name: "property_type", label: "Property type", type: "string" as const, required: true, placeholder: "Office", help: "As named in the CRREM file, e.g. Office, Retail, Warehouse (case-insensitive)." },
  { name: "pathway_type", label: "Pathway", type: "select" as const, required: true, options: [{ value: "ghg", label: "GHG intensity (kgCO2e/m2)" }, { value: "energy", label: "Energy intensity (kWh/m2)" }], default: "ghg" },
  { name: "scenario", label: "Scenario", type: "select" as const, required: true, options: [{ value: "1.5C", label: "1.5 °C" }, { value: "2C", label: "2 °C" }], default: "1.5C" },
];

function unavailable(ctx: OperationContext, summary: string, version?: string): OperationResult {
  return { summary, columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "pathways", basis: "unavailable", version }) };
}

function resolve(ctx: OperationContext, params: Record<string, unknown>): { idx?: VersionIndex; series: PathwayPoint[]; error?: OperationResult } {
  const versions = loadVersions(ctx);
  const requested = params.version ? String(params.version) : undefined;
  const idx = requested ? versions.find((v) => v.version === requested) : versions[0];
  if (!idx) {
    const loaded = versions.map((v) => v.version).join(", ") || "none";
    return { series: [], error: unavailable(ctx, requested ? `CRREM version ${requested} is not loaded (loaded: ${loaded}). Save it as ${requested}.csv in ${referenceDir(ctx.env, ID)}.` : `No CRREM pathway files loaded in ${referenceDir(ctx.env, ID)}.`) };
  }
  const series = selectSeries(idx, String(params.country_code), String(params.property_type), String(params.pathway_type), String(params.scenario));
  if (series.length === 0) {
    return { idx, series, error: unavailable(ctx, `No ${params.scenario} ${params.pathway_type} pathway for ${String(params.country_code).toUpperCase()} / ${params.property_type} in CRREM ${idx.version}. Loaded property types: ${idx.propertyTypes.join(", ") || "none"}; countries: ${idx.countries.join(", ") || "none"}.`, fileVersion(idx.file, idx.version)) };
  }
  return { idx, series };
}

export const definition = defineIntegration({
  id: ID,
  name: "CRREM decarbonisation pathways",
  group: "pathways",
  access: "download",
  territory: "Global (UK pathways included)",
  description: "Carbon Risk Real Estate Monitor GHG- and energy-intensity pathways per country and property type for 1.5 °C and 2 °C scenarios, loaded from versioned local files, with a misalignment (stranding) year calculation for an asset's intensity series.",
  docsUrl: "https://www.crrem.eu/tool/",
  termsUrl: "https://www.crrem.eu/",
  attribution: "Pathways: CRREM (Carbon Risk Real Estate Monitor), version as stated. © CRREM / IIÖ. Used under the CRREM terms of use.",
  licence: "restricted",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: "Directory holding reference files (default data/reference). Pathways are read from <dir>/crrem-pathways/<version>.csv." }],
  status: "built_unverified",
  notes: [
    "Supply the file: export the pathway tables from the CRREM tool or the published pathway workbook into data/reference/crrem-pathways/<version>.csv (e.g. v2.04.csv) with columns version, country_code, property_type, pathway_type (ghg|energy), scenario (1.5C|2C), year, value, unit. One file per CRREM release; treat files as immutable and add a new file for a new release.",
    "Confirm software-use rights with CRREM before embedding pathway values in a commercial tool or client deliverables; the pathways are published for the CRREM tool under CRREM's terms, not an open licence.",
    "Pathway values carry basis 'modelled': they are science-based decarbonisation targets derived by CRREM, not measurements.",
    "The misalignment year is the first year the asset intensity exceeds the pathway. A single asset value is held constant (static projection); for a CRREM-consistent result supply the projected series (grid decarbonisation, planned measures) as year,value lines. Floor-area basis and scope (whole building vs landlord) must match the pathway's.",
    "Keep CRREM separate from the UK Net Zero Carbon Buildings Standard limits (uk-nzcbs): different scopes, metrics and years.",
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "<version>.csv"),
  operations: [
    {
      id: "pathway",
      label: "Pathway series",
      description: "Year-by-year pathway values for a country, property type, scenario and pathway type.",
      params: SELECTOR_PARAMS,
      async run(params, ctx) {
        const { idx, series, error } = resolve(ctx, params);
        if (error || !idx) return error!;
        return {
          summary: `CRREM ${idx.version} ${params.scenario} ${params.pathway_type} pathway for ${String(params.country_code).toUpperCase()} ${series[0].property_type}: ${series[0].value} → ${series[series.length - 1].value} ${series[0].unit} (${series[0].year}-${series[series.length - 1].year}, ${series.length} points).`,
          columns: COLUMNS,
          rows: series.map((p) => ({ ...p })),
          provenance: makeProvenance(definition, ctx, { dataset: "pathways", basis: "modelled", version: fileVersion(idx.file, idx.version) }),
        };
      },
    },
    {
      id: "misalignment",
      label: "Misalignment year for an asset",
      description: "Compares an asset's intensity series with the pathway and reports the first year the asset exceeds it.",
      params: [
        ...SELECTOR_PARAMS,
        { name: "asset_series", label: "Asset intensity series", type: "text", required: true, placeholder: "2025,65\n2026,63\n2027,61", help: "year,value lines (or JSON [{year,value}]) in the pathway's unit. A single value is held constant across all pathway years." },
      ],
      async run(params, ctx) {
        const { idx, series, error } = resolve(ctx, params);
        if (error || !idx) return error!;
        const asset = parseYearSeries(String(params.asset_series));
        if (asset.length === 0) throw new Error("asset_series must contain at least one year,value pair");
        const result = computeMisalignment(series, asset);
        const unit = series[0].unit;
        const warnings: string[] = [];
        if (result.assetConstant) warnings.push("Single asset value held constant across all years (static projection). Supply a projected series for a CRREM-consistent misalignment year.");
        const missingYears = result.assetConstant ? [] : asset.filter((a) => !series.some((p) => p.year === a.year)).map((a) => a.year);
        if (missingYears.length) warnings.push(`Asset years outside the pathway were ignored: ${missingYears.join(", ")}.`);
        if (result.rows.some((r) => r.status === "no_pathway_value")) warnings.push("Some pathway years carry no value in the file and were skipped.");
        warnings.push("Check floor-area basis, scope and grid factor assumptions match the pathway before reporting.");
        const label = `${String(params.country_code).toUpperCase()} ${series[0].property_type}, ${params.scenario} ${params.pathway_type} (CRREM ${idx.version})`;
        if (result.rows.length === 0) {
          return {
            summary: `No overlap: the asset series (${asset[0].year}-${asset[asset.length - 1].year}) shares no year with the ${label} pathway (${result.firstYear}-${result.lastYear}), so no misalignment year can be computed.`,
            columns: ["year", "asset_value", "pathway_value", "excess", "status", "unit"],
            rows: [],
            raw: { misalignment_year: null, unit, version: idx.version },
            provenance: makeProvenance(definition, ctx, { dataset: "misalignment", basis: "unavailable", version: fileVersion(idx.file, idx.version) }),
            warnings,
          };
        }
        return {
          summary: result.misalignmentYear === null ? `Aligned: the asset stays at or below the ${label} pathway for every year compared (${result.rows[0]?.year ?? result.firstYear}-${result.rows[result.rows.length - 1]?.year ?? result.lastYear}).` : `Misalignment year ${result.misalignmentYear}: the asset first exceeds the ${label} pathway in ${result.misalignmentYear} (${result.rows.find((r) => r.year === result.misalignmentYear)?.asset_value} vs ${result.rows.find((r) => r.year === result.misalignmentYear)?.pathway_value} ${unit}).`,
          columns: ["year", "asset_value", "pathway_value", "excess", "status", "unit"],
          rows: result.rows.map((r) => ({ ...r, unit })),
          raw: { misalignment_year: result.misalignmentYear, unit, version: idx.version },
          provenance: makeProvenance(definition, ctx, { dataset: "misalignment", basis: "modelled", version: fileVersion(idx.file, idx.version) }),
          warnings,
        };
      },
    },
    {
      id: "versions",
      label: "Loaded CRREM versions",
      description: "Which pathway files are loaded, with coverage and file modification time.",
      params: [],
      async run(_params, ctx) {
        const versions = loadVersions(ctx);
        const rows = versions.map((v) => ({ version: v.version, file: v.file.name, points: v.points.length, countries: v.countries.join(", "), property_types: v.propertyTypes.join(", "), modified_at: v.file.modifiedAt, size_bytes: v.file.sizeBytes }));
        return {
          summary: rows.length ? `${rows.length} CRREM version(s) loaded: ${rows.map((r) => r.version).join(", ")}.` : `No CRREM pathway files loaded in ${referenceDir(ctx.env, ID)}.`,
          columns: ["version", "file", "points", "countries", "property_types", "modified_at", "size_bytes"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "pathways", basis: rows.length ? "modelled" : "unavailable" }),
          links: [{ label: "CRREM tool and pathways", url: "https://www.crrem.eu/tool/" }],
        };
      },
    },
  ],
});
