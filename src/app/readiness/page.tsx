"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PeriodPicker, defaultPeriodSelection, periodQuery, type PeriodSelection } from "@/components/PeriodPicker";

type Severity = "blocker" | "gap" | "advisory";
type Status = "ok" | "attention" | "unknown";

interface Check {
  id: string;
  group: string;
  title: string;
  severity: Severity;
  status: Status;
  detail: string;
  fix?: { label: string; href: string };
  count?: number;
}

interface Report {
  period: { label: string; from: string; to: string; days: number; factorYear: number };
  checks: Check[];
  score: { ok: number; attention: number; total: number; blockers: number };
  summary: string;
}

const OK = "#1e7e34";
const GAP = "#856404";
const BLOCKER = "#b02a37";
const MUTED = "#666";

/** Colour follows the consequence, not the count: a blocker is always red. */
function colourOf(c: Check): string {
  if (c.status === "ok") return OK;
  if (c.status === "unknown") return MUTED;
  return c.severity === "blocker" ? BLOCKER : c.severity === "gap" ? GAP : MUTED;
}

function statusLabel(c: Check): string {
  if (c.status === "ok") return "OK";
  if (c.status === "unknown") return "NOT CHECKED";
  return c.severity === "blocker" ? "BLOCKER" : c.severity === "gap" ? "GAP" : "ADVISORY";
}

/** Outstanding blockers first, then gaps, advisories, unchecked, and settled checks last. */
function rank(c: Check): number {
  if (c.status === "attention") return c.severity === "blocker" ? 0 : c.severity === "gap" ? 1 : 2;
  return c.status === "unknown" ? 3 : 4;
}

export default function ReadinessPage() {
  const [selection, setSelection] = useState<PeriodSelection>(() => defaultPeriodSelection());
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (s: PeriodSelection) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/readiness?${periodQuery(s)}`);
      const b = await res.json();
      if (!res.ok) setError(b.error ?? `Failed (${res.status})`);
      else setReport(b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // Initial load: state is set from the response, never synchronously in the effect body.
  useEffect(() => {
    let active = true;
    fetch(`/api/readiness?${periodQuery(defaultPeriodSelection())}`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!active) return;
        if (ok) setReport(b);
        else setError(b.error ?? "Failed to load readiness");
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

  const checks = report?.checks ?? [];
  const groups = [...new Set(checks.map((c) => c.group))].sort((a, b) => {
    const worst = (g: string) => Math.min(...checks.filter((c) => c.group === g).map(rank));
    return worst(a) - worst(b);
  });
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const gaps = checks.filter((c) => c.severity === "gap" && c.status === "attention").length;
  const advisories = checks.filter((c) => c.severity === "advisory" && c.status === "attention").length;

  return (
    <>
      <h1>Reporting readiness</h1>
      <p style={{ color: "#555" }}>
        What is still missing before this return can be filed for a period. Every check reads the same data the{" "}
        <Link href="/portfolio">portfolio</Link> roll-up, <Link href="/transport">transport</Link> engine and{" "}
        <Link href="/consents">consents</Link> use, so nothing here can disagree with the figures. A check that cannot be
        run says so rather than passing.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <PeriodPicker value={selection} onChange={change} disabled={busy} />
      </div>

      {error && <p style={{ background: "#f8d7da", border: "1px solid #f1aeb5", padding: 12 }}>{error}</p>}
      {busy && !report && <p>Loading…</p>}

      {report && (
        <>
          <section
            style={{
              background: "#fff",
              border: "1px solid #ddd",
              borderLeft: `4px solid ${report.score.blockers > 0 ? BLOCKER : OK}`,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>{report.summary}</p>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: MUTED }}>
              {report.period.label} · {report.period.from.slice(0, 10)} to {report.period.to.slice(0, 10)} ·{" "}
              {report.period.days} days · factor set {report.period.factorYear}
            </p>
          </section>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <Stat label="Blockers" value={report.score.blockers} colour={report.score.blockers > 0 ? BLOCKER : OK} />
            <Stat label="Gaps to disclose" value={gaps} colour={gaps > 0 ? GAP : OK} />
            <Stat label="Advisory" value={advisories} colour={MUTED} />
            <Stat label="Checks passed" value={`${report.score.ok} of ${report.score.total}`} colour={OK} />
            <Stat label="Not checked" value={unknown} colour={MUTED} />
          </div>

          {groups.map((group) => (
            <section key={group} style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>{group}</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {checks
                  .filter((c) => c.group === group)
                  .sort((a, b) => rank(a) - rank(b))
                  .map((c) => (
                    <article
                      key={c.id}
                      style={{ background: "#fff", border: "1px solid #ddd", borderLeft: `4px solid ${colourOf(c)}`, padding: 12 }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ color: colourOf(c), fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>{statusLabel(c)}</span>
                        <strong style={{ fontSize: 14 }}>{c.title}</strong>
                        {c.count !== undefined && c.status === "attention" && (
                          <span style={{ fontSize: 12, color: MUTED }}>{c.count} affected</span>
                        )}
                      </div>
                      <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.5 }}>{c.detail}</p>
                      {c.fix && c.status !== "ok" && (
                        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
                          <Link href={c.fix.href}>Fix in {c.fix.label}</Link>
                        </p>
                      )}
                      <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED }}>{c.id}</p>
                    </article>
                  ))}
              </div>
            </section>
          ))}

          <p style={{ fontSize: 12, color: MUTED }}>
            Readiness reports what the portal holds. The exclusions the SECR export lists on its face still apply to any
            return produced from it.
          </p>
        </>
      )}
    </>
  );
}

function Stat({ label, value, colour }: { label: string; value: string | number; colour: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", padding: "10px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: colour }}>{value}</div>
    </div>
  );
}
