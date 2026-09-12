"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { RESTATEMENT_REASONS, RESTATEMENT_REASON_LABELS, type RestatementReason } from "@/lib/value-chain/types";

interface Movement { counterpartyId: string; name: string; fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; basisChanged: boolean; detail: string }
interface YearOnYear {
  reportingYear: number; previousYear: number;
  headline: { fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; changePct: number | null };
  likeForLike: { counterparties: number; fromTco2e: number | null; toTco2e: number | null; changeTco2e: number | null; changePct: number | null };
  entered: Movement[]; left: Movement[]; rebased: Movement[]; moved: Movement[]; detail: string; warnings: string[];
}
interface Restatement { id: string; reportingYear: number; reason: RestatementReason; detail: string; recordedOn: string }
interface YearTotals { reportingYear: number; attributableTco2e: number | null; returnedTco2e: number | null; estimatedTco2e: number | null; primarySharePct: number | null; active: number; withData: number; valueCoveredPct: number | null; restatements: Restatement[] }
interface Trend {
  years: YearTotals[];
  baseline?: { baselineYear: number; rationale: string; setOn: string };
  vsBaseline?: { baselineYear: number; latestYear: number; changeTco2e: number | null; changePct: number | null; detail: string };
  yearOnYear: YearOnYear[];
  warnings: string[];
}

