import { defineIntegration, makeProvenance, type EnvLike, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { parseNumericCell } from "../_shared/csv";
import { peekCsvRows, scanCsv } from "../_shared/csv-stream";
import { cell, columnIndexes, normalisedSet } from "../_shared/columns";
import { fileVersion, listReferenceFiles, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";
import { downloadText, expectedPath, writeCache } from "../gender-pay-gap/download-cache";

/**
 * DESNZ postcode-level domestic electricity and gas consumption statistics
 * (the "Postcode level electricity statistics" / "Postcode level gas
 * statistics" annual CSVs in the sub-national consumption collections).
 *
 * Column layout confirmed from DESNZ's "about the data" notes and several
 * open-source users of the files (UCL/urban-energy, mysociety), not from a
 * live download here:
 *
 *   Outcode | Postcode | Num_meters | Total_cons_kwh | Mean_cons_kwh | Median_cons_kwh
 *
 * Rows whose Postcode is "All postcodes" carry the whole postcode district
 * (outcode). Postcodes with fewer than five meters, or where two meters
 * dominate, are suppressed (absent), and meters under 100 kWh/year are
 * excluded. Gas is weather corrected; electricity is not.
 *
 * Files are 50-80 MB (1.5-2 million rows) so queries stream them and keep
 * only the matching postcode and outcode rows; only the header is cached.
 */

export const ID = "desnz-subnational-consumption";
export const FILE_PATTERN = /^(electricity|gas)(?:-(standard|economy7))?-(\d{4})\.csv$/i;

export type Fuel = "electricity" | "gas";
export type MeterType = "all" | "standard" | "economy7";

export interface FileMeta {
  file: ReferenceFile;
  fuel: Fuel;
  meterType: MeterType;
  year: number;
}

export function fileMeta(file: ReferenceFile): FileMeta {
  const m = FILE_PATTERN.exec(file.name)!;
  return { file, fuel: m[1].toLowerCase() as Fuel, meterType: (m[2]?.toLowerCase() as MeterType | undefined) ?? "all", year: Number(m[3]) };
}

export function fileName(fuel: Fuel, year: number, meterType: MeterType = "all"): string {
  return `${fuel}${meterType === "all" ? "" : `-${meterType}`}-${year}.csv`;
}

/**
 * gov.uk asset URLs by fuel and year. Media IDs are not predictable, so each
 * release has to be recorded here or supplied via DESNZ_SUBNATIONAL_URLS /
 * the download operation's url parameter. "confirmed" means the exact URL
 * was seen in an open-source project or search result; "inferred" means it
 * was derived from a gov.uk csv-preview link and has not been fetched.
 */
export const KNOWN_URLS: { fuel: Fuel; year: number; url: string; confidence: "confirmed" | "inferred" }[] = [
  { fuel: "electricity", year: 2024, url: "https://assets.publishing.service.gov.uk/media/694282a1fdbd8404f9e1f1da/Postcode_level_all_meters_electricity_2024.csv", confidence: "confirmed" },
  { fuel: "gas", year: 2024, url: "https://assets.publishing.service.gov.uk/media/6942a4e2501cdd438f4cf502/Postcode_level_gas_2024.csv", confidence: "confirmed" },
  { fuel: "electricity", year: 2023, url: "https://assets.publishing.service.gov.uk/media/6942860e143d960161547d58/Postcode_level_all_meters_electricity_2023.csv", confidence: "inferred" },
  { fuel: "gas", year: 2022, url: "https://assets.publishing.service.gov.uk/media/65b10088160765001118f7bd/Postcode_level_gas_2022.csv", confidence: "confirmed" },
  { fuel: "electricity", year: 2021, url: "https://assets.publishing.service.gov.uk/media/6762f20f3229e84d9bbde81f/Postcode_level_all_meters_electricity_2021.csv", confidence: "confirmed" },
  { fuel: "electricity", year: 2020, url: "https://assets.publishing.service.gov.uk/media/69428cecfdbd8404f9e1f1ec/Postcode_level_all_meters_electricity_2020.csv", confidence: "inferred" },
];

/** Parses "electricity-2025=https://...;gas-2025=https://..." (comma or semicolon separated). */
export function envUrls(env: EnvLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (env.DESNZ_SUBNATIONAL_URLS ?? "").split(/[;,]/)) {
    const [key, ...rest] = part.split("=");
    const url = rest.join("=").trim();
    if (key?.trim() && url) out.set(key.trim().toLowerCase(), url);
  }
  return out;
}

export function resolveUrl(env: EnvLike, fuel: Fuel, year: number, override?: string): { url: string; origin: string } | undefined {
  if (override?.trim()) return { url: override.trim(), origin: "parameter" };
  const fromEnv = envUrls(env).get(`${fuel}-${year}`);
  if (fromEnv) return { url: fromEnv, origin: "DESNZ_SUBNATIONAL_URLS" };
  const known = KNOWN_URLS.find((k) => k.fuel === fuel && k.year === year);
  return known ? { url: known.url, origin: `built-in (${known.confidence})` } : undefined;
}

const SPEC = {
  outcode: ["Outcode"],
  postcode: ["Postcode"],
  meters: ["Num_meters", "Number of meters"],
  total: ["Total_cons_kwh", "Total consumption (kWh)"],
  mean: ["Mean_cons_kwh", "Mean consumption (kWh)"],
  median: ["Median_cons_kwh", "Median consumption (kWh)"],
};
type Key = keyof typeof SPEC;

export function isHeaderRow(row: string[]): boolean {
  const set = normalisedSet(row);
  return set.has("postcode") && (set.has("num_meters") || set.has("total_cons_kwh") || set.has("mean_cons_kwh"));
}

export interface FileIndex extends FileMeta {
  header: string[];
  headerRowIndex: number;
  columns: Record<Key, number>;
}

export function indexHeader(rows: string[][], file: ReferenceFile): FileIndex {
  const headerRowIndex = rows.slice(0, 10).findIndex(isHeaderRow);
  if (headerRowIndex < 0) throw new Error(`${file.name}: no header row with Postcode and Num_meters/Total_cons_kwh columns. Expected a DESNZ postcode-level consumption CSV.`);
  const header = rows[headerRowIndex];
  const columns = columnIndexes(header, SPEC);
  const missing = (Object.keys(columns) as Key[]).filter((k) => columns[k] < 0);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}. Expected Outcode, Postcode, Num_meters, Total_cons_kwh, Mean_cons_kwh, Median_cons_kwh.`);
  return { ...fileMeta(file), header, headerRowIndex, columns };
}

const headerCache = new Map<string, { modifiedAt: string; sizeBytes: number; index: FileIndex }>();
export function cachedIndex(file: ReferenceFile): FileIndex {
  const hit = headerCache.get(file.path);
  if (hit && hit.modifiedAt === file.modifiedAt && hit.sizeBytes === file.sizeBytes) return hit.index;
  const index = indexHeader(peekCsvRows(file.path, 64 * 1024), file);
  headerCache.set(file.path, { modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes, index });
  return index;
}

export function listFiles(env: EnvLike, fuel?: Fuel | "any"): FileMeta[] {
  return listReferenceFiles(env, ID, FILE_PATTERN)
    .map(fileMeta)
    .filter((m) => !fuel || fuel === "any" || m.fuel === fuel)
    .sort((a, b) => b.year - a.year || a.fuel.localeCompare(b.fuel) || a.meterType.localeCompare(b.meterType));
}

export type ConsumptionRow = {
  year: number;
  fuel: Fuel;
  meter_type: MeterType;
  level: "postcode" | "outcode";
  postcode: string;
  outcode: string;
  meters: number | null;
  total_kwh: number | null;
  mean_kwh: number | null;
  median_kwh: number | null;
  file: string;
}

export const COLUMNS: (keyof ConsumptionRow)[] = ["year", "fuel", "meter_type", "level", "postcode", "outcode", "meters", "total_kwh", "mean_kwh", "median_kwh", "file"];

export function normalisePostcode(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

/** Outward code of a normalised postcode (everything before the final three characters). */
export function outcodeOf(normalised: string): string {
  return normalised.slice(0, -3);
}

function toRow(idx: FileIndex, row: string[], level: "postcode" | "outcode"): ConsumptionRow {
  const c = idx.columns;
  return {
    year: idx.year,
    fuel: idx.fuel,
    meter_type: idx.meterType,
    level,
    postcode: level === "postcode" ? cell(row, c.postcode) : "",
    outcode: cell(row, c.outcode),
    meters: parseNumericCell(cell(row, c.meters)),
    total_kwh: parseNumericCell(cell(row, c.total)),
    mean_kwh: parseNumericCell(cell(row, c.mean)),
    median_kwh: parseNumericCell(cell(row, c.median)),
    file: idx.file.name,
  };
}

/** Streams one file for the postcode row and its outcode ("All postcodes") row, stopping once both are found. */
export async function findPostcode(idx: FileIndex, target: string, signal?: AbortSignal): Promise<{ postcode?: ConsumptionRow; outcode?: ConsumptionRow; rowsScanned: number }> {
  const outcode = outcodeOf(target);
  let pc: ConsumptionRow | undefined;
  let oc: ConsumptionRow | undefined;
  let seen = -1;
  const result = await scanCsv(idx.file.path, { isHeader: () => ++seen === idx.headerRowIndex, signal }, (row) => {
    const rowOutcode = normalisePostcode(cell(row, idx.columns.outcode));
    if (rowOutcode !== outcode) return;
    const rowPostcode = cell(row, idx.columns.postcode);
    if (/^all postcodes$/i.test(rowPostcode)) oc = toRow(idx, row, "outcode");
    else if (normalisePostcode(rowPostcode) === target) pc = toRow(idx, row, "postcode");
    if (pc && oc) return false;
  });
  return { postcode: pc, outcode: oc, rowsScanned: result.rows };
}

export function publicationLinks() {
  return [
    { label: "Sub-national electricity consumption data (collection)", url: "https://www.gov.uk/government/collections/sub-national-electricity-consumption-data" },
    { label: "Sub-national gas consumption data (collection)", url: "https://www.gov.uk/government/collections/sub-national-gas-consumption-data" },
    { label: "Postcode level gas statistics: 2024", url: "https://www.gov.uk/government/statistics/postcode-level-gas-statistics-2024" },
    { label: "Postcode level electricity statistics: 2024", url: "https://www.gov.uk/government/statistics/postcode-level-electricity-statistics-2024" },
    { label: "About the postcode level data (notes, suppression rules)", url: "https://www.gov.uk/government/publications/postcode-level-domestic-gas-and-electricity-consumption-about-the-data" },
  ];
}

const WARN_AGGREGATE = "These are area aggregates of domestic meters across the whole postcode (typically 15-20 addresses), not the consumption of any one building. Use them for benchmarking or as an estimate with basis 'estimated' in a report, never as an asset's measured consumption.";
const WARN_WEATHER = "Gas figures are weather corrected by DESNZ; electricity figures are not. Both cover domestic meters only, exclude meters under 100 kWh/year, and are suppressed where a postcode has fewer than five meters or two meters dominate.";

function noFilesResult(def: IntegrationDefinition, ctx: OperationContext): OperationResult {
  return {
    summary: `No postcode-level consumption files loaded. Save the DESNZ CSVs as electricity-<year>.csv and gas-<year>.csv in ${referenceDir(ctx.env, ID)} or run the download operation.`,
    columns: COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "postcode-level", basis: "unavailable" }),
    links: publicationLinks(),
  };
}

const FUEL_PARAM = { name: "fuel", label: "Fuel", type: "select" as const, default: "any", options: [{ value: "any", label: "Electricity and gas" }, { value: "electricity", label: "Electricity" }, { value: "gas", label: "Gas" }] };

export const definition = defineIntegration({
  id: ID,
  name: "DESNZ postcode-level energy consumption",
  group: "energy",
  access: "download",
  territory: "GB",
  description: "Annual domestic electricity and gas consumption by postcode (meter count, total, mean and median kWh) from the DESNZ sub-national consumption statistics, loaded from the annual CSVs saved locally. Benchmarking and estimation where no meter data exists.",
  docsUrl: "https://www.gov.uk/government/collections/sub-national-electricity-consumption-data",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Department for Energy Security and Net Zero, sub-national electricity and gas consumption statistics.",
  licence: "OGL",
  envVars: [
    { name: "REFERENCE_DATA_DIR", required: false, description: `Directory holding reference files (default data/reference). Files are read from <dir>/${ID}/electricity-<year>.csv, gas-<year>.csv (optionally electricity-standard-<year>.csv, electricity-economy7-<year>.csv).` },
    { name: "DESNZ_SUBNATIONAL_URLS", required: false, description: "Optional download URL overrides as fuel-year=url pairs separated by ; e.g. electricity-2025=https://assets.publishing.service.gov.uk/media/<id>/Postcode_level_all_meters_electricity_2025.csv;gas-2025=https://..." },
  ],
  status: "built_unverified",
  notes: [
    "Supply the files: from the gov.uk 'Postcode level electricity statistics: <year>' and 'Postcode level gas statistics: <year>' pages download the CSV ('Postcode level all domestic meters electricity <year>' and 'Postcode level gas <year>') and save as data/reference/desnz-subnational-consumption/electricity-<year>.csv and gas-<year>.csv. The standard and Economy 7 electricity splits can be saved as electricity-standard-<year>.csv and electricity-economy7-<year>.csv.",
    "Column layout (Outcode, Postcode, Num_meters, Total_cons_kwh, Mean_cons_kwh, Median_cons_kwh; 'All postcodes' rows per outcode) is taken from DESNZ's notes and open-source users of the files, not from a live download here. Columns are matched by normalised name.",
    "Download URLs on gov.uk carry unpredictable media IDs. The 2024 electricity and gas, 2022 gas and 2021 electricity URLs were confirmed from open-source projects; the 2023 and 2020 electricity URLs are inferred from gov.uk preview links. Supply other years through DESNZ_SUBNATIONAL_URLS or the download operation's url parameter. No URL has been fetched from this codebase.",
    "Postcode-level files are published each December for the previous calendar year (2024 data published December 2025). Each is 50-80 MB; a lookup streams every loaded file, so expect a second or two per file.",
    WARN_AGGREGATE,
    WARN_WEATHER,
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "electricity-<year>.csv and gas-<year>.csv"),
  operations: [
    {
      id: "postcode",
      label: "Consumption for a postcode",
      description: "Domestic electricity and gas meter count, total, mean and median annual kWh for a postcode in every loaded year, with the postcode district (outcode) aggregate for context.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SW1A 1AA" }, FUEL_PARAM, { name: "include_outcode", label: "Include outcode aggregate rows", type: "boolean", default: true }],
      async run(params, ctx) {
        const files = listFiles(ctx.env, String(params.fuel ?? "any") as Fuel | "any");
        if (files.length === 0) return noFilesResult(definition, ctx);
        const target = normalisePostcode(String(params.postcode));
        const includeOutcode = params.include_outcode !== false;
        const rows: ConsumptionRow[] = [];
        const scans: { file: string; rowsScanned: number; found_postcode: boolean; found_outcode: boolean }[] = [];
        for (const meta of files) {
          const idx = cachedIndex(meta.file);
          const found = await findPostcode(idx, target, ctx.signal);
          if (found.postcode) rows.push(found.postcode);
          if (found.outcode && includeOutcode) rows.push(found.outcode);
          scans.push({ file: meta.file.name, rowsScanned: found.rowsScanned, found_postcode: !!found.postcode, found_outcode: !!found.outcode });
        }
        const pcRows = rows.filter((r) => r.level === "postcode");
        const warnings = [WARN_AGGREGATE, WARN_WEATHER];
        const missingIn = scans.filter((s) => !s.found_postcode).map((s) => s.file);
        if (missingIn.length && rows.length) warnings.push(`${params.postcode} has no row in ${missingIn.join(", ")}: DESNZ suppresses postcodes with fewer than five meters or where two meters dominate. The outcode aggregate is shown instead where available.`);
        const latest = pcRows[0];
        const headline = latest ? `${latest.year} ${latest.fuel}: ${latest.meters ?? "n/a"} meters, median ${latest.median_kwh ?? "n/a"} kWh, mean ${latest.mean_kwh ?? "n/a"} kWh per meter.` : "";
        return {
          summary: rows.length === 0 ? `No consumption rows for ${params.postcode} (or its outcode ${outcodeOf(target)}) in ${files.length} loaded file(s).` : pcRows.length === 0 ? `${params.postcode} is not published (suppressed) in ${files.length} loaded file(s); ${rows.length} outcode aggregate row(s) for ${outcodeOf(target)} shown instead.` : `${pcRows.length} postcode row(s) for ${params.postcode} across ${files.length} file(s). ${headline}`,
          columns: COLUMNS,
          rows,
          raw: { scans },
          provenance: makeProvenance(definition, ctx, { dataset: "postcode-level", basis: rows.length ? "measured" : "unavailable", version: files.map((f) => fileVersion(f.file)).join(" | ") }),
          warnings,
          links: publicationLinks().slice(0, 2),
        };
      },
    },
    {
      id: "download",
      label: "Download a year",
      description: "Downloads one fuel's postcode-level CSV for a year into the reference directory (built-in URL where known, else DESNZ_SUBNATIONAL_URLS or the url parameter).",
      params: [
        { name: "fuel", label: "Fuel", type: "select", required: true, options: [{ value: "electricity", label: "Electricity (all domestic meters)" }, { value: "gas", label: "Gas" }] },
        { name: "year", label: "Data year", type: "integer", required: true, min: 2015, max: 2100, placeholder: "2024" },
        { name: "url", label: "CSV URL (optional override)", type: "string", placeholder: "https://assets.publishing.service.gov.uk/media/<id>/Postcode_level_gas_2025.csv", help: "Copy the CSV link from the gov.uk statistics page when the year is not built in." },
      ],
      async run(params, ctx) {
        const fuel = String(params.fuel) as Fuel;
        const year = Number(params.year);
        const resolved = resolveUrl(ctx.env, fuel, year, params.url as string | undefined);
        if (!resolved) throw new Error(`No download URL known for ${fuel} ${year}. Copy the CSV link from the gov.uk 'Postcode level ${fuel} statistics: ${year}' page into the url parameter or DESNZ_SUBNATIONAL_URLS, or save the file by hand at ${expectedPath(ctx.env, ID, fileName(fuel, year))}.`);
        const text = await downloadText(ctx, resolved.url, 300_000);
        if (!/postcode/i.test(text.slice(0, 2000)) || !/num_meters|total_cons_kwh/i.test(text.slice(0, 2000))) throw new Error(`Downloaded content from ${resolved.url} does not look like a DESNZ postcode-level CSV (no Postcode/Num_meters header).`);
        const file = writeCache(ctx.env, ID, fileName(fuel, year), text);
        const idx = cachedIndex(file);
        return {
          summary: `Downloaded ${fuel} ${year} (${Math.round(file.sizeBytes / 1_048_576)} MB) to ${file.path} from ${resolved.origin} URL.`,
          columns: ["fuel", "year", "path", "size_bytes", "url", "url_origin", "header"],
          rows: [{ fuel, year, path: file.path, size_bytes: file.sizeBytes, url: resolved.url, url_origin: resolved.origin, header: idx.header.join(", ") }],
          raw: { url: resolved.url, path: file.path },
          provenance: makeProvenance(definition, ctx, { dataset: "postcode-level", basis: "measured", version: fileVersion(file) }),
        };
      },
    },
    {
      id: "files",
      label: "Loaded files",
      description: "Which postcode-level files are present, by fuel and year.",
      params: [],
      async run(_params, ctx) {
        const files = listFiles(ctx.env);
        const rows = files.map((m) => {
          try {
            const idx = cachedIndex(m.file);
            return { file: m.file.name, fuel: m.fuel, meter_type: m.meterType, year: m.year, size_mb: Math.round((m.file.sizeBytes / 1_048_576) * 10) / 10, modified_at: m.file.modifiedAt, header: idx.header.join(", "), error: "" };
          } catch (e) {
            return { file: m.file.name, fuel: m.fuel, meter_type: m.meterType, year: m.year, size_mb: Math.round((m.file.sizeBytes / 1_048_576) * 10) / 10, modified_at: m.file.modifiedAt, header: "", error: e instanceof Error ? e.message : String(e) };
          }
        });
        return {
          summary: rows.length === 0 ? `No files in ${referenceDir(ctx.env, ID)}. Expected electricity-<year>.csv and gas-<year>.csv.` : `${rows.length} file(s): ${rows.map((r) => `${r.fuel}${r.meter_type === "all" ? "" : ` (${r.meter_type})`} ${r.year}`).join(", ")}.`,
          columns: ["file", "fuel", "meter_type", "year", "size_mb", "modified_at", "header", "error"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "postcode-level", basis: rows.length ? "measured" : "unavailable" }),
          links: publicationLinks(),
        };
      },
    },
    {
      id: "links",
      label: "Publication pages",
      description: "gov.uk collection and statistics pages for the postcode-level files, plus the built-in download URLs.",
      params: [],
      async run(_params, ctx) {
        const links = publicationLinks();
        const rows = [...links.map((l) => ({ label: l.label, url: l.url, kind: "page", confidence: "" })), ...KNOWN_URLS.map((k) => ({ label: `${k.fuel} ${k.year} CSV`, url: k.url, kind: "csv", confidence: k.confidence }))];
        return {
          summary: "Postcode-level consumption is published annually as one CSV per fuel; save each as electricity-<year>.csv or gas-<year>.csv, or use the download operation for years with a known URL.",
          columns: ["label", "url", "kind", "confidence"],
          rows,
          links,
          provenance: makeProvenance(definition, ctx, { dataset: "publications", basis: "not_applicable" }),
        };
      },
    },
  ],
});
