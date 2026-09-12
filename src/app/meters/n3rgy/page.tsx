"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Status = { configured: true; environment: string; baseUrl: string } | { configured: false; reason: string };

interface Daily {
  date: string;
  value: number;
  unit: string;
  intervals: number;
}

interface ConsentSummary {
  id: string;
  utilities: string[];
  effectiveStatus: string;
  expiresOn: string;
  occupierName: string;
}

interface Result {
  environment: string;
  consentRef?: string;
  partial: boolean;
  retrievedAt: string;
  count: number;
  unit: string | null;
  attribution: string | null;
  daily: Daily[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default function N3rgyPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mpxn, setMpxn] = useState("");
  const [utility, setUtility] = useState<"electricity" | "gas">("electricity");
  const [direction, setDirection] = useState<"import" | "export">("import");
  const [start, setStart] = useState(() => isoDate(new Date(Date.now() - 30 * 86_400_000)));
  const [end, setEnd] = useState(() => isoDate(new Date(Date.now() - 86_400_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [consentLookup, setConsentLookup] = useState<{ mpxn: string; consents: ConsentSummary[] } | null>(null);

  const cleanMpxn = mpxn.replace(/\s+/g, "");
  const mpxnValid = /^\d{6,13}$/.test(cleanMpxn);

  useEffect(() => {
    if (!mpxnValid) return;
    const ctrl = new AbortController();
    fetch(`/api/consents?mpxn=${cleanMpxn}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((b) => setConsentLookup({ mpxn: cleanMpxn, consents: b.consents ?? [] }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [cleanMpxn, mpxnValid]);

  const consents = mpxnValid && consentLookup?.mpxn === cleanMpxn ? consentLookup.consents : null;

  useEffect(() => {
    fetch("/api/n3rgy/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, reason: "Status check failed" }));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const params = new URLSearchParams({ mpxn: mpxn.trim(), utility, direction, start, end });
    try {
      const res = await fetch(`/api/n3rgy/consumption?${params}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`);
      } else {
        setResult(body);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const csvHref = `/api/n3rgy/consumption?${new URLSearchParams({ mpxn: mpxn.trim(), utility, direction, start, end })}`;

  return (
    <>
      <h1>n3rgy smart-meter data</h1>
      {status === null && <p>Checking connector…</p>}
      {status?.configured === false && (
        <p style={{ background: "#fff3cd", padding: 12, border: "1px solid #ffe69c" }}>
          Connector not configured: {status.reason}
        </p>
      )}
      {status?.configured && (
        <p style={{ color: "#555" }}>
          Environment: <strong>{status.environment}</strong> ({status.baseUrl})
        </p>
      )}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
        <label>
          MPAN / MPRN
          <input
            value={mpxn}
            onChange={(e) => setMpxn(e.target.value)}
            required
            pattern="[0-9 ]{6,15}"
            style={{ display: "block", width: "100%", padding: 8 }}
          />
        </label>
        {consents !== null && status?.configured && status.environment !== "sandbox" && (
          <p style={{ fontSize: 13, margin: 0 }}>
            {consents.some((c) => c.effectiveStatus === "active" && c.utilities.includes(utility)) ? (
              <span style={{ color: "#1e7e34" }}>Active consent on file for {utility}.</span>
            ) : (
              <span style={{ color: "#b02a37" }}>
                No active {utility} consent for this MPxN. <Link href="/consents">Record or verify one</Link> before pulling live data.
              </span>
            )}
          </p>
        )}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label>
            Utility
            <select value={utility} onChange={(e) => setUtility(e.target.value as "electricity" | "gas")} style={{ display: "block", padding: 8 }}>
              <option value="electricity">Electricity</option>
              <option value="gas">Gas</option>
            </select>
          </label>
          <label>
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as "import" | "export")} style={{ display: "block", padding: 8 }}>
              <option value="import">Import (consumption)</option>
              <option value="export">Export (production)</option>
            </select>
          </label>
          <label>
            Start
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required style={{ display: "block", padding: 8 }} />
          </label>
          <label>
            End
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required style={{ display: "block", padding: 8 }} />
          </label>
        </div>
        <button type="submit" disabled={busy || status?.configured === false} style={{ padding: "10px 16px" }}>
          {busy ? "Fetching…" : "Fetch readings"}
        </button>
      </form>

      {error && (
        <p style={{ background: "#f8d7da", padding: 12, border: "1px solid #f1aeb5", marginTop: 16 }}>{error}</p>
      )}

      {result && (
        <section style={{ marginTop: 24 }}>
          <p>
            {result.count} intervals, {result.unit}. Retrieved {result.retrievedAt} from {result.environment}
            {result.consentRef ? ` under consent ${result.consentRef}` : ""}.
            {result.partial && " Some chunks returned partial content."}
          </p>
          <p>
            <a href={csvHref} target="_blank" rel="noreferrer">
              Raw JSON
            </a>
          </p>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 520 }}>
            <thead>
              <tr>
                <th style={th}>Date (UTC)</th>
                <th style={th}>Intervals</th>
                <th style={th}>Total ({result.unit})</th>
              </tr>
            </thead>
            <tbody>
              {result.daily.map((d) => (
                <tr key={d.date}>
                  <td style={td}>{d.date}</td>
                  <td style={td}>{d.intervals}</td>
                  <td style={td}>{d.value.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.attribution && <p style={{ color: "#666", fontSize: 12 }}>{result.attribution}</p>}
        </section>
      )}
    </>
  );
}

const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px" };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px" };