export default function TrendPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [from, setFrom] = useState("");
  const [trend, setTrend] = useState<Trend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [baselineForm, setBaselineForm] = useState({ baselineYear: "", rationale: "", setOn: new Date().toISOString().slice(0, 10) });
  const [restatement, setRestatement] = useState({ reportingYear: "", reason: "better_data" as RestatementReason, detail: "", recordedOn: new Date().toISOString().slice(0, 10) });

  const load = useCallback(async (s: PeriodSelection, fromYear: string) => {
    const res = await fetch(`/api/value-chain/trend?${periodQuery(s)}${fromYear ? `&from=${fromYear}` : ""}`);
    const b = await res.json();
    if (b.error) setError(b.error);
    else { setError(null); setTrend(b); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/value-chain/trend?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json())
      .then((b) => { if (!active) return; if (b.error) setError(b.error); else setTrend(b); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function send(label: string, url: string, init: RequestInit) {
    setBusy(label);
    try {
      const res = await fetch(url, init);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error ?? `${label} failed (${res.status})`);
        return false;
      }
      await load(selection, from);
      return true;
    } finally { setBusy(null); }
  }

  async function setBaseline(e: FormEvent) {
    e.preventDefault();
    await send("Baseline", "/api/value-chain/trend", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baselineYear: Number(baselineForm.baselineYear), rationale: baselineForm.rationale, setOn: baselineForm.setOn }),
    });
  }

  async function addRestatement(e: FormEvent) {
    e.preventDefault();
    if (await send("Restatement", "/api/value-chain/trend", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "restatement", reportingYear: Number(restatement.reportingYear), reason: restatement.reason, detail: restatement.detail, recordedOn: restatement.recordedOn }),
    })) setRestatement({ ...restatement, detail: "" });
  }

  return (
    <>
      <h1>Value chain over time</h1>
      <p style={{ color: "#555" }}>
        What actually moved. The headline change between two years mixes real abatement with counterparties joining or leaving the register and with the same
        counterparty being measured a different way. Only the first is a reduction, so the three are shown apart. Back to the{" "}
        <Link href="/value-chain">register</Link>, or the <Link href="/value-chain/hotspots">hotspot screen</Link>.
      </p>
      <div style={{ marginBottom: 12, ...row, alignItems: "flex-end" }}>
        <PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s, from); }} disabled={busy !== null} />
        <label style={{ fontSize: 12 }}>From year<input style={{ ...input, width: 90 }} value={from} onChange={(e) => setFrom(e.target.value)} onBlur={() => load(selection, from)} placeholder="2023" /></label>
      </div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {trend && (
        <>
          <section style={card}>
            <h2 style={h2}>Baseline</h2>
            {trend.baseline ? (
              <p style={{ fontSize: 13 }}>
                <strong>{trend.baseline.baselineYear}</strong>, set on {trend.baseline.setOn}. {trend.baseline.rationale}
              </p>
            ) : (
              <p style={box("#fff3cd", "#ffe69c")}>No baseline year is set, so there is nothing to measure progress against.</p>
            )}
            {trend.vsBaseline && <p style={{ fontSize: 13, marginTop: 6 }}>{trend.vsBaseline.detail}</p>}
            <form onSubmit={setBaseline} style={{ ...row, marginTop: 8, alignItems: "flex-end" }}>
              <label style={{ fontSize: 12 }}>Baseline year<input required style={{ ...input, width: 90 }} value={baselineForm.baselineYear} onChange={(e) => setBaselineForm({ ...baselineForm, baselineYear: e.target.value })} /></label>
              <label style={{ fontSize: 12, flex: 1, minWidth: 260 }}>Why this year<input required style={input} value={baselineForm.rationale} onChange={(e) => setBaselineForm({ ...baselineForm, rationale: e.target.value })} placeholder="First year with supplier data across the top 20 by spend" /></label>
              <button disabled={busy !== null}>{trend.baseline ? "Replace baseline" : "Set baseline"}</button>
            </form>
          </section>

          <section style={card}>
            <h2 style={h2}>Each year</h2>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Year</th><th style={th}>Attributable tCO2e</th><th style={th}>Of which returned</th><th style={th}>Of which estimated</th><th style={th}>Primary share</th><th style={th}>Counterparties with data</th><th style={th}>Value covered</th><th style={th}>Restatements</th></tr></thead>
              <tbody>
                {trend.years.map((y) => (
                  <tr key={y.reportingYear}>
                    <td style={td}>{y.reportingYear}{trend.baseline?.baselineYear === y.reportingYear && <span style={{ color: "#555" }}> (baseline)</span>}</td>
                    <td style={td}>{fmtN(y.attributableTco2e)}</td>
                    <td style={td}>{fmtN(y.returnedTco2e)}</td>
                    <td style={td}>{fmtN(y.estimatedTco2e)}</td>
                    <td style={td}>{y.primarySharePct === null ? "unavailable" : `${y.primarySharePct}%`}</td>
                    <td style={td}>{y.withData} of {y.active}</td>
                    <td style={td}>{y.valueCoveredPct === null ? "unavailable" : `${y.valueCoveredPct}%`}</td>
                    <td style={td}>{y.restatements.length === 0 ? "—" : y.restatements.map((r) => RESTATEMENT_REASON_LABELS[r.reason]).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {trend.yearOnYear.map((y) => (
            <section key={`${y.previousYear}-${y.reportingYear}`} style={card}>
              <h2 style={h2}>{y.previousYear} to {y.reportingYear}</h2>
              <div style={{ ...row, marginBottom: 8 }}>
                <div style={box("#eef", "#ccd")}>
                  <strong>Headline</strong><br />
                  {fmtN(y.headline.fromTco2e)} → {fmtN(y.headline.toTco2e)} tCO2e{y.headline.changePct === null ? "" : ` (${y.headline.changePct > 0 ? "+" : ""}${y.headline.changePct}%)`}
                </div>
                <div style={box("#e7f6e7", "#b9dfb9")}>
                  <strong>Like for like</strong><br />
                  {y.likeForLike.counterparties} counterpart{y.likeForLike.counterparties === 1 ? "y" : "ies"}: {fmtN(y.likeForLike.fromTco2e)} → {fmtN(y.likeForLike.toTco2e)} tCO2e
                  {y.likeForLike.changePct === null ? "" : ` (${y.likeForLike.changePct > 0 ? "+" : ""}${y.likeForLike.changePct}%)`}
                </div>
              </div>
              <p style={{ fontSize: 13 }}>{y.detail}</p>
              {y.warnings.map((w) => <p key={w} style={{ ...box("#fff3cd", "#ffe69c"), marginTop: 6 }}>{w}</p>)}
              {[["Moved, same basis", y.moved], ["Measured differently", y.rebased], ["Entered", y.entered], ["Left", y.left]].map(([label, list]) => {
                const set = list as Movement[];
                if (set.length === 0) return null;
                return (
                  <details key={label as string} style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 13 }}>{label as string} ({set.length})</summary>
                    <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
                      <thead><tr><th style={th}>Counterparty</th><th style={th}>{y.previousYear}</th><th style={th}>{y.reportingYear}</th><th style={th}>Change</th><th style={th}>Note</th></tr></thead>
                      <tbody>
                        {set.map((m) => (
                          <tr key={m.counterpartyId}>
                            <td style={td}><Link href={`/value-chain/${m.counterpartyId}`}>{m.name}</Link></td>
                            <td style={td}>{fmtN(m.fromTco2e)}</td>
                            <td style={td}>{fmtN(m.toTco2e)}</td>
                            <td style={td}>{m.changeTco2e === null ? "—" : `${m.changeTco2e > 0 ? "+" : ""}${fmtN(m.changeTco2e)}`}</td>
                            <td style={td}>{m.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                );
              })}
            </section>
          ))}

          <section style={card}>
            <h2 style={h2}>Record a restatement</h2>
            <p style={{ fontSize: 13, color: "#555" }}>A figure already published that has since changed. The trend uses current figures, so the reason it moved belongs on record.</p>
            <form onSubmit={addRestatement} style={{ ...row, alignItems: "flex-end" }}>
              <label style={{ fontSize: 12 }}>Year<input required style={{ ...input, width: 90 }} value={restatement.reportingYear} onChange={(e) => setRestatement({ ...restatement, reportingYear: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}>Reason
                <select style={input} value={restatement.reason} onChange={(e) => setRestatement({ ...restatement, reason: e.target.value as RestatementReason })}>
                  {RESTATEMENT_REASONS.map((r) => <option key={r} value={r}>{RESTATEMENT_REASON_LABELS[r]}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, flex: 1, minWidth: 260 }}>What changed<input required style={input} value={restatement.detail} onChange={(e) => setRestatement({ ...restatement, detail: e.target.value })} /></label>
              <button disabled={busy !== null}>Record</button>
            </form>
          </section>

          {trend.warnings.map((w) => <p key={w} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
        </>
      )}
    </>
  );
}

const fmtN = (n: number | null) => (n === null ? "unavailable" : n.toLocaleString("en-GB", { maximumFractionDigits: n < 10 ? 2 : 0 }));
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
