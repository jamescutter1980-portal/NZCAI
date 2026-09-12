"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  Cohort,
  CohortSpec,
  Coverage,
  Prospect,
  ProspectSummary,
} from "@/lib/site-intel/prospects";

/**
 * S-08 prospect list.
 *
 * Two things are placed deliberately.
 *
 * The COVERAGE STATEMENT sits above the results, not in a footnote, because
 * the corpus is a loaded cache. "Four F-rated buildings in DN4" and "there are
 * four F-rated buildings in DN4" are different claims, and only the first one
 * is true.
 *
 * The EXEMPTION CAVEAT is attached to the below-minimum cohort itself rather
 * than only to the page, because that cohort is the one a reader will treat as
 * an enforcement list. A building below the minimum band with a registered
 * exemption is lawfully let, and we cannot see the register.
 */

interface Response {
  prospects: Prospect[];
  summary: ProspectSummary;
  coverage: Coverage;
  cohorts: CohortSpec[];
  caveats: string[];
  wordingUnapproved: string[];
  notApplied: { clause: string; reason: string }[];
  truncated: boolean;
  error?: string;
}

const COHORT_TONE: Partial<Record<Cohort, string>> = {
  below_minimum: "alert",
  expired: "alert",
  at_risk_2031: "watch",
  area_unclear: "watch",
};

