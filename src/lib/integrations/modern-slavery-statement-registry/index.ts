import { defineIntegration, makeProvenance, type EnvLike, type HealthResult } from "../framework";
import { csvToRecords } from "../_shared/csv";
import { listReferenceFiles, type ReferenceFile } from "../_shared/reference-data";
import { downloadText, expectedPath, loadCached, writeCache } from "./download-cache";

/**
 * GOV.UK Modern slavery statement registry (Home Office): annual CSVs of
 * statement summaries, downloaded from the registry's public downloads host.
 *
 * Built from open-source consumers of the CSV (URL pattern and column names);
 * no live download has been made from this codebase.
 */

export const ID = "modern-slavery-statement-registry";
export const DOWNLOAD_BASE = "https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads";

export function yearUrl(year: number): string {
  return `${DOWNLOAD_BASE}/StatementSummaries${year}.csv`;
}
export function fileName(year: number): string {
  return `StatementSummaries${year}.csv`;
}

export interface Statement {
  organisation: string;
  company_number: string;
  statement_year: string;
  period_start: string;
  period_end: string;
  turnover_band: string;
  sector_type: string;
  sectors: string;
  group_submission: string;
  statement_url: string;
  summary_url: string;
}

function col(rec: Record<string, string>, ...names: string[]): string {
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase());
    if (key !== undefined && rec[key]?.trim()) return rec[key].trim();
  }
  return "";
}

