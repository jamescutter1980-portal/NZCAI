/**
 * The contract a caller instantiates per import type, plus the ready-made cell
 * parsers every caller needs.
 *
 * Consultancy users receive client data as spreadsheets that have been edited
 * by hand, mailed around and re-saved by Excel, so the parsers here are
 * deliberately tolerant of presentation (thousands separators, currency signs,
 * trailing units, day-first dates, Excel date serials) and deliberately
 * intolerant of guesswork: an ambiguous value is an error naming both readings,
 * never a silent choice.
 *
 * House rules (docs/assets-and-carbon.md) apply to every field:
 *
 * - **Blank is never zero.** A blank cell is "not supplied". `applyMapping`
 *   never calls a parser with a blank string: a blank in a required field is an
 *   error, a blank in an optional field leaves the key absent from the row.
 * - **Provenance and basis travel with the value.** A parser returns the value
 *   as written (converted, never rescaled): a percentage is not divided by 100,
 *   a unit suffix is stripped but not converted, so the caller's own unit and
 *   basis stay the authority.
 *
 * Every parser is a factory, so they read the same in a spec:
 *
 * ```ts
 * const spec: ImportSpec = {
 *   id: "meter-readings",
 *   label: "Meter readings",
 *   fields: [
 *     { name: "mpan", label: "MPAN", required: true, parse: textField({ pattern: /^\d{13}$/ }) },
 *     { name: "readAt", label: "Read date", required: true, aliases: ["date"], parse: dateField() },
 *     { name: "kwh", label: "Consumption (kWh)", required: true, parse: numberField({ min: 0 }) },
 *   ],
 * };
 * ```
 */

import { normaliseColumn } from "@/lib/integrations/_shared/columns";
import { toCsv } from "@/lib/export/csv";

export type FieldParse<V> = (raw: string, row: Record<string, string>) => { ok: true; value: V } | { ok: false; error: string };

export interface ImportField {
  /** Key the parsed value is stored under. */
  name: string;
  /** Human label, shown in the mapping UI and used for matching. */
  label: string;
  required?: boolean;
  /** Extra header spellings to match, beyond the name and label. */
  aliases?: string[];
  /** One line of guidance shown under the mapping select. */
  help?: string;
  /** A realistic value, used in the downloadable template. */
  example?: string;
  parse: FieldParse<unknown>;
}

export interface ImportSpec {
  id: string;
  label: string;
  description?: string;
  fields: ImportField[];
  /** Cross-field checks run once a row's own fields have parsed. Return one message per problem. */
  rowCheck?: (row: Record<string, unknown>, rowNumber: number) => string[];
}

/** The subset of a field a presentational component needs; `parse` is optional there. */
export interface ImportFieldDescriptor {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  example?: string;
}

const ok = <V,>(value: V) => ({ ok: true as const, value });
const err = (error: string) => ({ ok: false as const, error });

const quote = (raw: string) => `"${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}"`;

const BLANK = "is blank (a blank cell is never read as zero)";

/* -------------------------------------------------------------------------- */
/* text                                                                       */
/* -------------------------------------------------------------------------- */

export interface TextFieldOptions {
  maxLength?: number;
  minLength?: number;
  /** Must match, or the cell is an error. */
  pattern?: RegExp;
  /** What the pattern means, in the user's words ("13 digits"). */
  patternMessage?: string;
  /** Upper-case the value (codes, references). */
  upper?: boolean;
}

/** Trimmed text with internal runs of whitespace collapsed to one space. */
export function textField(opts: TextFieldOptions = {}): FieldParse<string> {
  return (raw) => {
    let value = raw.trim().replace(/\s+/g, " ");
    if (value === "") return err(BLANK);
    if (opts.upper) value = value.toUpperCase();
    if (opts.minLength !== undefined && value.length < opts.minLength) return err(`${quote(raw)} is too short (at least ${opts.minLength} characters)`);
    if (opts.maxLength !== undefined && value.length > opts.maxLength) return err(`${quote(raw)} is too long (at most ${opts.maxLength} characters)`);
    if (opts.pattern && !opts.pattern.test(value)) return err(`${quote(raw)} is not ${opts.patternMessage ?? `in the expected format (${String(opts.pattern)})`}`);
    return ok(value);
  };
}