export default function MeesProspects() {
  const [data, setData] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cohort, setCohort] = useState<Cohort | "">("");
  const [district, setDistrict] = useState("");
  const [gasOnly, setGasOnly] = useState(false);
  const [minArea, setMinArea] = useState("");

  const params = useCallback(() => {
    const q = new URLSearchParams();
    if (cohort) q.set("cohort", cohort);
    if (district.trim()) q.set("district", district.trim().toUpperCase());
    if (gasOnly) q.set("gas", "1");
    if (minArea.trim()) q.set("min_area", minArea.trim());
    return q;
  }, [cohort, district, gasOnly, minArea]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/site-intel/prospects?${params().toString()}`);
      const body = (await res.json()) as Response;
      if (body.error) setError(body.error);
      else setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the list");
    } finally {
      setBusy(false);
    }
  }, [params]);

  useEffect(() => {
    void run();
    // Runs once; the filters re-run it through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spec = (key: Cohort): CohortSpec | undefined =>
    data?.cohorts.find((c) => c.key === key);

  return (
    <div className="mees-page">
      <header className="mees-top">
        <h1>MEES prospects</h1>
        <p className="mees-sub">
          Non-domestic certificates screened against the minimum band in force and
          the EPC B standard proposed for 2031. Screening flags for review by a
          qualified person — not a compliance determination.
        </p>
      </header>

      {data && (
        <p className="mees-coverage">
          <strong>What this covers.</strong> {data.coverage.statement}
          {data.coverage.sampleDistricts.length > 0 && (
            <> Districts held: {data.coverage.sampleDistricts.join(", ")}.</>
          )}
        </p>
      )}

      {data && data.wordingUnapproved.length > 0 && (
        <p className="mees-unapproved">
          Wording for {data.wordingUnapproved.length} rule(s) has not been signed
          off. This states a legal duty — do not issue it to a client yet.
        </p>
      )}

      <form
        className="mees-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          Cohort
          <select value={cohort} onChange={(e) => setCohort(e.target.value as Cohort | "")}>
            <option value="">All</option>
            {data?.cohorts.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label>
          District
          <input
            type="text"
            value={district}
            placeholder="DN4"
            onChange={(e) => setDistrict(e.target.value)}
          />
        </label>
        <label>
          Min area m²
          <input
            type="number"
            min="0"
            value={minArea}
            placeholder="1000"
            onChange={(e) => setMinArea(e.target.value)}
          />
        </label>
        <label className="mees-check">
          <input type="checkbox" checked={gasOnly} onChange={(e) => setGasOnly(e.target.checked)} />
          Gas or LPG only
        </label>
        <button type="submit" disabled={busy}>{busy ? "…" : "Apply"}</button>
        <a className="mees-export" href={`/api/site-intel/prospects?${(() => {
          const q = params();
          q.set("format", "csv");
          return q.toString();
        })()}`}>
          Export CSV
        </a>
      </form>

      {error && <p className="search-error">{error}</p>}

      {data && (
        <>
          {data.notApplied.length > 0 && (
            <div className="search-ignored">
              <p className="search-ignored-head">Not everything was shown</p>
              <ul>
                {data.notApplied.map((n) => (
                  <li key={n.clause}><strong>{n.clause}</strong> — {n.reason}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mees-summary">
            {data.summary.byCohort
              .filter((c) => c.count > 0)
              .map((c) => (
                <button
                  key={c.cohort}
                  type="button"
                  className={`mees-tile ${COHORT_TONE[c.cohort] ?? ""} ${cohort === c.cohort ? "on" : ""}`}
                  onClick={() => {
                    setCohort(cohort === c.cohort ? "" : c.cohort);
                  }}
                >
                  <span className="mees-tile-n">{c.count}</span>
                  <span className="mees-tile-l">{c.label}</span>
                </button>
              ))}
          </div>

          {data.summary.total > 0 && (
            <div className="mees-bands">
              <p className="eyebrow">Band distribution of these {data.summary.total} rows</p>
              <ul>
                {data.summary.byBand.map((b) => (
                  <li key={b.band}>
                    <span className={`epc-band band-${String(b.band).toLowerCase().replace("+", "plus")}`}>
                      {b.band === "none" ? "—" : b.band}
                    </span>
                    <span className="mees-band-n">{b.count}</span>
                  </li>
                ))}
              </ul>
              <p className="mees-bench">
                {data.summary.atOrAboveBPct !== null && (
                  <>
                    {data.summary.atOrAboveBPct}% at B or above here, against{" "}
                    {data.summary.benchmark.atOrAboveBPct}% for {data.summary.benchmark.name}.{" "}
                  </>
                )}
                <em>{data.summary.benchmark.caution}</em>{" "}
                <span className="mees-cite">{data.summary.benchmark.citation}</span>
              </p>
            </div>
          )}

          {cohort && spec(cohort) && (
            <div className="mees-cohort-note">
              <p className="mees-cohort-crit"><strong>Criteria.</strong> {spec(cohort)?.criteria}</p>
              <p className="mees-cohort-why">{spec(cohort)?.why}</p>
            </div>
          )}

          {data.prospects.length === 0 ? (
            <p className="search-count">
              No certificates matched. That reflects what is loaded, not the country —
              see the coverage note above.
            </p>
          ) : (
            <div className="mees-rows">
              {data.prospects.map((p) => (
                <article key={p.lmkKey} className={`mees-row ${COHORT_TONE[p.cohort] ?? ""}`}>
                  <p className="mees-row-head">
                    <span className={`epc-band band-${(p.band ?? "x").toLowerCase().replace("+", "plus")}`}>
                      {p.band ?? "—"}
                    </span>
                    {/*
                      * An expired certificate's band is what the building was
                      * rated when it was last assessed, which may be a decade
                      * ago. The badge on its own reads as current, so it is
                      * labelled rather than left to the finding text.
                      */}
                    {p.cohort === "expired" && p.band && (
                      <span className="mees-lastknown">last known</span>
                    )}
                    <span className="mees-addr">{p.address || "No address on the certificate"}</span>
                    <span className="mees-pc">{p.postcode ?? "—"}</span>
                  </p>
                  <p className="mees-meta">
                    {spec(p.cohort)?.label}
                    {p.floorAreaM2 ? ` · ${p.floorAreaM2.toLocaleString()} m²` : ""}
                    {p.mainFuel ? ` · ${p.mainFuel}` : ""}
                    {p.expiresOn ? ` · expires ${p.expiresOn}` : ""}
                    {p.scorePointsToTarget ? ` · ${p.scorePointsToTarget} BER points off B` : ""}
                  </p>
                  <p className="mees-finding">{p.finding}</p>
                  {/*
                    * On the row, not only in the cohort note: this is the row a
                    * reader treats as an enforcement list, and it is the one
                    * most likely to be screenshotted on its own.
                    */}
                  {p.cohort === "below_minimum" && (
                    <p className="mees-exempt">
                      Exemption status unknown — the PRS Exemptions Register is not held
                      here, and a building below the minimum band may be lawfully let
                      under a registered exemption.
                    </p>
                  )}
                  {p.gasOrLpg && (
                    <p className="mees-pv">
                      Gas or LPG — PV will not move this band, though that says nothing
                      about the roof.
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}

          <details className="perf-caveats mees-caveats">
            <summary>What this list does not know ({data.caveats.length})</summary>
            <ul>
              {data.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
