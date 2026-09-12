/**
 * Matching the columns a client actually sent to the fields an import needs,
 * and turning the mapped rows into values.
 *
 * Matching is tolerant (case, punctuation and spacing are ignored, and a field
 * matches on its name, its label or any alias) because the same column arrives
 * as "MPAN", "mpan core", "Meter Point Administration Number" and "MPAN #".
 * Applying the mapping is not tolerant: a required cell that is blank or
 * unreadable becomes an error naming the row, the column and the value, never
 * a dropped row and never a substituted zero.
 */

import { normaliseColumn } from "@/lib/integrations/_shared/columns";
import type { ImportSpec } from "./spec";

/** The most rows one import may carry; the rest are refused with a stated truncation. */
export const MAX_IMPORT_ROWS = 20_000;

/** Field name -> column index in `headers`, or null when nothing is mapped. */
export type ColumnMapping = Record<string, number | null>;

export interface MappedRow {
  /** Parsed values, keyed by field name. An optional field left blank is absent, not null. */
  data: Record<string, unknown>;
  /** Row number as the user sees it: the header is row 1. */
  rowNumber: number;
}

export interface MappingError {
  rowNumber: number;
  /** The header the value came from, when the field is mapped. */
  column?: string;
  /** The field name the value was destined for. */
  field?: string;
  message: string;
}

export interface ApplyResult {
  rows: MappedRow[];
  errors: MappingError[];
  /** Rows whose every mapped cell was blank. Counted, never silently dropped. */
  skippedBlank: number;
  /** One line of counts for the UI: "312 rows, 4 with errors, 308 will be imported". */
  summary: string;
  /** True when more rows were supplied than `MAX_IMPORT_ROWS`. */
  truncated: boolean;
}

export interface ApplyMappingOptions {
  /** Row number of the first data row. Default 2, the header being row 1. */
  firstRowNumber?: number;
  /** Ceiling on rows read. Default `MAX_IMPORT_ROWS`. */
  maxRows?: number;
}

const candidatesFor = (field: { name: string; label: string; aliases?: string[] }) => [field.name, field.label, ...(field.aliases ?? [])].map(normaliseColumn).filter((c) => c !== "");

/**
 * A best guess at which column feeds which field: an exact normalised match on
 * the field's name, label or aliases first, then a contains match.
 *
 * Required fields choose first, and a column that has been claimed is never
 * offered again, so one column can never satisfy two required fields.
 */
export function suggestMapping(spec: ImportSpec, headers: string[]): ColumnMapping {
  const norm = headers.map((h) => normaliseColumn(h));
  const mapping: ColumnMapping = {};
  for (const f of spec.fields) mapping[f.name] = null;
  const taken = new Set<number>();
  const ordered = [...spec.fields].sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));

  for (const field of ordered) {
    const candidates = candidatesFor(field);
    const exact = norm.findIndex((h, i) => !taken.has(i) && h !== "" && candidates.includes(h));
    if (exact >= 0) {
      mapping[field.name] = exact;
      taken.add(exact);
    }
  }
  for (const field of ordered) {
    if (mapping[field.name] !== null) continue;
    const candidates = candidatesFor(field).filter((c) => c.length >= 3);
    const loose = norm.findIndex((h, i) => !taken.has(i) && h.length >= 3 && candidates.some((c) => h.includes(c) || c.includes(h)));
    if (loose >= 0) {
      mapping[field.name] = loose;
      taken.add(loose);
    }
  }
  return mapping;
}

/** What still stands between this mapping and a commit, in the user's words. */
export function mappingIssues(spec: ImportSpec, mapping: ColumnMapping): string[] {
  const issues: string[] = [];
  for (const f of spec.fields) {
    if (f.required && (mapping[f.name] === null || mapping[f.name] === undefined)) issues.push(`${f.label} is required and no column is mapped to it.`);
  }
  const byColumn = new Map<number, string[]>();
  for (const f of spec.fields) {
    const idx = mapping[f.name];
    if (idx === null || idx === undefined) continue;
    byColumn.set(idx, [...(byColumn.get(idx) ?? []), f.label]);
  }
  for (const [, fields] of byColumn) {
    if (fields.length > 1) issues.push(`One column is mapped to ${fields.length} fields (${fields.join(", ")}); map each field to its own column.`);
  }
  return issues;
}

