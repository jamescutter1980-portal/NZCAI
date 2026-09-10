"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

interface MetricMeta { label: string; unit: string; group: string }
interface Field { key: string; label: string; metric: string; unit?: string; override?: number; note?: string }
interface RequestRecord {
  id: string; counterpartyId: string; title: string; reportingYear: number; periodStartMonth: number; template?: string; fields: Field[]; dueOn?: string; owner?: string;
  cadence: string; state: "open" | "submitted" | "closed"; submittedOn?: string; submittedFigures?: { key: string; label: string; value: number | null; unit: string }[]; submissionNote?: string; notes?: string;
}
interface Item { request: RequestRecord; requesterName: string; daysToDue: number | null; overdue: boolean; needsRollForward: boolean }
interface Summary { items: Item[]; counts: { open: number; overdue: number; dueSoon: number; submitted: number; needsRollForward: number }; metrics: Record<string, MetricMeta> }
interface Conflict { requesterName: string; submittedOn: string; value: number | null; variancePct: number | null; detail: string }
interface DraftField { key: string; label: string; metric: string; metricLabel: string; value: number | null; unit: string; requestedUnit?: string; source: string; overridden: boolean; note?: string; conflicts: Conflict[]; warnings: string[] }
interface Draft { request: RequestRecord; requesterName: string; period: { label: string }; fields: DraftField[]; counts: { fields: number; answered: number; blank: number; conflicts: number }; warnings: string[] }
interface Counterparty { id: string; name: string; roles: string[] }

const blankField = (): Field => ({ key: "", label: "", metric: "scope1_kgco2e", unit: "" });

