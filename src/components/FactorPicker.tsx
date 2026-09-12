"use client";

import { useEffect, useState } from "react";

export interface FactorRowView {
  id: string; scope: string; level1: string; level2: string; level3: string; level4: string;
  columnText: string; uom: string; ghgUnit: string; factor: number | null; availability: string;
}

export function factorLabel(r: FactorRowView): string {
  return [r.level1, r.level2, r.level3, r.level4, r.columnText].filter(Boolean).join(" · ");
}

/**
 * Picks a published DESNZ row for an activity. Only rows from the loaded flat
 * file are offered, so the portal never presents a factor it does not hold.
 */
export function FactorPicker({
  year,
  value,
  onSelect,
}: {
  year: number;
  value?: { id: string; year: number; uom: string } | null;
  onSelect: (row: FactorRowView | null) => void;
}) {
  const [q, setQ] = useState("");
  const [level1, setLevel1] = useState("");
  const [rows, setRows] = useState<FactorRowView[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ year: String(year), limit: "60" });
    if (q.trim()) params.set("q", q.trim());
    if (level1) params.set("level1", level1);
    const timer = setTimeout(() => {
      fetch(`/api/factors?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((b) => {
          setRows(b.rows ?? []);
          setLevels(b.levels ?? []);
          setTotal(b.total ?? 0);
          setDetail(b.detail ?? null);
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, level1, year, open]);

  return (
    <div style={{ border: "1px solid #ddd", padding: 8, background: "#fff" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Conversion factor</strong>
        {value ? (
          <span style={{ fontSize: 12 }}>
            DESNZ {value.year} row {value.id} (per {value.uom}){" "}
            <button type="button" onClick={() => onSelect(null)} style={mini}>clear</button>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#b02a37" }}>none chosen — the line will report as unavailable</span>
        )}
        <button type="button" onClick={() => setOpen(!open)} style={mini}>{open ? "Close" : "Choose"}</button>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the loaded factor file" style={{ padding: 6, minWidth: 240 }} />
            <select value={level1} onChange={(e) => setLevel1(e.target.value)} style={{ padding: 6 }}>
              <option value="">All categories</option>
              {levels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <span style={{ fontSize: 12, color: "#666", alignSelf: "center" }}>{total} matching, showing {rows.length}</span>
          </div>
          {detail && <p style={{ fontSize: 12, color: "#b02a37" }}>{detail}</p>}
          <div style={{ maxHeight: 260, overflowY: "auto", marginTop: 6 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["", "Factor", "Per", "Scope", "Row"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>
                      <button type="button" onClick={() => { onSelect(r); setOpen(false); }} disabled={r.availability !== "available"} style={mini}>
                        {factorLabel(r)}
                      </button>
                    </td>
                    <td style={td}>{r.factor ?? <span style={{ color: "#b02a37" }}>not available</span>}</td>
                    <td style={td}>{r.uom}</td>
                    <td style={td}>{r.scope}</td>
                    <td style={td}>{r.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "4px 6px", fontSize: 11 };
const td = { borderBottom: "1px solid #eee", padding: "4px 6px", fontSize: 11 };
const mini = { padding: "2px 6px", fontSize: 11 };
