import { defineIntegration, makeProvenance, type EnvLike, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords, parseNumericCell } from "../_shared/csv";
import { peekCsvRows, scanCsv } from "../_shared/csv-stream";
import { cell, columnIndexes, findColumn, normaliseColumn } from "../_shared/columns";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";
import { downloadText, expectedPath, writeCache } from "../gender-pay-gap/download-cache";

/**
 * English Indices of Deprivation (MHCLG) at LSOA level, plus an optional ONS
 * Postcode Directory (ONSPD) file for postcode -> LSOA lookups.
 *
 * IMD: "File 7: all ranks, deciles and scores for the indices of deprivation,
 * and population denominators". Column names confirmed from open-source
 * users (humaniverse/IMD, TomboloDigitalConnector) for the 2019 edition
 * (LSOA 2011 geography) and the 2025 edition (LSOA 2021 geography):
 *
 *   LSOA code (2011|2021) | LSOA name (...) | Local Authority District code (2019|...) |
 *   Local Authority District name (...) | Index of Multiple Deprivation (IMD) Score |
 *   Index of Multiple Deprivation (IMD) Rank (where 1 is most deprived) |
 *   Index of Multiple Deprivation (IMD) Decile (where 1 is most deprived 10% of LSOAs) |
 *   Income Score (rate) | Income Rank (...) | Income Decile (...) | Employment ... |
 *   Education, Skills and Training ... | Health Deprivation and Disability ... | Crime ... |
 *   Barriers to Housing and Services ... | Living Environment ... |
 *   Income Deprivation Affecting Children Index (IDACI) ... | Income Deprivation Affecting Older People (IDAOPI) ... |
 *   Total population ... | ...
 *
 * ONSPD: the full-UK CSV (about 1.3 GB, columns pcd, pcd2, pcds, dointr,
 * doterm, ..., oseast1m, osnrth1m, ..., ctry, rgn, ..., lsoa11, msoa11, ...,
 * lat, long, ..., lsoa21, msoa21) or the per-postcode-area split files. It
 * is streamed, never loaded into memory.
 */

export const ID = "ons-geography-imd";
export const IMD_PATTERN = /^imd[-_]?(\d{4}).*\.csv$/i;
export const ONSPD_PATTERN = /^onspd.*\.csv$/i;

/** File 7 download URLs. 2019: seen directly in search results. 2025: derived from the gov.uk csv-preview link (media id + file name); not fetched here. */
export const IMD_URLS: Record<number, { url: string; confidence: "confirmed" | "inferred" }> = {
  2019: { url: "https://assets.publishing.service.gov.uk/media/5dc407b440f0b6379a7acc8d/File_7_-_All_IoD2019_Scores__Ranks__Deciles_and_Population_Denominators_3.csv", confidence: "confirmed" },
  2025: { url: "https://assets.publishing.service.gov.uk/media/691ded56d140bbbaa59a2a7d/File_7_IoD2025_All_Ranks_Scores_Deciles_Population_Denominators.csv", confidence: "inferred" },
};

export function imdFileName(edition: number): string {
  return `imd${edition}-file7.csv`;
}

export const DOMAINS = [
  { key: "income", prefix: "income", label: "Income" },
  { key: "employment", prefix: "employment", label: "Employment" },
  { key: "education", prefix: "education_skills_and_training", label: "Education, skills and training" },
  { key: "health", prefix: "health_deprivation_and_disability", label: "Health deprivation and disability" },
  { key: "crime", prefix: "crime", label: "Crime" },
  { key: "housing", prefix: "barriers_to_housing_and_services", label: "Barriers to housing and services" },
  { key: "environment", prefix: "living_environment", label: "Living environment" },
  { key: "idaci", prefix: "income_deprivation_affecting_children_index_idaci", label: "IDACI" },
  { key: "idaopi", prefix: "income_deprivation_affecting_older_people_idaopi", label: "IDAOPI" },
] as const;

