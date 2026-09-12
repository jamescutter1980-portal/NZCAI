"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { FactorPicker, factorLabel, type FactorRowView } from "@/components/FactorPicker";
import { CsvImport } from "@/components/CsvImport";
import { activityLedgerImportFields } from "@/lib/value-chain/import-spec";
import {
  ALLOCATION_LABELS,
  ASK_LABELS,
  CHANNELS,
  DECLINE_REASONS,
  ROLES,
  STATE_LABELS,
  TIER_LABELS,
  categoryLabel,
  type EngagementState,
  type Tier,
} from "@/lib/value-chain/types";

interface Counterparty {
  id: string; name: string; companyNumber?: string; sector?: string; country?: string; roles: string[]; ghgCategories: string[]; annualValueGbp?: number;
  contactName?: string; contactEmail?: string; escalationName?: string; escalationEmail?: string; ask: string; status: string; notes?: string;
  spendFactorKgCo2ePerGbp?: number; spendFactorSource?: string;
}
interface Candidate { companyName: string; companyNumber: string; status: string | null; type: string | null; incorporated: string | null; address: string | null }
interface Event { id: string; at: string; action: string; fromState: string; toState: string; channel?: string; detail?: string; actor?: string }
interface Engagement { id: string; reportingYear: number; state: EngagementState; ask: string; dueOn?: string; lastContactOn?: string; remindersSent: number; escalated: boolean; declineReason?: string; events: Event[] }
interface ReportRecord {
  id: string; reportingYear: number; periodStart: string; periodEnd: string; scope1Tco2e?: number; scope2LocationTco2e?: number; scope2MarketTco2e?: number; scope3Tco2e?: number;
  allocationMethod: string; allocatedTco2e?: number; supplierRevenueGbp?: number; methodology: string; boundary: string; assurance: string; assuranceProvider?: string; basis: string; evidence?: string; documentDate?: string;
}
interface Dossier { counterparty: Counterparty; engagements: Engagement[]; reports: ReportRecord[]; activity: { id: string; reportingYear: number }[] }
interface LedgerLine {
  id: string; label: string; activityType: string; periodStart: string; periodEnd: string; quantity: number; unit: string; sharePct: number;
  factor: { value: number | null; unit: string; reference: string }; lineKgCo2e: number | null; kgCo2e: number | null; tier: Tier | null; basis: string; warnings: string[];
}
interface View {
  state: EngagementState; dataSource: string; attributableTco2e: number | null; tier: Tier | null;
  report?: { id: string; reportedTotalTco2e: number | null; attributableTco2e: number | null; allocationDetail: string; tier: Tier | null; warnings: string[] };
  ledger: { lines: LedgerLine[]; counts: { lines: number; resolved: number; unresolved: number }; attributableTco2e: number | null; tier: Tier | null };
  reconciliation?: { detail: string };
  spendEstimate?: { attributableTco2e: number | null; detail: string };
  next: { action: string; reason: string; due: boolean; overdue: boolean };
  warnings: string[];
}
interface ReportEnvelope { reportingYear: number; period: { label: string; factorYear: number }; counterparties: ({ counterparty: { id: string } } & View)[] }

const ACTIONS: [string, string][] = [
  ["request_sent", "Request sent"], ["reminder_sent", "Reminder sent"], ["escalated", "Escalated"], ["reply_received", "Reply received"],
  ["data_received", "Data received"], ["marked_complete", "Marked complete"], ["verified", "Verified"], ["declined", "Declined"], ["unreachable", "Unreachable"], ["reopened", "Reopened"], ["note", "Note"],
];

