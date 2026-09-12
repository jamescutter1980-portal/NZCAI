"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";
import { STATE_LABELS, type EngagementState } from "@/lib/value-chain/types";

interface Hotspot {
  rank: number; counterpartyId: string; name: string; sector?: string; annualValueGbp?: number; categories: string[];
  state: EngagementState; basis: "returned" | "spend_estimate"; screeningTco2e: number | null; tier: string | null;
  sharePct: number | null; cumulativeSharePct: number | null; priority: boolean; detail: string;
}
interface Screen {
  reportingYear: number; thresholdPct: number; hotspots: Hotspot[];
  unscreenable: { counterpartyId: string; name: string; annualValueGbp?: number; reason: string }[];
  totals: { screenedTco2e: number; returnedTco2e: number; estimatedTco2e: number; screened: number; fromReturnedData: number; fromSpendEstimate: number; priorityCount: number; prioritySharePct: number | null; priorityWithoutData: number };
  detail: string; warnings: string[];
}

export default function HotspotsPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [threshold, setThreshold] = useState("80");
  const [screen, setScreen] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyPriority, setOnlyPriority] = useState(false);

  const load = useCallback(async (s: PeriodSelection, t: string) => {
    const res = await fetch(`/api/value-chain/hotspots?${periodQuery(s)}&threshold=${t || 80}`);
    const b = await res.json();
    if (b.error) setError(b.error);
    else { setError(null); setScreen(b); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/api/value-chain/hotspots?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json())
      .then((b) => { if (!active) return; if (b.error) setError(b.error); else setScreen(b); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  const rows = (screen?.hotspots ?? []).filter((h) => !onlyPriority || h.priority);

  return (
    <>
      <h1>Where the emissions are</h1>
      <p style={{ color: "#555" }}>
        Every active counterparty placed on its best available figure: returned data where it exists, a spend estimate where it does not. The ranking says where
        engagement is worth the effort. It is for prioritising only and never feeds the reported total, which stays in the{" "}
        <Link href="/value-chain">register</Link>; a counterparty placed from spend has still returned nothing.
      </p>
      <div style={{ marginBottom: 12, ...row, alignItems: "flex-end" }}>
        <PeriodPicker value={selection} onChange={(s) => { setSelection(s); load(s, threshold); }} />
        <label style={{ fontSize: 12 }}>Priority covers<input style={{ ...input, width: 80 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} onBlur={() => load(selection, threshold)} />%</label>
        <label style={{ fontSize: 12 }}><input type="checkbox" checked={onlyPriority} onChange={(e) => setOnlyPriority(e.target.checked)} /> priority only</label>
      </div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {screen && (
        <>
          <section style={card}>
            <p style={{ fontSize: 13, margin: 0 }}>{screen.detail}</p>
            <div style={{ ...row, marginTop: 8 }}>
              <div style={box("#eef", "#ccd")}><strong>{fmtN(screen.totals.screenedTco2e)}</strong> tCO2e screened</div>
              <div style={box("#e7f6e7", "#b9dfb9")}><strong>{fmtN(screen.totals.returnedTco2e)}</strong> from returned data</div>
              <div style={box("#fff3cd", "#ffe69c")}><strong>{fmtN(screen.totals.estimatedTco2e)}</strong> from spend estimates</div>
              <div style={box("#eef", "#ccd")}><strong>{screen.totals.priorityCount}</strong> in the priority set</div>
              <div style={box(screen.totals.priorityWithoutData > 0 ? "#fff3cd" : "#e7f6e7", screen.totals.priorityWithoutData > 0 ? "#ffe69c" : "#b9dfb9")}>
                <strong>{screen.totals.priorityWithoutData}</strong> of those returned nothing
              </div>
            </div>
          </section>

          <section style={card}>
            <h2 style={h2}>Ranked</h2>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>#</th><th style={th}>Counterparty</th><th style={th}>Sector</th><th style={th}>Screening tCO2e</th><th style={th}>Share</th><th style={th}>Cumulative</th><th style={th}>Basis</th><th style={th}>Engagement</th><th style={th}>Note</th></tr></thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.counterpartyId} style={h.priority ? { background: "#f5f9ff" } : undefined}>
                    <td style={td}>{h.rank}</td>
                    <td style={td}><Link href={`/value-chain/${h.counterpartyId}`}>{h.name}</Link>{h.priority && <span style={{ color: "#036", fontSize: 11 }}> priority</span>}</td>
                    <td style={td}>{h.sector ?? "—"}</td>
                    <td style={td}>{fmtN(h.screeningTco2e)}</td>
                    <td style={td}>{h.sharePct === null ? "—" : `${h.sharePct}%`}</td>
                    <td style={td}>{h.cumulativeSharePct === null ? "—" : `${h.cumulativeSharePct}%`}</td>
                    <td style={td}>{h.basis === "returned" ? `returned, tier ${h.tier ?? "?"}` : "spend estimate, tier D"}</td>
                    <td style={td}>{STATE_LABELS[h.state] ?? h.state}</td>
                    <td style={td}>{h.detail}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td style={td} colSpan={9}>Nothing to rank.</td></tr>}
              </tbody>
            </table>
          </section>

          {screen.unscreenable.length > 0 && (
            <section style={card}>
              <h2 style={h2}>Cannot be placed at all ({screen.unscreenable.length})</h2>
              <p style={{ fontSize: 13, color: "#555" }}>Missing from the ranking rather than ranked low, because a counterparty with no figure is not a small one.</p>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={th}>Counterparty</th><th style={th}>Annual value</th><th style={th}>What is missing</th></tr></thead>
                <tbody>
                  {screen.unscreenable.map((u) => (
                    <tr key={u.counterpartyId}>
                      <td style={td}><Link href={`/value-chain/${u.counterpartyId}`}>{u.name}</Link></td>
                      <td style={td}>{u.annualValueGbp === undefined ? "not recorded" : `£${fmtN(u.annualValueGbp)}`}</td>
                      <td style={td}>{u.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {screen.warnings.map((w) => <p key={w} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
        </>
      )}
    </>
  );
}

const fmtN = (n: number | null) => (n === null ? "unavailable" : n.toLocaleString("en-GB", { maximumFractionDigits: n < 10 ? 2 : 0 }));
const card = { background: "#fff", border: "1px solid #ddd", padding: 12, marginBottom: 16 };
const h2 = { fontSize: 16, marginBottom: 8 };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const input = { display: "inline-block", padding: 6, boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 10, border: `1px solid ${border}`, fontSize: 13 });
