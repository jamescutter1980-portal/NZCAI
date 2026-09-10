"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";

interface AssetSummary {
  assetId: string; name: string; postcode?: string; floorAreaM2?: number; propertyType?: string; meterCount: number;
  electricityKwh: number; gasKwh: number; exportKwh: number; totalImportKwh: number; eui: number | null;
  scope1: number | null; scope2Location: number | null; scope2Market: number | null; scope3TandD: number | null;
  intensity: number | null; completeness: number | null; factorsComplete: boolean;
}
interface Issue { assetId?: string; assetName?: string; kind: string; detail: string }
interface Report {
  period: { label: string; from: string; to: string; days: number; factorYear: number };
  assets: AssetSummary[];
  totals: {
    assets: number; assetsWithReadings: number; meters: number; floorAreaM2: number; electricityKwh: number; gasKwh: number; exportKwh: number; totalImportKwh: number;
    scope1: number | null; scope2Location: number | null; scope2Market: number | null; scope3TandD: number | null;
    contributing: { scope1: number; scope2Location: number; scope2Market: number; scope3TandD: number };
  };
  issues: Issue[];
  factorReferences: string[];
}

const ISSUE_LABELS: Record<string, string> = {
  no_meters: "No meters linked",
  no_readings: "No readings in the period",
  no_floor_area: "No floor area",
  no_location: "No coordinates",
  factors_missing: "Conversion factor unavailable",
  over_allocated: "Meter over-allocated",
  under_allocated: "Meter under-allocated",
  partial_period: "Partial period",
};
const SERIOUS = new Set(["over_allocated", "factors_missing", "no_readings"]);

