import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchText, type OperationContext } from "../framework";
import { listReferenceFiles, loadReferenceFile, referenceDir, type ReferenceFile } from "../_shared/reference-data";

/**
 * Download-and-cache support for bulk register connectors.
 *
 * A connector may download its source file into
 * `<REFERENCE_DATA_DIR>/<integration id>/<name>` (default `data/reference`,
 * taken from `ctx.env`), and must also accept a file the user placed there by
 * hand. Reading goes through the shared reference-data loader so parsed
 * tables are cached per (path, mtime, size).
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The cached or user-placed file, if present. */
export function cachedFile(env: OperationContext["env"], integrationId: string, name: string): ReferenceFile | undefined {
  return listReferenceFiles(env, integrationId, new RegExp(`^${escapeRegExp(name)}$`))[0];
}

/** Writes text to the integration's reference directory and returns its descriptor. */
export function writeCache(env: OperationContext["env"], integrationId: string, name: string, text: string): ReferenceFile {
  const dir = referenceDir(env, integrationId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), text, "utf8");
  const file = cachedFile(env, integrationId, name);
  if (!file) throw new Error(`Failed to write ${name} to ${dir}`);
  return file;
}

/** GET a text file (CSV) with a long timeout; throws IntegrationHttpError on non-2xx. */
export async function downloadText(ctx: OperationContext, url: string, timeoutMs = 120_000): Promise<string> {
  const { text } = await fetchText(ctx, url, { headers: { accept: "text/csv, text/plain, */*" } }, { timeoutMs });
  return text;
}

/** Parses a cached file once per version on disk. */
export function loadCached<T>(file: ReferenceFile, parse: (text: string) => T): T {
  return loadReferenceFile(file, (text) => parse(text));
}

/** Where the user should put a file by hand. */
export function expectedPath(env: OperationContext["env"], integrationId: string, name: string): string {
  return path.join(referenceDir(env, integrationId), name);
}
