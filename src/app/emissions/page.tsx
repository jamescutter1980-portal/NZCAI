"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { FactorPicker, factorLabel, type FactorRowView } from "@/components/FactorPicker";
import { CsvImport } from "@/components/CsvImport";
import { siteActivityImportFields } from "@/lib/emissions/import-spec";

interface Line {
  id: string; category: string; categoryLabel: string; ghgCategory: string; scope: number; family: string;
  label: string; periodStart: string; periodEnd: string; quantity: number; unit: string; conversionNote?: string;
  refrigerantType?: string; wasteMaterial?: string;
  factor: { value: number | null; unit: string; basis: string; reference: string };
  kgCo2e: number | null; basis: string; warnings: string[];
}
interface Carbon {
  period: { label: string; factorYear: number };
  lines: Line[];
  byGhgCategory: { ghgCategory: string; scope: number; kgCo2e: number | null; lines: number; unresolved: number }[];
  totals: { scope1: number | null; scope3: number | null; total: number | null };
  byFamily: { refrigerant: number | null; water: number | null; waste: number | null };
  waste: { totalTonnes: number | null; divertedTonnes: number | null; landfillTonnes: number | null; diversionRatePct: number | null; detail: string };
  counts: { lines: number; resolved: number; unresolved: number };
  factorReferences: string[];
  warnings: string[];
}

const CATEGORIES: [string, string][] = [
  ["refrigerant_topup", "Refrigerant top-up or loss (Scope 1 fugitive)"],
  ["water_supply", "Water supplied (Scope 3 cat 1)"],
  ["water_treatment", "Water treated (Scope 3 cat 5)"],
  ["waste_landfill", "Waste to landfill (Scope 3 cat 5)"],
  ["waste_recycling", "Waste to recycling (Scope 3 cat 5)"],
  ["waste_combustion", "Waste to energy recovery (Scope 3 cat 5)"],
  ["waste_composting", "Waste to composting (Scope 3 cat 5)"],
  ["waste_anaerobic_digestion", "Waste to anaerobic digestion (Scope 3 cat 5)"],
  ["waste_reuse", "Waste reused (Scope 3 cat 5)"],
];