export type ImdRow = {
  edition: number;
  lsoa_code: string;
  lsoa_name: string;
  lad_code: string;
  lad_name: string;
  imd_score: number | null;
  imd_rank: number | null;
  imd_decile: number | null;
  income_decile: number | null;
  employment_decile: number | null;
  education_decile: number | null;
  health_decile: number | null;
  crime_decile: number | null;
  housing_decile: number | null;
  environment_decile: number | null;
  idaci_decile: number | null;
  idaopi_decile: number | null;
  income_rank: number | null;
  employment_rank: number | null;
  education_rank: number | null;
  health_rank: number | null;
  crime_rank: number | null;
  housing_rank: number | null;
  environment_rank: number | null;
  total_population: number | null;
  file: string;
}

export const IMD_COLUMNS: (keyof ImdRow)[] = ["edition", "lsoa_code", "lsoa_name", "lad_code", "lad_name", "imd_score", "imd_rank", "imd_decile", "income_decile", "employment_decile", "education_decile", "health_decile", "crime_decile", "housing_decile", "environment_decile", "idaci_decile", "idaopi_decile", "income_rank", "employment_rank", "education_rank", "health_rank", "crime_rank", "housing_rank", "environment_rank", "total_population", "file"];

export interface ImdIndex {
  edition: number;
  /** LSOA geography year the codes refer to (2011 for IoD2019, 2021 for IoD2025). */
  geography: number;
  file: ReferenceFile;
  header: string[];
  byLsoa: Map<string, ImdRow>;
  lsoaCount: number;
}

/** Column whose normalised name starts with `prefix` and ends with `suffix` (e.g. "income" + "decile"). */
function findDomainColumn(header: string[], prefix: string, suffix: "score" | "rank" | "decile"): string | undefined {
  const norm = header.map(normaliseColumn);
  const i = norm.findIndex((h) => h.startsWith(`${prefix}_${suffix}`) || (h.startsWith(prefix) && h.includes(`_${suffix}`) && !h.includes("index_of_multiple")));
  return i >= 0 ? header[i] : undefined;
}

export function parseImd(text: string, edition: number, file: ReferenceFile): ImdIndex {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => normaliseColumn(c).startsWith("lsoa_code")) });
  const header = table.header;
  const lsoaCodeCol = header[findColumn(header, ["LSOA code*"])];
  const lsoaNameCol = header[findColumn(header, ["LSOA name*"])];
  const ladCodeCol = header[findColumn(header, ["Local Authority District code*"])];
  const ladNameCol = header[findColumn(header, ["Local Authority District name*"])];
  const imdScoreCol = header[findColumn(header, ["Index of Multiple Deprivation (IMD) Score"])];
  const imdRankCol = header[findColumn(header, ["Index of Multiple Deprivation (IMD) Rank*"])];
  const imdDecileCol = header[findColumn(header, ["Index of Multiple Deprivation (IMD) Decile*"])];
  const popCol = header[findColumn(header, ["Total population*"])];
  if (!lsoaCodeCol || !imdRankCol || !imdDecileCol) throw new Error(`${file.name}: missing LSOA code / IMD rank / IMD decile columns. Expected the Indices of Deprivation 'File 7: all ranks, deciles and scores' CSV.`);
  const geography = Number(/(\d{4})/.exec(lsoaCodeCol)?.[1] ?? (edition >= 2025 ? 2021 : 2011));
  const domainCols: Record<string, { decile?: string; rank?: string }> = {};
  for (const d of DOMAINS) domainCols[d.key] = { decile: findDomainColumn(header, d.prefix, "decile"), rank: findDomainColumn(header, d.prefix, "rank") };
  const byLsoa = new Map<string, ImdRow>();
  const num = (r: Record<string, string>, colName?: string) => (colName ? parseNumericCell(r[colName]) : null);
  for (const r of table.records) {
    const code = (r[lsoaCodeCol] ?? "").trim().toUpperCase();
    if (!code) continue;
    byLsoa.set(code, {
      edition,
      lsoa_code: code,
      lsoa_name: lsoaNameCol ? (r[lsoaNameCol] ?? "") : "",
      lad_code: ladCodeCol ? (r[ladCodeCol] ?? "") : "",
      lad_name: ladNameCol ? (r[ladNameCol] ?? "") : "",
      imd_score: num(r, imdScoreCol),
      imd_rank: num(r, imdRankCol),
      imd_decile: num(r, imdDecileCol),
      income_decile: num(r, domainCols.income.decile),
      employment_decile: num(r, domainCols.employment.decile),
      education_decile: num(r, domainCols.education.decile),
      health_decile: num(r, domainCols.health.decile),
      crime_decile: num(r, domainCols.crime.decile),
      housing_decile: num(r, domainCols.housing.decile),
      environment_decile: num(r, domainCols.environment.decile),
      idaci_decile: num(r, domainCols.idaci.decile),
      idaopi_decile: num(r, domainCols.idaopi.decile),
      income_rank: num(r, domainCols.income.rank),
      employment_rank: num(r, domainCols.employment.rank),
      education_rank: num(r, domainCols.education.rank),
      health_rank: num(r, domainCols.health.rank),
      crime_rank: num(r, domainCols.crime.rank),
      housing_rank: num(r, domainCols.housing.rank),
      environment_rank: num(r, domainCols.environment.rank),
      total_population: num(r, popCol),
      file: file.name,
    });
  }
  return { edition, geography, file, header, byLsoa, lsoaCount: byLsoa.size };
}

