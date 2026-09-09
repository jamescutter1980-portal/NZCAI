import { defineIntegration, makeProvenance, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { parseNumericCell } from "../_shared/csv";
import { peekCsvRows, scanCsv } from "../_shared/csv-stream";
import { cell, columnIndexes, normalisedSet } from "../_shared/columns";
import { fileVersion, listReferenceFiles, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * Scottish EPC Register open data extracts (Scottish Government via
 * statistics.gov.scot / the register's data extract page), read from CSV
 * files the user places under data/reference/scottish-epc-register/.
 *
 * Built from open-source parsers of the extracts (PlaceBasedCarbonCalculator/EPC,
 * nestauk/asf_core_data), not from a download in this environment. What they
 * document:
 *
 * - Domestic extracts arrive as a ZIP of one CSV per quarter or year with a
 *   TWO-ROW header: row 1 carries long descriptive names, row 2 the working
 *   column names, which mix upper-case technical names (ADDRESS1, POST_TOWN,
 *   OSG_UPRN, FLOOR_ENERGY_EFF ...) with friendly names ("Postcode",
 *   "Current energy efficiency rating", "Current energy efficiency rating
 *   band", "Total floor area (m²)", "Main Heating 1 Fuel Type", "Date of
 *   Certificate"). Re-published copies use the England & Wales names
 *   (POSTCODE, CURRENT_ENERGY_EFFICIENCY, TOTAL_FLOOR_AREA ...). Columns are
 *   therefore matched by normalised name against both spellings.
 * - Non-domestic extracts are a single combined CSV with the same two-row
 *   layout ("Energy Band", "Current Energy Performance Rating", "Main Heating
 *   Fuel", "Lodgement Date" in dd/mm/yyyy HH:MM:SS).
 *
 * Files are hundreds of megabytes, so every query streams the file and
 * filters rows; only the detected header is cached per file (by mtime/size).
 */

export const ID = "scottish-epc-register";
export const FILE_PATTERN = /^(domestic|non-domestic)-.*\.csv$/i;

export type Dataset = "domestic" | "non-domestic";

const DOMESTIC_SPEC = {
  uprn: ["UPRN", "OSG_UPRN"],
  reference: ["BUILDING_REFERENCE_NUMBER", "Property_UPRN", "RRN", "Report Reference Number"],
  address1: ["ADDRESS1", "Address1", "Address 1"],
  address2: ["ADDRESS2", "Address2", "Address 2"],
  address3: ["ADDRESS3", "Address3"],
  post_town: ["POST_TOWN", "POSTTOWN", "Post Town"],
  postcode: ["POSTCODE", "Postcode"],
  local_authority: ["LOCAL_AUTHORITY_LABEL", "Local Authority"],
  current_rating: ["CURRENT_ENERGY_RATING", "Current energy efficiency rating band"],
  current_efficiency: ["CURRENT_ENERGY_EFFICIENCY", "Current energy efficiency rating"],
  potential_rating: ["POTENTIAL_ENERGY_RATING", "Potential energy efficiency rating band"],
  potential_efficiency: ["POTENTIAL_ENERGY_EFFICIENCY", "Potential Energy Efficiency Rating"],
  environmental_impact: ["ENVIRONMENT_IMPACT_CURRENT", "Current Environmental Impact Rating"],
  floor_area: ["TOTAL_FLOOR_AREA", "Total floor area*"],
  property_type: ["PROPERTY_TYPE", "Property Type"],
  built_form: ["BUILT_FORM", "Built Form"],
  construction_age: ["CONSTRUCTION_AGE_BAND", "Part 1 Construction Age Band"],
  tenure: ["TENURE", "Tenure"],
  main_fuel: ["MAIN_HEATING_FUEL", "MAIN_FUEL", "Main Heating 1 Fuel Type", "Main Heating Fuel"],
  main_heating: ["MAINHEAT_DESCRIPTION", "Main Heating Description"],
  energy_consumption: ["ENERGY_CONSUMPTION_CURRENT", "Primary Energy Indicator*"],
  co2_per_m2: ["CO2_EMISS_CURR_PER_FLOOR_AREA", "CO2 Emissions Current Per Floor Area*"],
  lodgement_date: ["LODGEMENT_DATE", "Date of Certificate", "Lodgement Date"],
  inspection_date: ["INSPECTION_DATE", "Date of Assessment"],
  transaction_type: ["TRANSACTION_TYPE", "Transaction Type"],
};

const NON_DOMESTIC_SPEC = {
  uprn: ["UPRN", "OSG_UPRN"],
  reference: ["BUILDING_REFERENCE_NUMBER", "Property_UPRN", "RRN", "Report Reference Number"],
  address1: ["ADDRESS1", "Address1", "Address 1"],
  address2: ["ADDRESS2", "Address2", "Address 2"],
  address3: ["ADDRESS3", "Address3"],
  post_town: ["POST_TOWN", "POSTTOWN", "Post Town"],
  postcode: ["POSTCODE", "Postcode"],
  local_authority: ["LOCAL_AUTHORITY_LABEL", "Local Authority"],
  current_rating: ["ASSET_RATING_BAND", "CURRENT_ENERGY_PERFORMANCE_BAND", "Energy Band"],
  current_efficiency: ["ASSET_RATING", "CURRENT_ENERGY_PERFORMANCE_RATING", "Current Energy Performance Rating"],
  potential_rating: ["POTENTIAL_ENERGY_PERFORMANCE_BAND", "Potential Energy Band"],
  potential_efficiency: ["POTENTIAL_ENERGY_PERFORMANCE_RATING", "Potential Energy Performance Rating"],
  environmental_impact: ["BUILDING_EMISSIONS", "Building Emissions*"],
  floor_area: ["FLOOR_AREA", "TOTAL_FLOOR_AREA", "Total floor area*", "Floor Area*"],
  property_type: ["PROPERTY_TYPE", "Property Type", "Building Type"],
  built_form: ["BUILT_FORM", "Built Form"],
  construction_age: ["CONSTRUCTION_AGE_BAND", "Construction Age Band"],
  tenure: ["TENURE", "Tenure"],
  main_fuel: ["MAIN_HEATING_FUEL", "Main Heating Fuel"],
  main_heating: ["MAINHEAT_DESCRIPTION", "Main Heating Description"],
  energy_consumption: ["PRIMARY_ENERGY_VALUE", "Primary Energy*"],
  co2_per_m2: ["BUILDING_EMISSIONS", "Building Emissions*"],
  lodgement_date: ["LODGEMENT_DATE", "Lodgement Date", "Date of Certificate"],
  inspection_date: ["INSPECTION_DATE", "Date of Assessment"],
  transaction_type: ["TRANSACTION_TYPE", "Transaction Type"],
};

type Key = keyof typeof DOMESTIC_SPEC;

const ID_MARKERS = ["uprn", "osg_uprn", "property_uprn", "building_reference_number", "rrn", "report_reference_number"];
const RATING_MARKERS = ["current_energy_efficiency", "current_energy_efficiency_rating", "current_energy_efficiency_rating_band", "current_energy_rating", "current_energy_performance_rating", "asset_rating", "asset_rating_band", "energy_band"];
const ADDRESS_MARKERS = ["address1", "address_1", "post_town", "posttown", "postcode"];

/**
 * Header score for a row: how many known column names it carries. Row 1 of
 * the extracts is descriptive text ("Postcode of the property"), row 2 the
 * working names, so the best-scoring row among the first few wins.
 */
export function headerScore(row: string[]): number {
  const set = normalisedSet(row);
  if (!set.has("postcode")) return 0;
  const ids = ID_MARKERS.filter((m) => set.has(m)).length;
  const ratings = RATING_MARKERS.filter((m) => set.has(m)).length;
  if (ids + ratings === 0) return 0;
  return ids + ratings + ADDRESS_MARKERS.filter((m) => set.has(m)).length;
}

/** True when the row carries a postcode column plus a known identifier or rating column. */
export function isHeaderRow(row: string[]): boolean {
  return headerScore(row) > 0;
}

export interface FileIndex {
  file: ReferenceFile;
  dataset: Dataset;
  header: string[];
  headerRowIndex: number;
  columns: Record<Key, number>;
  missing: Key[];
}

export function datasetOf(name: string): Dataset {
  return /^non-domestic/i.test(name) ? "non-domestic" : "domestic";
}

export function indexHeader(rows: string[][], dataset: Dataset, file: ReferenceFile): FileIndex {
  let headerRowIndex = -1;
  let best = 0;
  rows.slice(0, 10).forEach((row, i) => {
    const score = headerScore(row);
    if (score > best) {
      best = score;
      headerRowIndex = i;
    }
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: no header row with a postcode column found in the first ${rows.length} rows. Expected a Scottish EPC extract CSV (two-row header) or a re-published copy with POSTCODE/UPRN columns.`);
  const header = rows[headerRowIndex];
  const columns = columnIndexes(header, dataset === "domestic" ? DOMESTIC_SPEC : NON_DOMESTIC_SPEC);
  const missing = (Object.keys(columns) as Key[]).filter((k) => columns[k] < 0);
  return { file, dataset, header, headerRowIndex, columns, missing };
}

// Header detection reads only the first 256 KB. The shared loadReferenceFile
// would read the whole file to hand `parse` its text, which defeats
// streaming, so the header cache is keyed by hand on the same (path, mtime,
// size) rule.
const headerCache = new Map<string, { modifiedAt: string; sizeBytes: number; index: FileIndex }>();
export function cachedIndex(file: ReferenceFile): FileIndex {
  const hit = headerCache.get(file.path);
  if (hit && hit.modifiedAt === file.modifiedAt && hit.sizeBytes === file.sizeBytes) return hit.index;
  const index = indexHeader(peekCsvRows(file.path), datasetOf(file.name), file);
  headerCache.set(file.path, { modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes, index });
  return index;
}

export function listFiles(ctx: OperationContext, dataset?: Dataset | "both"): ReferenceFile[] {
  return listReferenceFiles(ctx.env, ID, FILE_PATTERN).filter((f) => !dataset || dataset === "both" || datasetOf(f.name) === dataset);
}

export type EpcRow = {
  dataset: Dataset;
  file: string;
  uprn: string;
  reference: string;
  address: string;
  post_town: string;
  postcode: string;
  local_authority: string;
  current_rating: string;
  current_efficiency: number | null;
  potential_rating: string;
  potential_efficiency: number | null;
  environmental_impact: number | null;
  floor_area_m2: number | null;
  property_type: string;
  built_form: string;
  construction_age: string;
  tenure: string;
  main_fuel: string;
  main_heating: string;
  energy_consumption_kwh_m2: number | null;
  co2_kg_m2: number | null;
  lodgement_date: string;
  inspection_date: string;
  transaction_type: string;
}

export const COLUMNS: (keyof EpcRow)[] = ["dataset", "file", "uprn", "reference", "address", "post_town", "postcode", "local_authority", "current_rating", "current_efficiency", "potential_rating", "potential_efficiency", "environmental_impact", "floor_area_m2", "property_type", "built_form", "construction_age", "tenure", "main_fuel", "main_heating", "energy_consumption_kwh_m2", "co2_kg_m2", "lodgement_date", "inspection_date", "transaction_type"];

export function toRow(idx: FileIndex, row: string[]): EpcRow {
  const c = idx.columns;
  const get = (k: Key) => cell(row, c[k]);
  const num = (k: Key) => parseNumericCell(get(k));
  return {
    dataset: idx.dataset,
    file: idx.file.name,
    uprn: get("uprn"),
    reference: get("reference"),
    address: [get("address1"), get("address2"), get("address3")].filter(Boolean).join(", "),
    post_town: get("post_town"),
    postcode: get("postcode"),
    local_authority: get("local_authority"),
    current_rating: get("current_rating"),
    current_efficiency: num("current_efficiency"),
    potential_rating: get("potential_rating"),
    potential_efficiency: num("potential_efficiency"),
    environmental_impact: num("environmental_impact"),
    floor_area_m2: num("floor_area"),
    property_type: get("property_type"),
    built_form: get("built_form"),
    construction_age: get("construction_age"),
    tenure: get("tenure"),
    main_fuel: get("main_fuel"),
    main_heating: get("main_heating"),
    energy_consumption_kwh_m2: num("energy_consumption"),
    co2_kg_m2: num("co2_per_m2"),
    lodgement_date: toIsoDate(get("lodgement_date")),
    inspection_date: toIsoDate(get("inspection_date")),
    transaction_type: get("transaction_type"),
  };
}

/** "dd/mm/yyyy[ HH:MM:SS]" or "yyyy-mm-dd[...]" to "yyyy-mm-dd"; other text is returned as printed. */
export function toIsoDate(s: string): string {
  const t = s.trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return iso ? iso[1] : t;
}

export function normalisePostcode(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

export interface ScanSummary {
  file: string;
  rowsScanned: number;
  matches: number;
}

/** Streams every selected file, keeping rows for which `match` is true, up to `limit` in total. */
export async function scanFiles(ctx: OperationContext, dataset: Dataset | "both", match: (row: string[], idx: FileIndex) => boolean, limit: number): Promise<{ rows: EpcRow[]; scans: ScanSummary[]; total: number }> {
  const rows: EpcRow[] = [];
  const scans: ScanSummary[] = [];
  let total = 0;
  for (const file of listFiles(ctx, dataset)) {
    const idx = cachedIndex(file);
    let matches = 0;
    let seen = -1;
    const result = await scanCsv(file.path, { isHeader: () => ++seen === idx.headerRowIndex, signal: ctx.signal }, (row) => {
      if (!match(row, idx)) return;
      matches++;
      total++;
      if (rows.length < limit) rows.push(toRow(idx, row));
    });
    scans.push({ file: file.name, rowsScanned: result.rows, matches });
  }
  return { rows, scans, total };
}

export function publicationLinks() {
  return [
    { label: "Domestic EPCs (statistics.gov.scot)", url: "https://statistics.gov.scot/data/domestic-energy-performance-certificates" },
    { label: "Non-domestic EPCs (statistics.gov.scot)", url: "https://statistics.gov.scot/data/non-domestic-energy-performance-certificates" },
    { label: "Scottish EPC Register data extracts", url: "https://www.scottishepcregister.org.uk/CustomerFacingPortal/DataExtract" },
    { label: "Scottish EPC Register public search", url: "https://www.scottishepcregister.org.uk/" },
  ];
}

function noFilesResult(def: IntegrationDefinition, ctx: OperationContext, dataset: string): OperationResult {
  return {
    summary: `No Scottish EPC files loaded for ${dataset} certificates. Unzip the statistics.gov.scot extract and save its CSVs as domestic-<label>.csv or non-domestic-<label>.csv in ${referenceDir(ctx.env, ID)}.`,
    columns: COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "extract", basis: "unavailable" }),
    links: publicationLinks(),
  };
}

function sortNewestFirst(rows: EpcRow[]): EpcRow[] {
  return [...rows].sort((a, b) => (b.lodgement_date || b.inspection_date).localeCompare(a.lodgement_date || a.inspection_date));
}

const WARN_DATES = "Lodgement and assessment dates are normalised to yyyy-mm-dd (the files use ISO in some releases and dd/mm/yyyy HH:MM:SS in others); the newest certificate per address is the one to use, and several rows for one UPRN are normal.";
const WARN_MODEL = "EPC figures are SAP/RdSAP or SBEM asset-rating outputs under standardised occupancy, not measured consumption; Scottish bands and the 2025 regulations differ from England and Wales.";

const DATASET_PARAM = { name: "dataset", label: "Dataset", type: "select" as const, default: "both", options: [{ value: "both", label: "Domestic and non-domestic" }, { value: "domestic", label: "Domestic" }, { value: "non-domestic", label: "Non-domestic" }] };
const LIMIT_PARAM = { name: "limit", label: "Max rows", type: "integer" as const, default: 50, min: 1, max: 100 };

function versionOf(files: ReferenceFile[]): string {
  return files.map((f) => fileVersion(f)).join(" | ");
}

export const definition = defineIntegration({
  id: ID,
  name: "Scottish EPC Register (open data extracts)",
  group: "identity",
  access: "download",
  territory: "Scotland",
  description: "Energy Performance Certificates lodged in Scotland, published by the Scottish Government as bulk CSV extracts (domestic and non-domestic). Loaded from CSV files saved locally and searched by postcode or UPRN.",
  docsUrl: "https://statistics.gov.scot/data/domestic-energy-performance-certificates",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Scottish Government / Scottish EPC Register (Energy Saving Trust).",
  licence: "OGL",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: `Directory holding reference files (default data/reference). Extract CSVs are read from <dir>/${ID}/domestic-*.csv and non-domestic-*.csv.` }],
  status: "built_unverified",
  notes: [
    "Supply the files: download the domestic and non-domestic extracts from statistics.gov.scot (ZIP archives named like D_EPC_data_2012-<year>Q<q>_extract_<mmyy>.zip, one CSV per quarter or year inside), unzip, and save each CSV as data/reference/scottish-epc-register/domestic-<label>.csv or non-domestic-<label>.csv. The download links change with each quarterly release and the archives are ZIPs, so no automatic download is offered.",
    "Header layout confirmed from open-source parsers (PlaceBasedCarbonCalculator/EPC, nestauk/asf_core_data), not from a live download: a two-row header whose second row mixes technical names (ADDRESS1, POST_TOWN, OSG_UPRN) and friendly names ('Postcode', 'Current energy efficiency rating', 'Current energy efficiency rating band', 'Total floor area (m²)', 'Main Heating 1 Fuel Type', 'Date of Certificate'). England-and-Wales style names (POSTCODE, UPRN, CURRENT_ENERGY_EFFICIENCY, TOTAL_FLOOR_AREA, LODGEMENT_DATE) are accepted too. Columns are matched case-insensitively by normalised name; anything unmatched is left blank, and the files operation lists which fields each file lacks.",
    "Files are large (hundreds of MB). Each search streams every loaded file line by line and keeps only matching rows, so memory stays flat but a search takes seconds per file. Only the detected header is cached per file (by modification time and size).",
    "Values are certificate outputs (SAP/RdSAP or SBEM asset ratings under standard occupancy), not measured energy. Scotland's bands, regime (Energy Performance of Buildings (Scotland) Regulations, revised 2025) and thresholds differ from England and Wales; do not mix them in portfolio statistics without noting it.",
    "UPRN is the OS UPRN where the register holds one (OSG_UPRN); older certificates can lack it, so postcode search is the reliable fallback. Save the file as UTF-8 if re-exporting; non-UTF-8 bytes are tolerated but shown as replacement characters.",
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "domestic-<label>.csv and/or non-domestic-<label>.csv"),
  operations: [
    {
      id: "by_postcode",
      label: "EPCs at a postcode",
      description: "Every certificate lodged for addresses in a postcode, newest first, from all loaded extract files.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "EH1 1YZ" }, DATASET_PARAM, LIMIT_PARAM],
      async run(params, ctx) {
        const dataset = String(params.dataset ?? "both") as Dataset | "both";
        const files = listFiles(ctx, dataset);
        if (files.length === 0) return noFilesResult(definition, ctx, dataset);
        const target = normalisePostcode(String(params.postcode));
        const limit = Number(params.limit ?? 50);
        const { rows, scans, total } = await scanFiles(ctx, dataset, (row, idx) => normalisePostcode(cell(row, idx.columns.postcode)) === target, limit);
        const sorted = sortNewestFirst(rows);
        const warnings = [WARN_MODEL, WARN_DATES];
        if (total > rows.length) warnings.push(`${total} certificates matched; showing ${rows.length}. Narrow the dataset or search by UPRN.`);
        const first = sorted[0];
        return {
          summary: total === 0 ? `No certificates for ${params.postcode} in ${files.length} loaded file(s) (${scans.reduce((a, s) => a + s.rowsScanned, 0)} rows scanned).` : `${total} certificate(s) at ${params.postcode} across ${files.length} file(s). Newest: ${first.address || "(no address)"}, rating ${first.current_rating || "n/a"}${first.current_efficiency !== null ? ` (${first.current_efficiency})` : ""}, ${first.floor_area_m2 !== null ? `${first.floor_area_m2} m²` : "floor area n/a"}, lodged ${first.lodgement_date || first.inspection_date || "n/a"}.`,
          columns: COLUMNS,
          rows: sorted,
          raw: { scans, total },
          provenance: makeProvenance(definition, ctx, { dataset: "extract", basis: total ? "measured" : "unavailable", version: versionOf(files) }),
          warnings,
          links: publicationLinks().slice(0, 2),
        };
      },
    },
    {
      id: "by_uprn",
      label: "EPCs for a UPRN",
      description: "Certificates whose OS UPRN matches, newest first.",
      params: [{ name: "uprn", label: "UPRN", type: "uprn", required: true, placeholder: "906700000000" }, DATASET_PARAM, LIMIT_PARAM],
      async run(params, ctx) {
        const dataset = String(params.dataset ?? "both") as Dataset | "both";
        const files = listFiles(ctx, dataset);
        if (files.length === 0) return noFilesResult(definition, ctx, dataset);
        const target = String(params.uprn).replace(/^0+/, "");
        const limit = Number(params.limit ?? 50);
        const { rows, scans, total } = await scanFiles(ctx, dataset, (row, idx) => idx.columns.uprn >= 0 && cell(row, idx.columns.uprn).replace(/\.0+$/, "").replace(/^0+/, "") === target, limit);
        const sorted = sortNewestFirst(rows);
        const warnings = [WARN_MODEL, WARN_DATES];
        const withoutUprn = files.filter((f) => cachedIndex(f).columns.uprn < 0);
        if (withoutUprn.length) warnings.push(`${withoutUprn.map((f) => f.name).join(", ")} carry no UPRN column and were not searched.`);
        const first = sorted[0];
        return {
          summary: total === 0 ? `No certificates for UPRN ${params.uprn} in ${files.length} loaded file(s).` : `${total} certificate(s) for UPRN ${params.uprn}. Newest: ${first.address || "(no address)"} ${first.postcode}, rating ${first.current_rating || "n/a"}${first.current_efficiency !== null ? ` (${first.current_efficiency})` : ""}, lodged ${first.lodgement_date || first.inspection_date || "n/a"}.`,
          columns: COLUMNS,
          rows: sorted,
          raw: { scans, total },
          provenance: makeProvenance(definition, ctx, { dataset: "extract", basis: total ? "measured" : "unavailable", version: versionOf(files) }),
          warnings,
        };
      },
    },
    {
      id: "files",
      label: "Loaded extract files",
      description: "Which extract CSVs are present, their detected header row and which fields could not be matched.",
      params: [],
      async run(_params, ctx) {
        const files = listFiles(ctx);
        const rows = files.map((f) => {
          try {
            const idx = cachedIndex(f);
            return { file: f.name, dataset: idx.dataset, size_mb: Math.round((f.sizeBytes / 1_048_576) * 10) / 10, modified_at: f.modifiedAt, header_row: idx.headerRowIndex + 1, columns: idx.header.length, unmatched_fields: idx.missing.join(", ") || "none", error: "" };
          } catch (e) {
            return { file: f.name, dataset: datasetOf(f.name), size_mb: Math.round((f.sizeBytes / 1_048_576) * 10) / 10, modified_at: f.modifiedAt, header_row: null, columns: null, unmatched_fields: "", error: e instanceof Error ? e.message : String(e) };
          }
        });
        return {
          summary: rows.length === 0 ? `No extract files in ${referenceDir(ctx.env, ID)}. Expected domestic-<label>.csv and non-domestic-<label>.csv.` : `${rows.length} file(s) loaded: ${rows.map((r) => `${r.file} (${r.size_mb} MB)`).join(", ")}.`,
          columns: ["file", "dataset", "size_mb", "modified_at", "header_row", "columns", "unmatched_fields", "error"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "extract", basis: rows.length ? "measured" : "unavailable" }),
          links: publicationLinks(),
        };
      },
    },
    {
      id: "links",
      label: "Download links",
      description: "Official Scottish EPC open data extracts and the register's public search.",
      params: [],
      async run(_params, ctx) {
        const links = publicationLinks();
        return {
          summary: "Scottish EPC data is published as bulk CSV extracts on statistics.gov.scot; there is no public API. Download, unzip and save the CSVs under data/reference/scottish-epc-register/.",
          columns: ["label", "url"],
          rows: links.map((l) => ({ ...l })),
          links,
          provenance: makeProvenance(definition, ctx, { dataset: "download-links", basis: "not_applicable" }),
        };
      },
    },
  ],
});