export default function EmissionsPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [carbon, setCarbon] = useState<Carbon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [factor, setFactor] = useState<FactorRowView | null>(null);
  const [form, setForm] = useState({ category: "waste_recycling", label: "", periodStart: "", periodEnd: "", quantity: "", unit: "tonnes", basis: "measured", refrigerantType: "", wasteMaterial: "", evidence: "" });

  const load = useCallback(async (s: PeriodSelection) => {
    const res = await fetch(`/api/emissions/carbon?${periodQuery(s)}`);
    const b = await res.json();
    if (b.error) setError(b.error);
    else setCarbon(b);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/emissions/carbon?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json())
      .then((b) => {
        if (!active) return;
        if (b.error) setError(b.error);
        else setCarbon(b);
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function send(label: string, url: string, init: RequestInit) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url, init);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error ?? `${label} failed (${res.status})`);
        return false;
      }
      await load(selection);
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...form,
      refrigerantType: form.refrigerantType || undefined,
      wasteMaterial: form.wasteMaterial || undefined,
      evidence: form.evidence || undefined,
      factorId: factor?.id,
      factorYear: factor ? carbon?.period.factorYear : undefined,
    };
    if (await send("Add", "/api/emissions/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) {
      setForm({ ...form, label: "", quantity: "", evidence: "" });
    }
  }

  const isRefrigerant = form.category === "refrigerant_topup";
  const isWaste = form.category.startsWith("waste_");

  return (
    <>
      <h1>Refrigerants, water and waste</h1>
      <p style={{ color: "#555" }}>
        The Scope 1 fugitive and Scope 3 sources that meter data does not cover. Refrigerant leakage is usually material for
        air-conditioned buildings. Each line points at a published DESNZ row from the factor file you have loaded, exactly as{" "}
        <Link href="/transport">transport</Link> does.
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {carbon && (
        <section style={card}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Refrigerants (Scope 1)" value={fmtN(carbon.byFamily.refrigerant)} />
            <Stat label="Water (Scope 3)" value={fmtN(carbon.byFamily.water)} />
            <Stat label="Waste (Scope 3)" value={fmtN(carbon.byFamily.waste)} />
            <Stat label="Total kgCO2e" value={fmtN(carbon.totals.total)} sub={`${carbon.counts.resolved} of ${carbon.counts.lines} lines`} />
            <Stat label="Landfill diversion" value={carbon.waste.diversionRatePct === null ? "—" : `${carbon.waste.diversionRatePct}%`} sub={carbon.waste.totalTonnes === null ? undefined : `${carbon.waste.totalTonnes} t total`} />
          </div>
          <p style={{ fontSize: 12, color: "#666", marginBottom: 0 }}>{carbon.waste.detail}</p>
          {carbon.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
        </section>
      )}

      <section style={card}>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 16 }}>Import from a spreadsheet</summary>
          <div style={{ marginTop: 10 }}>
            <CsvImport
              spec={{
                id: "site-activity",
                label: "Refrigerants, water and waste",
                description: "Map the columns of a waste contractor report, water bill schedule or F-gas service record. UK day-first dates and thousands separators are understood.",
                fields: siteActivityImportFields,
              }}
              onCommit={async (rows) => {
                const res = await fetch("/api/emissions/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
                const b = await res.json().catch(() => ({}));
                if (!res.ok) {
                  const detail = b.issues?.slice(0, 3).map((i: { row: number; message: string }) => `row ${i.row}: ${i.message}`).join("; ");
                  return { ok: false, message: [b.error, detail].filter(Boolean).join(" ") || `Import failed (${res.status})` };
                }
                await load(selection);
                return { ok: true, message: `Imported ${b.created} rows.` };
              }}
            />
          </div>
        </details>
      </section>

      <section style={card}>
        <h2 style={h2}>Add a line</h2>
        <form onSubmit={add} style={{ display: "grid", gap: 10, maxWidth: 760 }}>
          <div style={row}>
            <label style={{ flex: 2 }}>Category
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={input}>
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label style={{ flex: 2 }}>Description<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required placeholder="Q2 dry mixed recycling" style={input} /></label>
          </div>
          <div style={row}>
            <label>From<input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} required style={input} /></label>
            <label>To<input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required style={input} /></label>
            <label>Quantity<input type="number" step="any" min="0" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required style={input} /></label>
            <label>Unit<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required placeholder="tonnes, kg, m3" style={input} /></label>
          </div>
          <div style={row}>
            {isRefrigerant && <label style={{ flex: 1 }}>Refrigerant<input value={form.refrigerantType} onChange={(e) => setForm({ ...form, refrigerantType: e.target.value })} placeholder="R410A" style={input} /></label>}
            {isWaste && <label style={{ flex: 1 }}>Material<input value={form.wasteMaterial} onChange={(e) => setForm({ ...form, wasteMaterial: e.target.value })} placeholder="Mixed commercial" style={input} /></label>}
            <label style={{ flex: 1 }}>Basis
              <select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })} style={input}>
                <option value="measured">measured</option><option value="estimated">estimated</option><option value="client_declared">client declared</option>
              </select>
            </label>
            <label style={{ flex: 2 }}>Evidence<input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="Waste contractor report, F-gas log" style={input} /></label>
          </div>
          <FactorPicker
            year={carbon?.period.factorYear ?? new Date().getUTCFullYear() - 1}
            value={factor ? { id: factor.id, year: carbon?.period.factorYear ?? 0, uom: factor.uom } : null}
            onSelect={(r) => { setFactor(r); if (r) setForm((f) => ({ ...f, unit: r.uom })); }}
          />
          {factor && <p style={{ fontSize: 12, color: "#666", margin: 0 }}>{factorLabel(factor)} — {factor.factor} {factor.ghgUnit} per {factor.uom}, published as {factor.scope}.</p>}
          {isRefrigerant && <p style={{ fontSize: 12, color: "#666", margin: 0 }}>Mass balance: record the refrigerant added over the period, not the system charge. What was added is taken as what leaked.</p>}
          <button type="submit" disabled={busy !== null} style={{ padding: "8px 14px", width: "fit-content" }}>{busy === "Add" ? "Saving…" : "Add line"}</button>
        </form>
      </section>

      {carbon && carbon.lines.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Lines ({carbon.lines.length})</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Description", "Category", "Period", "Quantity", "Factor", "kgCO2e", "Basis", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {carbon.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.label}{(l.refrigerantType || l.wasteMaterial) && <div style={{ color: "#666", fontSize: 11 }}>{l.refrigerantType ?? l.wasteMaterial}</div>}</td>
                    <td style={td}>{l.categoryLabel}<div style={{ color: "#666", fontSize: 11 }}>{l.ghgCategory}</div></td>
                    <td style={td}>{l.periodStart} to {l.periodEnd}</td>
                    <td style={td}>{l.quantity} {l.unit}{l.conversionNote && <div style={{ color: "#666", fontSize: 11 }}>{l.conversionNote}</div>}</td>
                    <td style={td}>{l.factor.value === null ? <span style={{ color: "#b02a37" }}>unavailable</span> : `${l.factor.value} ${l.factor.unit}`}<div style={{ color: "#666", fontSize: 11 }}>{l.factor.reference}</div></td>
                    <td style={td}>{fmtN(l.kgCo2e)}</td>
                    <td style={td}>{l.basis.replace("_", " ")}</td>
                    <td style={td}><button onClick={() => send("Delete", `/api/emissions/activity/${l.id}`, { method: "DELETE" })} disabled={busy !== null} style={mini}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {carbon.lines.some((l) => l.warnings.length > 0) && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#856404" }}>Line warnings</summary>
              <ul style={{ fontSize: 12 }}>{carbon.lines.flatMap((l) => l.warnings.map((w, i) => <li key={`${l.id}-${i}`}><strong>{l.label}</strong>: {w}</li>))}</ul>
            </details>
          )}
          {carbon.factorReferences.length > 0 && <p style={{ fontSize: 12, color: "#666" }}>Factors used: {carbon.factorReferences.join("; ")}.</p>}
        </section>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#f7f7f5", border: "1px solid #ddd", padding: "8px 12px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#666" }}>{sub}</div>}
    </div>
  );
}
const fmtN = (n: number | null) => (n === null ? "unavailable" : n.toLocaleString("en-GB", { maximumFractionDigits: 0 }));
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const mini = { padding: "2px 6px", fontSize: 11 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