export default function CounterpartyPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [envelope, setEnvelope] = useState<ReportEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [action, setAction] = useState({ action: "request_sent", on: "", channel: "email", detail: "", dueOn: "", complete: "false", declineReason: "no_capability", actor: "" });
  const [reportForm, setReportForm] = useState({ periodStart: "", periodEnd: "", scope1Tco2e: "", scope2LocationTco2e: "", scope2MarketTco2e: "", scope3Tco2e: "", allocationMethod: "spend_share", allocatedTco2e: "", supplierRevenueGbp: "", methodology: "ghg_protocol", boundary: "operational_control", assurance: "none", assuranceProvider: "", basis: "supplier_reported", evidence: "", documentDate: "" });
  const [lineForm, setLineForm] = useState({ label: "", activityType: "", periodStart: "", periodEnd: "", quantity: "", unit: "kWh", sharePct: "100", declaredKgCo2e: "", basis: "supplier_declared", evidence: "" });
  const [factor, setFactor] = useState<FactorRowView | null>(null);
  const [edit, setEdit] = useState<Partial<Counterparty> | null>(null);
  const [candidates, setCandidates] = useState<{ query: string; items: Candidate[] } | null>(null);
  const [resolution, setResolution] = useState<{ applied: string[]; warnings: string[] } | null>(null);
  const [links, setLinks] = useState<{ id: string; reportingYear: number; tokenHint: string; expiresOn: string; state: string; submittedAt?: string }[]>([]);
  const [issued, setIssued] = useState<{ url: string; expiresOn: string } | null>(null);

  const loadLinks = useCallback(async () => {
    const res = await fetch(`/api/value-chain/submissions?counterpartyId=${id}`);
    const b = await res.json().catch(() => ({}));
    if (!b.error) setLinks(b.links ?? []);
  }, [id]);

  const load = useCallback(async (s: PeriodSelection) => {
    const [d, r] = await Promise.all([fetch(`/api/value-chain/counterparties/${id}`).then((x) => x.json()), fetch(`/api/value-chain/report?${periodQuery(s)}`).then((x) => x.json())]);
    if (d.error) setError(d.error); else setDossier(d);
    if (r.error) setError(r.error); else setEnvelope(r);
  }, [id]);

  useEffect(() => {
    let active = true;
    const s = defaultPeriodSelection();
    Promise.all([
      fetch(`/api/value-chain/counterparties/${id}`).then((x) => x.json()),
      fetch(`/api/value-chain/report?${periodQuery(s)}`).then((x) => x.json()),
      fetch(`/api/value-chain/submissions?counterpartyId=${id}`).then((x) => x.json()),
    ])
      .then(([d, r, l]) => {
        if (!active) return;
        if (d.error) setError(d.error); else setDossier(d);
        if (r.error) setError(r.error); else setEnvelope(r);
        if (!l.error) setLinks(l.links ?? []);
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);

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
  const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const year = envelope?.reportingYear;
  const view = envelope?.counterparties.find((v) => v.counterparty.id === id);
  const engagement = dossier?.engagements.find((e) => e.reportingYear === year);
  const reportsForYear = dossier?.reports.filter((r) => r.reportingYear === year) ?? [];
  const c = dossier?.counterparty;

  async function recordAction(e: FormEvent) {
    e.preventDefault();
    if (!year) return;
    const body: Record<string, unknown> = { reportingYear: year, action: action.action, on: action.on || undefined, channel: action.channel, detail: action.detail || undefined, actor: action.actor || undefined };
    if (action.action === "request_sent" && action.dueOn) body.dueOn = action.dueOn;
    if (action.action === "data_received") body.complete = action.complete === "true";
    if (action.action === "declined") body.declineReason = action.declineReason;
    if (await send("Record", `/api/value-chain/counterparties/${id}/engagement`, json(body))) setAction({ ...action, detail: "", on: "" });
  }

  async function loadDraft() {
    if (!year) return;
    setBusy("Draft");
    try {
      const q = new URLSearchParams({ year: String(year) });
      if (action.dueOn) q.set("dueOn", action.dueOn);
      const res = await fetch(`/api/value-chain/counterparties/${id}/engagement?${q}`);
      const b = await res.json();
      if (b.error) setError(b.error); else setDraft(b.draft);
    } finally {
      setBusy(null);
    }
  }

  async function addReport(e: FormEvent) {
    e.preventDefault();
    if (!year) return;
    const body = Object.fromEntries(Object.entries({ ...reportForm, counterpartyId: id, reportingYear: year }).map(([k, v]) => [k, v === "" ? undefined : v]));
    if (await send("Report", "/api/value-chain/emissions", json(body))) setReportForm({ ...reportForm, scope1Tco2e: "", scope2LocationTco2e: "", scope2MarketTco2e: "", scope3Tco2e: "", allocatedTco2e: "", evidence: "" });
  }

  async function addLine(e: FormEvent) {
    e.preventDefault();
    if (!year) return;
    const body = { ...lineForm, counterpartyId: id, reportingYear: year, declaredKgCo2e: lineForm.declaredKgCo2e || undefined, evidence: lineForm.evidence || undefined, factorId: factor?.id, factorYear: factor ? envelope?.period.factorYear : undefined };
    if (await send("Line", "/api/value-chain/activity", json(body))) setLineForm({ ...lineForm, label: "", quantity: "", declaredKgCo2e: "" });
  }

  async function findOnRegister() {
    setBusy("Find");
    setError(null);
    try {
      const res = await fetch(`/api/value-chain/counterparties/${id}/resolve`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) setError(b.error ?? `Search failed (${res.status})`);
      else setCandidates({ query: b.query, items: b.candidates });
    } finally {
      setBusy(null);
    }
  }
  async function applyCandidate(companyNumber: string) {
    const b = await send("Resolve", `/api/value-chain/counterparties/${id}/resolve`, json({ companyNumber }));
    if (b) {
      setResolution({ applied: b.applied as string[], warnings: b.warnings as string[] });
      setCandidates(null);
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const body = Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, v === "" ? null : v]));
    if (await send("Save", `/api/value-chain/counterparties/${id}`, json(body, "PATCH"))) setEdit(null);
  }

  if (error && !dossier) return <p style={box("#f8d7da", "#f1aeb5")}>{error} <Link href="/value-chain">Back to the value chain</Link></p>;
  if (!c) return <p>Loading…</p>;

  const isSpendShare = reportForm.allocationMethod === "spend_share";
  const needsAllocated = reportForm.allocationMethod === "supplier_allocated" || reportForm.allocationMethod === "product_specific";

  return (
    <>
      <p style={{ fontSize: 13 }}><Link href="/value-chain">← Value chain</Link></p>
      <h1 style={{ marginBottom: 4 }}>{c.name}{c.status === "inactive" && <span style={{ fontSize: 14, color: "#888", marginLeft: 8 }}>inactive</span>}</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        {c.roles.map((r) => ROLES[r]?.label ?? r).join(", ")} · {c.ghgCategories.map(categoryLabel).join("; ")}
        {c.sector ? ` · ${c.sector}` : ""}{c.companyNumber ? ` · Companies House ${c.companyNumber}` : ""}
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); setDraft(null); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2 style={h2}>Relationship</h2>
          {!edit && (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={findOnRegister} disabled={busy !== null} style={mini}>{busy === "Find" ? "Searching…" : c.companyNumber ? "Re-check Companies House" : "Find on Companies House"}</button>
              <button onClick={() => setEdit({ name: c.name, annualValueGbp: c.annualValueGbp, contactName: c.contactName ?? "", contactEmail: c.contactEmail ?? "", escalationName: c.escalationName ?? "", escalationEmail: c.escalationEmail ?? "", ask: c.ask, status: c.status, sector: c.sector ?? "", companyNumber: c.companyNumber ?? "", notes: c.notes ?? "", spendFactorKgCo2ePerGbp: c.spendFactorKgCo2ePerGbp, spendFactorSource: c.spendFactorSource ?? "" })} style={mini}>Edit</button>
            </div>
          )}
        </div>
        {edit ? (
          <form onSubmit={saveEdit} style={{ display: "grid", gap: 10, maxWidth: 820 }}>
            <div style={row}>
              <label style={{ flex: 2 }}>Name<input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required style={input} /></label>
              <label style={{ flex: 1 }}>Annual value (£)<input type="number" min="0" step="any" value={edit.annualValueGbp ?? ""} onChange={(e) => setEdit({ ...edit, annualValueGbp: e.target.value === "" ? undefined : Number(e.target.value) })} style={input} /></label>
              <label style={{ flex: 1 }}>Sector<input value={edit.sector ?? ""} onChange={(e) => setEdit({ ...edit, sector: e.target.value })} style={input} /></label>
              <label style={{ flex: 1 }}>Company number<input value={edit.companyNumber ?? ""} onChange={(e) => setEdit({ ...edit, companyNumber: e.target.value })} style={input} /></label>
            </div>
            <div style={row}>
              <label style={{ flex: 1 }}>Contact<input value={edit.contactName ?? ""} onChange={(e) => setEdit({ ...edit, contactName: e.target.value })} style={input} /></label>
              <label style={{ flex: 1 }}>Contact email<input value={edit.contactEmail ?? ""} onChange={(e) => setEdit({ ...edit, contactEmail: e.target.value })} style={input} /></label>
              <label style={{ flex: 1 }}>Escalation<input value={edit.escalationName ?? ""} onChange={(e) => setEdit({ ...edit, escalationName: e.target.value })} style={input} /></label>
              <label style={{ flex: 1 }}>Escalation email<input value={edit.escalationEmail ?? ""} onChange={(e) => setEdit({ ...edit, escalationEmail: e.target.value })} style={input} /></label>
            </div>
            <div style={row}>
              <label style={{ flex: 2 }}>Minimum ask<select value={edit.ask} onChange={(e) => setEdit({ ...edit, ask: e.target.value })} style={input}>{Object.entries(ASK_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label style={{ flex: 1 }}>Status<select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} style={input}><option value="active">active</option><option value="inactive">inactive</option></select></label>
            </div>
            <div style={row}>
              <label style={{ flex: 1 }}>Spend factor (kgCO2e per £)<input type="number" min="0" step="any" value={edit.spendFactorKgCo2ePerGbp ?? ""} onChange={(e) => setEdit({ ...edit, spendFactorKgCo2ePerGbp: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="Tier D fallback while no data" style={input} /></label>
              <label style={{ flex: 2 }}>Spend factor source<input value={edit.spendFactorSource ?? ""} onChange={(e) => setEdit({ ...edit, spendFactorSource: e.target.value })} placeholder="Publication, sector and year" style={input} /></label>
            </div>
            <label>Notes<textarea value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} rows={2} style={input} /></label>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={busy !== null} style={{ padding: "6px 12px" }}>Save</button>
              <button type="button" onClick={() => setEdit(null)} style={{ padding: "6px 12px" }}>Cancel</button>
              <button type="button" onClick={async () => { if (confirm(`Delete ${c.name} and everything recorded against it?`)) { if (await send("Delete", `/api/value-chain/counterparties/${id}`, { method: "DELETE" })) router.push("/value-chain"); } }} style={{ padding: "6px 12px", marginLeft: "auto", color: "#b02a37" }}>Delete counterparty</button>
            </div>
          </form>
        ) : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Annual value" value={c.annualValueGbp === undefined ? "not recorded" : `£${fmtN(c.annualValueGbp)}`} />
            <Stat label="Contact" value={c.contactName ?? "—"} sub={c.contactEmail} />
            <Stat label="Escalation" value={c.escalationName ?? "—"} sub={c.escalationEmail} />
            <Stat label="Minimum ask" value={ASK_LABELS[c.ask as keyof typeof ASK_LABELS]?.split(" (")[0] ?? c.ask} />
            {view && <Stat label={`${year} attributable`} value={view.dataSource === "none" ? "no data" : `${fmtN(view.attributableTco2e)} tCO2e`} sub={view.dataSource === "spend_estimate" ? "spend estimate, tier D" : view.tier ? `Tier ${view.tier}: ${TIER_LABELS[view.tier]}` : undefined} />}
            {c.spendFactorKgCo2ePerGbp !== undefined && <Stat label="Spend factor" value={`${c.spendFactorKgCo2ePerGbp} kgCO2e/£`} sub={c.spendFactorSource} />}
          </div>
        )}
        {candidates && (
          <div style={{ marginTop: 10, border: "1px solid #ddd", padding: 8 }}>
            <p style={{ fontSize: 12, margin: "0 0 6px" }}>Companies House matches for &quot;{candidates.query}&quot;. Pick one to fill the company number and sector; the recorded name is kept.</p>
            {candidates.items.length === 0 ? <p style={{ fontSize: 12, color: "#856404", margin: 0 }}>No matches. Edit the name or search a different spelling.</p> : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>{["Registered name", "Number", "Status", "Incorporated", "Address", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{candidates.items.map((k) => (
                  <tr key={k.companyNumber}>
                    <td style={td}>{k.companyName}</td><td style={td}>{k.companyNumber}</td><td style={td}>{k.status ?? ""}</td><td style={td}>{k.incorporated ?? ""}</td><td style={{ ...td, whiteSpace: "normal" }}>{k.address ?? ""}</td>
                    <td style={td}><button onClick={() => applyCandidate(k.companyNumber)} disabled={busy !== null} style={mini}>Use</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <button onClick={() => setCandidates(null)} style={{ ...mini, marginTop: 6 }}>Close</button>
          </div>
        )}
        {resolution && (
          <div style={{ marginTop: 8 }}>
            <p style={box("#e7f3e7", "#b6dfb6")}>Applied from Companies House: {resolution.applied.join("; ")}.</p>
            {resolution.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
          </div>
        )}
        {c.notes && !edit && <p style={{ fontSize: 12, color: "#555", whiteSpace: "pre-wrap" }}>{c.notes}</p>}
      </section>

      {view && year && (
        <section style={card}>
          <h2 style={h2}>Engagement for {year}</h2>
          <p style={{ margin: "0 0 8px" }}>
            <strong>{STATE_LABELS[view.state]}</strong>
            {engagement?.dueOn && ` · due ${engagement.dueOn}`}{engagement?.lastContactOn && ` · last contact ${engagement.lastContactOn}`}
            {engagement && engagement.remindersSent > 0 && ` · ${engagement.remindersSent} reminder${engagement.remindersSent === 1 ? "" : "s"}`}{engagement?.escalated && " · escalated"}
            {engagement?.declineReason && ` · ${DECLINE_REASONS[engagement.declineReason as keyof typeof DECLINE_REASONS] ?? engagement.declineReason}`}
          </p>
          <p style={box(view.next.overdue ? "#f8d7da" : view.next.due ? "#fff3cd" : "#e7f3e7", view.next.overdue ? "#f1aeb5" : view.next.due ? "#ffe69c" : "#b6dfb6")}>
            <strong>{view.next.action}.</strong> {view.next.reason}
          </p>
          {view.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}

          <form onSubmit={recordAction} style={{ display: "grid", gap: 10, maxWidth: 820, marginTop: 8 }}>
            <div style={row}>
              <label style={{ flex: 1 }}>Record
                <select value={action.action} onChange={(e) => setAction({ ...action, action: e.target.value })} style={input}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <label>Date<input type="date" value={action.on} onChange={(e) => setAction({ ...action, on: e.target.value })} style={input} /></label>
              <label>Channel<select value={action.channel} onChange={(e) => setAction({ ...action, channel: e.target.value })} style={input}>{CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}</select></label>
              {action.action === "request_sent" && <label>Deadline given<input type="date" value={action.dueOn} onChange={(e) => setAction({ ...action, dueOn: e.target.value })} style={input} /></label>}
              {action.action === "data_received" && <label>Everything asked for?<select value={action.complete} onChange={(e) => setAction({ ...action, complete: e.target.value })} style={input}><option value="false">Partial</option><option value="true">Complete</option></select></label>}
              {action.action === "declined" && <label style={{ flex: 1 }}>Reason<select value={action.declineReason} onChange={(e) => setAction({ ...action, declineReason: e.target.value })} style={input}>{Object.entries(DECLINE_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            </div>
            <div style={row}>
              <label style={{ flex: 3 }}>Detail<input value={action.detail} onChange={(e) => setAction({ ...action, detail: e.target.value })} placeholder="Who was contacted, what was said, file received" style={input} /></label>
              <label style={{ flex: 1 }}>Recorded by<input value={action.actor} onChange={(e) => setAction({ ...action, actor: e.target.value })} style={input} /></label>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="submit" disabled={busy !== null} style={{ padding: "6px 12px" }}>{busy === "Record" ? "Saving…" : "Record"}</button>
              <button type="button" onClick={loadDraft} disabled={busy !== null} style={{ padding: "6px 12px" }}>Draft the request</button>
            </div>
          </form>
          {draft && (
            <div style={{ marginTop: 10 }}>
              <p style={{ fontSize: 12, color: "#666", margin: "0 0 4px" }}>Paste into an email. Nothing is sent from the portal. Set the client name with CLIENT_NAME in .env.local.</p>
              <input readOnly value={draft.subject} style={{ ...input, marginBottom: 4, fontWeight: 600 }} onFocus={(e) => e.target.select()} />
              <textarea readOnly value={draft.body} rows={16} style={{ ...input, fontFamily: "inherit" }} onFocus={(e) => e.target.select()} />
            </div>
          )}

          {engagement && engagement.events.length > 0 && (
            <details style={{ marginTop: 10 }} open>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>Audit trail ({engagement.events.length})</summary>
              <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
                <thead><tr>{["Date", "Action", "State", "Channel", "Detail", "By"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {engagement.events.map((ev) => (
                    <tr key={ev.id}>
                      <td style={td}>{ev.at}</td><td style={td}>{ev.action.replace(/_/g, " ")}</td>
                      <td style={td}>{ev.fromState === ev.toState ? ev.toState : `${ev.fromState} → ${ev.toState}`}</td>
                      <td style={td}>{ev.channel ?? ""}</td><td style={{ ...td, whiteSpace: "normal" }}>{ev.detail ?? ""}</td><td style={td}>{ev.actor ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {dossier && dossier.engagements.filter((e) => e.reportingYear !== year).length > 0 && (
            <p style={{ fontSize: 12, color: "#666", marginBottom: 0 }}>Other years: {dossier.engagements.filter((e) => e.reportingYear !== year).map((e) => `${e.reportingYear} ${STATE_LABELS[e.state].toLowerCase()}`).join("; ")}.</p>
          )}
        </section>
      )}

      {dossier && (
        <section style={card}>
          <h2 style={h2}>Ask them to send it themselves</h2>
          <p style={{ fontSize: 13, color: "#555" }}>
            A one-time link lets this counterparty enter its own figures without a portal account. What comes back waits for review here; it does not become the
            reported figure until it is accepted. The link is shown once and cannot be recovered afterwards.
          </p>
          <div style={{ ...row, alignItems: "flex-end" }}>
            <button
              disabled={busy !== null}
              onClick={async () => {
                const b = await send("Link", "/api/value-chain/submissions", {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ counterpartyId: id, reportingYear: year, ask: dossier.counterparty.ask, validForDays: 30 }),
                });
                if (b) {
                  const token = (b as { token: string }).token;
                  const link = (b as { link: { expiresOn: string } }).link;
                  setIssued({ url: `${window.location.origin}/value-chain/submit/${token}`, expiresOn: link.expiresOn });
                  void loadLinks();
                }
              }}
            >
              Issue a link for {year}
            </button>
          </div>
          {issued && (
            <p style={{ ...box("#e7f6e7", "#b9dfb9"), marginTop: 8, wordBreak: "break-all" }}>
              Send this to them now; it expires on {issued.expiresOn} and is not stored anywhere you can read it back.<br />
              <code style={{ fontSize: 12 }}>{issued.url}</code>
            </p>
          )}
          {links.length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 10 }}>
              <thead><tr><th style={th}>Year</th><th style={th}>Link</th><th style={th}>Expires</th><th style={th}>State</th><th style={th}>Sent</th><th style={th}></th></tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.reportingYear}</td>
                    <td style={td}>ending {l.tokenHint}</td>
                    <td style={td}>{l.expiresOn}</td>
                    <td style={td}>{l.state}</td>
                    <td style={td}>{l.submittedAt?.slice(0, 10) ?? "—"}</td>
                    <td style={td}>
                      {l.state === "submitted" && (
                        <>
                          <button style={mini} disabled={busy !== null} onClick={async () => { if (await send("Accept", `/api/value-chain/submissions/${l.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) })) void loadLinks(); }}>Accept</button>{" "}
                          <button style={mini} disabled={busy !== null} onClick={async () => { if (await send("Reject", `/api/value-chain/submissions/${l.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }) })) void loadLinks(); }}>Reject</button>
                        </>
                      )}
                      {l.state === "open" && (
                        <button style={mini} disabled={busy !== null} onClick={async () => { if (await send("Revoke", `/api/value-chain/submissions/${l.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revoke" }) })) void loadLinks(); }}>Withdraw</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {dossier && dossier.reports.some((r) => r.reportingYear !== year) && (
        <section style={card}>
          <h2 style={h2}>Previous years</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["Year", "Period", "Scope 1", "Scope 2", "Scope 3", "Allocation", "Assurance", "Evidence"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{dossier.reports.filter((r) => r.reportingYear !== year).map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.reportingYear}</td><td style={td}>{r.periodStart} to {r.periodEnd}</td><td style={td}>{fmtT(r.scope1Tco2e)}</td><td style={td}>{fmtT(r.scope2MarketTco2e ?? r.scope2LocationTco2e)}</td><td style={td}>{fmtT(r.scope3Tco2e)}</td>
                <td style={td}>{ALLOCATION_LABELS[r.allocationMethod as keyof typeof ALLOCATION_LABELS] ?? r.allocationMethod}{r.allocatedTco2e !== undefined ? ` (${fmtN(r.allocatedTco2e)} tCO2e)` : ""}</td><td style={td}>{r.assurance}</td><td style={{ ...td, whiteSpace: "normal" }}>{r.evidence ?? ""}</td>
              </tr>
            ))}</tbody>
          </table>
          <p style={{ fontSize: 12, color: "#666", marginBottom: 0 }}>Last year&apos;s figures are the starting point for this year&apos;s ask: confirm or correct, then request only what is new.</p>
        </section>
      )}

      {year && (
        <section style={card}>
          <h2 style={h2}>Annual GHG report for {year}</h2>
          {reportsForYear.length > 0 && view?.report && (
            <div style={{ marginBottom: 10 }}>
              {reportsForYear.map((r) => (
                <div key={r.id} style={{ border: "1px solid #ddd", padding: 10, marginBottom: 6, background: "#fafaf8" }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <Stat label="Period" value={`${r.periodStart} to ${r.periodEnd}`} />
                    <Stat label="Scope 1" value={fmtT(r.scope1Tco2e)} />
                    <Stat label="Scope 2" value={fmtT(r.scope2MarketTco2e ?? r.scope2LocationTco2e)} sub={r.scope2MarketTco2e !== undefined && r.scope2LocationTco2e !== undefined ? `market; location ${fmtT(r.scope2LocationTco2e)}` : r.scope2MarketTco2e !== undefined ? "market-based" : r.scope2LocationTco2e !== undefined ? "location-based" : undefined} />
                    <Stat label="Scope 3" value={fmtT(r.scope3Tco2e)} />
                    <Stat label="Reported total" value={fmtT(view.report?.id === r.id ? view.report.reportedTotalTco2e ?? undefined : undefined)} />
                    <Stat label="Attributable to us" value={view.report?.id === r.id ? fmtT(view.report.attributableTco2e ?? undefined) : "—"} sub={view.report?.id === r.id && view.report.tier ? `Tier ${view.report.tier}` : undefined} />
                  </div>
                  <p style={{ fontSize: 12, margin: "6px 0 0" }}>{view.report?.id === r.id ? view.report.allocationDetail : ALLOCATION_LABELS[r.allocationMethod as keyof typeof ALLOCATION_LABELS]}</p>
                  <p style={{ fontSize: 12, color: "#666", margin: "4px 0 0" }}>
                    {r.methodology.replace(/_/g, " ")} · {r.boundary.replace(/_/g, " ")} · assurance {r.assurance}{r.assuranceProvider ? ` by ${r.assuranceProvider}` : ""} · {r.basis.replace(/_/g, " ")}
                    {r.evidence ? ` · evidence: ${r.evidence}` : <span style={{ color: "#b02a37" }}> · no evidence recorded</span>}{r.documentDate ? ` (${r.documentDate})` : ""}
                  </p>
                  <button onClick={() => send("Delete", `/api/value-chain/emissions/${r.id}`, { method: "DELETE" })} disabled={busy !== null} style={{ ...mini, marginTop: 6 }}>Delete</button>
                </div>
              ))}
              {view.reconciliation && <p style={box("#e8f0fe", "#b6d0f7")}>{view.reconciliation.detail}</p>}
            </div>
          )}
          <details open={reportsForYear.length === 0}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Record the figures from a report</summary>
            <form onSubmit={addReport} style={{ display: "grid", gap: 10, maxWidth: 820, marginTop: 8 }}>
              <div style={row}>
                <label>Report period from<input type="date" value={reportForm.periodStart} onChange={(e) => setReportForm({ ...reportForm, periodStart: e.target.value })} required style={input} /></label>
                <label>to<input type="date" value={reportForm.periodEnd} onChange={(e) => setReportForm({ ...reportForm, periodEnd: e.target.value })} required style={input} /></label>
                <label>Scope 1 tCO2e<input type="number" min="0" step="any" value={reportForm.scope1Tco2e} onChange={(e) => setReportForm({ ...reportForm, scope1Tco2e: e.target.value })} style={input} /></label>
                <label>Scope 2 location<input type="number" min="0" step="any" value={reportForm.scope2LocationTco2e} onChange={(e) => setReportForm({ ...reportForm, scope2LocationTco2e: e.target.value })} style={input} /></label>
                <label>Scope 2 market<input type="number" min="0" step="any" value={reportForm.scope2MarketTco2e} onChange={(e) => setReportForm({ ...reportForm, scope2MarketTco2e: e.target.value })} style={input} /></label>
                <label>Scope 3 tCO2e<input type="number" min="0" step="any" value={reportForm.scope3Tco2e} onChange={(e) => setReportForm({ ...reportForm, scope3Tco2e: e.target.value })} style={input} /></label>
              </div>
              <div style={row}>
                <label style={{ flex: 2 }}>How it is attributed to us
                  <select value={reportForm.allocationMethod} onChange={(e) => setReportForm({ ...reportForm, allocationMethod: e.target.value })} style={input}>{Object.entries(ALLOCATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                {isSpendShare && <label style={{ flex: 1 }}>Their revenue (£)<input type="number" min="0" step="any" value={reportForm.supplierRevenueGbp} onChange={(e) => setReportForm({ ...reportForm, supplierRevenueGbp: e.target.value })} required style={input} /></label>}
                {needsAllocated && <label style={{ flex: 1 }}>Attributable tCO2e<input type="number" min="0" step="any" value={reportForm.allocatedTco2e} onChange={(e) => setReportForm({ ...reportForm, allocatedTco2e: e.target.value })} required style={input} /></label>}
              </div>
              {isSpendShare && <p style={{ fontSize: 12, color: "#666", margin: 0 }}>Share = our annual value (£{c.annualValueGbp === undefined ? "not recorded" : fmtN(c.annualValueGbp)}) ÷ their revenue. Record the annual value on the relationship first.</p>}
              <div style={row}>
                <label>Methodology<select value={reportForm.methodology} onChange={(e) => setReportForm({ ...reportForm, methodology: e.target.value })} style={input}><option value="ghg_protocol">GHG Protocol</option><option value="iso_14064">ISO 14064</option><option value="vsme">VSME</option><option value="other">Other</option></select></label>
                <label>Boundary<select value={reportForm.boundary} onChange={(e) => setReportForm({ ...reportForm, boundary: e.target.value })} style={input}><option value="operational_control">Operational control</option><option value="financial_control">Financial control</option><option value="equity_share">Equity share</option><option value="unknown">Not stated</option></select></label>
                <label>Assurance<select value={reportForm.assurance} onChange={(e) => setReportForm({ ...reportForm, assurance: e.target.value })} style={input}><option value="none">None</option><option value="limited">Limited</option><option value="reasonable">Reasonable</option></select></label>
                {reportForm.assurance !== "none" && <label>Assurance provider<input value={reportForm.assuranceProvider} onChange={(e) => setReportForm({ ...reportForm, assuranceProvider: e.target.value })} style={input} /></label>}
                <label>Basis<select value={reportForm.basis} onChange={(e) => setReportForm({ ...reportForm, basis: e.target.value })} style={input}><option value="supplier_reported">Sent to us by the counterparty</option><option value="public_report">Taken from a public report</option><option value="estimated">Estimated</option></select></label>
              </div>
              <div style={row}>
                <label style={{ flex: 3 }}>Evidence<input value={reportForm.evidence} onChange={(e) => setReportForm({ ...reportForm, evidence: e.target.value })} placeholder="2025 Sustainability Report p.14; email of 3 Feb 2026 with attachment" style={input} /></label>
                <label>Document date<input type="date" value={reportForm.documentDate} onChange={(e) => setReportForm({ ...reportForm, documentDate: e.target.value })} style={input} /></label>
              </div>
              <button type="submit" disabled={busy !== null} style={{ padding: "6px 12px", width: "fit-content" }}>{busy === "Report" ? "Saving…" : "Record report"}</button>
            </form>
          </details>
        </section>
      )}

      {year && view && (
        <section style={card}>
          <h2 style={h2}>Activity ledger for {year}</h2>
          <p style={{ fontSize: 12, color: "#666", marginTop: 0 }}>
            For a counterparty with no annual report. Each line is converted with a DESNZ row, or carries the kgCO2e the counterparty declared; the share is the part done on our account.
            {view.ledger.counts.lines > 0 && ` ${view.ledger.counts.resolved} of ${view.ledger.counts.lines} lines resolve, giving ${view.ledger.attributableTco2e === null ? "a blank total" : `${fmtN(view.ledger.attributableTco2e)} tCO2e`}${view.ledger.tier ? ` at tier ${view.ledger.tier}` : ""}.`}
          </p>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Upload the ledger the counterparty returned</summary>
            <div style={{ marginTop: 8 }}>
              <CsvImport
                spec={{ id: "counterparty-activity", label: `${c.name} activity ledger ${year}`, description: "The template sent with the request, or the counterparty's own export. Download the template to send it with the request.", fields: activityLedgerImportFields }}
                onCommit={async (rows) => {
                  const res = await fetch("/api/value-chain/activity", json({ counterpartyId: id, reportingYear: year, rows }));
                  const b = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    const detail = b.issues?.slice(0, 3).map((i: { row: number; message: string }) => `row ${i.row}: ${i.message}`).join("; ");
                    return { ok: false, message: [b.error, detail].filter(Boolean).join(" ") || `Import failed (${res.status})` };
                  }
                  await load(selection);
                  return { ok: true, message: `Imported ${b.created} lines. Choose a DESNZ row for any line without one.` };
                }}
              />
            </div>
          </details>
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Add a line</summary>
            <form onSubmit={addLine} style={{ display: "grid", gap: 10, maxWidth: 820, marginTop: 8 }}>
              <div style={row}>
                <label style={{ flex: 2 }}>Description<input value={lineForm.label} onChange={(e) => setLineForm({ ...lineForm, label: e.target.value })} required placeholder="Depot electricity Q1" style={input} /></label>
                <label style={{ flex: 1 }}>Activity type<input value={lineForm.activityType} onChange={(e) => setLineForm({ ...lineForm, activityType: e.target.value })} required placeholder="Electricity" style={input} /></label>
              </div>
              <div style={row}>
                <label>From<input type="date" value={lineForm.periodStart} onChange={(e) => setLineForm({ ...lineForm, periodStart: e.target.value })} required style={input} /></label>
                <label>To<input type="date" value={lineForm.periodEnd} onChange={(e) => setLineForm({ ...lineForm, periodEnd: e.target.value })} required style={input} /></label>
                <label>Quantity<input type="number" min="0" step="any" value={lineForm.quantity} onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })} required style={input} /></label>
                <label>Unit<input value={lineForm.unit} onChange={(e) => setLineForm({ ...lineForm, unit: e.target.value })} required style={input} /></label>
                <label>Our share (%)<input type="number" min="0" max="100" step="any" value={lineForm.sharePct} onChange={(e) => setLineForm({ ...lineForm, sharePct: e.target.value })} required style={input} /></label>
              </div>
              <div style={row}>
                <label>Declared kgCO2e<input type="number" min="0" step="any" value={lineForm.declaredKgCo2e} onChange={(e) => setLineForm({ ...lineForm, declaredKgCo2e: e.target.value })} placeholder="Only if no factor" style={input} /></label>
                <label>Basis<select value={lineForm.basis} onChange={(e) => setLineForm({ ...lineForm, basis: e.target.value })} style={input}><option value="measured">measured</option><option value="estimated">estimated</option><option value="supplier_declared">supplier declared</option></select></label>
                <label style={{ flex: 2 }}>Evidence<input value={lineForm.evidence} onChange={(e) => setLineForm({ ...lineForm, evidence: e.target.value })} placeholder="Utility bills, fleet report" style={input} /></label>
              </div>
              <FactorPicker year={envelope?.period.factorYear ?? new Date().getUTCFullYear() - 1} value={factor ? { id: factor.id, year: envelope?.period.factorYear ?? 0, uom: factor.uom } : null} onSelect={(r) => { setFactor(r); if (r) setLineForm((f) => ({ ...f, unit: r.uom })); }} />
              {factor && <p style={{ fontSize: 12, color: "#666", margin: 0 }}>{factorLabel(factor)} — {factor.factor} {factor.ghgUnit} per {factor.uom}, published as {factor.scope}.</p>}
              <button type="submit" disabled={busy !== null} style={{ padding: "6px 12px", width: "fit-content" }}>{busy === "Line" ? "Saving…" : "Add line"}</button>
            </form>
          </details>
          {view.ledger.lines.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>{["Description", "Period", "Quantity", "Share", "Factor", "kgCO2e", "Tier", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {view.ledger.lines.map((l) => (
                    <tr key={l.id}>
                      <td style={td}>{l.label}<div style={{ color: "#666", fontSize: 11 }}>{l.activityType} · {l.basis.replace(/_/g, " ")}</div></td>
                      <td style={td}>{l.periodStart} to {l.periodEnd}</td>
                      <td style={td}>{l.quantity} {l.unit}</td>
                      <td style={td}>{l.sharePct}%</td>
                      <td style={td}>{l.factor.value === null ? <span style={{ color: l.lineKgCo2e === null ? "#b02a37" : "#666" }}>{l.factor.reference}</span> : `${l.factor.value} ${l.factor.unit}`}{l.factor.value !== null && <div style={{ color: "#666", fontSize: 11 }}>{l.factor.reference}</div>}</td>
                      <td style={td}>{l.kgCo2e === null ? "unavailable" : fmtN(l.kgCo2e)}{l.sharePct !== 100 && l.lineKgCo2e !== null && <div style={{ color: "#666", fontSize: 11 }}>of {fmtN(l.lineKgCo2e)}</div>}</td>
                      <td style={td}>{l.tier ?? "—"}</td>
                      <td style={td}><button onClick={() => send("Delete", `/api/value-chain/activity/${l.id}`, { method: "DELETE" })} disabled={busy !== null} style={mini}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.ledger.lines.some((l) => l.warnings.length > 0) && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "#856404" }}>Line warnings</summary>
                  <ul style={{ fontSize: 12 }}>{view.ledger.lines.flatMap((l) => l.warnings.map((w, i) => <li key={`${l.id}-${i}`}><strong>{l.label}</strong>: {w}</li>))}</ul>
                </details>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#f7f7f5", border: "1px solid #ddd", padding: "8px 12px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#666" }}>{sub}</div>}
    </div>
  );
}
const fmtN = (n: number | null) => (n === null ? "unavailable" : n.toLocaleString("en-GB", { maximumFractionDigits: n < 10 ? 2 : 0 }));
const fmtT = (n: number | undefined) => (n === undefined ? "—" : `${fmtN(n)} tCO2e`);
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const mini = { padding: "2px 6px", fontSize: 11 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
