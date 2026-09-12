import { defineIntegration, makeProvenance, type HealthResult, type OperationContext } from "../framework";
import { missingColumns } from "../_shared/csv";
import { listReferenceFiles, loadReferenceCsv, referenceDir } from "../_shared/reference-data";
import path from "node:path";

/**
 * Science Based Targets initiative (SBTi) Target Dashboard.
 *
 * The dashboard offers an XLSX export and no public API, so this connector
 * is reference-only: it links to the dashboard and searches a CSV the user
 * saves from the export into the reference directory.
 */

export const ID = "sbti-targets";
export const FILE_NAME = "targets.csv";
export const DASHBOARD_URL = "https://sciencebasedtargets.org/target-dashboard";
export const REQUIRED_COLUMNS = ["company_name", "isin", "lei", "country", "sector", "near_term_status", "near_term_target_year", "net_zero_status", "date"];

export type SbtiRow = {
  company_name: string;
  isin: string;
  lei: string;
  country: string;
  sector: string;
  near_term_status: string;
  near_term_target_year: string;
  net_zero_status: string;
  date: string;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function findTargets(rows: Record<string, string>[], query: string): SbtiRow[] {
  const q = query.trim();
  const nq = norm(q);
  const upper = q.toUpperCase().replace(/\s+/g, "");
  return rows
    .filter((r) => (r.isin && r.isin.toUpperCase() === upper) || (r.lei && r.lei.toUpperCase() === upper) || (nq && norm(r.company_name ?? "").includes(nq)))
    .map((r) => ({
      company_name: r.company_name ?? "",
      isin: r.isin ?? "",
      lei: r.lei ?? "",
      country: r.country ?? "",
      sector: r.sector ?? "",
      near_term_status: r.near_term_status ?? "",
      near_term_target_year: r.near_term_target_year ?? "",
      net_zero_status: r.net_zero_status ?? "",
      date: r.date ?? "",
    }));
}

function userFile(ctx: OperationContext) {
  return listReferenceFiles(ctx.env, ID, /^targets\.csv$/)[0];
}

const LINKS = [
  { label: "SBTi Target Dashboard (XLSX export)", url: DASHBOARD_URL },
  { label: "SBTi Corporate Net-Zero Standard", url: "https://sciencebasedtargets.org/net-zero" },
  { label: "SBTi companies taking action (legacy list)", url: "https://sciencebasedtargets.org/companies-taking-action" },
];

export const definition = defineIntegration({
  id: ID,
  name: "SBTi Target Dashboard",
  group: "company",
  access: "download",
  territory: "Global",
  description: "Validated science-based targets and commitments by company (near-term and net-zero status, target year, sector). No API: link to the dashboard export and search a CSV the user saves from it.",
  docsUrl: DASHBOARD_URL,
  termsUrl: "https://sciencebasedtargets.org/terms-and-conditions",
  attribution: "Source: Science Based Targets initiative, Target Dashboard. Data reproduced for internal analysis; check the SBTi terms before redistributing.",
  licence: "restricted",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: `Directory for user-placed files (default data/reference). Save the dashboard export as <dir>/${ID}/${FILE_NAME} with columns ${REQUIRED_COLUMNS.join(", ")}.` }],
  status: "reference_only",
  notes: [
    "The SBTi Target Dashboard publishes an XLSX export and no public API; the export's licence terms restrict redistribution, so the portal does not download it automatically.",
    `To search locally: open the XLSX export, keep or rename columns to ${REQUIRED_COLUMNS.join(", ")} and save as CSV at data/reference/${ID}/${FILE_NAME}.`,
    "A validated target is a commitment, not delivered performance; pair it with reported emissions (CDP, annual report) before using it as supplier evidence.",
    "Status vocabulary (for example 'Targets set', 'Committed', 'Commitment removed') follows the SBTi export at the time of saving; the date column records when it was saved.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const f = userFile(ctx);
    return f ? { ok: true, detail: `${FILE_NAME} present (modified ${f.modifiedAt})` } : { ok: false, detail: `No ${FILE_NAME} in ${referenceDir(ctx.env, ID)}; save one from the dashboard export to enable local search.` };
  },
  operations: [
    {
      id: "links",
      label: "Open the SBTi Target Dashboard",
      description: "Links to the dashboard export and standards; no data is fetched.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "The SBTi Target Dashboard is a manual XLSX export; open it to check a company's target status, or save the export as targets.csv for local search.",
          rows: LINKS.map((l) => ({ resource: l.label, url: l.url })),
          columns: ["resource", "url"],
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "target-dashboard", basis: "not_applicable" }),
        };
      },
    },
    {
      id: "search",
      label: "Search a saved dashboard export",
      description: "Finds a company by name, ISIN or LEI in the CSV saved from the dashboard export.",
      params: [{ name: "query", label: "Company name, ISIN or LEI", type: "string", required: true, placeholder: "Example plc" }],
      async run(params, ctx) {
        const file = userFile(ctx);
        if (!file) throw new Error(`No ${FILE_NAME} found. Save the dashboard export as ${path.join(referenceDir(ctx.env, ID), FILE_NAME)} with columns ${REQUIRED_COLUMNS.join(", ")}.`);
        const table = loadReferenceCsv(file, { isHeader: (row) => row.some((c) => /company_name/i.test(c)) });
        const missing = missingColumns(table.header, ["company_name"]);
        if (missing.length) throw new Error(`${FILE_NAME} is missing required column(s): ${missing.join(", ")}.`);
        const rows = findTargets(table.records, String(params.query)).slice(0, 100);
        const first = rows[0];
        return {
          summary: first
            ? `${rows.length} row(s) match "${params.query}". ${first.company_name}: near-term ${first.near_term_status || "n/a"}${first.near_term_target_year ? ` (target year ${first.near_term_target_year})` : ""}, net zero ${first.net_zero_status || "n/a"} (export dated ${first.date || "unknown"}).`
            : `No SBTi row for "${params.query}" in the saved export (${table.records.length} rows). Absence means no validated target or commitment was in the export, not that the company has no climate plan.`,
          columns: REQUIRED_COLUMNS,
          rows,
          raw: rows,
          provenance: makeProvenance(definition, ctx, { dataset: "target-dashboard-export", basis: rows.length ? "client_declared" : "unavailable", version: `file ${file.name}; modified ${file.modifiedAt}` }),
          warnings: ["Target status is as of the date the export was saved; re-export to refresh. A target is a commitment, not delivered emissions performance."],
        };
      },
    },
  ],
});
