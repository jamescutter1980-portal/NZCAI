"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

interface Asset { id: string; name: string; uprn?: string; address?: string; postcode?: string; latitude?: number; longitude?: number; floorAreaM2?: number; propertyType?: string; country?: string; notes?: string }
interface Meter { mpxn: string; utility: string; direction: string; label?: string; supplierFactorKgCo2ePerKwh?: number; supplierFactorEvidence?: string; readings: number; latest: string | null; consentStatus: string; consent: { id: string; expiresOn: string } | null }
interface Result { sourceId: string; sourceName: string; opId: string; opLabel: string; section: string; status: string; summary: string; rowCount: number; columns?: string[]; rows?: Record<string, unknown>[]; warnings?: string[]; error?: string; durationMs: number }
interface Screening { id: string; ranAt: string; results: Result[]; okCount: number; errorCount: number }
interface Factor { value: number | null; unit: string; basis: string; source: string; reference: string; detail?: string }
interface Line { label: string; kwh: number; factor: Factor; kgCo2e: number | null; meters?: string[] }
interface Carbon {
  year: number; energy: { mpxn: string; utility: string; direction: string; kwh: number; intervals: number }[];
  scope1: Line[]; scope2Location: Line[]; scope2Market: Line[]; scope3TandD: Line[];
  timeVarying: { kwhMatched: number; kwhUnmatched: number; kgCo2e: number | null; region?: string; detail: string };
  totals: { scope1: number | null; scope2Location: number | null; scope2Market: number | null }; warnings: string[];
}

const SECTIONS: Record<string, string> = { identity: "Identity and certificates", flood: "Flood", ground: "Ground and environmental liabilities", heritage_planning: "Heritage and planning constraints", nature: "Nature", air: "Air quality", grid: "Grid" };
const STATUS_COLOUR: Record<string, string> = { ok: "#1e7e34", empty: "#555", partial: "#856404", error: "#b02a37", skipped: "#6c757d", not_configured: "#856404" };

