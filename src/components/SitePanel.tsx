"use client";

import { useCallback, useState } from "react";
import type { Candidate, SiteProfile } from "@/lib/site-intel/types";
import type { ConstraintScreening } from "@/lib/site-intel/constraints";
import type { OwnershipResult } from "@/lib/site-intel/ownership";
import type { CompanyRecord } from "@/lib/site-intel/companies-house";
import type { AreaComparison, UseClassInference, VoaResult } from "@/lib/site-intel/voa";
import { AREA_BASIS_LABEL } from "@/lib/site-intel/area-basis";
import type { EpcCertificate } from "@/lib/site-intel/epc";
import type { MeesScreening } from "@/lib/site-intel/mees";
import type { GridProfile } from "@/lib/site-intel/grid";
import type { CertificateAge, Intensity, RatingReading } from "@/lib/site-intel/performance";
import { TIER_LABEL } from "@/lib/site-intel/types";

/**
 * S-01 "Is this the building?" step.
 *
 * The brief is explicit that anything short of an exact register match must be
 * confirmed by a person before it is trusted, so the confirm control is the
 * primary action and the confidence is stated in plain words rather than left
 * to a badge colour.
 */

export interface SiteMapApi {
  showSite(lat: number, lon: number): void;
  showGeometry(profile: SiteProfile | null): void;
  /**
   * S-02 layers. Passing null clears them AND the coverage strip - a stale
   * coverage line under a cleared map would describe a screening that is no
   * longer on screen.
   */
  showConstraints(screening: ConstraintScreening | null): void;
  clearSite(): void;
}

interface Props {
  mapApi: SiteMapApi;
}

// Kept deliberately neutral: the precise provenance is the candidate's own
// `source.method`, shown underneath. Naming a source here would have claimed an
// address-register match for what is actually a direct UPRN lookup.
const CONFIDENCE_COPY: Record<string, string> = {
  exact: "Exact match",
  probable: "Probable — confirm this is the right building",
  approximate: "Approximate — pick the building or move the pin",
  manual: "Picked from the map — confirm this is the right building",
  none: "Not resolved",
};

const STATE_COPY: Record<string, string> = {
  present: "found",
  proximity: "nearby",
  not_found_coverage_complete: "none (coverage complete)",
  not_found_coverage_unknown: "none found — coverage unknown",
  not_supported: "not supported here",
  source_error: "source unavailable",
};

interface EpcReport {
  certificates: EpcCertificate[];
  current: EpcCertificate | null;
  unavailable: string | null;
  fromCache: boolean;
}

const UPRN_SOURCE_COPY: Record<string, string> = {
  address_matched: "UPRN matched by the register",
  energy_assessor: "UPRN entered by the energy assessor — verify before relying on it",
  unknown: "UPRN source not stated",
  none: "No UPRN on this certificate",
};

/**
 * EPC certificates for the site.
 *
 * The UPRN source is shown because the register does not grade them equally: an
 * address-matched UPRN is register-grade, one typed in by an assessor is not.
 */
function EpcPanel({ report }: { report: EpcReport }) {
  const { certificates, current, unavailable, fromCache } = report;

  return (
    <section className="epc">
      <p className="eyebrow">Energy performance</p>

      {unavailable && <p className="epc-note">{unavailable}</p>}

      {!current && !unavailable && (
        <p className="epc-note">
          No EPC found for this postcode in the register.
        </p>
      )}

      {current && (
        <div className="epc-cert">
          <p className="epc-head">
            <span className={`epc-band band-${(current.rating ?? "x").toLowerCase()}`}>
              {current.rating ?? "—"}
            </span>
            <span className="epc-register">{current.register}</span>
          </p>
          <dl className="epc-facts">
            <dt>Address</dt>
            <dd>{current.address || "—"}</dd>
            <dt>Floor area</dt>
            <dd>{current.floorAreaM2 ? `${current.floorAreaM2.toLocaleString()} m²` : "—"}</dd>
            <dt>Inspected</dt>
            <dd>{current.inspectionDate ?? "—"}</dd>
            {current.assetRating !== null && (
              <>
                <dt>Asset rating</dt>
                <dd>{current.assetRating}</dd>
              </>
            )}
          </dl>
          <p className={current.uprnSource === "address_matched" ? "epc-note" : "epc-warn"}>
            {UPRN_SOURCE_COPY[current.uprnSource]}
          </p>
        </div>
      )}

      {certificates.length > 1 && (
        <p className="epc-note">
          {certificates.length} certificates in this postcode
          {fromCache ? " (from cache)" : ""}.
        </p>
      )}
    </section>
  );
}

