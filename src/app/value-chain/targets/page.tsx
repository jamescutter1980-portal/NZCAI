"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { INITIATIVE_STATUS, LEVERS, LEVER_LABELS, TARGET_KINDS, TARGET_KIND_META, TARGET_STATUS, type InitiativeStatus, type Lever, type TargetKind } from "@/lib/value-chain/types";

interface Progress {
  target: { id: string; name: string; kind: TargetKind; baselineYear: number; targetYear: number; targetValue: number; status: string; owner?: string };
  unit: string; baselineValue: number | null; latestYear: number | null; latestValue: number | null; requiredValue: number | null;
  varianceToLine: number | null; onTrack: boolean | null; remaining: number | null; detail: string;
}
interface Pipeline {
  expectedTco2e: number; actualTco2e: number;
  byStatus: { status: InitiativeStatus; count: number; expectedTco2e: number; actualTco2e: number }[];
  byLever: { lever: Lever; label: string; count: number; expectedTco2e: number }[];
  unquantified: { id: string; name: string; status: InitiativeStatus }[];
  detail: string;
}
interface Initiative {
  id: string; counterpartyId?: string; name: string; lever: Lever; status: InitiativeStatus;
  expectedAnnualTco2e?: number; expectedFromYear?: number; actualAnnualTco2e?: number; owner?: string;
}
interface Data { progress: Progress[]; pipeline: Pipeline; gapAnalysis?: { targetId: string; targetName: string; remainingTco2e: number | null; pipelineTco2e: number; shortfallTco2e: number | null; detail: string }[]; warnings: string[] }

