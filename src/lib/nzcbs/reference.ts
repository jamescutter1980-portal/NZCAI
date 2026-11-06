import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EnvLike } from "@/lib/integrations/framework";
import { csvToRecords, parseNumericCell } from "@/lib/integrations/_shared/csv";
import { DEFAULT_REFERENCE_DATA_DIR } from "@/lib/integrations/_shared/reference-data";
import { LIMIT_TABLE_FIRST_YEAR, LIMIT_TABLE_LAST_YEAR } from "./constants";
import type { AreaBasis, LimitTable, Region } from "./types";

/**
 * Loader for the UK NZCBS reference tables.
 *
 * A version is a folder holding limits.csv, renewables_targets.csv,
 * other_limits.csv, reduction_curves.csv, menus.csv and manifest.json, as
 * written by scripts/nzcbs/convert-proforma-tables.py. Two roots are searched:
 *
 * - the deployment's reference directory, `<REFERENCE_DATA_DIR>/uk-nzcbs/<version>/`,
 *   for revisions supplied after this code shipped;
 * - the repository's bundled copy, `reference/uk-nzcbs/<version>/`.
 *
 * A deployment folder with the same version name wins. Every file's SHA-256
 * is checked against the manifest, so a hand-edited limit table is refused
 * rather than silently used.
 */

export const INTEGRATION_ID = "uk-nzcbs";
const BUNDLED_ROOT = "reference";
const MANIFEST = "manifest.json";
const FILES = ["limits.csv", "renewables_targets.csv", "other_limits.csv", "reduction_curves.csv", "menus.csv"] as const;

export type LimitStatus = "limit" | "no_limit" | "not_applicable" | "deferred" | "unavailable";

export interface LimitRow {
  table: LimitTable;
  aspect: string;
  sector: string;
  subsector: string;
  scope: string;
  label: string;
  areaBasis: AreaBasis | "PUE" | "";
  year: number;
  value: number | null;
  unit: string;
  status: LimitStatus;
  note: string;
}

export interface RenewablesTargetRow {
  region: Region;
  buildingGroup: "all_other" | "single_family_homes_or_single_storey_storage";
  value: number;
  unit: string;
}

export interface OtherLimit {
  value: number | null;
  unit: string;
  source: string;
  note: string;
}

export interface ReferenceManifest {
  version: string;
  standard: string;
  proforma: string;
  publisher: string;
  converted_on: string;
  files: Record<string, { sha256: string; rows: number }>;
}

export interface NzcbsReference {
  version: string;
  dir: string;
  bundled: boolean;
  manifest: ReferenceManifest;
  limits: LimitRow[];
  renewablesTargets: RenewablesTargetRow[];
  otherLimits: Record<string, OtherLimit>;
  reductionCurves: { year: number; residential: number; nonResidential: number }[];
  menus: Record<string, string[]>;
  sectors: string[];
  /** Mod time of the manifest, for provenance strings. */
  modifiedAt: string;
}

export interface ReferenceVersion {
  version: string;
  dir: string;
  bundled: boolean;
}

export class NzcbsReferenceError extends Error {}

/* ------------------------------------------------------------------ */
/* discovery                                                           */
/* ------------------------------------------------------------------ */

export function deploymentReferenceDir(env: EnvLike): string {
  const base = env.REFERENCE_DATA_DIR?.trim() || DEFAULT_REFERENCE_DATA_DIR;
  return path.resolve(base, INTEGRATION_ID);
}

export function bundledReferenceDir(env: EnvLike): string {
  const base = env.NZCBS_BUNDLED_REFERENCE_DIR?.trim() || BUNDLED_ROOT;
  return path.resolve(base, INTEGRATION_ID);
}

function versionFolders(root: string, bundled: boolean): ReferenceVersion[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    .map((name) => ({ version: name, dir: path.join(root, name), bundled }))
    .filter((v) => statSync(v.dir).isDirectory() && existsSync(path.join(v.dir, MANIFEST)));
}

