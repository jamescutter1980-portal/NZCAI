import { defineIntegration, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";
import { csvToRecords, parseNumericCell } from "../_shared/csv";
import { cachedFile, downloadText, expectedPath, loadCached, writeCache } from "./download-cache";

/**
 * Payment practices reporting (Department for Business and Trade):
 * "Check when large businesses pay their suppliers". The service publishes a
 * full CSV export of every statutory report.
 *
 * Built from the service's export page and open-source scripts that parse
 * the export (column names); no live download has been made from this
 * codebase. The export is large (tens of MB); parsing happens once per file
 * version and is cached in memory.
 */

export const ID = "payment-practices-reporting";
export const FILE_NAME = "payment-practices.csv";
/** "Get CSV file" link on the export page; override with PAYMENT_PRACTICES_CSV_URL if it changes. */
export const DEFAULT_URL = "https://check-payment-practices.service.gov.uk/export/csv/";

export function exportUrl(env: EnvLike): string {
  return env.PAYMENT_PRACTICES_CSV_URL?.trim() || DEFAULT_URL;
}

export interface PaymentReport {
  company: string;
  company_number: string;
  period_start: string;
  period_end: string;
  filing_date: string;
  average_days_to_pay: number | null;
  pct_paid_within_30_days: number | null;
  pct_paid_31_to_60_days: number | null;
  pct_paid_over_60_days: number | null;
  pct_not_paid_within_agreed_terms: number | null;
  shortest_standard_terms_days: number | null;
  longest_standard_terms_days: number | null;
  e_invoicing_offered: boolean | null;
  report_url: string;
}

function col(rec: Record<string, string>, ...names: string[]): string {
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase().replace(/[^a-z0-9%]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[^a-z0-9%]/g, ""));
    if (key !== undefined && rec[key]?.trim()) return rec[key].trim();
  }
  return "";
}
function bool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  return s === "true" || s === "yes" ? true : s === "false" || s === "no" ? false : null;
}

export function parsePaymentCsv(text: string): PaymentReport[] {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => /company number/i.test(c)) });
  return table.records.map((r) => ({
    company: col(r, "Company", "Company name"),
    company_number: col(r, "Company number").toUpperCase(),
    period_start: col(r, "Start date"),
    period_end: col(r, "End date"),
    filing_date: col(r, "Filing date"),
    average_days_to_pay: parseNumericCell(col(r, "Average time to pay", "Average number of days to pay")),
    pct_paid_within_30_days: parseNumericCell(col(r, "% Invoices paid within 30 days")),
    pct_paid_31_to_60_days: parseNumericCell(col(r, "% Invoices paid between 31 and 60 days")),
    pct_paid_over_60_days: parseNumericCell(col(r, "% Invoices paid later than 60 days")),
    pct_not_paid_within_agreed_terms: parseNumericCell(col(r, "% Invoices not paid within agreed terms")),
    shortest_standard_terms_days: parseNumericCell(col(r, "Shortest (or only) standard payment period")),
    longest_standard_terms_days: parseNumericCell(col(r, "Longest standard payment period")),
    e_invoicing_offered: bool(col(r, "E-Invoicing offered")),
    report_url: col(r, "URL", "Report URL"),
  }));
}

