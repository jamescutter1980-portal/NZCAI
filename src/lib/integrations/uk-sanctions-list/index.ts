import { defineIntegration, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";
import { csvToRecords } from "../_shared/csv";
import { cachedFile, downloadText, expectedPath, loadCached, writeCache } from "./download-cache";

/**
 * FCDO UK Sanctions List (the single UK designations list since the OFSI
 * Consolidated List closed on 28 January 2026).
 *
 * Built from the GOV.UK format guide and open-source consumers of the CSV
 * (moov-io/watchman and others); no live download has been made from this
 * codebase. The CSV's first line carries the publication date and the header
 * row follows; each designation spreads over several rows (one per name /
 * alias and per regime), keyed by "Unique ID".
 */

export const ID = "uk-sanctions-list";
export const FILE_NAME = "UK_Sanctions_List.csv";
/** Stable download URL used by open-source screening tools; override with UK_SANCTIONS_LIST_URL if it moves. */
export const DEFAULT_URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv";

export function listUrl(env: EnvLike): string {
  return env.UK_SANCTIONS_LIST_URL?.trim() || DEFAULT_URL;
}

export interface Designation {
  id: string;
  primaryName: string;
  aliases: string[];
  type: string;
  regimes: string[];
  dateDesignated: string | null;
  lastUpdated: string | null;
  countries: string[];
}

export interface ParsedList {
  publicationDate: string | null;
  rowCount: number;
  designations: Designation[];
}

function col(rec: Record<string, string>, ...names: string[]): string {
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (key !== undefined && rec[key]?.trim()) return rec[key].trim();
  }
  return "";
}

/** Joins "Name 1".."Name 6" (given names then surname / entity name) into one display name. */
export function buildName(rec: Record<string, string>): string {
  const parts: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const v = col(rec, `Name ${i}`);
    if (v) parts.push(v);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function parseSanctionsCsv(text: string): ParsedList {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const dateMatch = firstLine.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => /unique id/i.test(c)) });
  const byId = new Map<string, Designation>();
  for (const rec of table.records) {
    const id = col(rec, "Unique ID", "OFSI Group ID", "Group ID");
    const name = buildName(rec) || col(rec, "Name 6", "Name");
    if (!id && !name) continue;
    const key = id || name.toLowerCase();
    const nameType = col(rec, "Name type", "Alias Type").toLowerCase();
    const regime = col(rec, "Regime Name", "Regime");
    const country = col(rec, "Country", "Country of birth", "Nationality");
    let d = byId.get(key);
    if (!d) {
      d = {
        id: id || key,
        primaryName: "",
        aliases: [],
        type: col(rec, "Designation Type", "Individual, Entity, Ship", "Group Type") || "Unknown",
        regimes: [],
        dateDesignated: col(rec, "Date Designated", "Designation Date", "Listed On") || null,
        lastUpdated: col(rec, "Last Updated") || null,
        countries: [],
      };
      byId.set(key, d);
    }
    if (name) {
      if (!nameType || nameType.startsWith("primary name") && !nameType.includes("variation")) {
        if (!d.primaryName) d.primaryName = name;
        else if (name !== d.primaryName && !d.aliases.includes(name)) d.aliases.push(name);
      } else if (name !== d.primaryName && !d.aliases.includes(name)) d.aliases.push(name);
    }
    if (regime && !d.regimes.includes(regime)) d.regimes.push(regime);
    if (country && !d.countries.includes(country)) d.countries.push(country);
    const updated = col(rec, "Last Updated");
    if (updated && (!d.lastUpdated || updated > d.lastUpdated)) d.lastUpdated = updated;
  }
  for (const d of byId.values()) {
    if (!d.primaryName && d.aliases.length) d.primaryName = d.aliases.shift() as string;
  }
  return { publicationDate: dateMatch?.[1] ?? null, rowCount: table.records.length, designations: [...byId.values()] };
}

