"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { CsvImport } from "@/components/CsvImport";
import { counterpartyImportFields } from "@/lib/value-chain/import-spec";
import { ASK_LABELS, CHANNELS, DECLINE_REASONS, ROLES, SCOPE3_CATEGORIES, STATE_LABELS, TIER_LABELS, type EngagementState, type Tier } from "@/lib/value-chain/types";

interface View {
  counterparty: { id: string; name: string; roles: string[]; ghgCategories: string[]; annualValueGbp?: number; status: string; contactName?: string; ask: string };
  direction: string;
  state: EngagementState;
  dataSource: "report" | "ledger" | "spend_estimate" | "none";
  attributableTco2e: number | null;
  tier: Tier | null;
  primary: boolean;
  engagement?: { dueOn?: string; lastContactOn?: string; remindersSent: number; escalated: boolean };
  next: { action: string; reason: string; due: boolean; overdue: boolean };
  warnings: string[];
}
interface Report {
  period: { label: string };
  reportingYear: number;
  counterparties: View[];
  coverage: { total: number; active: number; upstream: number; downstream: number; both: number; asked: number; withData: number; estimated: number; verified: number; declined: number; unreachable: number; dueNow: number; overdue: number; valueTotalGbp: number; valueWithDataGbp: number; valueCoveredPct: number | null; unvalued: number };
  totals: { attributableTco2e: number | null; returnedTco2e: number | null; estimatedTco2e: number | null; resolved: number; unresolved: number; primarySharePct: number | null; byDirection: { upstream: number | null; downstream: number | null }; byCategory: { category: string; label: string; counterparties: number; withData: number; tco2e: number | null }[]; byTier: Record<Tier, number> };
  plan: { counterpartyId: string; name: string; annualValueGbp?: number; state: EngagementState; action: string; reason: string; overdue: boolean }[];
  warnings: string[];
}

