"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Item { mpxn: string; utility: string; direction: string; readingsUpserted: number; tariffRows: number; gaps: unknown[]; warning: string | null; error: string | null }
interface Run {
  id: string; startedAt: string; finishedAt: string | null; trigger: string; environment: string;
  summary: { consents: number; meters: number; readingsUpserted: number; errors: number; gaps: number; warnings: string[] } | null;
  items: Item[];
}

export default function SyncPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/readings/meters");
    const body = await res.json();
    setRuns(body.runs ?? []);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/readings/meters")
      .then((r) => r.json())
      .then((b) => { if (active) setRuns(b.runs ?? []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function runNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/n3rgy/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Sync failed (${res.status})`);
      else setMessage(body.headline);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>n3rgy sync</h1>
      <p style={{ color: "#555" }}>
        Pulls new half-hourly readings and tariffs for every active <Link href="/consents">consent</Link> into the portal
        database, starting from the last stored interval. Schedule <code>pnpm n3rgy:sync</code> daily or point a scheduler at{" "}
        <code>POST /api/n3rgy/sync</code> with the sync token.
      </p>
      <button onClick={runNow} disabled={busy} style={{ padding: "10px 16px" }}>{busy ? "Running…" : "Run sync now"}</button>
      {message && <p style={{ background: "#d1e7dd", padding: 12, border: "1px solid #a3cfbb" }}>{message}</p>}
      {error && <p style={{ background: "#f8d7da", padding: 12, border: "1px solid #f1aeb5" }}>{error}</p>}

      <h2 style={{ fontSize: 18 }}>Recent runs</h2>
      {runs.length === 0 && <p>No runs yet.</p>}
      {runs.map((r) => (
        <details key={r.id} style={{ marginBottom: 8, background: "#fff", border: "1px solid #ddd", padding: 8 }}>
          <summary style={{ cursor: "pointer" }}>
            {r.startedAt.slice(0, 16).replace("T", " ")} · {r.trigger} · {r.environment} ·{" "}
            {r.summary ? `${r.summary.readingsUpserted} readings, ${r.summary.errors} errors, ${r.summary.gaps} gaps` : "running"}
          </summary>
          {r.summary?.warnings?.length ? (
            <ul style={{ color: "#856404" }}>{r.summary.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          ) : null}
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["MPxN", "Utility", "Dir", "Readings", "Tariff rows", "Gaps", "Note"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {r.items.map((i, n) => (
                <tr key={n}>
                  <td style={td}><code>{i.mpxn}</code></td>
                  <td style={td}>{i.utility}</td>
                  <td style={td}>{i.direction}</td>
                  <td style={td}>{i.readingsUpserted}</td>
                  <td style={td}>{i.tariffRows}</td>
                  <td style={td}>{i.gaps.length}</td>
                  <td style={{ ...td, color: i.error ? "#b02a37" : "#666" }}>{i.error ?? i.warning ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </>
  );
}

const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 13 };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13 };
