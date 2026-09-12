"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { CATEGORY_STATUS, CATEGORY_STATUS_LABELS, RELEVANCE, RELEVANCE_LABELS, type CategoryStatus, type Relevance } from "@/lib/value-chain/types";

interface Line {
  category: string; label: string; relevance: Relevance; status: CategoryStatus;
  counterparties: number; withData: number; tco2e: number | null; gap?: string;
  assessment?: { justification: string; method?: string; evidence?: string; assessedOn: string };
}
interface Completeness {
  reportingYear: number; lines: Line[]; complete: boolean; detail: string; warnings: string[];
  counts: { assessed: number; unassessed: number; relevant: number; notRelevant: number; quantified: number; relevantWithoutData: number; unjustifiedExclusions: number };
}

export default function CompletenessPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [data, setData] = useState<Completeness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ relevance: "relevant" as Relevance, status: "calculated" as CategoryStatus, justification: "", method: "", evidence: "" });
  const [rollFrom, setRollFrom] = useState("");

  const load = useCallback(async (s: PeriodSelection) => {
    const res = await fetch(`/api/value-chain/completeness?${periodQuery(s)}`);
    const b = await res.json();
    if (b.error) setError(b.error);
    else { setError(null); setData(b); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/value-chain/completeness?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json())
      .then((b) => { if (!active) return; if (b.error) setError(b.error); else setData(b); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function send(label: string, body: unknown) {
    setBusy(label);
    try {
      const res = await fetch("/api/value-chain/completeness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error ?? `${label} failed (${res.status})`);
        return false;
      }
      await load(selection);
      return true;
    } finally { setBusy(null); }
  }

  function start(line: Line) {
    setOpen(line.category);
    setForm({
      relevance: line.relevance === "not_yet_assessed" ? "relevant" : line.relevance,
      status: line.status === "not_started" ? "calculated" : line.status,
      justification: line.assessment?.justification ?? "",
      method: line.assessment?.method ?? "",
      evidence: line.assessment?.evidence ?? "",
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data || !open) return;
    const ok = await send("Assessment", {
      reportingYear: data.reportingYear, category: open, relevance: form.relevance, status: form.status,
      justification: form.justification, method: form.method || undefined, evidence: form.evidence || undefined,
      assessedOn: new Date().toISOString().slice(0, 10),
    });
    if (ok) setOpen(null);
  }

  return (
    <>
      <h1>Scope 3 category completeness</h1>
      <p style={{ color: "#555" }}>
        All fifteen categories, each one answered. A category left out with nothing on record cannot be told apart from one nobody thought about, which is the
        first thing a reviewer asks. An exclusion here needs a reason that would survive being read aloud. Back to the <Link href="/value-chain">register</Link>.
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {data && (
        <>
          <section style={card}>
            <p style={{ fontSize: 13, margin: 0 }}>{data.detail}</p>
            <div style={{ ...row, marginTop: 8 }}>
              <div style={box(data.complete ? "#e7f6e7" : "#fff3cd", data.complete ? "#b9dfb9" : "#ffe69c")}>
                <strong>{data.counts.assessed} of 15</strong> assessed
              </div>
              <div style={box("#eef", "#ccd")}><strong>{data.counts.relevant}</strong> relevant</div>
              <div style={box("#eef", "#ccd")}><strong>{data.counts.notRelevant}</strong> excluded</div>
              <div style={box("#eef", "#ccd")}><strong>{data.counts.quantified}</strong> quantified</div>
            </div>
            <form
              style={{ ...row, marginTop: 10, alignItems: "flex-end" }}
              onSubmit={(e) => { e.preventDefault(); if (rollFrom) void send("Roll forward", { kind: "roll_forward", fromYear: Number(rollFrom), toYear: data.reportingYear }); }}
            >
              <label style={{ fontSize: 12 }}>Carry answers forward from<input style={{ ...input, width: 110 }} value={rollFrom} onChange={(e) => setRollFrom(e.target.value)} placeholder={String(data.reportingYear - 1)} /></label>
              <button disabled={busy !== null || !rollFrom}>Carry forward</button>
              <span style={{ fontSize: 12, color: "#555" }}>Only categories with no answer for {data.reportingYear} are filled in.</span>
            </form>
          </section>

          <section style={card}>
            <h2 style={h2}>The fifteen</h2>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Category</th><th style={th}>Relevance</th><th style={th}>Status</th><th style={th}>Counterparties</th><th style={th}>With data</th><th style={th}>tCO2e</th><th style={th}>What is open</th><th style={th}></th></tr></thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.category} style={l.gap ? { background: "#fffdf5" } : undefined}>
                    <td style={td}>{l.label}</td>
                    <td style={td}>{RELEVANCE_LABELS[l.relevance]}</td>
                    <td style={td}>{CATEGORY_STATUS_LABELS[l.status]}</td>
                    <td style={td}>{l.counterparties}</td>
                    <td style={td}>{l.withData}</td>
                    <td style={td}>{l.tco2e === null ? "—" : l.tco2e.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</td>
                    <td style={td}>{l.gap ?? (l.assessment ? l.assessment.justification : "")}</td>
                    <td style={td}><button style={mini} onClick={() => start(l)} disabled={busy !== null}>{l.assessment ? "Revise" : "Assess"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {open && (
            <section style={card}>
              <h2 style={h2}>{data.lines.find((l) => l.category === open)?.label}</h2>
              <form onSubmit={save}>
                <div style={row}>
                  <label style={{ fontSize: 12 }}>Relevance
                    <select style={input} value={form.relevance} onChange={(e) => { const relevance = e.target.value as Relevance; setForm({ ...form, relevance, status: relevance === "not_relevant" ? "excluded" : form.status === "excluded" ? "calculated" : form.status }); }}>
                      {RELEVANCE.map((r) => <option key={r} value={r}>{RELEVANCE_LABELS[r]}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 12 }}>Status
                    <select style={input} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CategoryStatus })}>
                      {CATEGORY_STATUS.map((s) => <option key={s} value={s}>{CATEGORY_STATUS_LABELS[s]}</option>)}
                    </select>
                  </label>
                </div>
                <label style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                  {form.relevance === "not_relevant" ? "Why this category does not apply" : "What this category covers here"}
                  <textarea required rows={3} style={input} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })}
                    placeholder={form.relevance === "not_relevant" ? "The company sells professional services only; no sold product consumes energy in use." : "Purchased goods and services, from the supplier register weighted by spend."} />
                </label>
                <div style={row}>
                  <label style={{ fontSize: 12, flex: 1, minWidth: 240 }}>Method<input style={input} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} placeholder="Supplier-specific where returned, spend-based otherwise" /></label>
                  <label style={{ fontSize: 12, flex: 1, minWidth: 240 }}>Evidence<input style={input} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="Board paper, 12 March 2026" /></label>
                </div>
                <div style={{ ...row, marginTop: 8 }}>
                  <button disabled={busy !== null}>Record assessment</button>
                  <button type="button" onClick={() => setOpen(null)} disabled={busy !== null}>Cancel</button>
                </div>
              </form>
            </section>
          )}

          {data.warnings.map((w) => <p key={w} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
        </>
      )}
    </>
  );
}

const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const mini = { padding: "2px 6px", fontSize: 11 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