/* -------------------------------------------------------------------------- */
/* numbers                                                                    */
/* -------------------------------------------------------------------------- */

const CURRENCY = /[£$€¥₹]/g;
const SPACES_G = /[\s    ]/g;
const HAS_SPACE = /[\s    ]/;

/**
 * Reads a number the way a spreadsheet shows one.
 *
 * Accepted: `1234`, `1,234.5` (comma thousands, dot decimal), `1 234.5` and
 * `1 234,5` (space thousands), `£1,234`, `1234 kWh`, `45%` (the number as
 * written; it is not divided), `(1,234)` for -1234, `1.2e3`.
 *
 * Rejected, with an error naming both readings rather than a guess: `1.234,5`
 * and `1.234.567` (dot thousands), `1234,567` (could be 1234567 or 1234.567),
 * and any text a number cannot be read from (`N/A`, `-`, `TBC`).
 */
export function parseNumberText(rawIn: string): { ok: true; value: number } | { ok: false; error: string } {
  const raw = rawIn.trim();
  if (raw === "") return err(BLANK);

  let s = raw.replace(CURRENCY, "").trim();
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  if (/^[+-]/.test(s)) {
    if (s.startsWith("-")) sign = -sign;
    s = s.slice(1).trim();
  }

  const m = s.match(/^([0-9][0-9\s    .,]*(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) return err(`${quote(raw)} is not a number`);
  const numeric = m[1].trim();
  const trailing = m[2].trim();
  // A unit may carry a digit ("t CO2e", "m2"); a second free-standing number means the cell is not one value.
  if (/^\d/.test(trailing) || /\s\d/.test(trailing)) return err(`${quote(raw)} is not a number (there is more text after the number: ${quote(trailing)})`);

  if (HAS_SPACE.test(numeric.replace(/^[\s ]+|[\s ]+$/g, ""))) {
    if (!/^\d{1,3}(?:[\s    ]\d{3})+(?:[.,]\d+)?$/.test(numeric)) {
      return err(`${quote(raw)} has spaces inside the number that are not thousands separators; write it without spaces`);
    }
  }
  let body = numeric.replace(SPACES_G, "");

  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;
  const exponent = body.match(/[eE][+-]?\d+$/)?.[0] ?? "";
  if (exponent) body = body.slice(0, body.length - exponent.length);

  if (commas > 0 && dots > 0) {
    if (body.lastIndexOf(".") > body.lastIndexOf(",")) {
      if (!/^\d{1,3}(,\d{3})+\.\d+$/.test(body)) return err(`${quote(raw)} mixes "," and "." in a way that is not a thousands separator plus a decimal point; write it as a plain number such as 1234.5`);
      body = body.replace(/,/g, "");
    } else {
      return err(`${quote(raw)} uses "." for thousands and "," for the decimal point; write it as a plain number such as 1234.5`);
    }
  } else if (commas > 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(body)) body = body.replace(/,/g, "");
    else if (commas === 1) {
      const [before, after] = body.split(",");
      if (!/^\d+$/.test(before) || !/^\d+$/.test(after)) return err(`${quote(raw)} is not a number`);
      if (after.length === 3) return err(`${quote(raw)} is ambiguous: it could be ${before}${after} or ${before}.${after}; write it as a plain number with a dot decimal point`);
      body = `${before}.${after}`;
    } else return err(`${quote(raw)} is ambiguous: the commas are not thousands separators; write it as a plain number with a dot decimal point`);
  } else if (dots > 1) {
    return err(`${quote(raw)} uses "." for thousands; write it as a plain number such as ${body.replace(/\./g, "")}`);
  }

  if (!/^\d+(\.\d+)?$/.test(body)) return err(`${quote(raw)} is not a number`);
  const value = sign * Number(`${body}${exponent}`);
  if (!Number.isFinite(value)) return err(`${quote(raw)} is not a finite number`);
  return ok(value);
}

export interface NumberFieldOptions {
  min?: number;
  max?: number;
  /** Reject a value with a fractional part. */
  integer?: boolean;
}

/** A decimal number. See `parseNumberText` for the accepted presentations. */
export function numberField(opts: NumberFieldOptions = {}): FieldParse<number> {
  return (raw) => {
    const parsed = parseNumberText(raw);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    if (opts.integer && !Number.isInteger(value)) return err(`${quote(raw)} must be a whole number`);
    if (opts.min !== undefined && value < opts.min) return err(`${value} is below the minimum of ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) return err(`${value} is above the maximum of ${opts.max}`);
    return ok(value);
  };
}

/** A whole number. `1,234` and `1 234` are accepted; `12.5` is an error. */
export function integerField(opts: Omit<NumberFieldOptions, "integer"> = {}): FieldParse<number> {
  return numberField({ ...opts, integer: true });
}

/* -------------------------------------------------------------------------- */
/* dates                                                                      */
/* -------------------------------------------------------------------------- */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_FIRST = "dates are read day first (DD/MM/YYYY), as UK spreadsheets are written";
/** Excel's day 0 is 1899-12-30 once its non-existent 29 February 1900 is allowed for. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const EXCEL_MAX = 2958465; // 9999-12-31

function isoOf(y: number, m: number, d: number): { ok: true; value: string } | { ok: false; error: string } {
  if (m < 1 || m > 12) return err(`month ${m} does not exist`);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > days) return err(`${String(m).padStart(2, "0")}/${y} has ${days} days, so day ${d} does not exist`);
  return ok(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

const fullYear = (y: number) => (y >= 100 ? y : y <= 69 ? 2000 + y : 1900 + y);

/**
 * Reads a date and returns it as `YYYY-MM-DD`.
 *
 * Accepted: `2024-01-15` (and an ISO date-time, whose time is dropped),
 * `15/01/2024`, `15-01-2024`, `15.01.2024`, `15/01/24`, `20240115`,
 * `15 Jan 2024`, `Jan 15 2024`, and an Excel date serial such as `45306`.
 *
 * Slash and dash forms are read **day first**; `03/04/2024` is 3 April 2024,
 * and any error on such a value says so, because a US-style `03/15/2024` is
 * the usual reason a column fails.
 */
export function parseDateText(rawIn: string): { ok: true; value: string } | { ok: false; error: string } {
  const raw = rawIn.trim();
  if (raw === "") return err(BLANK);

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/);
  if (iso) {
    const r = isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return r.ok ? r : err(`${quote(raw)} is not a valid date: ${r.error}`);
  }

  const dmy = raw.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2}|\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = fullYear(Number(dmy[3]));
    if (m > 12) {
      const hint = d <= 12 ? ` — ${quote(raw)} looks like a month-first (US) date` : "";
      return err(`${quote(raw)} is not a valid date: ${DAY_FIRST}, so ${m} is not a month${hint}`);
    }
    const r = isoOf(y, m, d);
    return r.ok ? r : err(`${quote(raw)} is not a valid date: ${r.error} (${DAY_FIRST})`);
  }

  const named = raw.match(/^(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,})\.?\s*[-\s]\s*(\d{2}|\d{4})$/);
  const namedFirst = raw.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})\s*,?\s*(\d{2}|\d{4})$/);
  const parts = named ? { d: named[1], mon: named[2], y: named[3] } : namedFirst ? { d: namedFirst[2], mon: namedFirst[1], y: namedFirst[3] } : null;
  if (parts) {
    const m = MONTHS.indexOf(parts.mon.slice(0, 3).toLowerCase()) + 1;
    if (m === 0) return err(`${quote(raw)} is not a valid date: ${quote(parts.mon)} is not a month name`);
    const r = isoOf(fullYear(Number(parts.y)), m, Number(parts.d));
    return r.ok ? r : err(`${quote(raw)} is not a valid date: ${r.error}`);
  }

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact && Number(compact[1]) >= 1900 && Number(compact[1]) <= 2999) {
    const r = isoOf(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    return r.ok ? r : err(`${quote(raw)} is not a valid date: ${r.error}`);
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial === 60) return err(`${quote(raw)} is Excel's 29 February 1900, a day that does not exist; re-enter the date as YYYY-MM-DD`);
    if (serial < 61 || serial > EXCEL_MAX) return err(`${quote(raw)} is a number, not a date; write it as YYYY-MM-DD or DD/MM/YYYY`);
    const value = new Date(EXCEL_EPOCH + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
    return ok(value);
  }

  return err(`${quote(raw)} is not a date; write it as YYYY-MM-DD or DD/MM/YYYY (${DAY_FIRST})`);
}

export interface DateFieldOptions {
  /** Inclusive bounds as YYYY-MM-DD. */
  min?: string;
  max?: string;
}

/** A date, returned as `YYYY-MM-DD`. See `parseDateText` for the accepted forms. */
export function dateField(opts: DateFieldOptions = {}): FieldParse<string> {
  return (raw) => {
    const parsed = parseDateText(raw);
    if (!parsed.ok) return parsed;
    if (opts.min && parsed.value < opts.min) return err(`${parsed.value} is before ${opts.min}`);
    if (opts.max && parsed.value > opts.max) return err(`${parsed.value} is after ${opts.max}`);
    return parsed;
  };
}

/* -------------------------------------------------------------------------- */
/* enum, boolean, registration                                                */
/* -------------------------------------------------------------------------- */

export interface EnumFieldOptions<V extends string> {
  /** Spellings clients actually send, mapped to the value they mean. */
  aliases?: Record<string, V>;
}

/** One of a fixed set, matched ignoring case, punctuation and spacing. */
export function enumField<V extends string>(values: readonly V[], opts: EnumFieldOptions<V> = {}): FieldParse<V> {
  const byNorm = new Map<string, V>();
  for (const v of values) byNorm.set(normaliseColumn(v), v);
  for (const [alias, v] of Object.entries(opts.aliases ?? {})) byNorm.set(normaliseColumn(alias), v);
  return (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") return err(BLANK);
    const hit = byNorm.get(normaliseColumn(trimmed));
    if (hit === undefined) return err(`${quote(trimmed)} is not one of: ${values.join(", ")}`);
    return ok(hit);
  };
}

const TRUE = new Set(["yes", "y", "true", "t", "1"]);
const FALSE = new Set(["no", "n", "false", "f", "0"]);

/** yes/no, true/false, y/n or 1/0, in any case. */
export function booleanField(): FieldParse<boolean> {
  return (raw) => {
    const v = raw.trim().toLowerCase();
    if (v === "") return err(BLANK);
    if (TRUE.has(v)) return ok(true);
    if (FALSE.has(v)) return ok(false);
    return err(`${quote(raw)} is not yes or no (accepted: yes, no, true, false, y, n, 1, 0)`);
  };
}

const VRM_FORMATS = [
  /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/, // current, AB12CDE
  /^[A-Z][0-9]{1,3}[A-Z]{3}$/, // prefix, A123BCD
  /^[A-Z]{3}[0-9]{1,3}[A-Z]$/, // suffix, ABC123D
  /^[A-Z]{1,3}[0-9]{1,4}$/, // dateless
  /^[0-9]{1,4}[A-Z]{1,3}$/, // reversed dateless
];

export interface RegistrationFieldOptions {
  /** Reject anything that is not a recognised UK VRM format (off by default: personalised and imported plates vary). */
  strict?: boolean;
}

/** A UK vehicle registration mark: upper-cased with spaces, dots and dashes removed. */
export function registrationField(opts: RegistrationFieldOptions = {}): FieldParse<string> {
  return (raw) => {
    const value = raw.toUpperCase().replace(/[\s.\-_]/g, "");
    if (value === "") return err(BLANK);
    if (!/^[A-Z0-9]{2,8}$/.test(value)) return err(`${quote(raw)} is not a registration (letters and digits only, 2 to 8 characters)`);
    if (opts.strict && !VRM_FORMATS.some((re) => re.test(value))) return err(`${quote(raw)} is not a recognised UK registration format, such as AB12CDE`);
    return ok(value);
  };
}

/* -------------------------------------------------------------------------- */
/* template                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A one-row template CSV: the field labels as the header and each field's
 * example beneath, written with the same RFC 4180 rules and Excel guards as
 * every other export. Required labels are marked with `*`.
 */
export function templateCsv(spec: { fields: readonly ImportFieldDescriptor[] }): string {
  const header = spec.fields.map((f) => (f.required ? `${f.label}*` : f.label));
  const example = spec.fields.map((f) => f.example ?? "");
  const rows = example.some((v) => v !== "") ? [example] : [];
  return toCsv(header, rows, { bom: true });
}
