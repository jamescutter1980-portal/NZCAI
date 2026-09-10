"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { FactorPicker, factorLabel, type FactorRowView } from "@/components/FactorPicker";

interface Vehicle { id: string; registration?: string; make?: string; model?: string; fuelType?: string; engineCapacityCc?: number; co2GPerKm?: number; ownership: string; enrichmentSource?: string; enrichmentDetail?: string; notes?: string }
interface Line {
  id: string; category: string; categoryLabel: string; ghgCategory: string; scope: number; label: string;
  periodStart: string; periodEnd: string; quantity: number; unit: string; convertedQuantity: number | null;
  factorUnit: string | null; conversionNote?: string; factor: { value: number | null; unit: string; basis: string; reference: string; detail?: string };
  kgCo2e: number | null; basis: string; vehicle?: string; warnings: string[];
}
interface Carbon {
  period: { label: string; from: string; to: string; factorYear: number };
  lines: Line[];
  byGhgCategory: { ghgCategory: string; scope: number; kgCo2e: number | null; lines: number; unresolved: number }[];
  totals: { scope1: number | null; scope3: number | null; total: number | null };
  counts: { lines: number; resolved: number; unresolved: number };
  factorReferences: string[];
  warnings: string[];
}

const CATEGORIES: [string, string][] = [
  ["fleet_owned", "Own or leased vehicles (Scope 1)"],
  ["grey_fleet", "Grey fleet (Scope 3 cat 6)"],
  ["business_travel_air", "Air travel (Scope 3 cat 6)"],
  ["business_travel_rail", "Rail travel (Scope 3 cat 6)"],
  ["business_travel_road", "Taxi, bus, hire car (Scope 3 cat 6)"],
  ["business_travel_sea", "Ferry and sea (Scope 3 cat 6)"],
  ["hotel_stay", "Hotel stays (Scope 3 cat 6)"],
  ["commuting", "Employee commuting (Scope 3 cat 7)"],
  ["freight_upstream", "Freight, upstream (Scope 3 cat 4)"],
  ["freight_downstream", "Freight, downstream (Scope 3 cat 9)"],
  ["well_to_tank", "Well-to-tank for transport fuel (Scope 3 cat 3)"],
];

