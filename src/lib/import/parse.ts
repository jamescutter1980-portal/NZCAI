/**
 * Reads a pasted or uploaded spreadsheet export well enough to show the user
 * what is in it, before anything is mapped or validated.
 *
 * The RFC 4180 rules (quoted fields, doubled quotes, line breaks inside
 * quotes, CRLF/LF, trimmed cells) come from `integrations/_shared/csv.ts`;
 * this module adds only what a hand-edited client file needs on top:
 * delimiter detection, a UTF-8 BOM, blank lines, preamble rows above the real
 * header, repeated header names and ragged rows. Nothing here throws on a
 * malformed file: a problem the user can see and fix becomes a warning.
 *
 * Rows are numbered the way the user sees them once the preamble is skipped:
 * the header is row 1 and the first data row is row 2, in this module's
 * warnings, in `applyMapping`'s errors and in the preview table. Blank lines
 * are skipped and do not consume a number.
 */

import { parseCsv, parseNumericCell } from "@/lib/integrations/_shared/csv";
import { normaliseColumn } from "@/lib/integrations/_shared/columns";
import { parseDateText } from "./spec";

export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

/** Rows read into memory by default; also the ceiling `applyMapping` enforces. */
export const MAX_PREVIEW_ROWS = 20_000;

export interface CsvPreview {
  delimiter: CsvDelimiter;
  /** Header names, de-duplicated and with blanks named `Column n`. */
  headers: string[];
  /** Data rows, each padded or truncated to `headers.length`. */
  rows: string[][];
  /** Non-blank data rows in the whole text, whether or not they were kept. */
  totalRows: number;
  /** True when `rows` holds fewer than `totalRows`. */
  truncated: boolean;
  warnings: string[];
  /** Rows above the header that were skipped as preamble. */
  preambleRows: number;
}

export interface PreviewCsvOptions {
  /** Data rows to keep. Default `MAX_PREVIEW_ROWS`. */
  maxRows?: number;
}

const isBlankRow = (row: string[]) => row.every((c) => c === "");

const DELIMITER_NAMES: Record<CsvDelimiter, string> = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };

/** The delimiter's name, for messages ("semicolon"). */
export function delimiterName(d: CsvDelimiter): string {
  return DELIMITER_NAMES[d] ?? d;
}

function modalCount(counts: number[]): number {
  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
  let best = 0;
  let bestN = -1;
  for (const [count, n] of tally) {
    if (n > bestN || (n === bestN && count > best)) {
      best = count;
      bestN = n;
    }
  }
  return best;
}

/**
 * Picks the delimiter that splits the sample into the most consistent table.
 * A candidate that yields a single column everywhere is not a delimiter.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: CsvDelimiter = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const rows = parseCsv(sample, d)
      .filter((r) => !isBlankRow(r))
      .slice(0, 20);
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const modal = modalCount(counts);
    if (modal < 2) continue;
    const consistency = counts.filter((c) => c === modal).length / counts.length;
    const score = consistency * 1000 + Math.min(modal, 50);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Cells that read as a number or a date are values, not column names. */
function isValueLike(cell: string): boolean {
  return parseNumericCell(cell) !== null || parseDateText(cell).ok;
}

/**
 * True when a row looks like the column names: a majority of its cells are
 * non-empty and not values, and most of those names differ from each other.
 * This is the test `desnz-conversion-factors` applies by hand to skip the
 * title and note rows Excel leaves above the table.
 */
export function looksLikeHeaderRow(row: string[], modalWidth = row.length): boolean {
  if (isBlankRow(row)) return false;
  if (modalWidth > 1 && row.length < Math.max(2, Math.ceil(modalWidth / 2))) return false;
  const nonEmpty = row.filter((c) => c !== "");
  const names = nonEmpty.filter((c) => !isValueLike(c));
  if (names.length * 2 <= row.length) return false;
  const distinct = new Set(nonEmpty.map((c) => normaliseColumn(c))).size;
  return distinct >= Math.ceil(nonEmpty.length * 0.6);
}