/** Sort key for dd/mm/yyyy or ISO dates. */
export function sortableDate(v: string): string {
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return v.trim();
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normaliseCompanyNumber(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

export function findReports(records: PaymentReport[], query: string): PaymentReport[] {
  const q = query.trim();
  if (!q) return [];
  let hits: PaymentReport[] = [];
  if (/^[A-Z]{0,2}\d{1,8}$/i.test(q.replace(/\s+/g, ""))) {
    const n = normaliseCompanyNumber(q);
    hits = records.filter((r) => normaliseCompanyNumber(r.company_number) === n);
  }
  if (hits.length === 0) {
    const nq = norm(q);
    hits = records.filter((r) => norm(r.company).includes(nq));
  }
  return hits.sort((a, b) => sortableDate(b.period_end).localeCompare(sortableDate(a.period_end)));
}

function load(ctx: OperationContext) {
  const file = cachedFile(ctx.env, ID, FILE_NAME);
  if (!file) return null;
  return { file, records: loadCached(file, parsePaymentCsv) };
}

const COLUMNS = ["company", "company_number", "period_start", "period_end", "filing_date", "average_days_to_pay", "pct_paid_within_30_days", "pct_paid_31_to_60_days", "pct_paid_over_60_days", "pct_not_paid_within_agreed_terms", "shortest_standard_terms_days", "longest_standard_terms_days", "e_invoicing_offered", "report_url"];

export const definition = defineIntegration({
  id: ID,
  name: "Payment practices reporting (DBT)",
  group: "company",
  access: "download",
  territory: "UK",
  description: "Statutory half-yearly reports from large UK companies on how quickly they pay suppliers: average days to pay, share paid within 30 / 31-60 / over 60 days and share not paid within agreed terms.",
  docsUrl: "https://check-payment-practices.service.gov.uk/export/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Department for Business and Trade, payment practices and performance reports.",
  licence: "OGL",
  envVars: [
    { name: "PAYMENT_PRACTICES_CSV_URL", required: false, description: `Full-export CSV URL. Defaults to ${DEFAULT_URL}.` },
    { name: "REFERENCE_DATA_DIR", required: false, description: `Directory for the cached export (default data/reference). Place a downloaded export at <dir>/${ID}/${FILE_NAME} to skip the download.` },
  ],
  status: "built_unverified",
  notes: [
    `The export URL (${DEFAULT_URL}) and column names (Company, Company number, Start date, End date, Filing date, Average time to pay, % Invoices paid within 30 days, ... , % Invoices not paid within agreed terms, Shortest (or only) standard payment period, Longest standard payment period, E-Invoicing offered) come from the service's export page and open-source parsers; neither has been fetched from this codebase. If the link changes, download the CSV by hand from the export page and place it in the reference directory.`,
    "Only companies over two of: GBP 36m turnover, GBP 18m balance sheet, 250 employees must report, so absence says nothing about smaller suppliers.",
    "Figures are self-reported by the company and not audited. From reporting periods starting January 2025 the value of late invoices is also reported; from financial years starting January 2026 headline figures also appear in directors' reports.",
    "The full export is around 100 MB; the first search after a reload parses it once and caches the result in memory.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    const loaded = load(ctx);
    if (!loaded) return { ok: false, detail: `No ${FILE_NAME} at ${expectedPath(ctx.env, ID, FILE_NAME)}. Run the reload operation or place the export there.`, latencyMs: Date.now() - started };
    return { ok: true, detail: `${loaded.records.length} reports; file modified ${loaded.file.modifiedAt}`, latencyMs: Date.now() - started };
  },
  operations: [
    {
      id: "reload",
      label: "Download the full export",
      description: "Downloads the complete payment practices CSV export into the reference directory.",
      params: [],
      async run(_params, ctx) {
        const url = exportUrl(ctx.env);
        const text = await downloadText(ctx, url, 300_000);
        if (!/company number/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like the payment practices export (no "Company number" header). Download it by hand from ${definition.docsUrl} and place it at ${expectedPath(ctx.env, ID, FILE_NAME)}.`);
        const file = writeCache(ctx.env, ID, FILE_NAME, text);
        const records = loadCached(file, parsePaymentCsv);
        const companies = new Set(records.map((r) => r.company_number || r.company)).size;
        return {
          summary: `Downloaded ${records.length} reports from ${companies} companies to ${file.path}.`,
          columns: ["reports", "companies", "path"],
          rows: [{ reports: records.length, companies, path: file.path }],
          raw: { url, path: file.path, sizeBytes: file.sizeBytes },
          provenance: makeProvenance(definition, ctx, { dataset: "export", basis: "measured", version: `file modified ${file.modifiedAt}` }),
        };
      },
    },
    {
      id: "search",
      label: "Payment performance for a company",
      description: "Every report filed by a company (by name or company number), latest period first.",
      params: [{ name: "query", label: "Company name or number", type: "string", required: true, placeholder: "Example Facilities" }],
      async run(params, ctx) {
        const loaded = load(ctx);
        if (!loaded) throw new Error(`Payment practices export not loaded. Run the reload operation or place ${FILE_NAME} at ${expectedPath(ctx.env, ID, FILE_NAME)}.`);
        const hits = findReports(loaded.records, String(params.query)).slice(0, 100);
        const latest = hits[0];
        return {
          summary: latest
            ? `${hits.length} report(s) for "${params.query}". Latest (${latest.period_start} to ${latest.period_end}): ${latest.company} paid in ${latest.average_days_to_pay ?? "n/a"} days on average, ${latest.pct_paid_within_30_days ?? "n/a"}% within 30 days, ${latest.pct_not_paid_within_agreed_terms ?? "n/a"}% not within agreed terms.`
            : `No payment practices report for "${params.query}" in the export (${loaded.records.length} reports). Only large companies must report.`,
          columns: COLUMNS,
          rows: hits,
          raw: hits,
          provenance: makeProvenance(definition, ctx, { dataset: "export", basis: hits.length ? "client_declared" : "unavailable", version: `file modified ${loaded.file.modifiedAt}` }),
          warnings: ["Self-reported statutory figures; not audited by the department."],
        };
      },
    },
  ],
});