export default function InboxPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edits, setEdits] = useState<Record<string, { override: string; note: string }>>({});
  const [submitNote, setSubmitNote] = useState("");
  const [form, setForm] = useState({ counterpartyId: "", title: "", reportingYear: String(new Date().getUTCFullYear() - 1), periodStartMonth: "1", template: "", dueOn: "", owner: "", cadence: "annual", fields: [blankField()] as Field[] });

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([fetch("/api/value-chain/inbox").then((r) => r.json()), fetch("/api/value-chain/counterparties").then((r) => r.json())]);
    if (s.error) setError(s.error); else setSummary(s);
    if (!c.error) setCounterparties(c.counterparties);
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/value-chain/inbox").then((r) => r.json()), fetch("/api/value-chain/counterparties").then((r) => r.json())])
      .then(([s, c]) => { if (!active) return; if (s.error) setError(s.error); else setSummary(s); if (!c.error) setCounterparties(c.counterparties); })
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
      await load();
      return b;
    } finally {
      setBusy(null);
    }
  }
  const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function open(id: string) {
    if (openId === id) { setOpenId(null); setDraft(null); return; }
    setOpenId(id);
    setDraft(null);
    setEdits({});
    setSubmitNote("");
    const res = await fetch(`/api/value-chain/inbox/${id}`);
    const b = await res.json();
    if (b.error) setError(b.error); else setDraft(b.draft);
  }
  async function reloadDraft(id: string) {
    const res = await fetch(`/api/value-chain/inbox/${id}`);
    const b = await res.json();
    if (!b.error) setDraft(b.draft);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const body = { ...form, template: form.template || undefined, dueOn: form.dueOn || undefined, owner: form.owner || undefined, fields: form.fields.map((f) => ({ ...f, key: f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60), unit: f.unit || undefined })) };
    if (await send("Create", "/api/value-chain/inbox", json(body))) setForm({ ...form, title: "", template: "", dueOn: "", fields: [blankField()] });
  }

  async function saveOverrides() {
    if (!draft) return;
    const fields = draft.request.fields.map((f) => {
      const e = edits[f.key];
      if (!e) return f;
      return { ...f, override: e.override === "" ? undefined : Number(e.override), note: e.note || undefined };
    });
    if (await send("Save", `/api/value-chain/inbox/${draft.request.id}`, json({ fields }, "PATCH"))) { setEdits({}); await reloadDraft(draft.request.id); }
  }

  async function submit() {
    if (!draft) return;
    const b = await send("Submit", `/api/value-chain/inbox/${draft.request.id}/submit`, json({ note: submitNote || undefined }));
    if (b) { setSubmitNote(""); await reloadDraft(draft.request.id); }
  }

  async function setState(id: string, state: string) {
    if (await send("State", `/api/value-chain/inbox/${id}`, json({ state }, "PATCH"))) await reloadDraft(id);
  }

  const metrics = summary?.metrics ?? {};
  const metricOptions = Object.entries(metrics);

  return (
    <>
      <p style={{ fontSize: 13 }}><Link href="/value-chain">← Value chain</Link></p>
      <h1>Requests in</h1>
      <p style={{ color: "#555" }}>
        The data requests that come to us from franchisors, customers, a parent consolidating under CSRD, lenders or landlords. Each is a work item with a deadline and an owner.
        The response is drafted from the figures the portal already holds, so the same number goes to every requester; a figure that disagrees with one already sent is blocked until the difference is explained.
      </p>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {summary && (
        <section style={card}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Open" value={String(summary.counts.open)} sub={`${summary.counts.dueSoon} due within 30 days`} />
            <Stat label="Overdue" value={String(summary.counts.overdue)} />
            <Stat label="Submitted" value={String(summary.counts.submitted)} />
            <Stat label="To roll forward" value={String(summary.counts.needsRollForward)} sub="annual requests without next year's" />
          </div>
        </section>
      )}

      {summary && summary.items.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Requests ({summary.items.length})</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Requester", "Request", "Year", "Due", "Owner", "State", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {summary.items.map((i) => (
                  <tr key={i.request.id} style={i.overdue ? { background: "#fff5f5" } : i.request.state !== "open" ? { color: "#777" } : undefined}>
                    <td style={td}><Link href={`/value-chain/${i.request.counterpartyId}`}>{i.requesterName}</Link></td>
                    <td style={td}><button onClick={() => open(i.request.id)} style={{ ...mini, fontWeight: 600 }}>{i.request.title}</button>{i.request.template && <div style={{ color: "#666", fontSize: 11 }}>{i.request.template}</div>}</td>
                    <td style={td}>{i.request.reportingYear}{i.request.periodStartMonth !== 1 ? ` (FY from month ${i.request.periodStartMonth})` : ""}</td>
                    <td style={td}>{i.request.dueOn ?? "—"}{i.daysToDue !== null && i.request.state === "open" && <div style={{ color: i.overdue ? "#b02a37" : "#666", fontSize: 11 }}>{i.overdue ? `${-i.daysToDue} days overdue` : `in ${i.daysToDue} days`}</div>}</td>
                    <td style={td}>{i.request.owner ?? "—"}</td>
                    <td style={td}>{i.request.state}{i.request.submittedOn && <div style={{ color: "#666", fontSize: 11 }}>sent {i.request.submittedOn}</div>}</td>
                    <td style={td}>{i.needsRollForward && <button onClick={() => send("Roll", `/api/value-chain/inbox/${i.request.id}/roll-forward`, { method: "POST" })} disabled={busy !== null} style={mini}>Roll forward to {i.request.reportingYear + 1}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openId && draft && (
        <section style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h2 style={h2}>{draft.request.title} — draft response for {draft.requesterName}, {draft.period.label}</h2>
            <div style={{ display: "flex", gap: 6 }}>
              {draft.request.state === "open" && <button onClick={() => setState(draft.request.id, "closed")} disabled={busy !== null} style={mini}>Close without submitting</button>}
              {draft.request.state !== "open" && <button onClick={() => setState(draft.request.id, "open")} disabled={busy !== null} style={mini}>Reopen</button>}
              <button onClick={async () => { if (confirm("Delete this request?")) { if (await send("Delete", `/api/value-chain/inbox/${draft.request.id}`, { method: "DELETE" })) { setOpenId(null); setDraft(null); } } }} disabled={busy !== null} style={{ ...mini, color: "#b02a37" }}>Delete</button>
            </div>
          </div>
          <p style={{ fontSize: 12, color: "#666", margin: "0 0 8px" }}>{draft.counts.answered} of {draft.counts.fields} fields answered{draft.counts.conflicts ? `, ${draft.counts.conflicts} disagree with a previous submission` : ""}. Values come from the portal for {draft.period.label}; enter a value by hand only with a note saying why.</p>
          {draft.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
          {draft.request.state === "submitted" && <p style={box("#e7f3e7", "#b6dfb6")}>Submitted on {draft.request.submittedOn}. The figures below are the live draft; the figures as sent are held on the request{draft.request.submissionNote ? ` with the note: ${draft.request.submissionNote}` : ""}.</p>}
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Field asked for", "Portal metric", "Value", "Source", "By hand", "Note"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {draft.fields.map((f) => {
                  const e = edits[f.key] ?? { override: f.overridden ? String(draft.request.fields.find((x) => x.key === f.key)?.override ?? "") : "", note: f.note ?? "" };
                  return (
                    <tr key={f.key} style={f.conflicts.length ? { background: "#fff5f5" } : undefined}>
                      <td style={td}>{f.label}{f.requestedUnit && <div style={{ color: "#666", fontSize: 11 }}>in {f.requestedUnit}</div>}</td>
                      <td style={td}>{f.metricLabel}</td>
                      <td style={td}>{f.value === null ? <span style={{ color: "#b02a37" }}>blank</span> : `${f.value.toLocaleString("en-GB", { maximumFractionDigits: 3 })} ${f.unit}`}{f.overridden && <div style={{ color: "#856404", fontSize: 11 }}>entered by hand</div>}</td>
                      <td style={{ ...td, whiteSpace: "normal", maxWidth: 360 }}>{f.source}{f.warnings.map((w, i) => <div key={i} style={{ color: "#856404", fontSize: 11 }}>{w}</div>)}{f.conflicts.map((c, i) => <div key={i} style={{ color: "#b02a37", fontSize: 11 }}>{c.detail}</div>)}</td>
                      <td style={td}><input type="number" step="any" value={e.override} onChange={(ev) => setEdits({ ...edits, [f.key]: { ...e, override: ev.target.value } })} disabled={draft.request.state !== "open"} placeholder={f.metric === "manual" ? "required" : "override"} style={{ ...input, width: 110 }} /></td>
                      <td style={td}><input value={e.note} onChange={(ev) => setEdits({ ...edits, [f.key]: { ...e, note: ev.target.value } })} disabled={draft.request.state !== "open"} placeholder="Why" style={{ ...input, width: 180 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {draft.request.state === "open" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
              <button onClick={saveOverrides} disabled={busy !== null || Object.keys(edits).length === 0} style={{ padding: "6px 12px" }}>Save hand-entered values</button>
              {draft.counts.conflicts > 0 && <label style={{ flex: 1, minWidth: 240, fontSize: 12 }}>Why these figures differ from what was sent before (required to submit)<input value={submitNote} onChange={(ev) => setSubmitNote(ev.target.value)} style={input} /></label>}
              <button onClick={submit} disabled={busy !== null || Object.keys(edits).length > 0 || (draft.counts.conflicts > 0 && !submitNote.trim())} style={{ padding: "6px 12px" }} title={Object.keys(edits).length > 0 ? "Save the hand-entered values first" : undefined}>{busy === "Submit" ? "Recording…" : "Record as submitted"}</button>
            </div>
          )}
          {draft.request.submittedFigures && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>Figures as sent on {draft.request.submittedOn}</summary>
              <table style={{ borderCollapse: "collapse", marginTop: 6 }}>
                <tbody>{draft.request.submittedFigures.map((s) => <tr key={s.key}><td style={td}>{s.label}</td><td style={td}>{s.value === null ? "blank" : `${s.value} ${s.unit}`}</td></tr>)}</tbody>
              </table>
            </details>
          )}
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Record a request received</h2>
        {counterparties.length === 0 ? (
          <p style={{ fontSize: 13 }}>Add the requester as a counterparty on the <Link href="/value-chain">value chain</Link> first; a franchisor, customer or parent belongs there with its role.</p>
        ) : (
          <form onSubmit={create} style={{ display: "grid", gap: 10, maxWidth: 900 }}>
            <div style={row}>
              <label style={{ flex: 2 }}>Requester
                <select value={form.counterpartyId} onChange={(e) => setForm({ ...form, counterpartyId: e.target.value })} required style={input}>
                  <option value="">Choose a counterparty</option>
                  {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.roles.join(", ")})</option>)}
                </select>
              </label>
              <label style={{ flex: 2 }}>Request<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Yum! outlet energy return 2025" style={input} /></label>
              <label style={{ flex: 1 }}>Template<input value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} placeholder="Their form or file name" style={input} /></label>
            </div>
            <div style={row}>
              <label>Reporting year<input type="number" min="2000" max="2100" value={form.reportingYear} onChange={(e) => setForm({ ...form, reportingYear: e.target.value })} required style={input} /></label>
              <label>Period<select value={form.periodStartMonth} onChange={(e) => setForm({ ...form, periodStartMonth: e.target.value })} style={input}><option value="1">Calendar year</option><option value="4">Financial year from April</option><option value="10">Financial year from October</option></select></label>
              <label>Due<input type="date" value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} style={input} /></label>
              <label>Owner<input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} style={input} /></label>
              <label>Cadence<select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })} style={input}><option value="annual">Annual</option><option value="once">Once</option></select></label>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Fields they ask for</div>
              {form.fields.map((f, i) => (
                <div key={i} style={{ ...row, marginBottom: 6 }}>
                  <input value={f.label} onChange={(e) => setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} required placeholder="Their wording, e.g. Total Scope 1 emissions" style={{ ...input, flex: 2 }} />
                  <select value={f.metric} onChange={(e) => setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)) })} style={{ ...input, flex: 2 }}>
                    {metricOptions.map(([id, m]) => <option key={id} value={id}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>)}
                  </select>
                  <input value={f.unit ?? ""} onChange={(e) => setForm({ ...form, fields: form.fields.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })} placeholder="Unit they want" style={{ ...input, flex: 1 }} />
                  <button type="button" onClick={() => setForm({ ...form, fields: form.fields.filter((_, j) => j !== i) })} disabled={form.fields.length === 1} style={mini}>Remove</button>
                </div>
              ))}
              <button type="button" onClick={() => setForm({ ...form, fields: [...form.fields, blankField()] })} style={mini}>Add a field</button>
            </div>
            <button type="submit" disabled={busy !== null} style={{ padding: "8px 14px", width: "fit-content" }}>{busy === "Create" ? "Saving…" : "Record request"}</button>
          </form>
        )}
      </section>
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
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "block", padding: 6, width: "100%", boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const mini = { padding: "2px 6px", fontSize: 11 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
