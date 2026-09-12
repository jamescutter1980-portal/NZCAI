/**
 * A small RFC 4180 CSV writer.
 *
 * The portal's exports are opened in Excel by consultants and sent on to
 * clients and, in an ESOS or SECR evidence pack, to a regulator. So:
 *
 * - Fields containing a comma, a double quote, CR or LF are quoted, and
 *   embedded quotes are doubled (RFC 4180 s2.6, s2.7).
 * - Lines end CRLF (RFC 4180 s2.1).
 * - A UTF-8 BOM can be prepended so Excel on Windows reads the file as UTF-8
 *   rather than the local codepage.
 * - Text that Excel would evaluate as a formula (leading =, +, -, @, tab or
 *   CR) is prefixed with an apostrophe so the cell shows the text it was
 *   given. Numbers are written as numbers and are never guarded.
 *
 * Values are written unformatted: no thousands separators, no currency, no
 * percent signs. null and undefined become an empty field, which throughout
 * these exports means "unavailable", never zero.
 */

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvOptions {
  /** Prepend a UTF-8 byte order mark. Default false; the API route sets it. */
  bom?: boolean;
  /** Line terminator. Default CRLF, per RFC 4180. */
  eol?: string;
  /** Guard text Excel would treat as a formula. Default true. */
  guardFormulas?: boolean;
}

export const UTF8_BOM = "﻿";

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** True when Excel would evaluate the text rather than display it. */
export function looksLikeFormula(text: string): boolean {
  return FORMULA_START.test(text) && !NUMERIC_TEXT.test(text);
}

/** One field, quoted and escaped as needed. */
export function csvField(value: CsvValue, options: CsvOptions = {}): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  let text = value;
  if (options.guardFormulas !== false && looksLikeFormula(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record, without the line terminator. */
export function csvRow(fields: readonly CsvValue[], options: CsvOptions = {}): string {
  return fields.map((f) => csvField(f, options)).join(",");
}

/** A whole file: one header record then the data records. */
export function toCsv(header: readonly string[], rows: Iterable<readonly CsvValue[]>, options: CsvOptions = {}): string {
  const eol = options.eol ?? "\r\n";
  const parts: string[] = [csvRow(header, options)];
  for (const row of rows) parts.push(csvRow(row, options));
  return (options.bom ? UTF8_BOM : "") + parts.join(eol) + eol;
}

/**
 * Filesystem- and header-safe filename stem. Anything that is not a letter,
 * digit, dot, dash or underscore becomes a dash, so the value is safe to put
 * in a content-disposition header unquoted-ish and safe to save on any OS.
 */
export function safeFilename(stem: string, extension = "csv"): string {
  const cleaned = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return `${cleaned || "export"}.${extension}`;
}
