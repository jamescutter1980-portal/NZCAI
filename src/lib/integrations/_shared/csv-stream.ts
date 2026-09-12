import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { parseCsv } from "./csv";

/**
 * Streaming companion to `csv.ts` for bulk files too large to hold as one
 * string (Scottish EPC extracts, DESNZ postcode consumption, ONSPD). Same
 * RFC 4180 rules as `parseCsv`: quoted fields, doubled quotes, line breaks
 * inside quotes, CRLF/LF, a UTF-8 BOM, trimmed cells. Rows are yielded one at
 * a time so memory stays flat regardless of file size.
 *
 * Files are decoded as UTF-8; bytes that are not valid UTF-8 (some
 * publishers save CSVs as Windows-1252) become U+FFFD but never break a row.
 */

export interface StreamCsvOptions {
  signal?: AbortSignal;
  /** Read chunk size in bytes (tests use a tiny value to exercise chunk boundaries). */
  highWaterMark?: number;
}

export async function* streamCsvRows(path: string, opts: StreamCsvOptions = {}): AsyncGenerator<string[]> {
  const stream = createReadStream(path, { highWaterMark: opts.highWaterMark ?? 1 << 20 });
  const decoder = new TextDecoder("utf-8");
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  let first = true;
  // A '"' seen inside quotes as the last character of a chunk: escaped or closing? Resolved on the next character.
  let pendingQuote = false;
  // A '\r' ended a row; swallow one following '\n' even across a chunk boundary.
  let skipLf = false;

  const finishRow = (): string[] => {
    row.push(field.trim());
    const out = row;
    row = [];
    field = "";
    return out;
  };

  try {
    for await (const chunk of stream) {
      if (opts.signal?.aborted) throw new Error("CSV scan aborted");
      let text = decoder.decode(chunk as Buffer, { stream: true });
      if (first) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        first = false;
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        sawAny = true;
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
          // fall through: ch is processed as an unquoted character
        }
        if (inQuotes) {
          if (ch === '"') {
            if (i + 1 >= text.length) pendingQuote = true;
            else if (text[i + 1] === '"') {
              field += '"';
              i++;
            } else inQuotes = false;
          } else field += ch;
          continue;
        }
        if (skipLf) {
          skipLf = false;
          if (ch === "\n") continue;
        }
        if (ch === '"') inQuotes = true;
        else if (ch === ",") {
          row.push(field.trim());
          field = "";
        } else if (ch === "\r") {
          skipLf = true;
          yield finishRow();
        } else if (ch === "\n") yield finishRow();
        else field += ch;
      }
    }
    if (pendingQuote) inQuotes = false;
    if (sawAny && (field.length > 0 || row.length > 0)) yield finishRow();
  } finally {
    stream.destroy();
  }
}

export interface ScanCsvOptions extends StreamCsvOptions {
  /** Chooses the header row; defaults to the first row with any non-empty cell. */
  isHeader?: (row: string[]) => boolean;
  /** Give up if no header is found within this many rows (default 20). */
  maxHeaderSearch?: number;
}

export interface ScanResult {
  header: string[];
  /** Zero-based index of the header row in the file. */
  headerRowIndex: number;
  /** Data rows visited (empty rows skipped). */
  rows: number;
  /** True when `visit` returned false to stop early. */
  stopped: boolean;
}

/**
 * Streams a CSV, finds the header, then calls `visit` for each non-empty data
 * row (cells by position; map them with `columnIndexes`). Return `false` from
 * `visit` to stop early.
 */
export async function scanCsv(path: string, opts: ScanCsvOptions, visit: (row: string[], header: string[]) => boolean | void): Promise<ScanResult> {
  const isHeader = opts.isHeader ?? ((row: string[]) => row.some((c) => c !== ""));
  const maxHeaderSearch = opts.maxHeaderSearch ?? 20;
  let header: string[] | undefined;
  let headerRowIndex = -1;
  let index = -1;
  let rows = 0;
  let stopped = false;
  for await (const row of streamCsvRows(path, opts)) {
    index++;
    if (!header) {
      if (isHeader(row)) {
        header = row;
        headerRowIndex = index;
      } else if (index + 1 >= maxHeaderSearch) {
        throw new Error(`${path}: no header row found in the first ${maxHeaderSearch} rows`);
      }
      continue;
    }
    if (row.every((c) => c === "")) continue;
    rows++;
    if (visit(row, header) === false) {
      stopped = true;
      break;
    }
  }
  if (!header) throw new Error(`${path}: CSV has no header row`);
  return { header, headerRowIndex, rows, stopped };
}

/**
 * Reads only the first `maxBytes` of a file and returns its leading rows, so a
 * header can be inspected without scanning a multi-hundred-megabyte file.
 * The last row may be truncated; callers should only use it for header detection.
 */
export function peekCsvRows(path: string, maxBytes = 256 * 1024): string[][] {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const rows = parseCsv(text);
    // Drop a possibly truncated final row unless the file ended within the window.
    return n < maxBytes ? rows : rows.slice(0, -1);
  } finally {
    closeSync(fd);
  }
}