const STOP = new Set(["ltd", "limited", "llc", "inc", "plc", "co", "company", "corp", "corporation", "the", "of", "and", "&", "gmbh", "sa", "ag", "llp", "jsc", "ojsc", "pjsc", "ooo", "oao", "zao"]);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** 0..1 similarity: proportion of query tokens found in the candidate (whole or prefix), penalising stop words, with a bonus for exact normalised equality. */
export function similarity(query: string, candidate: string): number {
  const q = tokens(query);
  const c = tokens(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  if (q.join(" ") === c.join(" ")) return 1;
  const qSig = q.filter((t) => !STOP.has(t));
  const cSet = new Set(c);
  const base = qSig.length ? qSig : q;
  let hits = 0;
  for (const t of base) {
    if (cSet.has(t)) hits += 1;
    else if (t.length >= 4 && c.some((x) => x.startsWith(t) || t.startsWith(x) && x.length >= 4)) hits += 0.5;
  }
  const precision = hits / base.length;
  const coverage = hits / Math.max(base.length, c.filter((t) => !STOP.has(t)).length || 1);
  return Math.round((0.7 * precision + 0.3 * coverage) * 100) / 100;
}

export function screenName(list: ParsedList, query: string, minScore: number, maxResults: number) {
  const matches: { designation: Designation; matchedName: string; score: number }[] = [];
  for (const d of list.designations) {
    let best = { name: d.primaryName, score: similarity(query, d.primaryName) };
    for (const a of d.aliases) {
      const s = similarity(query, a);
      if (s > best.score) best = { name: a, score: s };
    }
    if (best.score >= minScore) matches.push({ designation: d, matchedName: best.name, score: best.score });
  }
  matches.sort((a, b) => b.score - a.score || a.designation.primaryName.localeCompare(b.designation.primaryName));
  return matches.slice(0, maxResults);
}

function loadList(ctx: OperationContext): { list: ParsedList; version: string } | null {
  const file = cachedFile(ctx.env, ID, FILE_NAME);
  if (!file) return null;
  const list = loadCached(file, parseSanctionsCsv);
  return { list, version: `${FILE_NAME}; published ${list.publicationDate ?? "unknown"}; file modified ${file.modifiedAt}` };
}

export const definition = defineIntegration({
  id: ID,
  name: "UK Sanctions List (FCDO)",
  group: "company",
  access: "download",
  territory: "UK",
  description: "Designated persons, entities and ships under UK sanctions regimes, downloaded as CSV and screened locally by name. Supplier and counterparty screening for procurement and human-rights due diligence.",
  docsUrl: "https://www.gov.uk/government/publications/the-uk-sanctions-list",
  termsUrl: "https://www.gov.uk/guidance/format-guide-for-the-uk-sanctions-list",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Foreign, Commonwealth and Development Office, UK Sanctions List.",
  licence: "OGL",
  envVars: [
    { name: "UK_SANCTIONS_LIST_URL", required: false, description: `CSV download URL. Defaults to ${DEFAULT_URL}; set if the published asset URL changes.` },
    { name: "REFERENCE_DATA_DIR", required: false, description: `Directory for cached or user-placed files (default data/reference). Place ${FILE_NAME} under <dir>/${ID}/.` },
  ],
  status: "built_unverified",
  notes: [
    "The OFSI Consolidated List of Asset Freeze Targets closed on 28 January 2026; the UK Sanctions List is the only official UK source.",
    `Default download URL (${DEFAULT_URL}) is the stable link used by open-source screening tools but has not been fetched from this codebase; the GOV.UK publication page also offers CSV, XML, ODS and PDF assets whose URLs change per release.`,
    "Name screening is a simple token-similarity match. It does not use dates of birth, addresses or identifiers, so every match needs human review against the full entry, and a clear result does not cover EU, UN or US lists.",
    "OpenSanctions (commercial licence for business use) is an optional extension for consolidated multi-list screening with entity resolution.",
    "Column names are matched case-insensitively against the published format guide (Name 1-6, Name type, Designation Type, Unique ID, Regime Name, Date Designated, Last Updated); a format change may need a parser update.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    const loaded = loadList(ctx);
    if (!loaded) return { ok: false, detail: `No ${FILE_NAME} at ${expectedPath(ctx.env, ID, FILE_NAME)}. Run the reload operation or place the file there.`, latencyMs: Date.now() - started };
    return { ok: true, detail: `${loaded.list.designations.length} designations; published ${loaded.list.publicationDate ?? "unknown"}`, latencyMs: Date.now() - started };
  },
  operations: [
    {
      id: "screen",
      label: "Screen a name against the UK Sanctions List",
      description: "Case-insensitive token matching of a person or organisation name against primary names and aliases, with a similarity score.",
      params: [
        { name: "name", label: "Name to screen", type: "string", required: true, placeholder: "Example Trading LLC" },
        { name: "min_score", label: "Minimum score (0-1)", type: "number", default: 0.6, min: 0, max: 1, help: "Lower to widen the net; 1 is an exact normalised match." },
        { name: "max_results", label: "Maximum matches", type: "integer", default: 25, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const loaded = loadList(ctx);
        if (!loaded) throw new Error(`UK Sanctions List not loaded. Run the reload operation or place ${FILE_NAME} at ${expectedPath(ctx.env, ID, FILE_NAME)}.`);
        const matches = screenName(loaded.list, String(params.name), params.min_score as number, params.max_results as number);
        const rows = matches.map((m) => ({
          score: m.score,
          matched_name: m.matchedName,
          primary_name: m.designation.primaryName,
          aliases: m.designation.aliases.join("; "),
          type: m.designation.type,
          regimes: m.designation.regimes.join("; "),
          date_designated: m.designation.dateDesignated,
          last_updated: m.designation.lastUpdated,
          countries: m.designation.countries.join("; "),
          unique_id: m.designation.id,
        }));
        return {
          summary: rows.length
            ? `${rows.length} possible match(es) for "${params.name}" on the UK Sanctions List (best score ${rows[0].score}). Human review required.`
            : `No name on the UK Sanctions List scored ${params.min_score} or above for "${params.name}" (${loaded.list.designations.length} designations checked, list published ${loaded.list.publicationDate ?? "unknown"}).`,
          columns: ["score", "matched_name", "primary_name", "aliases", "type", "regimes", "date_designated", "last_updated", "countries", "unique_id"],
          rows,
          raw: matches.map((m) => m.designation),
          provenance: makeProvenance(definition, ctx, { dataset: "uk-sanctions-list", basis: rows.length ? "measured" : "unavailable", version: loaded.version }),
          warnings: [
            "Name-only screening: every match needs human review against date of birth, address and identifiers in the full entry.",
            "A no-match result covers the UK list only; screen EU, UN and OFAC lists separately where relevant.",
          ],
        };
      },
    },
    {
      id: "reload",
      label: "Download the latest list",
      description: "Downloads the CSV from the configured URL into the reference directory and reports the row count and publication date.",
      params: [],
      async run(_params, ctx) {
        const url = listUrl(ctx.env);
        const text = await downloadText(ctx, url);
        if (!/unique id/i.test(text.slice(0, 5000))) throw new Error(`Downloaded content from ${url} does not look like the UK Sanctions List CSV (no "Unique ID" header).`);
        const file = writeCache(ctx.env, ID, FILE_NAME, text);
        const list = loadCached(file, parseSanctionsCsv);
        const byType = new Map<string, number>();
        for (const d of list.designations) byType.set(d.type, (byType.get(d.type) ?? 0) + 1);
        const rows = [...byType.entries()].map(([type, count]) => ({ type, designations: count }));
        return {
          summary: `Downloaded ${list.rowCount} rows (${list.designations.length} designations) published ${list.publicationDate ?? "on an unknown date"} to ${file.path}.`,
          columns: ["type", "designations"],
          rows,
          raw: { url, path: file.path, sizeBytes: file.sizeBytes, publicationDate: list.publicationDate, rowCount: list.rowCount },
          provenance: makeProvenance(definition, ctx, { dataset: "uk-sanctions-list", basis: "measured", version: `published ${list.publicationDate ?? "unknown"}` }),
        };
      },
    },
  ],
});