/** Loaded IMD editions, newest first; parsed once and cached per file version. */
export function loadEditions(env: EnvLike): ImdIndex[] {
  return listReferenceFiles(env, ID, IMD_PATTERN)
    .map((file) => loadReferenceFile(file, (text) => parseImd(text, Number(IMD_PATTERN.exec(file.name)![1]), file)))
    .sort((a, b) => b.edition - a.edition);
}

// ---- ONSPD ----------------------------------------------------------------

const ONSPD_SPEC = {
  pcd: ["pcd"],
  pcds: ["pcds"],
  doterm: ["doterm"],
  oslaua: ["oslaua"],
  ctry: ["ctry"],
  rgn: ["rgn"],
  oseast1m: ["oseast1m"],
  osnrth1m: ["osnrth1m"],
  lat: ["lat"],
  long: ["long"],
  lsoa11: ["lsoa11"],
  msoa11: ["msoa11"],
  lsoa21: ["lsoa21"],
  msoa21: ["msoa21"],
  oa21: ["oa21"],
};
type OnspdKey = keyof typeof ONSPD_SPEC;

export interface OnspdIndex {
  file: ReferenceFile;
  header: string[];
  headerRowIndex: number;
  columns: Record<OnspdKey, number>;
  /** Postcode area the file covers when it is a per-area split (ONSPD_..._UK_AB.csv), else undefined. */
  area?: string;
}

export function isOnspdHeader(row: string[]): boolean {
  const set = new Set(row.map(normaliseColumn));
  return set.has("pcd") && (set.has("lsoa11") || set.has("lsoa21")) && set.has("pcds");
}

const onspdCache = new Map<string, { modifiedAt: string; sizeBytes: number; index: OnspdIndex }>();
export function onspdIndex(file: ReferenceFile): OnspdIndex {
  const hit = onspdCache.get(file.path);
  if (hit && hit.modifiedAt === file.modifiedAt && hit.sizeBytes === file.sizeBytes) return hit.index;
  const rows = peekCsvRows(file.path, 64 * 1024);
  const headerRowIndex = rows.slice(0, 5).findIndex(isOnspdHeader);
  if (headerRowIndex < 0) throw new Error(`${file.name}: no ONSPD header (pcd, pcds, lsoa11/lsoa21 ...) found.`);
  const header = rows[headerRowIndex];
  const columns = columnIndexes(header, ONSPD_SPEC);
  const area = /_([A-Z]{1,2})\.csv$/i.exec(file.name)?.[1]?.toUpperCase();
  const index = { file, header, headerRowIndex, columns, area };
  onspdCache.set(file.path, { modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes, index });
  return index;
}

