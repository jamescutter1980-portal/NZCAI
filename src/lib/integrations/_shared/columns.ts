/**
 * Tolerant column matching for bulk files whose headers vary in case,
 * punctuation and wording between releases (Scottish EPC extracts, VCA car
 * fuel data, IMD editions, ONSPD).
 *
 * Names are normalised to lower-case snake_case (`"Current energy efficiency
 * rating band"` -> `current_energy_efficiency_rating_band`, `"CO2 g/km"` ->
 * `co2_g_km`). A candidate ending in `*` matches any header that starts with
 * the candidate's normalised prefix (for headers carrying units in an
 * encoding-dependent suffix, such as `Total floor area (m²)`).
 */

export function normaliseColumn(name: string): string {
  return name
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Index of the first header matching any candidate (exact candidates take priority over prefix ones), or -1. */
export function findColumn(header: string[], candidates: string[]): number {
  const norm = header.map(normaliseColumn);
  for (const c of candidates) {
    if (c.endsWith("*")) continue;
    const idx = norm.indexOf(normaliseColumn(c));
    if (idx >= 0) return idx;
  }
  for (const c of candidates) {
    if (!c.endsWith("*")) continue;
    const prefix = normaliseColumn(c.slice(0, -1));
    const idx = norm.findIndex((h) => h.startsWith(prefix));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Resolves every key of `spec` to a column index (-1 when absent). */
export function columnIndexes<K extends string>(header: string[], spec: Record<K, string[]>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of Object.keys(spec) as K[]) out[key] = findColumn(header, spec[key]);
  return out;
}

/** Cell text at `idx`, or "" when the column is absent or the row is short. */
export function cell(row: string[], idx: number): string {
  if (idx < 0) return "";
  return (row[idx] ?? "").trim();
}

/** Which keys of a resolved index map are absent. */
export function absentColumns<K extends string>(indexes: Record<K, number>, required: K[]): K[] {
  return required.filter((k) => indexes[k] < 0);
}

/** Header cells normalised, for "does this look like the header row" checks. */
export function normalisedSet(row: string[]): Set<string> {
  return new Set(row.map(normaliseColumn));
}