export default function TargetsPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [data, setData] = useState<Data | null>(null);
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState({ name: "", kind: "absolute_tco2e" as TargetKind, baselineYear: "", targetYear: "", targetValue: "", status: "active", owner: "" });
  const [initiative, setInitiative] = useState({ name: "", lever: "supplier_decarbonisation" as Lever, status: "proposed" as InitiativeStatus, expectedAnnualTco2e: "", expectedFromYear: "", actualAnnualTco2e: "", actualFromYear: "", owner: "" });

  const load = useCallback(async (s: PeriodSelection) => {
    const [a, b] = await Promise.all([fetch(`/api/value-chain/targets?${periodQuery(s)}`).then((r) => r.json()), fetch("/api/value-chain/initiatives").then((r) => r.json())]);
    if (a.error) setError(a.error);
    else { setError(null); setData(a); }
    if (!b.error) setInitiatives(b.initiatives);
  }, []);

  useEffect(() => {
    let active = true;
    const s = defaultPeriodSelection();
    Promise.all([fetch(`/api/value-chain/targets?${periodQuery(s)}`).then((r) => r.json()), fetch("/api/value-chain/initiatives").then((r) => r.json())])
      .then(([a, b]) => { if (!active) return; if (a.error) setError(a.error); else setData(a); if (!b.error) setInitiatives(b.initiatives); })
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
      await load(selection);
      return true;
    } finally { setBusy(null); }
  }

  async function addTarget(e: FormEvent) {
    e.preventDefault();
    const ok = await send("Target", "/api/value-chain/targets", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: target.name, kind: target.kind, baselineYear: Number(target.baselineYear), targetYear: Number(target.targetYear), targetValue: Number(target.targetValue), status: target.status, owner: target.owner || undefined }),
    });
    if (ok) setTarget({ ...target, name: "", targetValue: "", owner: "" });
  }

  async function addInitiative(e: FormEvent) {
    e.preventDefault();
    const ok = await send("Initiative", "/api/value-chain/initiatives", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: initiative.name, lever: initiative.lever, status: initiative.status, owner: initiative.owner || undefined,
        expectedAnnualTco2e: initiative.expectedAnnualTco2e ? Number(initiative.expectedAnnualTco2e) : undefined,
        expectedFromYear: initiative.expectedFromYear ? Number(initiative.expectedFromYear) : undefined,
        actualAnnualTco2e: initiative.actualAnnualTco2e ? Number(initiative.actualAnnualTco2e) : undefined,
        actualFromYear: initiative.actualFromYear ? Number(initiative.actualFromYear) : undefined,
      }),
    });
    if (ok) setInitiative({ ...initiative, name: "", expectedAnnualTco2e: "", actualAnnualTco2e: "", owner: "" });
  }

  return (
    <>
      <h1>Targets and reduction</h1>
      <p style={{ color: "#555" }}>
        Progress is measured against the straight line from baseline to target, so falling behind shows in the year it happens. Expected savings from initiatives
        are a plan and are never subtracted from measured emissions: the pipeline is shown next to the gap, not inside the footprint. The measured figures come from{" "}
        <Link href="/value-chain/trend">the trend</Link>.
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {data && (
        <>
          <section style={card}>
            <h2 style={h2}>Targets</h2>
            {data.progress.length === 0 ? (
              <p style={box("#fff3cd", "#ffe69c")}>No target is set, so there is nothing to measure the trend against.</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={th}>Target</th><th style={th}>Measure</th><th style={th}>Baseline</th><th style={th}>Latest</th><th style={th}>On the line</th><th style={th}>Standing</th><th style={th}>Still to find</th></tr></thead>
                <tbody>
                  {data.progress.map((p) => (
                    <tr key={p.target.id} style={p.onTrack === false ? { background: "#fffdf5" } : undefined}>
                      <td style={td}>{p.target.name}<br /><span style={{ color: "#555" }}>{p.target.targetValue} {p.unit} by {p.target.targetYear}</span></td>
                      <td style={td}>{TARGET_KIND_META[p.target.kind].label}</td>
                      <td style={td}>{fmtN(p.baselineValue)} <span style={{ color: "#555" }}>({p.target.baselineYear})</span></td>
                      <td style={td}>{fmtN(p.latestValue)} <span style={{ color: "#555" }}>({p.latestYear ?? "—"})</span></td>
                      <td style={td}>{fmtN(p.requiredValue)}</td>
                      <td style={td}>{p.onTrack === null ? "cannot be scored" : p.onTrack ? `ahead by ${fmtN(Math.abs(p.varianceToLine ?? 0))}` : `behind by ${fmtN(Math.abs(p.varianceToLine ?? 0))}`}</td>
                      <td style={td}>{fmtN(p.remaining)} {p.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.progress.map((p) => <p key={`${p.target.id}-d`} style={{ fontSize: 12, color: "#555", marginTop: 6 }}>{p.detail}</p>)}
            <form onSubmit={addTarget} style={{ ...row, marginTop: 10, alignItems: "flex-end" }}>
              <label style={{ fontSize: 12, flex: 1, minWidth: 200 }}>Name<input required style={input} value={target.name} onChange={(e) => setTarget({ ...target, name: e.target.value })} placeholder="Halve value chain emissions" /></label>
              <label style={{ fontSize: 12 }}>Measure
                <select style={input} value={target.kind} onChange={(e) => setTarget({ ...target, kind: e.target.value as TargetKind })}>
                  {TARGET_KINDS.map((k) => <option key={k} value={k}>{TARGET_KIND_META[k].label}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12 }}>Baseline year<input required style={{ ...input, width: 90 }} value={target.baselineYear} onChange={(e) => setTarget({ ...target, baselineYear: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}>Target year<input required style={{ ...input, width: 90 }} value={target.targetYear} onChange={(e) => setTarget({ ...target, targetYear: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}>Target ({TARGET_KIND_META[target.kind].unit})<input required style={{ ...input, width: 110 }} value={target.targetValue} onChange={(e) => setTarget({ ...target, targetValue: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}>Status
                <select style={input} value={target.status} onChange={(e) => setTarget({ ...target, status: e.target.value })}>{TARGET_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              </label>
              <button disabled={busy !== null}>Add target</button>
            </form>
          </section>

          <section style={card}>
            <h2 style={h2}>Initiative pipeline</h2>
            <p style={{ fontSize: 13 }}>{data.pipeline.detail}</p>
            <div style={{ ...row, marginTop: 8 }}>
              <div style={box("#eef", "#ccd")}><strong>{fmtN(data.pipeline.expectedTco2e)}</strong> tCO2e expected a year</div>
              <div style={box("#e7f6e7", "#b9dfb9")}><strong>{fmtN(data.pipeline.actualTco2e)}</strong> tCO2e recorded as achieved</div>
              {data.pipeline.byLever.slice(0, 3).map((l) => <div key={l.lever} style={box("#f6f6f6", "#ddd")}>{l.label}: <strong>{fmtN(l.expectedTco2e)}</strong></div>)}
            </div>
            {data.gapAnalysis?.map((g) => (
              <p key={g.targetId} style={{ ...box(g.shortfallTco2e === 0 ? "#e7f6e7" : "#fff3cd", g.shortfallTco2e === 0 ? "#b9dfb9" : "#ffe69c"), marginTop: 8 }}>
                <strong>{g.targetName}.</strong> {g.detail}
              </p>
            ))}
          </section>

          <section style={card}>
            <h2 style={h2}>Initiatives</h2>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Initiative</th><th style={th}>Lever</th><th style={th}>Status</th><th style={th}>Expected tCO2e a year</th><th style={th}>From</th><th style={th}>Achieved</th><th style={th}>Owner</th></tr></thead>
              <tbody>
                {initiatives.map((i) => (
                  <tr key={i.id}>
                    <td style={td}>{i.name}</td>
                    <td style={td}>{LEVER_LABELS[i.lever]}</td>
                    <td style={td}>{i.status.replace("_", " ")}</td>
                    <td style={td}>{i.expectedAnnualTco2e === undefined ? <span style={{ color: "#a60" }}>not quantified</span> : fmtN(i.expectedAnnualTco2e)}</td>
                    <td style={td}>{i.expectedFromYear ?? "—"}</td>
                    <td style={td}>{i.actualAnnualTco2e === undefined ? "—" : fmtN(i.actualAnnualTco2e)}</td>
                    <td style={td}>{i.owner ?? "—"}</td>
                  </tr>
                ))}
                {initiatives.length === 0 && <tr><td style={td} colSpan={7}>Nothing recorded yet.</td></tr>}
              </tbody>
            </table>
            <form onSubmit={addInitiative} style={{ ...row, marginTop: 10, alignItems: "flex-end" }}>
              <label style={{ fontSize: 12, flex: 1, minWidth: 220 }}>Initiative<input required style={input} value={initiative.name} onChange={(e) => setInitiative({ ...initiative, name: e.target.value })} placeholder="Supplier moves to certified renewable power" /></label>
              <label style={{ fontSize: 12 }}>Lever
                <select style={input} value={initiative.lever} onChange={(e) => setInitiative({ ...initiative, lever: e.target.value as Lever })}>{LEVERS.map((l) => <option key={l} value={l}>{LEVER_LABELS[l]}</option>)}</select>
              </label>
              <label style={{ fontSize: 12 }}>Status
                <select style={input} value={initiative.status} onChange={(e) => setInitiative({ ...initiative, status: e.target.value as InitiativeStatus })}>{INITIATIVE_STATUS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
              </label>
              <label style={{ fontSize: 12 }}>Expected tCO2e<input style={{ ...input, width: 110 }} value={initiative.expectedAnnualTco2e} onChange={(e) => setInitiative({ ...initiative, expectedAnnualTco2e: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}>From year<input style={{ ...input, width: 90 }} value={initiative.expectedFromYear} onChange={(e) => setInitiative({ ...initiative, expectedFromYear: e.target.value })} /></label>
              {initiative.status === "delivered" && (
                <>
                  <label style={{ fontSize: 12 }}>Achieved tCO2e<input style={{ ...input, width: 110 }} value={initiative.actualAnnualTco2e} onChange={(e) => setInitiative({ ...initiative, actualAnnualTco2e: e.target.value })} /></label>
                  <label style={{ fontSize: 12 }}>Achieved from<input style={{ ...input, width: 90 }} value={initiative.actualFromYear} onChange={(e) => setInitiative({ ...initiative, actualFromYear: e.target.value })} /></label>
                </>
              )}
              <button disabled={busy !== null}>Add initiative</button>
            </form>
          </section>

          {data.warnings.map((w) => <p key={w} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
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
