"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

interface Result { sourceId: string; sourceName: string; opId: string; opLabel: string; section: string; status: string; summary: string; rowCount: number; columns?: string[]; rows?: Record<string, unknown>[]; warnings?: string[]; error?: string; durationMs: number }
interface Response { location: { postcode?: string; latitude?: number; longitude?: number; uprn?: string; note?: string }; screening: { results: Result[]; okCount: number; partialCount?: number; errorCount: number; ranAt: string } }

const SECTIONS: Record<string, string> = { identity: "Identity and certificates", flood: "Flood", ground: "Ground and environmental liabilities", heritage_planning: "Heritage and planning constraints", nature: "Nature", air: "Air quality", grid: "Grid" };
const STATUS_COLOUR: Record<string, string> = { ok: "#1e7e34", empty: "#555", partial: "#856404", error: "#b02a37", skipped: "#6c757d", not_configured: "#856404" };

export default function LookupPage() {
  const [postcode, setPostcode] = useState("");
  const [uprn, setUprn] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Response | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postcode, uprn, latitude: lat, longitude: lon }) });
      const b = await res.json();
      if (!res.ok) setError(b.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") ?? b.error);
      else setData(b);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const bySection = (data?.screening.results ?? []).reduce<Record<string, Result[]>>((m, r) => ((m[r.section] ??= []).push(r), m), {});

  return (
    <>
      <h1>Location lookup</h1>
      <p style={{ color: "#555" }}>
        Run every location-based check at once for a postcode or a point, without saving anything. To keep results, add the site as an <Link href="/assets">asset</Link>.
      </p>
      <form onSubmit={run} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", background: "#fff", border: "1px solid #ddd", padding: 12 }}>
        <label style={{ fontSize: 13 }}>Postcode<input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="SW1A 1AA" style={input} /></label>
        <label style={{ fontSize: 13 }}>UPRN (optional)<input value={uprn} onChange={(e) => setUprn(e.target.value)} style={input} /></label>
        <span style={{ fontSize: 12, color: "#666" }}>or</span>
        <label style={{ fontSize: 13 }}>Latitude<input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="51.501" style={input} /></label>
        <label style={{ fontSize: 13 }}>Longitude<input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-0.142" style={input} /></label>
        <button type="submit" disabled={busy} style={{ padding: "8px 14px" }}>{busy ? "Running 14 checks…" : "Run lookup"}</button>
      </form>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      {data && (
        <section style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13 }}>
            {data.location.postcode ?? ""} {data.location.latitude !== undefined ? `(${data.location.latitude}, ${data.location.longitude})` : "(no coordinates)"} · {data.screening.okCount} completed, {data.screening.partialCount ?? 0} partial, {data.screening.errorCount} failed.
            {data.location.note && <span style={{ color: "#856404" }}> {data.location.note}</span>}
          </p>
          <p style={{ fontSize: 12, color: "#666" }}>Empty means checked and nothing found; partial means the source reported problems, so absence is not established. A desktop screening, not a survey.</p>
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
        </section>
      )}
    </>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
const input = { display: "block", padding: 8, minWidth: 140 };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