/** Newest first. A deployment folder shadows a bundled one of the same name. */
export function listReferenceVersions(env: EnvLike): ReferenceVersion[] {
  const byName = new Map<string, ReferenceVersion>();
  for (const v of versionFolders(bundledReferenceDir(env), true)) byName.set(v.version, v);
  for (const v of versionFolders(deploymentReferenceDir(env), false)) byName.set(v.version, v);
  return [...byName.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { modifiedAt: string; value: NzcbsReference }>();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readChecked(dir: string, manifest: ReferenceManifest, name: string): string {
  const file = path.join(dir, name);
  if (!existsSync(file)) throw new NzcbsReferenceError(`${dir}: ${name} is missing.`);
  const buf = readFileSync(file);
  const expected = manifest.files?.[name]?.sha256;
  if (!expected) throw new NzcbsReferenceError(`${dir}: manifest.json has no checksum for ${name}.`);
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new NzcbsReferenceError(`${dir}: ${name} does not match its manifest checksum, so it has been edited since conversion and is refused. Re-run the converter or restore the file.`);
  }
  return buf.toString("utf8");
}

function parseLimits(text: string): LimitRow[] {
  const table = csvToRecords(text);
  return table.records.map((r) => ({
    table: r.table as LimitTable,
    aspect: r.aspect,
    sector: r.sector,
    subsector: r.subsector,
    scope: r.scope,
    label: r.label,
    areaBasis: r.area_basis as LimitRow["areaBasis"],
    year: Number(r.year),
    value: parseNumericCell(r.value),
    unit: r.unit,
    status: r.status as LimitStatus,
    note: r.note,
  }));
}

export function loadNzcbsReference(env: EnvLike, version?: string): NzcbsReference | null {
  const versions = listReferenceVersions(env);
  const chosen = version ? versions.find((v) => v.version === version) : versions[0];
  if (!chosen) return null;
  const manifestPath = path.join(chosen.dir, MANIFEST);
  const modifiedAt = statSync(manifestPath).mtime.toISOString();
  const hit = cache.get(chosen.dir);
  if (hit && hit.modifiedAt === modifiedAt) return hit.value;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReferenceManifest;
  for (const name of FILES) {
    if (!manifest.files?.[name]) throw new NzcbsReferenceError(`${chosen.dir}: manifest.json does not list ${name}.`);
  }
  const limits = parseLimits(readChecked(chosen.dir, manifest, "limits.csv"));
  const renewablesTargets = csvToRecords(readChecked(chosen.dir, manifest, "renewables_targets.csv")).records.map((r) => ({
    region: r.region as Region,
    buildingGroup: r.building_group as RenewablesTargetRow["buildingGroup"],
    value: Number(r.value),
    unit: r.unit,
  }));
  const otherLimits: Record<string, OtherLimit> = {};
  for (const r of csvToRecords(readChecked(chosen.dir, manifest, "other_limits.csv")).records) {
    otherLimits[r.key] = { value: parseNumericCell(r.value), unit: r.unit, source: r.source, note: r.note };
  }
  const reductionCurves = csvToRecords(readChecked(chosen.dir, manifest, "reduction_curves.csv")).records.map((r) => ({
    year: Number(r.year),
    residential: Number(r.residential),
    nonResidential: Number(r.non_residential),
  }));
  const menus: Record<string, string[]> = {};
  for (const r of csvToRecords(readChecked(chosen.dir, manifest, "menus.csv")).records) {
    (menus[r.menu] ??= []).push(r.value);
  }
  const value: NzcbsReference = {
    version: chosen.version,
    dir: chosen.dir,
    bundled: chosen.bundled,
    manifest,
    limits,
    renewablesTargets,
    otherLimits,
    reductionCurves,
    menus,
    sectors: [...new Set(limits.map((l) => l.sector))].sort(),
    modifiedAt,
  };
  cache.set(chosen.dir, { modifiedAt, value });
  return value;
}

/** Clears the parse cache (tests). */
export function clearNzcbsReferenceCache(): void {
  cache.clear();
}

/** Provenance string for results. */
export function referenceLabel(ref: NzcbsReference): string {
  return `UK NZCBS ${ref.version} (${ref.manifest.standard}); ${ref.bundled ? "bundled" : "deployment"} reference tables, manifest ${ref.manifest.converted_on}`;
}

/* ------------------------------------------------------------------ */
/* limit lookup                                                        */
/* ------------------------------------------------------------------ */

export interface LimitQuery {
  table: LimitTable;
  sector: string;
  subsector?: string;
  scope?: string;
  areaBasis?: AreaBasis;
  /** Date of Commencement year or ORP start year, before clamping. */
  year: number;
}

export interface LimitResolution {
  status: LimitStatus | "not_found" | "ambiguous";
  value: number | null;
  unit: string;
  /** Year the limit was read for, after clamping to the table range. */
  year: number;
  row: LimitRow | null;
  /** Rows that tied when the query was ambiguous. */
  candidates: LimitRow[];
  notes: string[];
}

/** 5.2.7.1: before 2025 reads as 2025; Annex A plateaus after 2050. */
export function clampLimitYear(year: number): number {
  if (!Number.isFinite(year)) return LIMIT_TABLE_FIRST_YEAR;
  return Math.min(LIMIT_TABLE_LAST_YEAR, Math.max(LIMIT_TABLE_FIRST_YEAR, Math.trunc(year)));
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Finds the one limit row for a table, sector and year. Subsector, scope and
 * area basis narrow the choice; where the Standard publishes one figure for
 * the whole sector any subsector resolves to it. Two different figures that
 * both fit the query is reported as ambiguous, never guessed.
 */
export function findLimit(ref: NzcbsReference, q: LimitQuery): LimitResolution {
  const year = clampLimitYear(q.year);
  const notes: string[] = [];
  if (year !== q.year) notes.push(`Year ${q.year} is outside the published range, so the ${year} limit is used (5.2.7.1, Annex A).`);
  const sector = norm(q.sector);
  const rows = ref.limits.filter((r) => r.table === q.table && norm(r.sector) === sector && r.year === year);
  if (rows.length === 0) {
    const sectors = [...new Set(ref.limits.filter((r) => r.table === q.table).map((r) => r.sector))];
    return { status: "not_found", value: null, unit: "", year, row: null, candidates: [], notes: [...notes, `Table ${q.table} has no rows for sector "${q.sector}". Sectors in the table: ${sectors.join(", ")}.`] };
  }

  const want = { subsector: norm(q.subsector), scope: norm(q.scope), areaBasis: norm(q.areaBasis) };
  const scored = rows
    .map((row) => {
      let score = 0;
      const rs = norm(row.subsector);
      if (want.subsector) {
        if (rs === want.subsector) score += 30;
        else if (rs === "") score += 20;
        else return null;
      } else score += rs === "" ? 30 : 10;
      const rsc = norm(row.scope);
      if (want.scope) {
        if (rsc === want.scope) score += 3;
        else if (rsc === "") score += 2;
        else return null;
      } else score += rsc === "" || rsc === "whole building" ? 3 : 1;
      const rab = norm(row.areaBasis);
      if (want.areaBasis) {
        if (rab === want.areaBasis || rab === "pue" || rab === "") score += 200;
        else return null;
      } else score += rab === "nia" ? 100 : 200;
      return { row, score };
    })
    .filter((x): x is { row: LimitRow; score: number } => x !== null);

  if (scored.length === 0) {
    return { status: "not_found", value: null, unit: rows[0].unit, year, row: null, candidates: rows, notes: [...notes, `Table ${q.table}, ${q.sector}: no row matches subsector "${q.subsector ?? ""}", scope "${q.scope ?? ""}" and basis "${q.areaBasis ?? ""}". Rows available: ${describe(rows)}.`] };
  }
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).map((s) => s.row);
  const distinct = new Set(top.map((r) => `${r.status}:${r.value}:${r.unit}`));
  if (distinct.size > 1) {
    return { status: "ambiguous", value: null, unit: top[0].unit, year, row: null, candidates: top, notes: [...notes, `Table ${q.table}, ${q.sector}: more than one limit fits (${describe(top)}). Give the subsector${top.some((r) => r.scope) ? " and scope" : ""}.`] };
  }
  const row = top[0];
  if (row.note) notes.push(row.note);
  return { status: row.status, value: row.value, unit: row.unit, year, row, candidates: top, notes };
}

function describe(rows: LimitRow[]): string {
  return [...new Set(rows.map((r) => `${[r.subsector, r.scope, r.areaBasis].filter(Boolean).join(" / ") || "sector"}=${r.status === "limit" ? `${r.value} ${r.unit}` : r.status}`))].join("; ");
}

/** Annex A3 target for a region and building group. */
export function renewablesTarget(ref: NzcbsReference, region: Region, group: RenewablesTargetRow["buildingGroup"]): RenewablesTargetRow | null {
  return ref.renewablesTargets.find((t) => t.region === region && t.buildingGroup === group) ?? null;
}

export function otherLimit(ref: NzcbsReference, key: string): OtherLimit | null {
  return ref.otherLimits[key] ?? null;
}