interface PerformanceReport {
  certificate: EpcCertificate | null;
  rating: RatingReading | null;
  age: CertificateAge | null;
  intensity: Intensity | null;
  mees: MeesScreening;
  considered: number;
  unavailable: string | null;
}

/** States that mean the band itself is a problem, for emphasis only. */
const MEES_ALERT = new Set(["below_minimum", "certificate_expired"]);

/**
 * S-05 performance and MEES screening.
 *
 * The order here is the argument: the finding, then what to go and check, then
 * the numbers, then the flags, then the caveats. The caveats are last but they
 * are not optional - each one names something the screening does not know, and
 * the first of them says this is not a compliance determination. A reader who
 * takes the band and stops has still been told the band is a screening flag.
 */
function PerformancePanel({ report }: { report: PerformanceReport }) {
  const { mees, rating, age, intensity, certificate } = report;
  const alert = MEES_ALERT.has(mees.state);

  return (
    <section className="perf">
      <p className="eyebrow">Building performance &amp; MEES</p>

      <div className={`perf-finding ${alert ? "alert" : ""}`}>
        <p className="perf-label">{mees.label}</p>
        <p className="perf-text">{mees.finding}</p>
        <p className="perf-check">{mees.check}</p>
      </div>

      {!mees.approved && (
        <p className="perf-unapproved">
          This wording concerns a legal duty and has not been signed off yet.
        </p>
      )}

      {mees.band && (
        <dl className="perf-facts">
          <dt>Band</dt>
          <dd>
            <span className={`epc-band band-${mees.band.toLowerCase().replace("+", "plus")}`}>
              {mees.band}
            </span>
            {mees.score !== null ? ` · BER ${mees.score}` : ""}
          </dd>

          <dt>To the minimum in force</dt>
          <dd>
            {mees.bandsToMinimum === 0
              ? "at or above it"
              : `${mees.bandsToMinimum} band${mees.bandsToMinimum === 1 ? "" : "s"}` +
                (mees.scorePointsToMinimum ? ` · ${mees.scorePointsToMinimum} BER points` : "")}
          </dd>

          <dt>To the proposed 2031 target</dt>
          <dd>
            {mees.bandsToTarget === 0
              ? "at or above it"
              : `${mees.bandsToTarget} band${mees.bandsToTarget === 1 ? "" : "s"}` +
                (mees.scorePointsToTarget ? ` · ${mees.scorePointsToTarget} BER points` : "")}
          </dd>

          <dt>Floor area used</dt>
          <dd>
            {mees.areaM2 ? `${mees.areaM2.toLocaleString()} m²` : "—"}
            {mees.areaSource ? <span className="perf-src"> {mees.areaSource}</span> : null}
          </dd>

          {certificate?.mainFuel && (
            <>
              <dt>Main heating fuel</dt>
              <dd>{certificate.mainFuel}</dd>
            </>
          )}

          {intensity?.primaryEnergyKwhM2 !== null && intensity !== null && (
            <>
              <dt>Primary energy</dt>
              <dd>{intensity.primaryEnergyKwhM2?.toLocaleString()} kWh/m²/yr</dd>
            </>
          )}

          {intensity?.againstNotionalPct !== null && intensity !== null && (
            <>
              <dt>Against the notional building</dt>
              <dd>{intensity.againstNotionalPct}%</dd>
            </>
          )}

          {age?.expiresOn && (
            <>
              <dt>Certificate expires</dt>
              <dd className={age.validity === "expired" ? "perf-expired" : undefined}>
                {age.expiresOn}
                {age.validity === "expired" ? " — expired" : ""}
              </dd>
            </>
          )}
        </dl>
      )}

      {/* Stated for the PV workstream, and stated as the narrow claim it is. */}
      {mees.band && !mees.pvCanMoveBand && (
        <p className="perf-pv">
          Rooftop PV will not move this band — but that is a statement about the
          rating, not about the roof.
        </p>
      )}

      {rating?.disagreement && <p className="perf-warn">{rating.disagreement}</p>}

      {mees.flags.length > 0 && (
        <ul className="perf-flags">
          {mees.flags.map((f) => (
            <li key={f.key}>
              <strong>{f.label}</strong> {f.finding} <em>{f.check}</em>
            </li>
          ))}
        </ul>
      )}

      <details className="perf-caveats">
        <summary>What this screening does not know ({mees.caveats.length})</summary>
        <ul>
          {mees.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * S-03 grid capacity. Brief §5.4 step 4 and §5.5.
 *
 * The fixed caveat is rendered LAST and unconditionally, because it is the
 * sentence that makes every figure above it safe to read: indicative, not a
 * connection offer. It is not collapsible and not optional.
 *
 * `unrated` is shown as its own state with its own explanation. A screen with
 * no input is not a pass, and greying it out or hiding it would let a reader
 * infer one.
 */
function GridPanel({ report }: { report: GridProfile }) {
  const { dno, substations, ecr, ecrState, screens } = report;
  const stale = substations.substations.some((s) => s.freshness.stale);

  return (
    <section className="grid-panel">
      <p className="eyebrow">Grid capacity</p>

      <dl className="grid-facts">
        <dt>DNO</dt>
        <dd>
          {dno.areaName ?? "Not determined"}
          <span className="grid-method">{dno.method}</span>
        </dd>
      </dl>

      {substations.proximityNote && (
        <p className="grid-proximity">{substations.proximityNote}</p>
      )}

      {stale && (
        <p className="grid-stale">
          {substations.substations.find((s) => s.freshness.warning)?.freshness.warning}
        </p>
      )}

      {substations.substations.length > 0 ? (
        <ul className="grid-subs">
          {substations.substations.map((s) => (
            <li key={s.id}>
              <p className="grid-sub-head">
                <span className="grid-sub-name">{s.name ?? s.sourceRef}</span>
                {s.level && (
                  <span className="grid-sub-level">
                    {s.level}
                    {s.levelSource === "derived_from_voltage" && (
                      <em title="Inferred from voltage, not stated by the DNO"> inferred</em>
                    )}
                  </span>
                )}
                {s.distanceM !== null && (
                  <span className="grid-sub-dist">{(s.distanceM / 1000).toFixed(1)} km</span>
                )}
              </p>
              <p className="grid-sub-meta">
                <span className={`dot ${s.generationRag ?? "unknown"}`} />
                Generation {s.generationHeadroomMva ?? "—"} MVA
                {" · "}
                <span className={`dot ${s.demandRag ?? "unknown"}`} />
                Demand {s.demandHeadroomMva ?? "—"} MVA
                {!s.ragPublished && (
                  <em className="grid-ourband"> RAG is our screening band, not the DNO&rsquo;s</em>
                )}
              </p>
              {s.constraintNote && <p className="grid-constraint">{s.constraintNote}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="grid-none">{substations.proximityNote}</p>
      )}

      <div className="grid-screens">
        {screens.map((sc) => (
          <div key={sc.key} className={`grid-screen ${sc.result}`}>
            <p className="grid-screen-head">
              <span className={`dot ${sc.result === "unrated" ? "unknown" : sc.result}`} />
              {sc.key === "pv_export" ? "PV export" : "Electrification"}
              <span className="grid-screen-result">{sc.result}</span>
            </p>
            <p className="grid-screen-why">{sc.explanation}</p>
          </div>
        ))}
      </div>

      <div className="grid-ecr">
        <p className="grid-ecr-head">
          Embedded Capacity Register — within {ecr.radiusM / 1000} km, {ecr.minExportKw} kW export and above
        </p>
        {ecrState === "present" ? (
          <>
            <p className="grid-ecr-total">
              {ecr.entries.length} entr{ecr.entries.length === 1 ? "y" : "ies"},{" "}
              {ecr.totalExportMva} MVA export
            </p>
            <ul>
              {ecr.byTechnology.map((t) => (
                <li key={t.technology}>
                  {t.technology} — {t.count} × {t.exportMva} MVA
                </li>
              ))}
            </ul>
            <p className="grid-ecr-status">
              {ecr.byStatus.map((x) => `${x.status}: ${x.count}`).join(" · ")}
            </p>
          </>
        ) : (
          <p className="grid-none">
            {ecrState === "not_found_coverage_unknown"
              ? "No register data is loaded, so this is an absence of data rather than an absence of generation."
              : "The register is loaded and carries nothing matching within the radius."}
          </p>
        )}
      </div>

      <p className="grid-network-note">{report.networkVsSite}</p>

      {/* Brief §5.4 step 4. Unconditional, never collapsed. */}
      <p className="grid-caveat">{report.caveat}</p>

      {report.wordingUnapproved.length > 0 && (
        <p className="grid-unapproved">
          {report.wordingUnapproved.length} grid rule block(s) await sign-off.
        </p>
      )}
    </section>
  );
}

interface VoaReport {
  voa: VoaResult;
  useClass: UseClassInference | null;
  areas: AreaComparison;
}

/**
 * VOA assessment, floor area and inferred use class.
 *
 * Floor areas are shown per measurement basis and never combined: an energy
 * intensity in kWh/m² means something different depending on whether the
 * denominator is GIA, NIA or GEA, so the choice is the assessor's to make.
 */
function VoaPanel({ report }: { report: VoaReport }) {
  const { voa, useClass, areas } = report;
  const best = voa.candidates[0];

  return (
    <section className="voa">
      <p className="eyebrow">Floor area and use</p>

      {!best ? (
        <p className="voa-note">
          {voa.searchedPostcode
            ? `No VOA assessment matched ${voa.searchedPostcode} in the loaded rating list.`
            : "No postcode resolved for this site, so the rating list could not be searched."}
        </p>
      ) : (
        <>
          <div className={`voa-assessment ${best.quality}`}>
            <p className="voa-head">
              <span className="voa-uarn">UARN {best.assessment.uarn}</span>
              <span className="voa-quality">
                {best.quality === "postcode_and_address" ? "address match" : "postcode only"}
              </span>
            </p>
            {best.assessment.propertyAddress && (
              <p className="voa-addr">{best.assessment.propertyAddress}</p>
            )}
            <p className="voa-meta">
              {best.assessment.primaryDescription ?? "no description"}
              {best.assessment.rateableValue
                ? ` · RV £${best.assessment.rateableValue.toLocaleString()}`
                : ""}
            </p>
          </div>

          {useClass && (
            <div className="voa-useclass">
              <p className="voa-uc-head">
                Use class
                <span className="voa-uc-value">{useClass.useClass ?? "not determined"}</span>
              </p>
              {useClass.label && <p className="voa-uc-label">{useClass.label}</p>}
              <p className="voa-note">{useClass.note}</p>
            </div>
          )}
        </>
      )}

      {areas.estimates.length > 0 && (
        <div className="voa-areas">
          <p className="voa-areas-head">Floor area</p>
          <ul>
            {areas.estimates.map((estimate) => (
              <li key={`${estimate.source}-${estimate.basis}`}>
                <span className="voa-area-value">
                  {estimate.areaM2.toLocaleString()} m²
                </span>
                <span className="voa-area-basis">{AREA_BASIS_LABEL[estimate.basis]}</span>
                <span className="voa-area-source">{estimate.source}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {areas.note && (
        <p className={areas.flags.includes("floor_area_check") ? "voa-diverge" : "voa-note"}>
          {areas.note}
        </p>
      )}

      {best && <p className="voa-caveat">{voa.note}</p>}
    </section>
  );
}

interface OwnershipReport {
  ownership: OwnershipResult;
  companies: Record<string, CompanyRecord>;
  companiesUnavailable: string | null;
}

/**
 * Corporate ownership. Every candidate is a lead matched on address, never a
 * confirmed owner, so the wording and the ordering both say so.
 */
function OwnershipList({ report }: { report: OwnershipReport }) {
  const { ownership, companies, companiesUnavailable } = report;

  return (
    <section className="ownership">
      <p className="eyebrow">Corporate ownership</p>

      {ownership.candidates.length === 0 ? (
        <p className="own-note">
          {ownership.searchedPostcode
            ? `No corporate title matched ${ownership.searchedPostcode}. That does not mean the site is not company-owned — only that no match was found in the loaded data.`
            : "No postcode resolved for this site, so ownership could not be searched."}
        </p>
      ) : (
        ownership.candidates.slice(0, 5).map((candidate) => {
          const t = candidate.title;
          return (
            <div key={t.titleNumber} className={`own-title ${candidate.quality}`}>
              <p className="own-head">
                <span className="own-number">{t.titleNumber}</span>
                <span className="own-quality">
                  {candidate.quality === "postcode_and_address" ? "address match" : "postcode only"}
                </span>
              </p>
              {t.propertyAddress && <p className="own-addr">{t.propertyAddress}</p>}
              <p className="own-meta">
                {t.tenure ?? "tenure unknown"}
                {t.dataset === "ocod" ? " · overseas-owned" : ""}
                {t.multipleAddress ? " · covers several addresses" : ""}
              </p>

              {t.proprietors.map((proprietor) => {
                const record = proprietor.companyNumber
                  ? companies[proprietor.companyNumber.toUpperCase().padStart(8, "0")]
                  : undefined;
                return (
                  <div key={proprietor.name} className="own-prop">
                    <p className="own-prop-name">{proprietor.name}</p>
                    <p className="own-prop-meta">
                      {proprietor.companyNumber ?? "no company number"}
                      {proprietor.countryIncorporated ? ` · ${proprietor.countryIncorporated}` : ""}
                      {record?.profile?.status ? ` · ${record.profile.status}` : ""}
                    </p>
                    {record?.profile?.inactive && (
                      <p className="own-warn">
                        This company is not active at Companies House.
                      </p>
                    )}
                    {record && record.psc.filter((p) => !p.ceasedOn).length > 0 && (
                      <p className="own-psc">
                        Controlled by{" "}
                        {record.psc.filter((p) => !p.ceasedOn).map((p) => p.name).join(", ")}
                      </p>
                    )}
                    {record?.unavailable && <p className="own-note">{record.unavailable}</p>}
                  </div>
                );
              })}

              <ul className="own-reasons">
                {candidate.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          );
        })
      )}

      {companiesUnavailable && <p className="own-note">{companiesUnavailable}</p>}

      <p className="own-caveat">{ownership.note}</p>
    </section>
  );
}

/** Constraints found on or near the site. Absences are stated, never implied. */
function ConstraintList({ screening }: { screening: ConstraintScreening }) {
  const found = screening.constraints.filter(
    (c) => c.state === "present" || c.state === "proximity",
  );
  const unchecked = screening.constraints.filter(
    (c) => c.state === "not_found_coverage_unknown" || c.state === "source_error",
  );
  const unsupported = screening.constraints.filter((c) => c.state === "not_supported");

  return (
    <section className="constraints">
      <p className="eyebrow">Planning and environmental</p>

      {screening.unsupportedReason && (
        <p className="constraint-note">{screening.unsupportedReason}</p>
      )}

      {screening.flags.includes("source_conflict") && (
        <p className="constraint-conflict">
          Sources disagree on flood risk. Both readings are shown below; treat it as
          unresolved until checked directly.
        </p>
      )}

      {found.map((c) => (
        <div key={c.dataset} className={`constraint ${c.state}`}>
          <p className="constraint-label">
            {c.label}
            <span className="constraint-state">
              {c.state === "present" ? "on site" : `within ${screening.bufferM} m`}
            </span>
          </p>
          {c.message && <p className="constraint-msg">{c.message}</p>}
          {c.check && <p className="constraint-check">{c.check}</p>}
          {c.entities.length > 0 && (
            <p className="constraint-refs">
              {c.entities.slice(0, 4).map((e) => e.name ?? e.reference).filter(Boolean).join(", ")}
            </p>
          )}
        </div>
      ))}

      {found.length === 0 && unsupported.length === 0 && (
        <p className="constraint-note">
          Nothing was found on or within {screening.bufferM} m of this site. That is not
          the same as there being nothing: see the unconfirmed list below.
        </p>
      )}

      {unsupported.length > 0 && (
        <p className="constraint-note">
          {unsupported.length} datasets not screened — outside England.
        </p>
      )}

      {unchecked.length > 0 && (
        <details className="constraint-unchecked">
          <summary>{unchecked.length} not confirmed</summary>
          <p>
            Nothing was returned for these, but coverage could not be confirmed, so
            absence is not established.
          </p>
          <ul>
            {unchecked.map((c) => (
              <li key={c.dataset}>
                {c.label}
                {c.state === "source_error" ? " — source unavailable" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="constraint-caveat">
        Screening flags for review by a qualified person. Not a planning
        determination, and not a statement that consent is or is not required.
      </p>
    </section>
  );
}

export default function SitePanel({ mapApi }: Props) {
  const [queryText, setQueryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [step, setStep] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [profile, setProfile] = useState<SiteProfile | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [screening, setScreening] = useState<ConstraintScreening | null>(null);
  const [ownership, setOwnership] = useState<OwnershipReport | null>(null);
  const [voa, setVoa] = useState<VoaReport | null>(null);
  const [epc, setEpc] = useState<EpcReport | null>(null);
  const [performance, setPerformance] = useState<PerformanceReport | null>(null);
  const [grid, setGrid] = useState<GridProfile | null>(null);

  const reset = useCallback(() => {
    setCandidates([]);
    setSelected(null);
    setProfile(null);
    setConfirmed(false);
    setScreening(null);
    setOwnership(null);
    setVoa(null);
    setEpc(null);
    // Must be cleared with the rest: a MEES screening left on screen after a
    // new search would attach a finding about a legal duty to the wrong
    // building.
    setPerformance(null);
    setGrid(null);
    setStep(null);
    mapApi.clearSite();
  }, [mapApi]);

  const search = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const text = queryText.trim();
      if (!text) return;

      setBusy(true);
      setError(null);
      reset();

      // A bare UPRN is all digits; anything else goes in as an address, and the
      // API pulls a postcode out of it if there is one.
      const param = /^\d{6,12}$/.test(text) ? "uprn" : "address";
      try {
        const res = await fetch(
          `/api/site-intel/profile?${param}=${encodeURIComponent(text)}&candidates=1`,
        );
        const data = (await res.json()) as {
          candidates?: Candidate[];
          step?: string;
          reason?: string | null;
          error?: string;
        };
        if (data.error) {
          setError(data.error);
        } else if (!data.candidates?.length) {
          setError(data.reason ?? "No building matched that search");
        } else {
          setCandidates(data.candidates);
          setStep(data.step ?? null);
          if (data.candidates.length === 1) void choose(data.candidates[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setBusy(false);
      }
    },
    // `choose` is defined below and stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryText, reset],
  );

  const choose = useCallback(
    async (candidate: Candidate) => {
      setSelected(candidate);
      setConfirmed(false);
      setScreening(null);
      setOwnership(null);
      setVoa(null);
      setEpc(null);
      setPerformance(null);
      setGrid(null);
      mapApi.showConstraints(null);
      mapApi.showSite(candidate.lat, candidate.lon);

      if (!candidate.uprn) {
        setProfile(null);
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/site-intel/profile?uprn=${encodeURIComponent(candidate.uprn)}&constraints=1`,
        );
        const data = (await res.json()) as {
          profile?: SiteProfile;
          constraints?: ConstraintScreening | null;
          error?: string;
        };
        if (data.profile) {
          setProfile(data.profile);
          setScreening(data.constraints ?? null);
          mapApi.showGeometry(data.profile);
          mapApi.showConstraints(data.constraints ?? null);

          // Ownership is a separate call: it can be slow (Companies House per
          // proprietor) and the profile should not wait on it.
          void fetch(`/api/site-intel/ownership?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((own: OwnershipReport & { error?: string }) => {
              if (!own.error) setOwnership(own);
            })
            .catch(() => undefined);

          void fetch(`/api/site-intel/epc?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((report: EpcReport & { error?: string }) => {
              if (!report.error) setEpc(report);
            })
            .catch(() => undefined);

          void fetch(`/api/site-intel/grid?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((report: GridProfile & { error?: string }) => {
              if (!report.error) setGrid(report);
            })
            .catch(() => undefined);

          void fetch(`/api/site-intel/performance?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((report: PerformanceReport & { error?: string }) => {
              if (!report.error) setPerformance(report);
            })
            .catch(() => undefined);

          void fetch(`/api/site-intel/voa?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((report: VoaReport & { error?: string }) => {
              if (!report.error) setVoa(report);
            })
            .catch(() => undefined);
        } else if (data.error) {
          setError(data.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not build the profile");
      } finally {
        setBusy(false);
      }
    },
    [mapApi],
  );

  const confirm = useCallback(async () => {
    if (!selected?.uprn) return;
    const buildingId = `UPRN-${selected.uprn}`;
    setBusy(true);
    try {
      await fetch("/api/site-intel/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buildingId, uprn: selected.uprn }),
      });
      const res = await fetch("/api/site-intel/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buildingId, confirmed: true }),
      });
      const data = (await res.json()) as { profile?: SiteProfile; error?: string };
      if (data.profile) {
        setProfile(data.profile);
        setConfirmed(true);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the confirmation");
    } finally {
      setBusy(false);
    }
  }, [selected]);

  return (
    <section className="site">
      <form className="site-search" onSubmit={search}>
        <label htmlFor="site-query" className="eyebrow">
          Find a building
        </label>
        <div className="site-row">
          <input
            id="site-query"
            type="text"
            value={queryText}
            placeholder="Address, postcode or UPRN"
            onChange={(e) => setQueryText(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" disabled={busy || !queryText.trim()}>
            {busy ? "…" : "Find"}
          </button>
        </div>
      </form>

      {error && <p className="site-error">{error}</p>}

      {candidates.length > 1 && !selected && (
        <div className="site-card">
          <p className="site-q">Which building?</p>
          <p className="site-help">
            {candidates.length} matches{step ? ` via ${step}` : ""}. Pick one to see its profile.
          </p>
          <ul className="site-candidates">
            {candidates.slice(0, 12).map((c) => (
              <li key={`${c.uprn ?? "none"}-${c.lat}-${c.lon}`}>
                <button type="button" onClick={() => void choose(c)}>
                  <span className="uprn">{c.uprn ?? "No UPRN"}</span>
                  <span className="dist">
                    {c.address ?? c.postcode ?? ""}
                    {c.distanceM !== null ? ` · ${c.distanceM} m` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected && (
        <div className="site-card">
          <p className="site-q">{confirmed ? "Building confirmed" : "Is this the building?"}</p>
          <p className="site-help">
            {CONFIDENCE_COPY[selected.confidence]}
            <br />
            <span className="site-method">{selected.source.method}</span>
          </p>

          <dl className="site-facts">
            <dt>UPRN</dt>
            <dd>{selected.uprn ?? "—"}</dd>
            <dt>Address</dt>
            <dd>{profile?.address ?? selected.address ?? "—"}</dd>
            <dt>Postcode</dt>
            <dd>{profile?.postcode ?? selected.postcode ?? "—"}</dd>
            <dt>Planning authority</dt>
            <dd>{profile?.lpaName ?? "—"}</dd>
            <dt>Title extents</dt>
            <dd>
              {profile?.states["title-boundary"] === "present"
                ? profile.titleExtents.length
                : // A count of 0 would read as "there are none", which is not
                  // what an unavailable or incomplete source tells us.
                  "—"}
            </dd>
            <dt>Footprint</dt>
            <dd>
              {profile?.footprint.areaM2
                ? `${profile.footprint.areaM2.toLocaleString()} m²`
                : profile?.footprint.method === "unavailable"
                  ? "unavailable"
                  : "—"}
            </dd>
          </dl>

          {profile && Object.keys(profile.states).length > 0 && (
            <ul className="site-states">
              {Object.entries(profile.states).map(([dataset, state]) => (
                <li key={dataset} className={state.startsWith("not_found") || state === "source_error" ? "warn" : ""}>
                  <span>{dataset}</span>
                  <span>{STATE_COPY[state] ?? state}</span>
                </li>
              ))}
            </ul>
          )}

          {profile && profile.flags.length > 0 && (
            <p className="site-flags">{profile.flags.join(" · ")}</p>
          )}

          {screening && <ConstraintList screening={screening} />}

          {epc && <EpcPanel report={epc} />}

          {performance && <PerformancePanel report={performance} />}

          {grid && <GridPanel report={grid} />}

          {voa && <VoaPanel report={voa} />}

          {ownership && <OwnershipList report={ownership} />}

          <div className="site-actions">
            {!confirmed && selected.uprn && (
              <button type="button" className="primary" onClick={() => void confirm()} disabled={busy}>
                Confirm
              </button>
            )}
            <button type="button" onClick={() => { setSelected(null); setProfile(null); mapApi.clearSite(); }}>
              {candidates.length > 1 ? "Back to matches" : "Clear"}
            </button>
          </div>

          {profile && profile.sources.length > 0 && (
            <details className="site-lineage">
              <summary>Sources ({profile.sources.length})</summary>
              <ul>
                {profile.sources.map((s, i) => (
                  <li key={`${s.sourceId}-${i}`}>
                    <strong>{s.dataset}</strong> · {TIER_LABEL[s.tier]}
                    <br />
                    <span>{s.method}</span>
                    <br />
                    <span className="attrib">{s.attribution}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
