import { defineIntegration, makeProvenance, type EnvLike, type HealthResult } from "../framework";
import { csvToRecords, parseNumericCell } from "../_shared/csv";
import { listReferenceFiles, type ReferenceFile } from "../_shared/reference-data";
import { cachedFile, downloadText, expectedPath, loadCached, writeCache } from "./download-cache";

/**
 * Gender pay gap service (Government Equalities Office / Office for Equality
 * and Opportunity): one CSV per reporting year.
 *
 * Built from the service's download page and the column list documented
 * there; no live download has been made from this codebase.
 */

export const ID = "gender-pay-gap";
export const BASE = "https://gender-pay-gap.service.gov.uk";

export function yearUrl(year: number): string {
  return `${BASE}/viewing/download-data/${year}`;
}

export function fileName(year: number): string {
  return `${year}.csv`;
}

export type GpgRecord = {
  employer_name: string;
  current_name: string;
  employer_id: string;
  company_number: string;
  postcode: string;
  sic_codes: string;
  employer_size: string;
  mean_hourly_gap_pct: number | null;
  median_hourly_gap_pct: number | null;
  mean_bonus_gap_pct: number | null;
  median_bonus_gap_pct: number | null;
  male_bonus_pct: number | null;
  female_bonus_pct: number | null;
  female_lower_quartile_pct: number | null;
  female_lower_middle_quartile_pct: number | null;
  female_upper_middle_quartile_pct: number | null;
  female_top_quartile_pct: number | null;
  date_submitted: string;
  submitted_after_deadline: boolean | null;
  link: string;
};

function bool(v: string | undefined): boolean | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" ? true : s === "false" || s === "no" || s === "0" ? false : null;
}