export default function PortfolioPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<keyof AssetSummary>("totalImportKwh");

  const load = useCallback(async (s: PeriodSelection) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portfolio?${periodQuery(s)}`);
      const b = await res.json();
      if (!res.ok) setError(b.error ?? `Failed (${res.status})`);
      else setReport(b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const s = defaultPeriodSelection();
    fetch(`/api/portfolio?${periodQuery(s)}`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!active) return;
        if (ok) setReport(b);
        else setError(b.error ?? "Failed to load the portfolio");
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  function change(s: PeriodSelection) {
    setSelection(s);
    load(s);
  }

  const rows = report ? [...report.assets].sort((a, b) => Number(b[sort] ?? -1) - Number(a[sort] ?? -1)) : [];
  const grouped = (report?.issues ?? []).reduce<Record<string, Issue[]>>((m, i) => ((m[i.kind] ??= []).push(i), m), {});

  return (
    <>
      <h1>Portfolio</h1>
      <p style={{ color: "#555" }}>
        Energy and carbon across every <Link href="/assets">asset</Link> for a reporting period. Totals add only what is
        known: a scope total is blank when any asset in it could not be calculated, and the number of assets behind each
        total is shown.
      </p>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <PeriodPicker value={selection} onChange={change} disabled={busy} />
        {report &&
          (selection.kind === "calendar" ? (
            <span style={{ fontSize: 13, display: "flex", gap: 12 }}>
              <a href={`/api/exports/portfolio-energy?year=${selection.year}`}>Energy CSV</a>
              <a href={`/api/exports/portfolio-carbon?year=${selection.year}`}>Carbon CSV</a>
              <a href={`/api/exports/secr-summary?year=${selection.year}`}>SECR summary CSV</a>
            </span>
          ) : (
            <span style={{ fontSize: 13, color: "#666" }}>CSV exports cover calendar years only</span>
          ))}
      </div>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      {busy && !report && <p>Loading…</p>}

      {report && (
        <>
          <p style={{ fontSize: 13, color: "#555" }}>
            {report.period.label} · {report.period.from.slice(0, 10)} to {report.period.to.slice(0, 10)} · {report.period.days} days · factor set {report.period.factorYear}
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <Stat label="Assets" value={String(report.totals.assets)} sub={`${report.totals.assetsWithReadings} with data`} />
            <Stat label="Floor area m²" value={fmt(report.totals.floorAreaM2)} />
            <Stat label="Electricity kWh" value={fmt(report.totals.electricityKwh)} />
            <Stat label="Gas kWh" value={fmt(report.totals.gasKwh)} />
            <Stat label="Scope 1 kgCO2e" value={fmtN(report.totals.scope1)} sub={`${report.totals.contributing.scope1} assets`} />
            <Stat label="Scope 2 location" value={fmtN(report.totals.scope2Location)} sub={`${report.totals.contributing.scope2Location} assets`} />
            <Stat label="Scope 2 market" value={fmtN(report.totals.scope2Market)} sub={`${report.totals.contributing.scope2Market} assets`} />
            <Stat label="Scope 3 T&D" value={fmtN(report.totals.scope3TandD)} sub={`${report.totals.contributing.scope3TandD} assets`} />
          </div>

          {report.issues.length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16 }}>Data quality ({report.issues.length})</h2>
              {Object.entries(grouped)
                .sort(([a], [b]) => Number(SERIOUS.has(b)) - Number(SERIOUS.has(a)))
                .map(([kind, items]) => (
                  <details key={kind} style={{ marginBottom: 4 }} open={SERIOUS.has(kind)}>
                    <summary style={{ cursor: "pointer", fontSize: 13, color: SERIOUS.has(kind) ? "#b02a37" : "#856404" }}>
                      {ISSUE_LABELS[kind] ?? kind} — {items.length} asset{items.length > 1 ? "s" : ""}
                    </summary>
                    <ul style={{ fontSize: 12, marginTop: 4 }}>
                      {items.map((i, n) => (
                        <li key={n}>
                          {i.assetId ? <Link href={`/assets/${i.assetId}`}>{i.assetName}</Link> : i.assetName} — {i.detail}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
            </section>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {([
                    ["name", "Asset"],
                    ["floorAreaM2", "Floor area m²"],
                    ["electricityKwh", "Electricity kWh"],
                    ["gasKwh", "Gas kWh"],
                    ["eui", "EUI kWh/m²"],
                    ["scope1", "Scope 1"],
                    ["scope2Location", "Scope 2 loc."],
                    ["scope2Market", "Scope 2 mkt."],
                    ["intensity", "kgCO2e/m²"],
                    ["completeness", "Data %"],
                  ] as [keyof AssetSummary, string][]).map(([key, label]) => (
                    <th key={key} style={{ ...th, cursor: "pointer" }} onClick={() => setSort(key)} title="Sort by this column">
                      {label}{sort === key ? " ↓" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.assetId}>
                    <td style={td}>
                      <Link href={`/assets/${a.assetId}`}>{a.name}</Link>
                      {a.meterCount === 0 && <span style={{ color: "#b02a37", fontSize: 11 }}> no meters</span>}
                    </td>
                    <td style={num}>{a.floorAreaM2 ? fmt(a.floorAreaM2) : "—"}</td>
                    <td style={num}>{fmt(a.electricityKwh)}</td>
                    <td style={num}>{fmt(a.gasKwh)}</td>
                    <td style={num}>{a.eui === null ? "—" : a.eui.toFixed(1)}</td>
                    <td style={num}>{fmtN(a.scope1)}</td>
                    <td style={num}>{fmtN(a.scope2Location)}</td>
                    <td style={num}>{fmtN(a.scope2Market)}</td>
                    <td style={num}>{a.intensity === null ? "—" : a.intensity.toFixed(1)}</td>
                    <td style={{ ...num, color: (a.completeness ?? 100) < 95 ? "#b02a37" : undefined }}>{a.completeness === null ? "—" : `${a.completeness}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.factorReferences.length > 0 && (
            <p style={{ fontSize: 12, color: "#666" }}>Factors used: {report.factorReferences.join("; ")}.</p>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", padding: "8px 12px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#666" }}>{sub}</div>}
    </div>
  );
}
const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const fmtN = (n: number | null) => (n === null ? "unavailable" : fmt(n));
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12 };
const num = { ...td, textAlign: "right" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 12, border: `1px solid ${border}`, fontSize: 13 });