function dedupeHeaders(raw: string[], warnings: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, i) => {
    const base = cell.trim() === "" ? `Column ${i + 1}` : cell.trim();
    if (cell.trim() === "") warnings.push(`Column ${i + 1} has no name in the header row; it is shown as "${base}".`);
    const key = normaliseColumn(base) || `column_${i + 1}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return base;
    const name = `${base} (${n})`;
    warnings.push(`Column ${i + 1} repeats the name "${base}"; it is shown as "${name}".`);
    return name;
  });
}

/**
 * Reads `text` into a header and rows, reporting everything it had to assume.
 *
 * A blank cell stays blank: nothing here substitutes a zero or a default.
 */
export function previewCsv(text: string, opts: PreviewCsvOptions = {}): CsvPreview {
  const maxRows = Math.max(0, opts.maxRows ?? MAX_PREVIEW_ROWS);
  const warnings: string[] = [];
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (clean.trim() === "") {
    return { delimiter: ",", headers: [], rows: [], totalRows: 0, truncated: false, warnings: ["There is nothing to read: the file is empty."], preambleRows: 0 };
  }

  const delimiter = detectDelimiter(clean);
  const all = parseCsv(clean, delimiter);
  const nonBlank = all.filter((r) => !isBlankRow(r));
  if (nonBlank.length === 0) {
    return { delimiter, headers: [], rows: [], totalRows: 0, truncated: false, warnings: ["There is nothing to read: every line is blank."], preambleRows: 0 };
  }
  const blankLines = all.length - nonBlank.length;
  if (blankLines > 0) warnings.push(`${blankLines} blank line${blankLines === 1 ? "" : "s"} skipped.`);

  const modalWidth = modalCount(nonBlank.slice(0, 50).map((r) => r.length));
  let headerIndex = nonBlank.findIndex((r) => looksLikeHeaderRow(r, modalWidth));
  if (headerIndex < 0) {
    headerIndex = 0;
    warnings.push("No row looked like a header, so the first row is used as the column names. Check the mapping below.");
  }
  if (headerIndex > 0) {
    warnings.push(`${headerIndex} row${headerIndex === 1 ? "" : "s"} above the column names were skipped as preamble: ${nonBlank.slice(0, headerIndex).map((r) => `"${r.filter((c) => c !== "").join(" ").slice(0, 60)}"`).join(", ")}.`);
  }

  let headerCells = nonBlank[headerIndex];
  while (headerCells.length > 1 && headerCells[headerCells.length - 1] === "") headerCells = headerCells.slice(0, -1);
  const headers = dedupeHeaders(headerCells, warnings);

  const rows: string[][] = [];
  let totalRows = 0;
  const ragged: string[] = [];
  for (let i = headerIndex + 1; i < nonBlank.length; i++) {
    const row = nonBlank[i];
    totalRows++;
    const rowNumber = totalRows + 1; // the header is row 1
    if (row.length !== headers.length && ragged.length < 10) {
      const extra = row.slice(headers.length).filter((c) => c !== "");
      if (row.length > headers.length && extra.length > 0) ragged.push(`Row ${rowNumber} has ${row.length} values but there are ${headers.length} columns; the extra values (${extra.map((c) => `"${c}"`).join(", ")}) were ignored.`);
      else if (row.length < headers.length) ragged.push(`Row ${rowNumber} has only ${row.length} value${row.length === 1 ? "" : "s"} but there are ${headers.length} columns; the missing cells were read as blank.`);
    }
    if (rows.length < maxRows) rows.push(Array.from({ length: headers.length }, (_, c) => row[c] ?? ""));
  }
  warnings.push(...ragged);
  const raggedTotal = nonBlank.slice(headerIndex + 1).filter((r) => r.length !== headers.length).length;
  if (raggedTotal > ragged.length) warnings.push(`${raggedTotal - ragged.length} further row${raggedTotal - ragged.length === 1 ? " has" : "s have"} a different number of values from the header.`);

  const truncated = rows.length < totalRows;
  if (truncated) warnings.push(`Only the first ${rows.length.toLocaleString("en-GB")} of ${totalRows.toLocaleString("en-GB")} rows were read.`);

  return { delimiter, headers, rows, totalRows, truncated, warnings, preambleRows: headerIndex };
}