export default function ValueChainPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "upstream" | "downstream" | "due" | "no_data">("all");
  const [form, setForm] = useState({ name: "", roles: ["supplier"] as string[], ghgCategories: [] as string[], annualValueGbp: "", contactName: "", contactEmail: "", escalationName: "", escalationEmail: "", ask: "annual_ghg_report", sector: "", spendFactorKgCo2ePerGbp: "", spendFactorSource: "" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [wave, setWave] = useState({ action: "request_sent", on: "", dueOn: "", channel: "email", detail: "", declineReason: "no_capability" });
  const [waveResult, setWaveResult] = useState<string | null>(null);

  const load = useCallback(async (s: PeriodSelection) => {
    const res = await fetch(`/api/value-chain/report?${periodQuery(s)}`);
    const b = await res.json();
    if (b.error) setError(b.error);
    else setReport(b);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/value-chain/report?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json())
      .then((b) => { if (!active) return; if (b.error) setError(b.error); else setReport(b); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function send(label: string, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url, init);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error ?? `${label} failed (${res.status})`);
        return null;
      }
      await load(selection);
      return b;
    } finally {
      setBusy(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const body = { ...form, ghgCategories: form.ghgCategories.length ? form.ghgCategories : undefined, annualValueGbp: form.annualValueGbp || undefined, spendFactorKgCo2ePerGbp: form.spendFactorKgCo2ePerGbp || undefined, spendFactorSource: form.spendFactorSource || undefined };
    if (await send("Add", "/api/value-chain/counterparties", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) {
      setForm({ ...form, name: "", annualValueGbp: "", contactName: "", contactEmail: "", escalationName: "", escalationEmail: "", sector: "", spendFactorKgCo2ePerGbp: "", spendFactorSource: "" });
    }
  }

  async function runWave(e: FormEvent) {
    e.preventDefault();
    if (!report || selected.size === 0) return;
    const body: Record<string, unknown> = { reportingYear: report.reportingYear, counterpartyIds: [...selected], action: wave.action, on: wave.on || undefined, channel: wave.channel, detail: wave.detail || undefined };
    if (wave.action === "request_sent" && wave.dueOn) body.dueOn = wave.dueOn;
    if (wave.action === "declined") body.declineReason = wave.declineReason;
    setWaveResult(null);
    const b = await send("Wave", "/api/value-chain/engagements/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (b) {
      const skipped = (b as { skipped: { name: string; reason: string }[] }).skipped;
      setWaveResult(`Recorded for ${(b as { applied: number }).applied} counterpart${(b as { applied: number }).applied === 1 ? "y" : "ies"}.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 5).map((x) => `${x.name} (${x.reason})`).join("; ")}${skipped.length > 5 ? "…" : ""}` : ""}`);
      setSelected(new Set());
    }
  }
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const rows = (report?.counterparties ?? []).filter((v) => {
    if (filter === "upstream") return v.direction === "upstream" || v.direction === "both";
    if (filter === "downstream") return v.direction === "downstream" || v.direction === "both";
    if (filter === "due") return v.next.due && v.counterparty.status === "active";
    if (filter === "no_data") return (v.dataSource === "none" || v.dataSource === "spend_estimate") && v.counterparty.status === "active";
    return true;
  });

  return (
    <>
      <h1>Value chain</h1>
      <p style={{ color: "#555" }}>
        Every upstream and downstream counterparty whose emissions fall in Scope 3, where this year&apos;s request for data has got to, and what they returned.
        The minimum ask is an annual GHG report; a counterparty with none is asked for an activity ledger, which the portal converts with the same DESNZ rows as{" "}
        <Link href="/emissions">refrigerants, water and waste</Link>. Open a counterparty to record contact, figures and documents. Requests that come <em>to</em> us are answered from the portal&apos;s own figures in{" "}
        <Link href="/value-chain/inbox">Requests in</Link>.
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {report && (
        <section style={card}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Counterparties" value={String(report.coverage.active)} sub={`${report.coverage.upstream} upstream, ${report.coverage.downstream} downstream${report.coverage.both ? `, ${report.coverage.both} both` : ""}`} />
            <Stat label={`Asked for ${report.reportingYear}`} value={`${report.coverage.asked} of ${report.coverage.active}`} sub={`${report.coverage.declined} declined, ${report.coverage.unreachable} unreachable`} />
            <Stat label="Data returned" value={`${report.coverage.withData} of ${report.coverage.active}`} sub={`${report.coverage.verified} verified${report.coverage.estimated ? `, ${report.coverage.estimated} on a spend estimate` : ""}`} />
            <Stat label="Value covered" value={report.coverage.valueCoveredPct === null ? "—" : `${report.coverage.valueCoveredPct}%`} sub={`£${fmtN(report.coverage.valueWithDataGbp)} of £${fmtN(report.coverage.valueTotalGbp)}`} />
            <Stat label="Attributable tCO2e" value={fmtN(report.totals.attributableTco2e)} sub={report.coverage.estimated ? `${fmtN(report.totals.returnedTco2e)} returned, ${fmtN(report.totals.estimatedTco2e)} estimated (tier D)` : `${report.totals.resolved} resolved, ${report.totals.unresolved} unresolved`} />
            <Stat label="Primary data share" value={report.totals.primarySharePct === null ? "—" : `${report.totals.primarySharePct}%`} sub={`tiers A ${report.totals.byTier.A}, B ${report.totals.byTier.B}, C ${report.totals.byTier.C}, E ${report.totals.byTier.E}`} />
            <Stat label="Actions due" value={String(report.coverage.dueNow)} sub={`${report.coverage.overdue} overdue`} />
          </div>
          {report.totals.byCategory.length > 0 && (
            <p style={{ fontSize: 12, color: "#666", marginBottom: 0 }}>
              By category: {report.totals.byCategory.map((c) => `${c.label}: ${fmtN(c.tco2e)} tCO2e (${c.withData} of ${c.counterparties} with data)`).join("; ")}.
            </p>
          )}
          {report.warnings.slice(0, 6).map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
          {report.warnings.length > 6 && <p style={{ fontSize: 12, color: "#856404" }}>{report.warnings.length - 6} more warnings are shown on the counterparties concerned.</p>}
        </section>
      )}

      {report && report.plan.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Engagement plan for {report.reportingYear} ({report.plan.length} due)</h2>
          <p style={{ fontSize: 12, color: "#666", marginTop: 0 }}>Overdue first, then by annual value. Work the list from the top.</p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Counterparty", "Value", "State", "Do next", "Why"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {report.plan.slice(0, 25).map((p) => (
                  <tr key={p.counterpartyId} style={p.overdue ? { background: "#fff5f5" } : undefined}>
                    <td style={td}><Link href={`/value-chain/${p.counterpartyId}`}>{p.name}</Link></td>
                    <td style={td}>{p.annualValueGbp === undefined ? <span style={{ color: "#856404" }}>not recorded</span> : `£${fmtN(p.annualValueGbp)}`}</td>
                    <td style={td}>{STATE_LABELS[p.state]}</td>
                    <td style={td}><strong>{p.action}</strong>{p.overdue && <span style={{ color: "#b02a37", marginLeft: 6 }}>overdue</span>}</td>
                    <td style={{ ...td, whiteSpace: "normal" }}>{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.plan.length > 25 && <p style={{ fontSize: 12, color: "#666" }}>{report.plan.length - 25} more in the register below.</p>}
        </section>
      )}

      <section style={card}>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 16 }}>Import a supplier or customer list</summary>
          <div style={{ marginTop: 10 }}>
            <CsvImport
              spec={{
                id: "counterparties",
                label: "Value chain counterparties",
                description: "Map the columns of a supplier list, an accounts-payable vendor export or a tenancy schedule. Roles and categories may hold several values separated by semicolons; a row whose name already exists updates it.",
                fields: counterpartyImportFields,
              }}
              onCommit={async (rows) => {
                const res = await fetch("/api/value-chain/counterparties", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
                const b = await res.json().catch(() => ({}));
                if (!res.ok) {
                  const detail = b.issues?.slice(0, 3).map((i: { row: number; message: string }) => `row ${i.row}: ${i.message}`).join("; ");
                  return { ok: false, message: [b.error, detail].filter(Boolean).join(" ") || `Import failed (${res.status})` };
                }
                await load(selection);
                return { ok: true, message: `Created ${b.created} and updated ${b.updated} counterparties.` };
              }}
            />
          </div>
        </details>
      </section>

      <section style={card}>
        <h2 style={h2}>Add a counterparty</h2>
        <form onSubmit={add} style={{ display: "grid", gap: 10, maxWidth: 820 }}>
          <div style={row}>
            <label style={{ flex: 2 }}>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Bidfood Ltd" style={input} /></label>
            <label style={{ flex: 1 }}>Sector<input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} placeholder="Food wholesale" style={input} /></label>
            <label style={{ flex: 1 }}>Annual value (£)<input type="number" min="0" step="any" value={form.annualValueGbp} onChange={(e) => setForm({ ...form, annualValueGbp: e.target.value })} placeholder="Spend with them, or revenue from them" style={input} /></label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>Roles (hold Ctrl or Cmd for several)
              <select multiple value={form.roles} onChange={(e) => setForm({ ...form, roles: [...e.target.selectedOptions].map((o) => o.value) })} style={{ ...input, height: 120 }}>
                {Object.entries(ROLES).map(([id, m]) => <option key={id} value={id}>{m.label} ({m.direction})</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>Scope 3 categories (blank follows the roles)
              <select multiple value={form.ghgCategories} onChange={(e) => setForm({ ...form, ghgCategories: [...e.target.selectedOptions].map((o) => o.value) })} style={{ ...input, height: 120 }}>
                {Object.entries(SCOPE3_CATEGORIES).map(([id, l]) => <option key={id} value={id}>{id}. {l}</option>)}
              </select>
            </label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>Contact<input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} placeholder="Day-to-day contact" style={input} /></label>
            <label style={{ flex: 1 }}>Contact email<input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} style={input} /></label>
            <label style={{ flex: 1 }}>Escalation contact<input value={form.escalationName} onChange={(e) => setForm({ ...form, escalationName: e.target.value })} placeholder="Account manager or commercial lead" style={input} /></label>
            <label style={{ flex: 1 }}>Escalation email<input type="email" value={form.escalationEmail} onChange={(e) => setForm({ ...form, escalationEmail: e.target.value })} style={input} /></label>
          </div>
          <div style={row}>
            <label style={{ flex: 2 }}>Minimum ask
              <select value={form.ask} onChange={(e) => setForm({ ...form, ask: e.target.value })} style={input}>
                {Object.entries(ASK_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>Spend factor (kgCO2e per £)<input type="number" min="0" step="any" value={form.spendFactorKgCo2ePerGbp} onChange={(e) => setForm({ ...form, spendFactorKgCo2ePerGbp: e.target.value })} placeholder="Tier D fallback" style={input} /></label>
            <label style={{ flex: 2 }}>Spend factor source<input value={form.spendFactorSource} onChange={(e) => setForm({ ...form, spendFactorSource: e.target.value })} placeholder="Publication, sector, year" style={input} /></label>
          </div>
          <button type="submit" disabled={busy !== null} style={{ padding: "8px 14px", width: "fit-content" }}>{busy === "Add" ? "Saving…" : "Add counterparty"}</button>
        </form>
      </section>

      {report && report.counterparties.length > 0 && (
        <section style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2 style={h2}>Register ({rows.length} of {report.counterparties.length})</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(["all", "upstream", "downstream", "due", "no_data"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} style={{ ...mini, fontWeight: filter === f ? 700 : 400 }}>{{ all: "All", upstream: "Upstream", downstream: "Downstream", due: "Action due", no_data: "No data" }[f]}</button>
              ))}
              <a href={`/api/exports/value-chain?year=${report.reportingYear}`} style={{ ...mini, alignSelf: "center" }}>Export CSV</a>
            </div>
          </div>
          <form onSubmit={runWave} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", background: "#f7f7f5", border: "1px solid #ddd", padding: 8, margin: "8px 0", fontSize: 12 }}>
            <span style={{ alignSelf: "center" }}><strong>Wave:</strong> record for {selected.size} selected</span>
            <button type="button" onClick={() => setSelected(new Set(rows.filter((v) => v.counterparty.status === "active").map((v) => v.counterparty.id)))} style={mini}>Select all shown</button>
            <button type="button" onClick={() => setSelected(new Set(rows.filter((v) => v.counterparty.status === "active" && v.state === "identified").map((v) => v.counterparty.id)))} style={mini}>Select not yet asked</button>
            <button type="button" onClick={() => setSelected(new Set())} style={mini}>Clear</button>
            <label>Action<select value={wave.action} onChange={(e) => setWave({ ...wave, action: e.target.value })} style={input}>
              {[["request_sent", "Request sent"], ["reminder_sent", "Reminder sent"], ["escalated", "Escalated"], ["declined", "Declined"], ["unreachable", "Unreachable"], ["note", "Note"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
            <label>Date<input type="date" value={wave.on} onChange={(e) => setWave({ ...wave, on: e.target.value })} style={input} /></label>
            {wave.action === "request_sent" && <label>Deadline<input type="date" value={wave.dueOn} onChange={(e) => setWave({ ...wave, dueOn: e.target.value })} style={input} /></label>}
            {wave.action === "declined" && <label>Reason<select value={wave.declineReason} onChange={(e) => setWave({ ...wave, declineReason: e.target.value })} style={input}>{Object.entries(DECLINE_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            <label>Channel<select value={wave.channel} onChange={(e) => setWave({ ...wave, channel: e.target.value })} style={input}>{CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}</select></label>
            <label style={{ flex: 1, minWidth: 160 }}>Detail<input value={wave.detail} onChange={(e) => setWave({ ...wave, detail: e.target.value })} placeholder="Wave 1, annual report ask" style={input} /></label>
            <button type="submit" disabled={busy !== null || selected.size === 0} style={{ padding: "6px 12px" }}>{busy === "Wave" ? "Recording…" : "Record"}</button>
          </form>
          {waveResult && <p style={box("#e7f3e7", "#b6dfb6")}>{waveResult}</p>}
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["", "Counterparty", "Direction", "Categories", "Value", "Engagement", "Data", "tCO2e", "Tier", "Next", ""].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.counterparty.id} style={v.counterparty.status === "inactive" ? { color: "#888" } : undefined}>
                    <td style={td}><input type="checkbox" checked={selected.has(v.counterparty.id)} onChange={() => toggle(v.counterparty.id)} disabled={v.counterparty.status === "inactive"} /></td>
                    <td style={td}>
                      <Link href={`/value-chain/${v.counterparty.id}`}>{v.counterparty.name}</Link>
                      <div style={{ color: "#666", fontSize: 11 }}>{v.counterparty.roles.map((r) => ROLES[r]?.label ?? r).join(", ")}{v.counterparty.status === "inactive" ? " · inactive" : ""}</div>
                    </td>
                    <td style={td}>{v.direction}</td>
                    <td style={td}>{v.counterparty.ghgCategories.join(", ")}</td>
                    <td style={td}>{v.counterparty.annualValueGbp === undefined ? "—" : `£${fmtN(v.counterparty.annualValueGbp)}`}</td>
                    <td style={td}>{STATE_LABELS[v.state]}{v.engagement?.dueOn && <div style={{ color: "#666", fontSize: 11 }}>due {v.engagement.dueOn}{v.engagement.remindersSent ? `, ${v.engagement.remindersSent} reminder${v.engagement.remindersSent === 1 ? "" : "s"}` : ""}{v.engagement.escalated ? ", escalated" : ""}</div>}</td>
                    <td style={td}>{{ report: "Annual report", ledger: "Ledger", spend_estimate: "Spend estimate", none: "None" }[v.dataSource]}</td>
                    <td style={td}>{v.dataSource === "none" ? "—" : fmtN(v.attributableTco2e)}{v.dataSource === "spend_estimate" && <div style={{ color: "#856404", fontSize: 11 }}>estimate</div>}</td>
                    <td style={td} title={v.tier ? TIER_LABELS[v.tier] : undefined}>{v.tier ?? "—"}</td>
                    <td style={{ ...td, whiteSpace: "normal" }}>{v.next.due ? <strong>{v.next.action}</strong> : v.next.action}{v.next.overdue && <span style={{ color: "#b02a37", marginLeft: 6 }}>overdue</span>}</td>
                    <td style={td}>{v.warnings.length > 0 && <span title={v.warnings.join("\n")} style={{ color: "#856404" }}>{v.warnings.length} ⚠</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
const fmtN = (n: number | null) => (n === null ? "unavailable" : n.toLocaleString("en-GB", { maximumFractionDigits: n < 10 ? 2 : 0 }));
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const mini = { padding: "2px 6px", fontSize: 11 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