export default function TransportPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [carbon, setCarbon] = useState<Carbon | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [factor, setFactor] = useState<FactorRowView | null>(null);
  const [form, setForm] = useState({ category: "grey_fleet", label: "", periodStart: "", periodEnd: "", quantity: "", unit: "miles", basis: "client_declared", vehicleId: "", evidence: "" });
  const [vForm, setVForm] = useState({ registration: "", make: "", model: "", fuelType: "", ownership: "owned" });

  const load = useCallback(async (s: PeriodSelection) => {
    const [c, v] = await Promise.all([
      fetch(`/api/transport/carbon?${periodQuery(s)}`).then((r) => r.json()),
      fetch("/api/transport/vehicles").then((r) => r.json()),
    ]);
    if (c.error) setError(c.error);
    else setCarbon(c);
    setVehicles(v.vehicles ?? []);
  }, []);

  useEffect(() => {
    const s = defaultPeriodSelection();
    let active = true;
    Promise.all([
      fetch(`/api/transport/carbon?${periodQuery(s)}`).then((r) => r.json()),
      fetch("/api/transport/vehicles").then((r) => r.json()),
    ])
      .then(([c, v]) => {
        if (!active) return;
        if (c.error) setError(c.error);
        else setCarbon(c);
        setVehicles(v.vehicles ?? []);
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function send(label: string, url: string, init: RequestInit) {
    setBusy(label);
    setError(null);
    setNotice(null);
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

  async function addActivity(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...form,
      quantity: form.quantity,
      vehicleId: form.vehicleId || undefined,
      evidence: form.evidence || undefined,
      factorId: factor?.id,
      factorYear: factor ? carbon?.period.factorYear : undefined,
    };
    if (await send("Add activity", "/api/transport/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) {
      setForm({ ...form, label: "", quantity: "", evidence: "" });
    }
  }

  async function addVehicle(e: FormEvent) {
    e.preventDefault();
    if (await send("Add vehicle", "/api/transport/vehicles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(vForm) })) {
      setVForm({ registration: "", make: "", model: "", fuelType: "", ownership: "owned" });
    }
  }

  async function enrich(v: Vehicle) {
    if (!v.registration) return;
    setBusy(v.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/transport/enrich", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registration: v.registration }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error ?? `Lookup failed (${res.status})`);
        return;
      }
      const facts = b.facts ?? {};
      await fetch(`/api/transport/vehicles/${v.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          make: facts.make, model: facts.model, fuelType: facts.fuelType, engineCapacityCc: facts.engineCapacityCc,
          co2GPerKm: facts.co2GPerKm, yearOfManufacture: facts.yearOfManufacture,
          enrichmentSource: "dvla", enrichedAt: new Date().toISOString(),
          enrichmentDetail: [b.mileage?.detail, ...(b.warnings ?? [])].filter(Boolean).join(" "),
        }),
      });
      setNotice([`${v.registration}:`, facts.make, facts.model, facts.fuelType, ...(b.warnings ?? [])].filter(Boolean).join(" "));
      await load(selection);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Transport and business travel</h1>
      <p style={{ color: "#555" }}>
        Mobile combustion, grey fleet, business travel and commuting. Each line points at a published DESNZ row from the
        factor file you have loaded, so a figure can always be traced back to it. Without transport, the{" "}
        <Link href="/portfolio">SECR summary</Link> is incomplete and says so.
      </p>
      <div style={{ marginBottom: 12 }}><PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s); }} disabled={busy !== null} /></div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      {notice && <p style={box("#d1e7dd", "#a3cfbb")}>{notice}</p>}

      {carbon && (
        <section style={card}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Scope 1 mobile kgCO2e" value={fmtN(carbon.totals.scope1)} />
            <Stat label="Scope 3 travel kgCO2e" value={fmtN(carbon.totals.scope3)} />
            <Stat label="Total kgCO2e" value={fmtN(carbon.totals.total)} />
            <Stat label="Lines" value={`${carbon.counts.resolved} of ${carbon.counts.lines} calculated`} />
          </div>
          {carbon.byGhgCategory.length > 0 && (
            <table style={{ borderCollapse: "collapse", marginTop: 10 }}>
              <thead><tr>{["GHG Protocol category", "Scope", "Lines", "kgCO2e"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {carbon.byGhgCategory.map((g) => (
                  <tr key={g.ghgCategory}>
                    <td style={td}>{g.ghgCategory}</td>
                    <td style={td}>{g.scope}</td>
                    <td style={td}>{g.lines}{g.unresolved > 0 ? ` (${g.unresolved} unresolved)` : ""}</td>
                    <td style={td}>{fmtN(g.kgCo2e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {carbon.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Add activity</h2>
        <form onSubmit={addActivity} style={{ display: "grid", gap: 10, maxWidth: 760 }}>
          <div style={row}>
            <label style={{ flex: 2 }}>Category
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={input}>
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label style={{ flex: 2 }}>Description<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required placeholder="Q1 staff mileage claims" style={input} /></label>
          </div>
          <div style={row}>
            <label>From<input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} required style={input} /></label>
            <label>To<input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required style={input} /></label>
            <label>Quantity<input type="number" step="any" min="0" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required style={input} /></label>
            <label>Unit<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required placeholder="miles, km, passenger.km, litres" style={input} /></label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>Basis
              <select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })} style={input}>
                <option value="measured">measured</option><option value="estimated">estimated</option><option value="client_declared">client declared</option>
              </select>
            </label>
            <label style={{ flex: 1 }}>Vehicle
              <select value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })} style={input}>
                <option value="">none</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{[v.registration, v.make, v.model].filter(Boolean).join(" ")}</option>)}
              </select>
            </label>
            <label style={{ flex: 2 }}>Evidence<input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="Expenses export, fuel card statement" style={input} /></label>
          </div>
          <FactorPicker
            year={carbon?.period.factorYear ?? new Date().getUTCFullYear() - 1}
            value={factor ? { id: factor.id, year: carbon?.period.factorYear ?? 0, uom: factor.uom } : null}
            onSelect={(r) => { setFactor(r); if (r) setForm((f) => ({ ...f, unit: r.uom })); }}
          />
          {factor && <p style={{ fontSize: 12, color: "#666", margin: 0 }}>{factorLabel(factor)} — {factor.factor} {factor.ghgUnit} per {factor.uom}, published as {factor.scope}.</p>}
          <button type="submit" disabled={busy !== null} style={{ padding: "8px 14px", width: "fit-content" }}>{busy === "Add activity" ? "Saving…" : "Add activity"}</button>
        </form>
      </section>

      {carbon && carbon.lines.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Activity ({carbon.lines.length})</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Description", "Category", "Period", "Quantity", "Factor", "kgCO2e", "Basis", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {carbon.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.label}{l.vehicle && <div style={{ color: "#666", fontSize: 11 }}>{l.vehicle}</div>}</td>
                    <td style={td}>{l.categoryLabel}<div style={{ color: "#666", fontSize: 11 }}>{l.ghgCategory}</div></td>
                    <td style={td}>{l.periodStart} to {l.periodEnd}</td>
                    <td style={td}>{l.quantity} {l.unit}{l.conversionNote && <div style={{ color: "#666", fontSize: 11 }}>{l.conversionNote}</div>}</td>
                    <td style={td}>{l.factor.value === null ? <span style={{ color: "#b02a37" }}>unavailable</span> : `${l.factor.value} ${l.factor.unit}`}<div style={{ color: "#666", fontSize: 11 }}>{l.factor.reference}</div></td>
                    <td style={td}>{fmtN(l.kgCo2e)}</td>
                    <td style={td}>{l.basis.replace("_", " ")}</td>
                    <td style={td}><button onClick={() => send("Delete", `/api/transport/activity/${l.id}`, { method: "DELETE" })} disabled={busy !== null} style={mini}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {carbon.lines.some((l) => l.warnings.length > 0) && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#856404" }}>Line warnings</summary>
              <ul style={{ fontSize: 12 }}>
                {carbon.lines.flatMap((l) => l.warnings.map((w, i) => <li key={`${l.id}-${i}`}><strong>{l.label}</strong>: {w}</li>))}
              </ul>
            </details>
          )}
          {carbon.factorReferences.length > 0 && <p style={{ fontSize: 12, color: "#666" }}>Factors used: {carbon.factorReferences.join("; ")}.</p>}
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Vehicles ({vehicles.length})</h2>
        {vehicles.length > 0 && (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["Registration", "Make and model", "Fuel", "Engine cc", "CO2 g/km", "Ownership", "Enriched", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  <td style={td}><code>{v.registration ?? ""}</code></td>
                  <td style={td}>{[v.make, v.model].filter(Boolean).join(" ")}</td>
                  <td style={td}>{v.fuelType ?? ""}</td>
                  <td style={td}>{v.engineCapacityCc ?? ""}</td>
                  <td style={td}>{v.co2GPerKm ?? ""}</td>
                  <td style={td}>{v.ownership}</td>
                  <td style={td} title={v.enrichmentDetail}>{v.enrichmentSource ?? "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button onClick={() => enrich(v)} disabled={!v.registration || busy !== null} style={mini}>Look up</button>
                    <button onClick={() => send("Delete", `/api/transport/vehicles/${v.id}`, { method: "DELETE" })} disabled={busy !== null} style={mini}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addVehicle} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
          <label>Registration<input value={vForm.registration} onChange={(e) => setVForm({ ...vForm, registration: e.target.value })} placeholder="AB12 CDE" style={input} /></label>
          <label>Make<input value={vForm.make} onChange={(e) => setVForm({ ...vForm, make: e.target.value })} style={input} /></label>
          <label>Model<input value={vForm.model} onChange={(e) => setVForm({ ...vForm, model: e.target.value })} style={input} /></label>
          <label>Fuel<input value={vForm.fuelType} onChange={(e) => setVForm({ ...vForm, fuelType: e.target.value })} style={input} /></label>
          <label>Ownership
            <select value={vForm.ownership} onChange={(e) => setVForm({ ...vForm, ownership: e.target.value })} style={input}>
              <option value="owned">owned</option><option value="leased">leased</option><option value="employee">employee</option>
            </select>
          </label>
          <button type="submit" disabled={busy !== null} style={{ padding: "6px 12px" }}>Add vehicle</button>
        </form>
        <p style={{ fontSize: 12, color: "#666" }}>
          Look up fills make, model, fuel and engine size from DVLA, and estimates annual distance from MOT odometer readings.
          MOT distance cannot separate business from private use, so it is an upper bound for grey fleet, never the business figure.
          The DVLA CO2 figure is a type-approval value and is not a substitute for a DESNZ factor.
        </p>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f7f7f5", border: "1px solid #ddd", padding: "8px 12px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
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
const mini = { padding: "2px 6px", fontSize: 11, marginRight: 6 };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
