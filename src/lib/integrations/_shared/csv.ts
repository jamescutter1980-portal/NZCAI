/**
 * Minimal RFC 4180 CSV parser with no dependencies.
 *
 * Handles quoted fields, escaped quotes (""), commas and line breaks inside
 * quotes, CRLF and LF line endings, a UTF-8 BOM and a trailing newline. Used
 * by the reference-data loaders (DESNZ factors, AIB residual mix, CRREM
 * pathways, NZCBS limits). Values are returned as trimmed strings; a blank
 * cell is "" and must be interpreted by the caller (blank is never zero).
 */

export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\r") {
      // swallow; LF (if present) ends the row
      if (text[i + 1] !== "\n") {
        pushField();
        pushRow();
      }
    } else if (ch === "\n") {
      pushField();
      pushRow();
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

export interface CsvTable {
  header: string[];
  records: Record<string, string>[];
  /** Zero-based index of the header row in the file. */
  headerRowIndex: number;
}

export interface CsvToRecordsOptions {
  /**
   * Chooses the header row. Defaults to the first non-empty row. Reference
   * files exported from spreadsheets often carry preamble lines; pass a
   * predicate such as `(row) => row[0] === "ID"` to skip them.
   */
  isHeader?: (row: string[]) => boolean;
}

/** Rows keyed by header. Empty rows are skipped. Missing cells are "". */
export function csvToRecords(text: string, opts: CsvToRecordsOptions = {}): CsvTable {
  const rows = parseCsv(text);
  const isHeader = opts.isHeader ?? ((row: string[]) => row.some((c) => c !== ""));
  const headerRowIndex = rows.findIndex(isHeader);
  if (headerRowIndex < 0) throw new Error("CSV has no header row");
  const header = rows[headerRowIndex];
  const records: Record<string, string>[] = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => c === "")) continue;
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h === "") return;
      rec[h] = row[idx] ?? "";
    });
    records.push(rec);
  }
  return { header, records, headerRowIndex };
}

/**
 * Parses a numeric cell. Returns `null` for blank or non-numeric text so a
 * missing factor can never be read as 0. Accepts thousands separators and
 * scientific notation; rejects "N/A", "-", "ND" and similar.
 */
export function parseNumericCell(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim().replace(/,/g, "");
  if (v === "") return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ensures the header carries every required column; returns the missing ones. */
export function missingColumns(header: string[], required: string[]): string[] {
  const set = new Set(header.map((h) => h.toLowerCase()));
  return required.filter((c) => !set.has(c.toLowerCase()));
}
