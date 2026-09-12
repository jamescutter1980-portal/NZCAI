"use client";

import { use, useEffect, useState, type FormEvent } from "react";

/**
 * The counterparty's side of the wall. Reached with a one-time token and no
 * portal account, so it carries no navigation into the rest of the portal and
 * shows nothing about the client beyond what was already asked.
 */

interface Invitation { counterpartyName: string; reportingYear: number; ask: string; expiresOn: string; instructions: string[]; alreadySubmitted: boolean }

const ALLOCATION = [
  ["supplier_total", "Our whole company footprint"],
  ["spend_share", "A share of our footprint, by what you spend with us"],
  ["supplier_allocated", "A figure we have allocated to you ourselves"],
  ["product_specific", "Measured for the specific product or service you buy"],
] as const;
const METHODOLOGY = [["ghg_protocol", "GHG Protocol"], ["iso_14064", "ISO 14064"], ["vsme", "VSME"], ["other", "Other"]] as const;
const BOUNDARY = [["operational_control", "Operational control"], ["financial_control", "Financial control"], ["equity_share", "Equity share"], ["unknown", "Not sure"]] as const;
const ASSURANCE = [["none", "Not assured"], ["limited", "Limited assurance"], ["reasonable", "Reasonable assurance"]] as const;
const BASIS = [["supplier_reported", "Measured or calculated by us"], ["supplier_estimated", "Estimated by us"], ["third_party_verified", "Verified by a third party"]] as const;