/**
 * Applies a mapping to the previewed rows.
 *
 * A row is skipped only when every mapped cell in it is blank. Any other
 * problem — a required cell blank, a value that will not parse, a failed
 * `rowCheck` — puts the row in `errors` and keeps it out of `rows`, so the
 * count of what will be imported is always the count of what was understood.
 */
export function applyMapping(spec: ImportSpec, headers: string[], rows: string[][], mapping: ColumnMapping, opts: ApplyMappingOptions = {}): ApplyResult {
  const firstRowNumber = opts.firstRowNumber ?? 2;
  const maxRows = Math.max(0, opts.maxRows ?? MAX_IMPORT_ROWS);
  const out: MappedRow[] = [];
  const errors: MappingError[] = [];
  let skippedBlank = 0;
  const truncated = rows.length > maxRows;
  const considered = Math.min(rows.length, maxRows);
  const rowsWithErrors = new Set<number>();

  const columnOf = (name: string) => {
    const idx = mapping[name];
    return idx === null || idx === undefined || idx < 0 || idx >= headers.length ? null : idx;
  };

  for (let i = 0; i < considered; i++) {
    const cells = rows[i];
    const rowNumber = firstRowNumber + i;
    const mapped = spec.fields.map((f) => ({ field: f, idx: columnOf(f.name) }));
    if (mapped.every(({ idx }) => idx === null || (cells[idx] ?? "").trim() === "")) {
      skippedBlank++;
      continue;
    }
    const named: Record<string, string> = {};
    headers.forEach((h, c) => {
      named[h] = (cells[c] ?? "").trim();
    });

    const data: Record<string, unknown> = {};
    let failed = false;
    for (const { field, idx } of mapped) {
      const column = idx === null ? undefined : headers[idx];
      const raw = idx === null ? "" : (cells[idx] ?? "").trim();
      if (raw === "") {
        if (field.required) {
          failed = true;
          errors.push({ rowNumber, column, field: field.name, message: idx === null ? `${field.label} is required and no column is mapped to it.` : `${field.label} is required but the cell is blank (a blank cell is never read as zero).` });
        }
        continue;
      }
      const result = field.parse(raw, named);
      if (!result.ok) {
        failed = true;
        errors.push({ rowNumber, column, field: field.name, message: `${field.label}: ${result.error}` });
        continue;
      }
      data[field.name] = result.value;
    }

    if (!failed && spec.rowCheck) {
      for (const message of spec.rowCheck(data, rowNumber)) {
        failed = true;
        errors.push({ rowNumber, message });
      }
    }

    if (failed) rowsWithErrors.add(rowNumber);
    else out.push({ data, rowNumber });
  }

  if (truncated) {
    errors.push({ rowNumber: firstRowNumber + maxRows, message: `Only the first ${maxRows.toLocaleString("en-GB")} rows were read; ${(rows.length - maxRows).toLocaleString("en-GB")} further rows were ignored. Split the file and import the rest separately.` });
  }

  const parts = [`${considered.toLocaleString("en-GB")} row${considered === 1 ? "" : "s"}`, `${rowsWithErrors.size.toLocaleString("en-GB")} with errors`, `${out.length.toLocaleString("en-GB")} will be imported`];
  if (skippedBlank > 0) parts.push(`${skippedBlank.toLocaleString("en-GB")} blank row${skippedBlank === 1 ? "" : "s"} skipped`);
  if (truncated) parts.push(`only the first ${maxRows.toLocaleString("en-GB")} of ${rows.length.toLocaleString("en-GB")} rows were read`);

  return { rows: out, errors, skippedBlank, summary: parts.join(", "), truncated };
}
