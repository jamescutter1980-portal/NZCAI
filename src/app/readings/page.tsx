"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

interface Meter { mpxn: string; utility: string; direction: string; first: string; last: string; count: number }
interface Daily { date: string; value: number; unit: string; intervals: number }
interface Gap { from: string; to: string; missingIntervals: number }
interface Cost { unitCostGbp: number; standingCostGbp: number; totalGbp: number; unpricedIntervals: number; days: number }
interface Result {
  mpxn: string; utility: string; direction: string; count: number; unit: string | null; total: number;
  daily: Daily[]; gaps: Gap[]; cost: Cost | null; attribution: string | null; consentRefs: string[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default function ReadingsPage() {
  const [meters, setMeters] = useState<Meter[]>([]);
  const [mpxn, setMpxn] = useState("");
  const [utility, setUtility] = useState("electricity");
  const [direction, setDirection] = useState("import");
  const [start, setStart] = useState(() => isoDate(new Date(Date.now() - 30 * 86_400_000)));
  const [end, setEnd] = useState(() => isoDate(new Date(Date.now() - 86_400_000)));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/readings/meters")
      .then((r) => r.json())
      .then((b) => { if (active) setMeters(b.meters ?? []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const params = new URLSearchParams({ mpxn, utility, direction, start, end });

  async function load(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/readings?${params}`);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Failed (${res.status})`);
      else setResult(body);
    } finally {
      setBusy(false);
    }
  }

  function pick(m: Meter) {
    setMpxn(m.mpxn);
    setUtility(m.utility);
    setDirection(m.direction);
    setStart(m.last.slice(0, 10) < start ? m.first.slice(0, 10) : start);
  }

  return (
    <>
      <h1>Stored readings</h1>
      <p style={{ color: "#555" }}>
        Readings written by the <Link href="/sync">n3rgy sync</Link>. Pick a meter, choose a range, and view daily totals,
        gaps and an indicative cost from the stored tariff.
      </p>

      {meters.length === 0 ? (
        <p>No readings stored yet. Run a sync once a consent is active.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", marginBottom: 16 }}>
          <thead>
            <tr>{["MPxN", "Utility", "Direction", "From", "To", "Intervals", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {meters.map((m) => (
              <tr key={`${m.mpxn}-${m.utility}-${m.direction}`}>
                <td style={td}><code>{m.mpxn}</code></td>
                <td style={td}>{m.utility}</td>
                <td style={td}>{m.direction}</td>
                <td style={td}>{m.first.slice(0, 10)}</td>
                <td style={td}>{m.last.slice(0, 10)}</td>
                <td style={td}>{m.count}</td>
                <td style={td}><button onClick={() => pick(m)} style={btn}>Select</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={load} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <label>MPxN<input value={mpxn} onChange={(e) => setMpxn(e.target.value)} required style={input} /></label>
        <label>Utility
          <select value={utility} onChange={(e) => setUtility(e.target.value)} style={input}>
            <option value="electricity">electricity</option><option value="gas">gas</option>
          </select>
        </label>
        <label>Direction
          <select value={direction} onChange={(e) => setDirection(e.target.value)} style={input}>
            <option value="import">import</option><option value="export">export</option>
          </select>
        </label>
        <label>Start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={input} /></label>
        <label>End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={input} /></label>
        <button type="submit" disabled={busy} style={{ padding: "8px 14px" }}>{busy ? "Loading…" : "Show"}</button>
        {mpxn && <a href={`/api/readings?${params}&format=csv`} style={{ fontSize: 13 }}>Download CSV</a>}
      </form>

      {error && <p style={{ background: "#f8d7da", padding: 12, border: "1px solid #f1aeb5" }}>{error}</p>}

      {result && (
        <section style={{ marginTop: 20 }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
            <Stat label="Intervals" value={String(result.count)} />
            <Stat label={`Total ${result.unit ?? ""}`} value={result.total.toFixed(1)} />
            <Stat label="Gaps" value={String(result.gaps.length)} />
            {result.cost && <Stat label="Indicative cost" value={`£${result.cost.totalGbp.toFixed(2)}`} />}
          </div>
          {result.cost && (
            <p style={{ fontSize: 13, color: "#555" }}>
              Unit £{result.cost.unitCostGbp.toFixed(2)} + standing £{result.cost.standingCostGbp.toFixed(2)} over {result.cost.days} days.
              {result.cost.unpricedIntervals > 0 && ` ${result.cost.unpricedIntervals} intervals had no stored price and are excluded.`} Excludes VAT.
            </p>
          )}
          {result.gaps.length > 0 && (
            <details>
              <summary>{result.gaps.length} gaps</summary>
              <ul>{result.gaps.map((g) => <li key={g.from}>{g.from.slice(0, 16)} to {g.to.slice(0, 16)}: {g.missingIntervals} intervals</li>)}</ul>
            </details>
          )}
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 520, marginTop: 12 }}>
            <thead><tr><th style={th}>Date (UTC)</th><th style={th}>Intervals</th><th style={th}>Total ({result.unit})</th></tr></thead>
            <tbody>
              {result.daily.map((d) => (
                <tr key={d.date}>
                  <td style={td}>{d.date}</td>
                  <td style={{ ...td, color: d.intervals < 48 ? "#b02a37" : undefined }}>{d.intervals}</td>
                  <td style={td}>{d.value.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.attribution && <p style={{ color: "#666", fontSize: 12 }}>{result.attribution} Consent {result.consentRefs.join(", ")}.</p>}
        </section>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", padding: "8px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const input = { display: "block", padding: 8 };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 13 };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13 };
const btn = { padding: "4px 8px", fontSize: 12 };