export function parseStatementsCsv(text: string): Statement[] {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => /organisationname/i.test(c)) });
  return table.records.map((r) => ({
    organisation: col(r, "OrganisationName"),
    company_number: col(r, "CompanyNumber").toUpperCase(),
    statement_year: col(r, "StatementYear"),
    period_start: col(r, "StatementStartDate"),
    period_end: col(r, "StatementEndDate"),
    turnover_band: col(r, "Turnover", "TurnoverBand"),
    sector_type: col(r, "SectorType"),
    sectors: [col(r, "OrganisationSectors", "Sectors"), col(r, "OtherOrganisationSector")].filter(Boolean).join("; "),
    group_submission: col(r, "GroupSubmission"),
    statement_url: col(r, "StatementURL", "StatementUrl"),
    summary_url: col(r, "StatementSummaryURL", "StatementSummaryUrl"),
  }));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normaliseCompanyNumber(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

export function findStatements(records: Statement[], query: string): Statement[] {
  const q = query.trim();
  if (!q) return [];
  if (/^[A-Z]{0,2}\d{1,8}$/i.test(q.replace(/\s+/g, ""))) {
    const n = normaliseCompanyNumber(q);
    const hits = records.filter((r) => r.company_number && normaliseCompanyNumber(r.company_number) === n);
    if (hits.length) return hits;
  }
  const nq = norm(q);
  return records.filter((r) => norm(r.organisation).includes(nq));
}

export function loadedYears(env: EnvLike): { year: number; file: ReferenceFile }[] {
  return listReferenceFiles(env, ID, /^StatementSummaries\d{4}\.csv$/).map((file) => ({ year: Number(file.name.replace(/\D/g, "")), file }));
}

const COLUMNS = ["organisation", "company_number", "statement_year", "period_start", "period_end", "turnover_band", "sector_type", "sectors", "group_submission", "statement_url", "summary_url"];

export const definition = defineIntegration({
  id: ID,
  name: "Modern slavery statement registry",
  group: "company",
  access: "download",
  territory: "UK",
  description: "Registry of modern slavery statements published under section 54 of the Modern Slavery Act 2015: organisation, statement period, turnover band, sectors and statement URL, one CSV per statement year.",
  docsUrl: "https://modern-slavery-statement-registry.service.gov.uk/viewing/download",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Home Office, Modern slavery statement registry.",
  licence: "OGL",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: `Directory for cached files (default data/reference). Year files are stored as <dir>/${ID}/StatementSummaries<year>.csv and may also be placed there by hand.` }],
  status: "built_unverified",
  notes: [
    `Download URL pattern ${yearUrl(2025)} and the column names (OrganisationName, CompanyNumber, StatementYear, StatementStartDate, StatementEndDate, Turnover, SectorType, OrganisationSectors, GroupSubmission, StatementURL) come from open-source consumers of the registry; not fetched from this codebase.`,
    "Presence on the registry shows a statement was published, not that it is adequate or that the organisation's supply chain is free of forced labour. Absence is not proof of non-compliance: publication on the registry is voluntary and the duty applies only to organisations with turnover of GBP 36m or more.",
    "Statement content is not in the CSV; open the statement URL to read it.",
  ],
  async healthCheck(): Promise<HealthResult> {
    return { ok: true, detail: "Download-and-parse connector; use the reload operation to fetch a year." };
  },
  operations: [
    {
      id: "reload",
      label: "Download a statement year",
      description: "Downloads the statement summaries CSV for one year into the reference directory.",
      params: [{ name: "year", label: "Statement year", type: "integer", required: true, min: 2019, max: 2100, placeholder: "2025" }],
      async run(params, ctx) {
        const year = params.year as number;
        const url = yearUrl(year);
        const text = await downloadText(ctx, url);
        if (!/organisationname/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like a statement summaries CSV (no OrganisationName header).`);
        const file = writeCache(ctx.env, ID, fileName(year), text);
        const records = loadCached(file, parseStatementsCsv);
        return {
          summary: `Downloaded ${records.length} statement summaries for ${year} to ${file.path}.`,
          columns: ["year", "statements", "path"],
          rows: [{ year, statements: records.length, path: file.path }],
          raw: { url, path: file.path, sizeBytes: file.sizeBytes },
          provenance: makeProvenance(definition, ctx, { dataset: fileName(year), basis: "measured", version: `file modified ${file.modifiedAt}` }),
        };
      },
    },
    {
      id: "search",
      label: "Search statements by organisation or company number",
      description: "Finds published statements across every downloaded year (or one year).",
      params: [
        { name: "query", label: "Organisation name or company number", type: "string", required: true, placeholder: "Example Facilities" },
        { name: "year", label: "Statement year (optional)", type: "integer", min: 2019, max: 2100, help: "Leave blank to search every downloaded year." },
      ],
      async run(params, ctx) {
        const years = loadedYears(ctx.env).filter((y) => !params.year || y.year === params.year);
        if (years.length === 0) throw new Error(`No statement files loaded${params.year ? ` for ${params.year}` : ""}. Run the reload operation (files go in ${expectedPath(ctx.env, ID, "StatementSummaries<year>.csv")}).`);
        const rows: Statement[] = [];
        for (const { file } of years) rows.push(...findStatements(loadCached(file, parseStatementsCsv), String(params.query)).slice(0, 50));
        rows.sort((a, b) => b.statement_year.localeCompare(a.statement_year));
        const capped = rows.slice(0, 100);
        return {
          summary: capped.length
            ? `${capped.length} statement(s) on the registry for "${params.query}" across ${years.length} year file(s); latest ${capped[0].statement_year} (${capped[0].organisation}, turnover band ${capped[0].turnover_band || "not stated"}).`
            : `No statement for "${params.query}" in the loaded year file(s) (${years.map((y) => y.year).join(", ")}). Publication is voluntary; absence is not proof of non-compliance.`,
          columns: COLUMNS,
          rows: capped,
          raw: capped,
          provenance: makeProvenance(definition, ctx, { dataset: "statement-summaries", basis: capped.length ? "client_declared" : "unavailable", version: `years ${years.map((y) => y.year).join(", ")}` }),
          warnings: ["A published statement is evidence of reporting, not of performance; read the statement itself for due-diligence content."],
        };
      },
    },
  ],
});