export function normalisePostcode(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

export function postcodeArea(normalised: string): string {
  return /^[A-Z]{1,2}/.exec(normalised)?.[0] ?? "";
}

export interface PostcodeGeo {
  postcode: string;
  terminated: string;
  lsoa11: string;
  msoa11: string;
  lsoa21: string;
  msoa21: string;
  oa21: string;
  local_authority: string;
  country: string;
  region: string;
  easting: number | null;
  northing: number | null;
  latitude: number | null;
  longitude: number | null;
  file: string;
}

export const COUNTRY_NAMES: Record<string, string> = { E92000001: "England", W92000004: "Wales", S92000003: "Scotland", N92000002: "Northern Ireland", L93000001: "Channel Islands", M83000003: "Isle of Man" };

/** Streams the ONSPD file(s) for one postcode; per-area split files that cannot contain it are skipped. */
export async function lookupPostcode(env: EnvLike, postcode: string, signal?: AbortSignal): Promise<{ geo?: PostcodeGeo; file?: ReferenceFile; filesScanned: string[]; filesPresent: number }> {
  const files = listReferenceFiles(env, ID, ONSPD_PATTERN);
  const target = normalisePostcode(postcode);
  const area = postcodeArea(target);
  const filesScanned: string[] = [];
  for (const file of files) {
    const idx = onspdIndex(file);
    if (idx.area && idx.area !== area) continue;
    filesScanned.push(file.name);
    let geo: PostcodeGeo | undefined;
    let seen = -1;
    await scanCsv(file.path, { isHeader: () => ++seen === idx.headerRowIndex, signal }, (row) => {
      const c = idx.columns;
      if (normalisePostcode(cell(row, c.pcd)) !== target) return;
      const ctry = cell(row, c.ctry);
      geo = {
        postcode: cell(row, c.pcds) || cell(row, c.pcd),
        terminated: cell(row, c.doterm),
        lsoa11: cell(row, c.lsoa11),
        msoa11: cell(row, c.msoa11),
        lsoa21: cell(row, c.lsoa21),
        msoa21: cell(row, c.msoa21),
        oa21: cell(row, c.oa21),
        local_authority: cell(row, c.oslaua),
        country: COUNTRY_NAMES[ctry] ?? ctry,
        region: cell(row, c.rgn),
        easting: parseNumericCell(cell(row, c.oseast1m)),
        northing: parseNumericCell(cell(row, c.osnrth1m)),
        latitude: parseNumericCell(cell(row, c.lat)),
        longitude: parseNumericCell(cell(row, c.long)),
        file: file.name,
      };
      return false;
    });
    if (geo) return { geo, file, filesScanned, filesPresent: files.length };
  }
  return { filesScanned, filesPresent: files.length };
}

// ---- shared ---------------------------------------------------------------

export function publicationLinks() {
  return [
    { label: "English Indices of Deprivation (collection)", url: "https://www.gov.uk/government/collections/english-indices-of-deprivation" },
    { label: "English indices of deprivation 2019", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019" },
    { label: "English indices of deprivation 2025", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
    { label: "ONS Open Geography portal (ONS Postcode Directory)", url: "https://geoportal.statistics.gov.uk/" },
    { label: "postcodes.io (returns the LSOA code for a postcode)", url: "https://postcodes.io/" },
  ];
}

function noEditionResult(def: IntegrationDefinition, ctx: OperationContext): OperationResult {
  return {
    summary: `No Indices of Deprivation file loaded. Run the download operation or save File 7 as ${expectedPath(ctx.env, ID, imdFileName(2019))} (or imd2025-file7.csv).`,
    columns: IMD_COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "iod-file7", basis: "unavailable" }),
    links: publicationLinks(),
  };
}

const WARN_AREA = "Deprivation is a property of the small area (LSOA, roughly 1,500 residents), not of a site, its occupier or its workforce. Use it for community context, never as a statement about an individual building or company.";
const WARN_NATIONS = "The English indices cover England only. Scotland (SIMD), Wales (WIMD) and Northern Ireland (NIMDM) publish separate indices whose ranks and deciles are not comparable with the English IMD; a Scottish, Welsh or NI LSOA/Data Zone will not be found here.";
const WARN_EDITIONS = "IoD2019 uses 2011 LSOA boundaries and IoD2025 uses 2021 boundaries; ranks are relative within an edition (1 = most deprived of 32,844 or 33,755 LSOAs) and should not be compared across editions as a time series.";

function describe(row: ImdRow): string {
  return `${row.lsoa_name || row.lsoa_code} (${row.lad_name || row.lad_code}): IMD ${row.edition} decile ${row.imd_decile ?? "n/a"} (rank ${row.imd_rank ?? "n/a"}, score ${row.imd_score ?? "n/a"}); domain deciles income ${row.income_decile ?? "n/a"}, employment ${row.employment_decile ?? "n/a"}, education ${row.education_decile ?? "n/a"}, health ${row.health_decile ?? "n/a"}, crime ${row.crime_decile ?? "n/a"}, housing/services ${row.housing_decile ?? "n/a"}, living environment ${row.environment_decile ?? "n/a"}.`;
}

function lsoaRows(editions: ImdIndex[], codes: { code: string; geography?: number }[]): ImdRow[] {
  const rows: ImdRow[] = [];
  for (const e of editions) {
    const candidates = codes.filter((c) => c.geography === undefined || c.geography === e.geography);
    for (const c of candidates) {
      const row = e.byLsoa.get(c.code.toUpperCase());
      if (row) {
        rows.push(row);
        break;
      }
    }
  }
  return rows;
}

export const definition = defineIntegration({
  id: ID,
  name: "English Indices of Deprivation and ONS Postcode Directory",
  group: "company",
  access: "download",
  territory: "England (IMD); UK (ONSPD)",
  description: "LSOA-level deprivation ranks, deciles and scores from the English Indices of Deprivation (2019 and 2025 editions) for community context, with an optional ONS Postcode Directory file for postcode-to-LSOA lookups. Loaded from CSVs saved locally.",
  docsUrl: "https://www.gov.uk/government/collections/english-indices-of-deprivation",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Ministry of Housing, Communities and Local Government, English Indices of Deprivation. ONSPD: Contains OS data © Crown copyright and database right; contains Royal Mail data © Royal Mail copyright and database right; contains National Statistics data © Crown copyright and database right.",
  licence: "OGL",
  envVars: [
    { name: "REFERENCE_DATA_DIR", required: false, description: `Directory holding reference files (default data/reference). IMD File 7 is read from <dir>/${ID}/imd<edition>-file7.csv; an optional ONSPD CSV (full UK file or per-area split files) from <dir>/${ID}/onspd*.csv.` },
    { name: "IMD_FILE7_URL", required: false, description: "Overrides the built-in File 7 download URL for the download operation (copy the CSV link from the gov.uk edition page)." },
  ],
  status: "built_unverified",
  notes: [
    "Supply the IMD file: from the gov.uk 'English indices of deprivation 2019' (or 2025) page download 'File 7: all ranks, deciles and scores for the indices of deprivation, and population denominators' (CSV) and save it as data/reference/ons-geography-imd/imd2019-file7.csv or imd2025-file7.csv, or run the download operation. The 2019 URL was seen directly in search results; the 2025 URL is inferred from the gov.uk preview link. Neither has been fetched from this codebase.",
    "Column names (LSOA code (2011|2021), Index of Multiple Deprivation (IMD) Score / Rank (where 1 is most deprived) / Decile (where 1 is most deprived 10% of LSOAs), and the same Score/Rank/Decile triplets for Income, Employment, Education Skills and Training, Health Deprivation and Disability, Crime, Barriers to Housing and Services, Living Environment, IDACI and IDAOPI) are confirmed from open-source users of File 7. Columns are matched by normalised name prefix so both editions load.",
    "Postcode lookups need the ONS Postcode Directory: download the ONSPD from the ONS Open Geography portal (about 1.3 GB unzipped; the ZIP also holds per-postcode-area 'multi_csv' files) and save the CSV(s) as data/reference/ons-geography-imd/onspd*.csv (keep the _AB.csv area suffix on split files so only the right file is scanned). Without it, the postcode operation tells you to take the LSOA code from postcodes.io (the portal's postcodes-io connector returns codes.lsoa) and use the LSOA operation. The ONSPD is streamed, not loaded into memory. It is OGL but carries Royal Mail and OS attribution requirements.",
    WARN_AREA,
    WARN_NATIONS,
    WARN_EDITIONS,
  ],
  healthCheck: referenceHealth(ID, IMD_PATTERN, "imd2019-file7.csv or imd2025-file7.csv"),
  operations: [
    {
      id: "lsoa",
      label: "Deprivation for an LSOA",
      description: "IMD score, rank and decile plus every domain decile for a Lower-layer Super Output Area code, in each loaded edition.",
      params: [{ name: "lsoa", label: "LSOA code", type: "string", required: true, placeholder: "E01000001", help: "2011 code for IoD2019, 2021 code for IoD2025 (postcodes.io returns both; see codes.lsoa)." }],
      async run(params, ctx) {
        const editions = loadEditions(ctx.env);
        if (editions.length === 0) return noEditionResult(definition, ctx);
        const code = String(params.lsoa).trim().toUpperCase();
        const rows = lsoaRows(editions, [{ code }]);
        const warnings = [WARN_AREA, WARN_EDITIONS];
        if (/^[SWN9]/.test(code)) warnings.push(WARN_NATIONS);
        return {
          summary: rows.length === 0 ? `LSOA ${code} is not in the loaded edition(s) ${editions.map((e) => e.edition).join(", ")}${/^[SWN9]/.test(code) ? " (it is not an English LSOA)" : " (check the code matches the edition's geography year)"}.` : rows.map(describe).join(" "),
          columns: IMD_COLUMNS,
          rows,
          raw: rows,
          provenance: makeProvenance(definition, ctx, { dataset: "iod-file7", basis: rows.length ? "measured" : "unavailable", version: editions.map((e) => fileVersion(e.file, `IoD${e.edition}`)).join(" | ") }),
          warnings,
          links: publicationLinks().slice(0, 1),
        };
      },
    },
    {
      id: "postcode",
      label: "Deprivation for a postcode",
      description: "Looks the postcode up in the ONSPD file (if present) to find its LSOA, then returns the deprivation rows. Without an ONSPD file, tells you how to get the LSOA from postcodes.io.",
      params: [{ name: "postcode", label: "Postcode", type: "postcode", required: true, placeholder: "SW1A 1AA" }],
      async run(params, ctx) {
        const editions = loadEditions(ctx.env);
        if (editions.length === 0) return noEditionResult(definition, ctx);
        const found = await lookupPostcode(ctx.env, String(params.postcode), ctx.signal);
        if (found.filesPresent === 0) {
          return {
            summary: `No ONS Postcode Directory file is loaded, so ${params.postcode} cannot be mapped to an LSOA here. Use the postcodes-io connector (lookup returns codes.lsoa, the 2021 LSOA code, and lsoa the name) and run the 'Deprivation for an LSOA' operation with that code, or save the ONSPD CSV as ${expectedPath(ctx.env, ID, "onspd-<release>.csv")}.`,
            columns: IMD_COLUMNS,
            rows: [],
            provenance: makeProvenance(definition, ctx, { dataset: "onspd", basis: "unavailable" }),
            links: publicationLinks().slice(3),
            warnings: ["postcodes.io serves the current ONSPD lsoa code (2021 geography); the IoD2019 file uses 2011 codes, which postcodes.io does not return, so 2019 lookups by postcode need the ONSPD file."],
          };
        }
        const geo = found.geo;
        if (!geo) {
          return {
            summary: `${params.postcode} was not found in ${found.filesScanned.join(", ") || "the loaded ONSPD file(s)"} (${found.filesPresent} present).`,
            columns: IMD_COLUMNS,
            rows: [],
            raw: found,
            provenance: makeProvenance(definition, ctx, { dataset: "onspd", basis: "unavailable" }),
          };
        }
        const codes = [
          { code: geo.lsoa21, geography: 2021 },
          { code: geo.lsoa11, geography: 2011 },
        ].filter((c) => c.code);
        const rows = lsoaRows(editions, codes);
        const warnings = [WARN_AREA, WARN_EDITIONS];
        if (geo.country && geo.country !== "England") warnings.push(`${params.postcode} is in ${geo.country}. ${WARN_NATIONS}`);
        if (geo.terminated) warnings.push(`Postcode terminated ${geo.terminated} (yyyymm) according to the ONSPD.`);
        const geoRow = { edition: "ONSPD", lsoa_code: geo.lsoa21 || geo.lsoa11, lsoa_name: `LSOA 2011 ${geo.lsoa11 || "n/a"}; LSOA 2021 ${geo.lsoa21 || "n/a"}; MSOA 2021 ${geo.msoa21 || "n/a"}`, lad_code: geo.local_authority, lad_name: `${geo.country}${geo.region ? ` / ${geo.region}` : ""}`, file: geo.file };
        return {
          summary: rows.length === 0 ? `${params.postcode} maps to LSOA ${geo.lsoa21 || geo.lsoa11} (${geo.country}), which is not in the loaded edition(s) ${editions.map((e) => e.edition).join(", ")}.` : `${params.postcode} is in ${rows.map(describe).join(" ")}`,
          columns: IMD_COLUMNS,
          rows: [...rows, geoRow],
          raw: { postcode: geo, deprivation: rows },
          provenance: makeProvenance(definition, ctx, { dataset: "iod-file7+onspd", basis: rows.length ? "measured" : "unavailable", version: [...editions.map((e) => fileVersion(e.file, `IoD${e.edition}`)), ...(found.file ? [fileVersion(found.file, "ONSPD")] : [])].join(" | ") }),
          warnings,
          links: publicationLinks().slice(0, 1),
        };
      },
    },
    {
      id: "download",
      label: "Download an IMD edition",
      description: "Downloads File 7 for the 2019 or 2025 edition into the reference directory (built-in URL, IMD_FILE7_URL, or the url parameter).",
      params: [
        { name: "edition", label: "Edition", type: "select", required: true, options: [{ value: "2019", label: "IoD2019 (2011 LSOAs)" }, { value: "2025", label: "IoD2025 (2021 LSOAs)" }] },
        { name: "url", label: "CSV URL (optional override)", type: "string", placeholder: IMD_URLS[2019].url },
      ],
      async run(params, ctx) {
        const edition = Number(params.edition);
        const known = IMD_URLS[edition];
        const url = (params.url as string | undefined)?.trim() || ctx.env.IMD_FILE7_URL?.trim() || known?.url;
        if (!url) throw new Error(`No download URL for edition ${edition}.`);
        const text = await downloadText(ctx, url, 180_000);
        if (!/lsoa code/i.test(text.slice(0, 5000)) || !/index of multiple deprivation/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like IoD File 7 (no 'LSOA code' / 'Index of Multiple Deprivation' header).`);
        const file = writeCache(ctx.env, ID, imdFileName(edition), text);
        const idx = loadReferenceFile(file, (t) => parseImd(t, edition, file));
        return {
          summary: `Downloaded IoD${edition} File 7 (${idx.lsoaCount} LSOAs, ${idx.geography} geography) to ${file.path}.`,
          columns: ["edition", "lsoas", "geography", "path", "url", "url_confidence"],
          rows: [{ edition, lsoas: idx.lsoaCount, geography: idx.geography, path: file.path, url, url_confidence: params.url || ctx.env.IMD_FILE7_URL ? "override" : (known?.confidence ?? "") }],
          raw: { url, path: file.path, header: idx.header },
          provenance: makeProvenance(definition, ctx, { dataset: "iod-file7", basis: "measured", version: fileVersion(file, `IoD${edition}`) }),
        };
      },
    },
    {
      id: "files",
      label: "Loaded files",
      description: "Which IMD editions and ONSPD files are present.",
      params: [],
      async run(_params, ctx) {
        const editions = loadEditions(ctx.env);
        const onspd = listReferenceFiles(ctx.env, ID, ONSPD_PATTERN);
        const rows = [
          ...editions.map((e) => ({ file: e.file.name, kind: "imd", edition: e.edition, geography: e.geography, rows: e.lsoaCount, area: "", modified_at: e.file.modifiedAt, size_mb: Math.round((e.file.sizeBytes / 1_048_576) * 10) / 10, error: "" })),
          ...onspd.map((f) => {
            try {
              const idx = onspdIndex(f);
              return { file: f.name, kind: "onspd", edition: null, geography: null, rows: null, area: idx.area ?? "all", modified_at: f.modifiedAt, size_mb: Math.round((f.sizeBytes / 1_048_576) * 10) / 10, error: "" };
            } catch (e) {
              return { file: f.name, kind: "onspd", edition: null, geography: null, rows: null, area: "", modified_at: f.modifiedAt, size_mb: Math.round((f.sizeBytes / 1_048_576) * 10) / 10, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        ];
        return {
          summary: rows.length === 0 ? `No files in ${referenceDir(ctx.env, ID)}. Expected imd2019-file7.csv / imd2025-file7.csv and optionally onspd*.csv.` : `${editions.length} IMD edition(s) (${editions.map((e) => `${e.edition}: ${e.lsoaCount} LSOAs`).join(", ") || "none"}) and ${onspd.length} ONSPD file(s).`,
          columns: ["file", "kind", "edition", "geography", "rows", "area", "modified_at", "size_mb", "error"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "files", basis: rows.length ? "measured" : "unavailable" }),
          links: publicationLinks(),
        };
      },
    },
    {
      id: "links",
      label: "Publication pages",
      description: "gov.uk IMD pages, the ONS geography portal and postcodes.io, plus the built-in File 7 URLs.",
      params: [],
      async run(_params, ctx) {
        const links = publicationLinks();
        const rows = [...links.map((l) => ({ label: l.label, url: l.url, confidence: "" })), ...Object.entries(IMD_URLS).map(([ed, k]) => ({ label: `IoD${ed} File 7 CSV`, url: k.url, confidence: k.confidence }))];
        return {
          summary: "Save File 7 of the English Indices of Deprivation as imd<edition>-file7.csv (or use the download operation); add an ONSPD CSV for postcode lookups, or take the LSOA code from postcodes.io.",
          columns: ["label", "url", "confidence"],
          rows,
          links,
          provenance: makeProvenance(definition, ctx, { dataset: "publications", basis: "not_applicable" }),
        };
      },
    },
  ],
});
