"use client";

/**
 * Generic CSV import: paste or choose a file, check the preview, map the
 * columns, read the errors, commit.
 *
 * The component is presentational and knows nothing about what is being
 * imported: it takes a spec describing the fields and an `onCommit` that does
 * the work. Give the spec's fields their `parse` functions (from
 * `@/lib/import`) and every value is validated here before commit; give it
 * labels only and the component still previews, maps and checks that required
 * cells are present.
 *
 * Nothing is uploaded: the file is read in the browser with FileReader.
 */

import { useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import { applyMapping, mappingIssues, previewCsv, suggestMapping, templateCsv, textField, delimiterName, type ColumnMapping, type FieldParse, type ImportSpec } from "@/lib/import";

export interface CsvImportField {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  example?: string;
  /** Optional: with it, values are parsed and checked; without it, the cell text is kept as written. */
  parse?: FieldParse<unknown>;
}

export interface CsvImportProps {
  spec: { id: string; label: string; description?: string; fields: CsvImportField[] };
  onCommit: (rows: Record<string, unknown>[]) => Promise<{ ok: boolean; message: string }>;
  /** A few realistic lines the user can load to see the shape expected. */
  sampleCsv?: string;
}

const PREVIEW_ROWS = 20;
const MAX_SHOWN_ERRORS = 20;

const BORDER = "#ddd";
const ERROR = "#b02a37";
const WARNING = "#856404";
const SUCCESS = "#1e7e34";
const MUTED = "#555";

const font = { fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" } as const;
const panel = { border: `1px solid ${BORDER}`, borderRadius: 4, padding: 12, marginTop: 12 } as const;
const th = { border: `1px solid ${BORDER}`, padding: "4px 6px", background: "#f7f7f7", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" } as const;
const td = { border: `1px solid ${BORDER}`, padding: "4px 6px", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" } as const;
const sel = { fontSize: 13, padding: "2px 4px", marginTop: 2, maxWidth: 240 } as const;

export function CsvImport({ spec, onCommit, sampleCsv }: CsvImportProps) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappedFor, setMappedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A spec whose fields all parse: a field given no parser keeps its cell text.
  const runtimeSpec = useMemo<ImportSpec>(
    () => ({ id: spec.id, label: spec.label, description: spec.description, fields: spec.fields.map((f) => ({ ...f, parse: f.parse ?? textField() })) }),
    [spec],
  );

  const preview = useMemo(() => (text.trim() === "" ? null : previewCsv(text)), [text]);
  const headerKey = preview ? `${preview.delimiter}␟${preview.headers.join("␟")}` : null;

  // Re-suggest whenever a different set of columns arrives; the user's own
  // choices survive every other render.
  if (headerKey !== null && headerKey !== mappedFor) {
    setMapping(suggestMapping(runtimeSpec, preview?.headers ?? []));
    setMappedFor(headerKey);
  }

  const result = useMemo(() => (preview && preview.headers.length > 0 ? applyMapping(runtimeSpec, preview.headers, preview.rows, mapping) : null), [preview, runtimeSpec, mapping]);
  const issues = useMemo(() => (preview ? mappingIssues(runtimeSpec, mapping) : []), [preview, runtimeSpec, mapping]);
  const template = useMemo(() => `data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv(spec))}`, [spec]);

  const load = useCallback((next: string, name: string | null) => {
    setText(next);
    setFileName(name);
    setStatus(null);
  }, []);

  const onFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => setStatus({ ok: false, message: `${file.name} could not be read.` });
      reader.onload = () => load(String(reader.result ?? ""), file.name);
      reader.readAsText(file, "utf-8");
    },
    [load],
  );

  const commit = useCallback(async () => {
    if (!result || result.rows.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      setStatus(await onCommit(result.rows.map((r) => r.data)));
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : "The import failed." });
    } finally {
      setBusy(false);
    }
  }, [onCommit, result]);

  const ready = issues.length === 0 && (result?.rows.length ?? 0) > 0 && !busy;
  const shownErrors = result?.errors.slice(0, MAX_SHOWN_ERRORS) ?? [];

  return (
    <section style={{ ...font, fontSize: 14, color: "#111", maxWidth: 1100 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>{spec.label}</h2>
      {spec.description && <p style={{ margin: "0 0 8px", color: MUTED }}>{spec.description}</p>}

      <div style={panel}>
        <label htmlFor={`${spec.id}-paste`} style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
          1. Paste the rows, or choose a file
        </label>
        <textarea
          id={`${spec.id}-paste`}
          value={text}
          onChange={(e) => load(e.target.value, null)}
          rows={6}
          spellCheck={false}
          placeholder="Paste the spreadsheet here, including the header row. Commas, semicolons, tabs and pipes are all read."
          style={{ ...font, width: "100%", fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", border: `1px solid ${BORDER}`, borderRadius: 4, padding: 8, boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <input ref={fileInput} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={onFile} style={{ fontSize: 13 }} />
          <a href={template} download={`${spec.id}-template.csv`} style={{ fontSize: 13 }}>
            Download the template
          </a>
          {sampleCsv && (
            <button type="button" onClick={() => load(sampleCsv, "sample")} style={{ fontSize: 12, padding: "2px 6px" }}>
              Load a sample
            </button>
          )}
          {text !== "" && (
            <button
              type="button"
              onClick={() => {
                if (fileInput.current) fileInput.current.value = "";
                load("", null);
                setMappedFor(null);
              }}
              style={{ fontSize: 12, padding: "2px 6px" }}
            >
              Clear
            </button>
          )}
          {fileName && <span style={{ fontSize: 12, color: MUTED }}>Read in this browser from {fileName}; nothing was uploaded.</span>}
        </div>
      </div>

      {preview && preview.headers.length === 0 && <p style={{ ...panel, color: ERROR, borderColor: ERROR }}>{preview.warnings.join(" ")}</p>}

      {preview && preview.headers.length > 0 && (
        <>
          <div style={panel}>
            <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>2. Check the preview</h3>
            <p style={{ margin: "0 0 8px", color: MUTED, fontSize: 13 }}>
              {preview.totalRows.toLocaleString("en-GB")} row{preview.totalRows === 1 ? "" : "s"} and {preview.headers.length} columns, read as {delimiterName(preview.delimiter)}-separated
              {preview.preambleRows > 0 ? `, after skipping ${preview.preambleRows} row${preview.preambleRows === 1 ? "" : "s"} of preamble` : ""}. The first {Math.min(PREVIEW_ROWS, preview.rows.length)} rows are shown.
            </p>
            {preview.warnings.length > 0 && (
              <ul style={{ margin: "0 0 8px", paddingLeft: 18, color: WARNING, fontSize: 13 }}>
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, color: MUTED }}>Row</th>
                    {preview.headers.map((h) => (
                      <th key={h} style={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                    <tr key={i}>
                      <td style={{ ...td, color: MUTED }}>{i + 2}</td>
                      {preview.headers.map((h, c) => (
                        <td key={h} style={td}>
                          {row[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={panel}>
            <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>3. Map the columns</h3>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {spec.fields.map((f) => {
                const unmappedRequired = f.required && (mapping[f.name] === null || mapping[f.name] === undefined);
                return (
                  <div key={f.name} style={{ minWidth: 200 }}>
                    <label htmlFor={`${spec.id}-map-${f.name}`} style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                      {f.label}
                      {f.required && <span style={{ color: ERROR }}> *</span>}
                    </label>
                    <select
                      id={`${spec.id}-map-${f.name}`}
                      value={mapping[f.name] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [f.name]: e.target.value === "" ? null : Number(e.target.value) })}
                      style={{ ...sel, borderColor: unmappedRequired ? ERROR : BORDER }}
                    >
                      <option value="">Not mapped</option>
                      {preview.headers.map((h, i) => (
                        <option key={h} value={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {f.help && <p style={{ margin: "2px 0 0", fontSize: 11, color: MUTED, maxWidth: 240 }}>{f.help}</p>}
                    {f.example && <p style={{ margin: 0, fontSize: 11, color: MUTED }}>For example: {f.example}</p>}
                  </div>
                );
              })}
            </div>
            {issues.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: ERROR, fontSize: 13 }}>
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </div>

          {result && (
            <div style={panel}>
              <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>4. Check the values</h3>
              <p style={{ margin: "0 0 8px", fontWeight: 600, color: result.errors.length > 0 ? WARNING : SUCCESS }}>{result.summary}</p>
              {result.errors.length === 0 && result.rows.length > 0 && <p style={{ margin: 0, fontSize: 13, color: SUCCESS }}>Every row was read.</p>}
              {shownErrors.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, color: ERROR, fontSize: 13 }}>
                  {shownErrors.map((e, i) => (
                    <li key={`${e.rowNumber}-${e.field ?? "row"}-${i}`}>
                      <strong>Row {e.rowNumber}</strong>
                      {e.column ? `, column “${e.column}”` : ""}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {result.errors.length > shownErrors.length && (
                <p style={{ margin: "6px 0 0", fontSize: 13, color: ERROR }}>
                  and {(result.errors.length - shownErrors.length).toLocaleString("en-GB")} further error{result.errors.length - shownErrors.length === 1 ? "" : "s"}. Fix these in the spreadsheet and paste it again.
                </p>
              )}
            </div>
          )}

          <div style={{ ...panel, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={commit} disabled={!ready} style={{ fontSize: 14, padding: "6px 12px", cursor: ready ? "pointer" : "not-allowed" }}>
              {busy ? "Importing…" : `Import ${(result?.rows.length ?? 0).toLocaleString("en-GB")} row${(result?.rows.length ?? 0) === 1 ? "" : "s"}`}
            </button>
            {!ready && !busy && <span style={{ fontSize: 13, color: MUTED }}>{issues.length > 0 ? "Map every required column first." : "No row can be imported yet."}</span>}
            {result && result.errors.length > 0 && ready && <span style={{ fontSize: 13, color: WARNING }}>Rows with errors are not imported.</span>}
          </div>
        </>
      )}

      {status && (
        <p style={{ ...panel, margin: "12px 0 0", color: status.ok ? SUCCESS : ERROR, borderColor: status.ok ? SUCCESS : ERROR }}>{status.message}</p>
      )}
    </section>
  );
}

export default CsvImport;