export function parseGpgCsv(text: string): GpgRecord[] {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => /^EmployerName$/i.test(c)) });
  return table.records.map((r) => ({
    employer_name: r.EmployerName ?? "",
    current_name: r.CurrentName ?? "",
    employer_id: r.EmployerId ?? "",
    company_number: (r.CompanyNumber ?? "").trim().toUpperCase(),
    postcode: r.PostCode ?? "",
    sic_codes: r.SicCodes ?? "",
    employer_size: r.EmployerSize ?? "",
    mean_hourly_gap_pct: parseNumericCell(r.DiffMeanHourlyPercent),
    median_hourly_gap_pct: parseNumericCell(r.DiffMedianHourlyPercent),
    mean_bonus_gap_pct: parseNumericCell(r.DiffMeanBonusPercent),
    median_bonus_gap_pct: parseNumericCell(r.DiffMedianBonusPercent),
    male_bonus_pct: parseNumericCell(r.MaleBonusPercent),
    female_bonus_pct: parseNumericCell(r.FemaleBonusPercent),
    female_lower_quartile_pct: parseNumericCell(r.FemaleLowerQuartile),
    female_lower_middle_quartile_pct: parseNumericCell(r.FemaleLowerMiddleQuartile),
    female_upper_middle_quartile_pct: parseNumericCell(r.FemaleUpperMiddleQuartile),
    female_top_quartile_pct: parseNumericCell(r.FemaleTopQuartile),
    date_submitted: r.DateSubmitted ?? "",
    submitted_after_deadline: bool(r.SubmittedAfterTheDeadline),
    link: r.CompanyLinkToGPGInfo ?? "",
  }));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normaliseCompanyNumber(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

/** Match by company number (exact) or by name substring on the reported or current name. */
export function findEmployers(records: GpgRecord[], query: string): GpgRecord[] {
  const q = query.trim();
  if (!q) return [];
  if (/^[A-Z]{0,2}\d{1,8}$/i.test(q.replace(/\s+/g, ""))) {
    const number = normaliseCompanyNumber(q);
    const byNumber = records.filter((r) => normaliseCompanyNumber(r.company_number) === number);
    if (byNumber.length) return byNumber;
  }
  const nq = norm(q);
  return records.filter((r) => norm(r.employer_name).includes(nq) || norm(r.current_name).includes(nq));
}

export function loadedYears(env: EnvLike): { year: number; file: ReferenceFile }[] {
  return listReferenceFiles(env, ID, /^\d{4}\.csv$/).map((file) => ({ year: Number(file.name.slice(0, 4)), file }));
}

const COLUMNS = ["reporting_year", "employer_name", "company_number", "employer_size", "mean_hourly_gap_pct", "median_hourly_gap_pct", "mean_bonus_gap_pct", "median_bonus_gap_pct", "male_bonus_pct", "female_bonus_pct", "female_lower_quartile_pct", "female_lower_middle_quartile_pct", "female_upper_middle_quartile_pct", "female_top_quartile_pct", "date_submitted", "submitted_after_deadline", "postcode", "sic_codes", "link"];

function toRow(year: number, r: GpgRecord) {
  return { reporting_year: `${year}/${String(year + 1).slice(2)}`, ...r };
}

const YEAR_PARAM = { name: "year", label: "Reporting year (start year)", type: "integer" as const, required: true, min: 2017, max: 2100, placeholder: "2024", help: "Start year of the reporting year, e.g. 2024 for 2024/25 (snapshot date 5 April 2024 for private employers)." };

export const definition = defineIntegration({
  id: ID,
  name: "Gender pay gap service",
  group: "company",
  access: "download",
  territory: "UK",
  description: "Statutory gender pay gap reports from employers with 250 or more employees: mean and median hourly and bonus gaps, bonus proportions and pay quartiles, one CSV per reporting year.",
  docsUrl: "https://gender-pay-gap.service.gov.uk/viewing/download",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Gender pay gap service, Office for Equality and Opportunity.",
  licence: "OGL",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: `Directory for cached files (default data/reference). Year files are stored as <dir>/${ID}/<year>.csv and may also be placed there by hand.` }],
  status: "built_unverified",
  notes: [
    `Download URL pattern ${yearUrl(2024)} (year = start of the reporting year) is taken from the service's download page; it has not been fetched from this codebase.`,
    "Employers with fewer than 250 employees are not required to report, so absence from the file is not evidence of anything.",
    "Figures are employer self-reported; the service does not audit them. Positive gap values mean men are paid more on the measure.",
    "Employer names are as filed (from Companies House for private employers); CurrentName reflects later renames.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    const years = loadedYears(ctx.env);
    if (years.length === 0) return { ok: false, detail: `No year files at ${expectedPath(ctx.env, ID, "<year>.csv")}. Run the reload operation.`, latencyMs: Date.now() - started };
    return { ok: true, detail: `Years loaded: ${years.map((y) => y.year).join(", ")}`, latencyMs: Date.now() - started };
  },
  operations: [
    {
      id: "reload",
      label: "Download a reporting year",
      description: "Downloads the CSV for one reporting year into the reference directory.",
      params: [YEAR_PARAM],
      async run(params, ctx) {
        const year = params.year as number;
        const url = yearUrl(year);
        const text = await downloadText(ctx, url);
        if (!/EmployerName/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like a gender pay gap CSV (no EmployerName header).`);
        const file = writeCache(ctx.env, ID, fileName(year), text);
        const records = loadCached(file, parseGpgCsv);
        return {
          summary: `Downloaded ${records.length} employer reports for ${year}/${String(year + 1).slice(2)} to ${file.path}.`,
          columns: ["year", "reports", "path"],
          rows: [{ year, reports: records.length, path: file.path }],
          raw: { url, path: file.path, sizeBytes: file.sizeBytes },
          provenance: makeProvenance(definition, ctx, { dataset: `download-data/${year}`, basis: "measured", version: `file modified ${file.modifiedAt}` }),
        };
      },
    },
    {
      id: "lookup",
      label: "Look up an employer for a year",
      description: "Finds an employer by name or company number in one reporting year's file.",
      params: [YEAR_PARAM, { name: "query", label: "Employer name or company number", type: "string", required: true, placeholder: "Focus Green" }],
      async run(params, ctx) {
        const year = params.year as number;
        const file = cachedFile(ctx.env, ID, fileName(year));
        if (!file) throw new Error(`No file for ${year}. Run the reload operation or place ${fileName(year)} at ${expectedPath(ctx.env, ID, fileName(year))}.`);
        const records = loadCached(file, parseGpgCsv);
        const hits = findEmployers(records, String(params.query)).slice(0, 100);
        const rows = hits.map((r) => toRow(year, r));
        const first = hits[0];
        return {
          summary: hits.length
            ? `${hits.length} employer(s) match "${params.query}" for ${year}/${String(year + 1).slice(2)}. ${first.employer_name}: median hourly gap ${first.median_hourly_gap_pct ?? "n/a"}%, mean ${first.mean_hourly_gap_pct ?? "n/a"}% (${first.employer_size || "size not stated"}).`
            : `No employer matching "${params.query}" in the ${year}/${String(year + 1).slice(2)} file (${records.length} reports). Employers under 250 staff need not report.`,
          columns: COLUMNS,
          rows,
          raw: hits,
          provenance: makeProvenance(definition, ctx, { dataset: `download-data/${year}`, basis: hits.length ? "client_declared" : "unavailable", version: `file ${file.name}; modified ${file.modifiedAt}` }),
          warnings: ["Figures are self-reported by the employer under the Equality Act 2010 regulations and are not audited by the service."],
        };
      },
    },
    {
      id: "compare",
      label: "Compare an employer across years",
      description: "The same employer's gaps in every reporting year that has been downloaded.",
      params: [{ name: "query", label: "Employer name or company number", type: "string", required: true, placeholder: "12345678" }],
      async run(params, ctx) {
        const years = loadedYears(ctx.env);
        if (years.length === 0) throw new Error(`No year files loaded. Run the reload operation for each year you need (files go in ${expectedPath(ctx.env, ID, "<year>.csv")}).`);
        const rows: ReturnType<typeof toRow>[] = [];
        for (const { year, file } of years) {
          const records = loadCached(file, parseGpgCsv);
          for (const r of findEmployers(records, String(params.query)).slice(0, 20)) rows.push(toRow(year, r));
        }
        const medians = rows.map((r) => r.median_hourly_gap_pct).filter((v): v is number => v !== null);
        const trend = medians.length >= 2 ? ` Median hourly gap moved from ${medians[0]}% to ${medians[medians.length - 1]}% over ${medians.length} reports.` : "";
        return {
          summary: rows.length ? `${rows.length} report(s) for "${params.query}" across ${years.length} loaded year(s).${trend}` : `No reports for "${params.query}" in the ${years.length} loaded year(s) (${years.map((y) => y.year).join(", ")}).`,
          columns: COLUMNS,
          rows,
          raw: rows,
          provenance: makeProvenance(definition, ctx, { dataset: "download-data", basis: rows.length ? "client_declared" : "unavailable", version: `years ${years.map((y) => y.year).join(", ")}` }),
          warnings: ["Employer names and IDs can change between years; check that the rows refer to the same legal entity (company number where present)."],
        };
      },
    },
  ],
});
