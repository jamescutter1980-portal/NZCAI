import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EnvLike, HealthResult, OperationContext } from "../framework";
import { csvToRecords, type CsvTable, type CsvToRecordsOptions } from "./csv";

/**
 * Reading of user-supplied reference files (versioned factor tables and
 * pathways) from disk. These loaders are the only connectors allowed to touch
 * the filesystem, and only for reading.
 *
 * Files live under `<REFERENCE_DATA_DIR>/<integration id>/`. The directory
 * defaults to `data/reference` (gitignored) and is taken from `ctx.env`, never
 * from `process.env` directly. See docs/integrations/reference-data.md.
 */

export const DEFAULT_REFERENCE_DATA_DIR = "data/reference";

export interface ReferenceFile {
  /** File name within the integration's directory, e.g. "2026.csv". */
  name: string;
  path: string;
  modifiedAt: string;
  sizeBytes: number;
}

export function referenceDir(env: EnvLike, integrationId: string): string {
  const base = env.REFERENCE_DATA_DIR?.trim() || DEFAULT_REFERENCE_DATA_DIR;
  return path.resolve(base, integrationId);
}

/** Files in the integration directory whose names match `pattern`, sorted by name. */
export function listReferenceFiles(env: EnvLike, integrationId: string, pattern: RegExp): ReferenceFile[] {
  const dir = referenceDir(env, integrationId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => {
      const p = path.join(dir, name);
      const st = statSync(p);
      return { name, path: p, modifiedAt: st.mtime.toISOString(), sizeBytes: st.size };
    })
    .filter((f) => statSync(f.path).isFile());
}

interface CacheEntry<T> {
  modifiedAt: string;
  sizeBytes: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Reads and parses a file once per (path, mtime, size); later calls return the
 * cached value until the file changes on disk.
 */
export function loadReferenceFile<T>(file: ReferenceFile, parse: (text: string, file: ReferenceFile) => T): T {
  const hit = cache.get(file.path) as CacheEntry<T> | undefined;
  if (hit && hit.modifiedAt === file.modifiedAt && hit.sizeBytes === file.sizeBytes) return hit.value;
  const text = readFileSync(file.path, "utf8");
  const value = parse(text, file);
  cache.set(file.path, { modifiedAt: file.modifiedAt, sizeBytes: file.sizeBytes, value });
  return value;
}

/** Convenience: parse a reference CSV into keyed records, cached. */
export function loadReferenceCsv(file: ReferenceFile, opts: CsvToRecordsOptions = {}): CsvTable {
  return loadReferenceFile(file, (text) => csvToRecords(text, opts));
}

/** Clears the parse cache (tests). */
export function clearReferenceCache(): void {
  cache.clear();
}

/** Provenance version string: file name plus modification time. */
export function fileVersion(file: ReferenceFile, label?: string): string {
  return `${label ? `${label}; ` : ""}file ${file.name}; modified ${file.modifiedAt}`;
}

/** Health check for a loader: ok when at least one matching file is present and readable. */
export function referenceHealth(integrationId: string, pattern: RegExp, expected: string) {
  return async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const files = listReferenceFiles(ctx.env, integrationId, pattern);
      if (files.length === 0) {
        return { ok: false, detail: `No reference files found in ${referenceDir(ctx.env, integrationId)}. Expected ${expected}.`, latencyMs: Date.now() - started };
      }
      return { ok: true, detail: `${files.length} file(s): ${files.map((f) => f.name).join(", ")}`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  };
}

/** Parses "year,value" lines or a JSON array/object into a numeric series keyed by year. */
export function parseYearSeries(text: string): { year: number; value: number }[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const out: { year: number; value: number }[] = [];
  const push = (y: unknown, v: unknown) => {
    const year = Number(y);
    const value = Number(v);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error(`Invalid year "${String(y)}" in series`);
    if (!Number.isFinite(value)) throw new Error(`Invalid value "${String(v)}" for year ${year}`);
    out.push({ year, value });
  };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (Array.isArray(item)) push(item[0], item[1]);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          push(o.year, o.value);
        } else throw new Error("Series array items must be [year, value] or {year, value}");
      }
    } else if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) push(k, v);
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (l === "" || /^year\b/i.test(l)) continue;
      const parts = l.split(/[,;\t]+|\s+/).filter(Boolean);
      if (parts.length < 2) throw new Error(`Cannot read "${line}" as year,value`);
      push(parts[0], parts[1]);
    }
  }
  out.sort((a, b) => a.year - b.year);
  const seen = new Set<number>();
  for (const p of out) {
    if (seen.has(p.year)) throw new Error(`Year ${p.year} appears more than once in the series`);
    seen.add(p.year);
  }
  return out;
}