export default function SubmitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    periodStart: "", periodEnd: "", scope1Tco2e: "", scope2LocationTco2e: "", scope2MarketTco2e: "", scope3Tco2e: "",
    allocationMethod: "supplier_total", allocatedTco2e: "", supplierRevenueGbp: "", methodology: "ghg_protocol",
    boundary: "operational_control", assurance: "none", assuranceProvider: "", basis: "supplier_reported",
    evidence: "", documentDate: "", contactName: "", contactEmail: "", note: "",
  });

  useEffect(() => {
    let active = true;
    fetch(`/api/value-chain/submit/${token}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!active) return;
        if (!ok) setRefusal(body.error ?? "This link cannot be used.");
        else {
          setInvitation(body);
          setForm((f) => ({ ...f, periodStart: `${body.reportingYear}-01-01`, periodEnd: `${body.reportingYear}-12-31` }));
        }
      })
      .catch((e: Error) => { if (active) setRefusal(e.message); });
    return () => { active = false; };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
      const res = await fetch(`/api/value-chain/submit/${token}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          periodStart: form.periodStart, periodEnd: form.periodEnd,
          scope1Tco2e: num(form.scope1Tco2e), scope2LocationTco2e: num(form.scope2LocationTco2e), scope2MarketTco2e: num(form.scope2MarketTco2e), scope3Tco2e: num(form.scope3Tco2e),
          allocationMethod: form.allocationMethod, allocatedTco2e: num(form.allocatedTco2e), supplierRevenueGbp: num(form.supplierRevenueGbp),
          methodology: form.methodology, boundary: form.boundary, assurance: form.assurance,
          assuranceProvider: form.assuranceProvider || undefined, basis: form.basis,
          evidence: form.evidence || undefined, documentDate: form.documentDate || undefined,
          contactName: form.contactName || undefined, contactEmail: form.contactEmail || undefined, note: form.note || undefined,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error ?? `Could not send (${res.status})`);
        return;
      }
      setDone(b.note);
    } finally { setBusy(false); }
  }

  if (refusal) return <main style={page}><h1 style={{ fontSize: 20 }}>This link cannot be used</h1><p style={box("#f8d7da", "#f1aeb5")}>{refusal}</p></main>;
  if (done) return <main style={page}><h1 style={{ fontSize: 20 }}>Thank you</h1><p style={box("#e7f6e7", "#b9dfb9")}>{done}</p></main>;
  if (!invitation) return <main style={page}><p>Loading…</p></main>;

  return (
    <main style={page}>
      <h1 style={{ fontSize: 20 }}>Greenhouse gas figures for {invitation.reportingYear}</h1>
      <p style={{ color: "#555" }}>
        For <strong>{invitation.counterpartyName}</strong>. This link works until {invitation.expiresOn}.
        Leave anything you do not have blank rather than entering a zero: a blank is understood as not held, a zero is read as none.
      </p>
      <ul style={{ color: "#555", fontSize: 13 }}>{invitation.instructions.map((i) => <li key={i}>{i}</li>)}</ul>
      {invitation.alreadySubmitted && <p style={box("#fff3cd", "#ffe69c")}>Figures have already been sent with this link. Sending again replaces them.</p>}
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      <form onSubmit={submit} style={card}>
        <fieldset style={fieldset}>
          <legend style={legend}>The year these figures cover</legend>
          <div style={row}>
            <label style={label}>From<input required type="date" style={input} value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></label>
            <label style={label}>To<input required type="date" style={input} value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></label>
          </div>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>Your emissions, in tonnes of CO2e</legend>
          <div style={row}>
            <label style={label}>Scope 1<input style={input} value={form.scope1Tco2e} onChange={(e) => setForm({ ...form, scope1Tco2e: e.target.value })} /></label>
            <label style={label}>Scope 2, location based<input style={input} value={form.scope2LocationTco2e} onChange={(e) => setForm({ ...form, scope2LocationTco2e: e.target.value })} /></label>
            <label style={label}>Scope 2, market based<input style={input} value={form.scope2MarketTco2e} onChange={(e) => setForm({ ...form, scope2MarketTco2e: e.target.value })} /></label>
            <label style={label}>Scope 3<input style={input} value={form.scope3Tco2e} onChange={(e) => setForm({ ...form, scope3Tco2e: e.target.value })} /></label>
          </div>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>How much of it relates to what you supply us</legend>
          <label style={{ ...label, width: "100%" }}>Basis
            <select style={input} value={form.allocationMethod} onChange={(e) => setForm({ ...form, allocationMethod: e.target.value })}>
              {ALLOCATION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {form.allocationMethod === "spend_share" && <label style={label}>Your total revenue for the year (£)<input style={input} value={form.supplierRevenueGbp} onChange={(e) => setForm({ ...form, supplierRevenueGbp: e.target.value })} /></label>}
          {(form.allocationMethod === "supplier_allocated" || form.allocationMethod === "product_specific") && <label style={label}>Allocated to us (tCO2e)<input style={input} value={form.allocatedTco2e} onChange={(e) => setForm({ ...form, allocatedTco2e: e.target.value })} /></label>}
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>How the figures were produced</legend>
          <div style={row}>
            <label style={label}>Standard followed<select style={input} value={form.methodology} onChange={(e) => setForm({ ...form, methodology: e.target.value })}>{METHODOLOGY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={label}>Boundary<select style={input} value={form.boundary} onChange={(e) => setForm({ ...form, boundary: e.target.value })}>{BOUNDARY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={label}>Basis<select style={input} value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })}>{BASIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label style={label}>Assurance<select style={input} value={form.assurance} onChange={(e) => setForm({ ...form, assurance: e.target.value })}>{ASSURANCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          {form.assurance !== "none" && <label style={label}>Who assured them<input style={input} value={form.assuranceProvider} onChange={(e) => setForm({ ...form, assuranceProvider: e.target.value })} /></label>}
          <div style={row}>
            <label style={{ ...label, flex: 1, minWidth: 240 }}>Where these figures are published<input style={input} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="Annual report 2025, page 30" /></label>
            <label style={label}>Date of that document<input type="date" style={input} value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} /></label>
          </div>
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={legend}>Who to come back to</legend>
          <div style={row}>
            <label style={label}>Name<input style={input} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></label>
            <label style={label}>Email<input type="email" style={input} value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} /></label>
          </div>
          <label style={{ ...label, width: "100%" }}>Anything we should know<textarea rows={3} style={input} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        </fieldset>

        <button disabled={busy} style={{ padding: "8px 14px" }}>{busy ? "Sending…" : "Send figures"}</button>
        <p style={{ fontSize: 12, color: "#555", marginTop: 8 }}>What you send is reviewed before it is used. Nothing is published on your behalf.</p>
      </form>
    </main>
  );
}

const page = { maxWidth: 820, margin: "0 auto", padding: 16 };
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const fieldset = { border: "1px solid #eee", padding: 10, marginBottom: 12 };
const legend = { fontSize: 13, fontWeight: 600 as const, padding: "0 4px" };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const label = { fontSize: 12, display: "block" };
const input = { display: "block", padding: 6, boxSizing: "border-box" as const, minWidth: 160 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