export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [screening, setScreening] = useState<Screening | null>(null);
  const [history, setHistory] = useState<{ id: string; ranAt: string; okCount: number; errorCount: number }[]>([]);
  const [carbon, setCarbon] = useState<{ carbon: Carbon; eui: { kwhPerM2: number } | null; intensityCoverage: { intervals: number } | null } | null>(null);
  const [year, setYear] = useState(new Date().getUTCFullYear() - 1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [meterForm, setMeterForm] = useState({ mpxn: "", utility: "electricity", direction: "import", label: "", supplierFactorKgCo2ePerKwh: "", supplierFactorEvidence: "" });
  const [edit, setEdit] = useState<{ latitude: string; longitude: string; floorAreaM2: string; uprn: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/assets/${id}`);
    const b = await res.json();
    if (!res.ok) {
      setError(b.error ?? "Failed to load");
      return;
    }
    setAsset(b.asset);
    setMeters(b.meters ?? []);
    setScreening(b.latestScreening);
    setHistory(b.screenings ?? []);
  }, [id]);

  const loadCarbon = useCallback(async (y: number) => {
    const res = await fetch(`/api/assets/${id}/carbon?year=${y}`);
    if (res.ok) setCarbon(await res.json());
  }, [id]);

  useEffect(() => {
    let active = true;
    Promise.all([fetch(`/api/assets/${id}`).then((r) => r.json()), fetch(`/api/assets/${id}/carbon?year=${year}`).then((r) => (r.ok ? r.json() : null))])
      .then(([b, c]) => {
        if (!active) return;
        if (b.error) { setError(b.error); return; }
        setAsset(b.asset); setMeters(b.meters ?? []); setScreening(b.latestScreening); setHistory(b.screenings ?? []);
        if (c) setCarbon(c);
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function action(label: string, fn: () => Promise<Response>, after?: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const b = await res.json().catch(() => ({}));
      if (!res.ok) setError(b.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? b.error ?? `${label} failed (${res.status})`);
      else if (b.summary || b.warning || b.rows !== undefined) setNotice([b.summary, b.warning, b.rows !== undefined ? `${b.rows} half hours stored for ${b.region}` : null].filter(Boolean).join(" "));
      await (after ?? load)();
    } finally {
      setBusy(null);
    }
  }

  async function addMeter(e: FormEvent) {
    e.preventDefault();
    await action("Link meter", () => fetch(`/api/assets/${id}/meters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meterForm) }));
    setMeterForm({ ...meterForm, mpxn: "", label: "", supplierFactorKgCo2ePerKwh: "", supplierFactorEvidence: "" });
    loadCarbon(year);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    await action("Save", () => fetch(`/api/assets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(edit) }));
    setEdit(null);
  }

  if (error && !asset) return <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>;
  if (!asset) return <p>Loading…</p>;

  const bySection = (screening?.results ?? []).reduce<Record<string, Result[]>>((m, r) => ((m[r.section] ??= []).push(r), m), {});

  return (
    <>
      <p style={{ fontSize: 13 }}><Link href="/assets">← Assets</Link></p>
      <h1 style={{ marginBottom: 4 }}>{asset.name}</h1>
      <p style={{ color: "#555", marginTop: 0 }}>{[asset.address, asset.postcode].filter(Boolean).join(", ")}{asset.propertyType ? ` · ${asset.propertyType}` : ""}</p>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      {notice && <p style={box("#d1e7dd", "#a3cfbb")}>{notice}</p>}

      <section style={card}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "start" }}>
          <dl style={dl}>
            <dt>UPRN</dt><dd style={dd}>{asset.uprn ?? <span style={{ color: "#b02a37" }}>not set</span>}</dd>
            <dt>Coordinates</dt><dd style={dd}>{asset.latitude !== undefined ? `${asset.latitude}, ${asset.longitude}` : <span style={{ color: "#b02a37" }}>none</span>}</dd>
            <dt>Floor area</dt><dd style={dd}>{asset.floorAreaM2 ? `${asset.floorAreaM2} m²` : "not set"}</dd>
            <dt>Country</dt><dd style={dd}>{asset.country ?? ""}</dd>
          </dl>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => action("Geocode", () => fetch(`/api/assets/${id}/geocode`, { method: "POST" }))} disabled={!asset.postcode || busy !== null} style={btn}>Geocode from postcode</button>
            <button onClick={() => setEdit({ latitude: String(asset.latitude ?? ""), longitude: String(asset.longitude ?? ""), floorAreaM2: String(asset.floorAreaM2 ?? ""), uprn: asset.uprn ?? "" })} style={btn}>Edit</button>
          </div>
        </div>
        {edit && (
          <form onSubmit={saveEdit} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
            <label>Latitude<input value={edit.latitude} onChange={(e) => setEdit({ ...edit, latitude: e.target.value })} style={input} /></label>
            <label>Longitude<input value={edit.longitude} onChange={(e) => setEdit({ ...edit, longitude: e.target.value })} style={input} /></label>
            <label>Floor area m²<input value={edit.floorAreaM2} onChange={(e) => setEdit({ ...edit, floorAreaM2: e.target.value })} style={input} /></label>
            <label>UPRN<input value={edit.uprn} onChange={(e) => setEdit({ ...edit, uprn: e.target.value })} style={input} /></label>
            <button type="submit" disabled={busy !== null} style={btn}>Save</button>
            <button type="button" onClick={() => setEdit(null)} style={btn}>Cancel</button>
          </form>
        )}
      </section>

      <section style={card}>
        <h2 style={h2}>Meters</h2>
        {meters.length === 0 ? <p style={{ fontSize: 13 }}>No meters linked.</p> : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["MPxN", "Utility", "Direction", "Label", "Consent", "Readings", "Latest", "Supplier factor", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {meters.map((m) => (
                <tr key={`${m.mpxn}-${m.utility}-${m.direction}`}>
                  <td style={td}><code>{m.mpxn}</code></td>
                  <td style={td}>{m.utility}</td>
                  <td style={td}>{m.direction}</td>
                  <td style={td}>{m.label ?? ""}</td>
                  <td style={{ ...td, color: m.consentStatus === "active" ? "#1e7e34" : "#b02a37" }}>{m.consentStatus}{m.consent ? ` to ${m.consent.expiresOn}` : ""}</td>
                  <td style={td}>{m.readings}</td>
                  <td style={td}>{m.latest ? m.latest.slice(0, 10) : ""}</td>
                  <td style={td}>{m.supplierFactorKgCo2ePerKwh !== undefined ? `${m.supplierFactorKgCo2ePerKwh} kgCO2e/kWh${m.supplierFactorEvidence ? ` (${m.supplierFactorEvidence})` : " (no evidence)"}` : ""}</td>
                  <td style={td}><button onClick={() => action("Unlink", () => fetch(`/api/assets/${id}/meters?mpxn=${m.mpxn}&utility=${m.utility}&direction=${m.direction}`, { method: "DELETE" }))} style={btn}>Unlink</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addMeter} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginTop: 10 }}>
          <label>MPxN<input value={meterForm.mpxn} onChange={(e) => setMeterForm({ ...meterForm, mpxn: e.target.value })} required style={input} /></label>
          <label>Utility<select value={meterForm.utility} onChange={(e) => setMeterForm({ ...meterForm, utility: e.target.value })} style={input}><option value="electricity">electricity</option><option value="gas">gas</option></select></label>
          <label>Direction<select value={meterForm.direction} onChange={(e) => setMeterForm({ ...meterForm, direction: e.target.value })} style={input}><option value="import">import</option><option value="export">export</option></select></label>
          <label>Label<input value={meterForm.label} onChange={(e) => setMeterForm({ ...meterForm, label: e.target.value })} style={input} /></label>
          <label>Supplier factor kgCO2e/kWh<input value={meterForm.supplierFactorKgCo2ePerKwh} onChange={(e) => setMeterForm({ ...meterForm, supplierFactorKgCo2ePerKwh: e.target.value })} placeholder="market-based" style={input} /></label>
          <label>Evidence<input value={meterForm.supplierFactorEvidence} onChange={(e) => setMeterForm({ ...meterForm, supplierFactorEvidence: e.target.value })} placeholder="REGO / PPA reference" style={input} /></label>
          <button type="submit" disabled={busy !== null} style={btn}>Link meter</button>
        </form>
        <p style={{ fontSize: 12, color: "#666" }}>Readings arrive via the <Link href="/sync">n3rgy sync</Link> once a <Link href="/consents">consent</Link> is active.</p>
      </section>

      <section style={card}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ ...h2, margin: 0 }}>Energy and carbon</h2>
          <label style={{ fontSize: 13 }}>Year <input type="number" value={year} onChange={(e) => { const y = Number(e.target.value); setYear(y); if (y > 2000 && y < 2100) loadCarbon(y); }} style={{ width: 90, padding: 6 }} /></label>
          <button onClick={() => action("Grid intensity", () => fetch(`/api/assets/${id}/intensity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: `${year}-01-01`, to: `${year}-12-31` }) }), () => loadCarbon(year))} disabled={!asset.postcode || busy !== null} style={btn}>Fetch grid intensity for {year}</button>
        </div>
        {!carbon ? <p style={{ fontSize: 13 }}>No carbon data.</p> : (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0" }}>
              <Stat label="Electricity import kWh" value={fmt(carbon.carbon.energy.filter((e) => e.utility === "electricity" && e.direction === "import").reduce((n, e) => n + e.kwh, 0))} />
              <Stat label="Gas kWh" value={fmt(carbon.carbon.energy.filter((e) => e.utility === "gas").reduce((n, e) => n + e.kwh, 0))} />
              <Stat label="EUI kWh/m²" value={carbon.eui ? String(carbon.eui.kwhPerM2) : "no floor area"} />
              <Stat label="Scope 1 kgCO2e" value={fmtN(carbon.carbon.totals.scope1)} />
              <Stat label="Scope 2 location kgCO2e" value={fmtN(carbon.carbon.totals.scope2Location)} />
              <Stat label="Scope 2 market kgCO2e" value={fmtN(carbon.carbon.totals.scope2Market)} />
              <Stat label="Time-varying kgCO2e" value={fmtN(carbon.carbon.timeVarying.kgCo2e)} />
            </div>
            {carbon.carbon.warnings.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
            <p style={{ fontSize: 12, color: "#666" }}>Time-varying: {carbon.carbon.timeVarying.detail} Operational insight only; not a GHG Protocol reporting figure.</p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{["Line", "kWh", "Factor", "Basis", "kgCO2e", "Reference"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {[...carbon.carbon.scope1.map((l) => ({ ...l, group: "Scope 1" })), ...carbon.carbon.scope2Location.map((l) => ({ ...l, group: "Scope 2 location" })), ...carbon.carbon.scope2Market.map((l) => ({ ...l, group: "Scope 2 market" })), ...carbon.carbon.scope3TandD.map((l) => ({ ...l, group: "Scope 3 cat 3" }))].map((l, i) => (
                  <tr key={i}>
                    <td style={td}><strong>{l.group}</strong> · {l.label}</td>
                    <td style={td}>{fmt(l.kwh)}</td>
                    <td style={td}>{l.factor.value === null ? <span style={{ color: "#b02a37" }}>unavailable</span> : `${l.factor.value} ${l.factor.unit}`}</td>
                    <td style={td}>{l.factor.basis}</td>
                    <td style={td}>{fmtN(l.kgCo2e)}</td>
                    <td style={{ ...td, color: "#666" }}>{l.factor.reference}{l.factor.detail ? ` — ${l.factor.detail}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section style={card}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ ...h2, margin: 0 }}>Environmental screening</h2>
          <button onClick={() => action("Screen", () => fetch(`/api/assets/${id}/screen`, { method: "POST" }))} disabled={busy !== null} style={btn}>{busy === "Screen" ? "Running…" : "Run screening"}</button>
          {history.length > 0 && <span style={{ fontSize: 12, color: "#666" }}>{history.length} run{history.length > 1 ? "s" : ""}; latest {history[0].ranAt.slice(0, 16).replace("T", " ")}</span>}
        </div>
        {!screening ? <p style={{ fontSize: 13 }}>Not yet screened. Needs coordinates for the location checks.</p> : (
          <>
            <p style={{ fontSize: 13, color: "#555" }}>{screening.okCount} checks completed, {screening.errorCount} failed. Empty means checked and nothing found; partial means the source reported problems, so absence is not established. A desktop screening; not a survey, flood risk assessment or contamination report.</p>
            {Object.entries(SECTIONS).map(([key, label]) => {
              const items = bySection[key];
              if (!items?.length) return null;
              return (
                <div key={key} style={{ marginBottom: 12 }}>
                  <h3 style={{ fontSize: 14, margin: "8px 0 4px" }}>{label}</h3>
                  {items.map((r) => (
                    <details key={`${r.sourceId}-${r.opId}`} style={{ marginBottom: 4, fontSize: 13 }}>
                      <summary style={{ cursor: "pointer" }}>
                        <span style={{ color: STATUS_COLOUR[r.status] ?? "#333", fontWeight: 600 }}>{r.status.replace("_", " ")}</span> · {r.sourceName}: {r.opLabel} — {r.error ?? r.summary}
                      </summary>
                      {r.warnings?.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
                      {r.rows && r.rows.length > 0 && (
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ borderCollapse: "collapse", width: "100%" }}>
                            <thead><tr>{(r.columns ?? Object.keys(r.rows[0])).map((c) => <th key={c} style={th}>{c}</th>)}</tr></thead>
                            <tbody>{r.rows.map((row, i) => <tr key={i}>{(r.columns ?? Object.keys(r.rows![0])).map((c) => <td key={c} style={td}>{format(row[c])}</td>)}</tr>)}</tbody>
                          </table>
                        </div>
                      )}
                      <p style={{ fontSize: 11, color: "#666" }}><Link href={`/sources/${r.sourceId}`}>Source page</Link> · {r.durationMs} ms</p>
                    </details>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f7f7f5", border: "1px solid #ddd", padding: "8px 12px", minWidth: 130 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const fmtN = (n: number | null) => (n === null ? "unavailable" : fmt(n));
function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const dl = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", fontSize: 13, margin: 0 };
const dd = { margin: 0 };
const input = { display: "block", padding: 6, minWidth: 120 };
const btn = { padding: "6px 10px", fontSize: 12 };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
