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
import { TIER_LABEL, buildingIdFor } from "@/lib/site-intel/types";

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
  /** S-03 layers: supply area, the substations screened against, ECR points. */
  showGrid(grid: GridProfile | null): void;

  /**
   * Move pin (brief §3.4, resolution step (e)). One-shot: the next map click
   * reports where the user pointed, and the panel resolves that to the nearest
   * OS Open UPRN. The click itself is never stored.
   */
  startPick(handler: (lat: number, lon: number) => void): void;
  cancelPick(): void;

  /* Redraw (brief §3.2, §3.4). */
  startDraw(onChange: (count: number) => void): void;
  /** Seeds the editor from an existing shape. False when there is none. */
  startEdit(geometry: GeoJSON.Geometry | null, onChange: (count: number) => void): boolean;
  undoDrawPoint(): void;
  cancelDraw(): void;
  /** Closes the ring. Null below three points, which is not an area. */
  finishDraw(): GeoJSON.Polygon | null;
  /** Snap new and dragged vertices to nearby corners and walls. */
  setSnap(on: boolean): void;
  /**
   * Pull walls square or parallel to the shape's other walls. SEPARATE from
   * snapping: that aligns the shape to published data, this to an assumption
   * about buildings.
   */
  setSquare(on: boolean): void;
  /** Neighbouring polygons: context to draw against, and snap targets. */
  showNeighbours(buildings: { geometry: GeoJSON.Geometry; label: string }[]): void;

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
  /* Redraw. `drawPoints` is null when not drawing, a count when drawing. */
  const [drawPoints, setDrawPoints] = useState<number | null>(null);
  /*
   * Which of the two modes is running. They accept different gestures — a
   * click on open map places a corner in a fresh drawing and does nothing to
   * an existing ring — so the hint has to tell the user which one they are in.
   */
  const [editing, setEditing] = useState(false);
  /* True between pressing Move pin and the next map click. */
  const [picking, setPicking] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [squareOn, setSquareOn] = useState(true);
  /*
   * Null until asked for. Both halves matter: with nothing to snap to, the
   * reason is either "no buildings near this site" or "no building polygons
   * loaded at all", and those call for different things from the user.
   */
  const [neighbours, setNeighbours] = useState<{ nearby: number; loaded: number } | null>(null);
  /*
   * Set when the footprint changed after the constraints were screened. The
   * screening ran against the OLD shape, so the panel must say so rather than
   * show results that no longer describe what is on the map.
   */
  const [constraintsStale, setConstraintsStale] = useState(false);

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
    setDrawPoints(null);
    setEditing(false);
    setPicking(false);
    setNeighbours(null);
    setConstraintsStale(false);
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
      setDrawPoints(null);
      setConstraintsStale(false);
      mapApi.showConstraints(null);
      mapApi.showGrid(null);
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

          // Context to draw against, and the corners snapping needs.
          void fetch(
            `/api/site-intel/buildings?lat=${data.profile.lat}&lng=${data.profile.lon}`,
          )
            .then((r) => r.json())
            .then((body: {
              buildings?: { sourceRef: string | null; geometry: GeoJSON.Geometry }[];
              loadedTotal?: number;
              error?: string;
            }) => {
              if (body.error || !body.buildings) return;
              setNeighbours({
                nearby: body.buildings.length,
                loaded: body.loadedTotal ?? 0,
              });
              mapApi.showNeighbours(
                body.buildings.map((b) => ({
                  geometry: b.geometry,
                  label: b.sourceRef ?? "Nearby building",
                })),
              );
            })
            .catch(() => undefined);

          void fetch(`/api/site-intel/grid?uprn=${encodeURIComponent(candidate.uprn)}`)
            .then((r) => r.json())
            .then((report: GridProfile & { error?: string }) => {
              if (report.error) return;
              setGrid(report);
              mapApi.showGrid(report);
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

  /**
   * Resolves a map click to a building, per resolution step (e).
   *
   * The click is a POINTER. What gets stored is the nearest OS Open UPRN
   * within 25 m, so the profile's coordinate always agrees with its UPRN.
   * Beyond that radius nothing is changed and the reason is shown — silently
   * keeping the old pin would leave the user thinking the move worked, and
   * storing the raw click would put a coordinate on the profile that no
   * register published.
   */
  const pickAt = useCallback(
    async (lat: number, lon: number) => {
      setPicking(false);
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/site-intel/profile?lat=${lat}&lon=${lon}&candidates=1`,
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
          setError(data.reason ?? "No building matched that point");
        } else {
          // A different UPRN is a DIFFERENT BUILDING, so everything hanging off
          // the old one - constraints, EPC, ownership, VOA, grid - has to go.
          // `choose` already resets all of it.
          reset();
          setCandidates(data.candidates);
          setStep(data.step ?? null);
          if (data.candidates.length === 1) void choose(data.candidates[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not resolve that point");
      } finally {
        setBusy(false);
      }
    },
    [choose, reset],
  );

  /** PATCHes a footprint override, or reverts one, then refreshes the profile. */
  const patchFootprint = useCallback(
    async (body: Record<string, unknown>) => {
      const buildingId = selected?.uprn ? buildingIdFor(selected.uprn) : null;
      if (!buildingId) {
        setError("This site has no UPRN, so there is nothing to save the drawing against.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // The profile has to exist before it can be overridden. POST is
        // idempotent on building id, so this is safe whether or not the user
        // has pressed Confirm.
        await fetch("/api/site-intel/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ buildingId, uprn: selected?.uprn }),
        });
        const res = await fetch("/api/site-intel/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ buildingId, ...body }),
        });
        const data = (await res.json()) as { profile?: SiteProfile; error?: string };
        if (data.profile) {
          setProfile(data.profile);
          mapApi.showGeometry(data.profile);
          // Everything derived from the footprint was computed against the
          // previous shape. Say so; do not silently re-run, because a redraw
          // is often followed by another.
          setConstraintsStale(true);
        } else if (data.error) {
          setError(data.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the footprint");
      } finally {
        setBusy(false);
      }
    },
    [selected, mapApi],
  );

  /** Re-runs S-02 against the footprint now in force. */
  const rescreen = useCallback(async () => {
    if (!selected?.uprn) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/site-intel/profile?building_id=${encodeURIComponent(buildingIdFor(selected.uprn))}&constraints=1`,
      );
      const data = (await res.json()) as { constraints?: ConstraintScreening; error?: string };
      if (data.constraints) {
        setScreening(data.constraints);
        mapApi.showConstraints(data.constraints);
        setConstraintsStale(false);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not re-screen");
    } finally {
      setBusy(false);
    }
  }, [selected, mapApi]);

  const confirm = useCallback(async () => {
    if (!selected?.uprn) return;
    const buildingId = buildingIdFor(selected.uprn);
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
              {/*
                * A user drawing is a T4 override, not source data, and the
                * area it produces feeds the constraint screen. Label it on the
                * figure itself rather than only in the lineage list.
                */}
              {profile?.footprint.method === "user_drawn" && (
                <span className="fp-drawn">your drawing</span>
              )}
            </dd>
          </dl>

          {profile?.footprintOriginal && (
            <div className="fp-override">
              <p className="fp-override-head">Footprint overridden</p>
              <p>
                You redrew this footprint. The published polygon —{" "}
                {profile.footprintOriginal.areaM2
                  ? `${profile.footprintOriginal.areaM2.toLocaleString()} m²`
                  : "no area"}{" "}
                from <code>{profile.footprintOriginal.method.replace(/_/g, " ")}</code> — is kept
                and can be restored. Redrawing again replaces your shape, never the original.
              </p>
              {profile.footprint.areaM2 !== null &&
                profile.footprintOriginal.areaM2 !== null && (
                  <p className="fp-delta">
                    Your shape is{" "}
                    {Math.abs(
                      Math.round(
                        ((profile.footprint.areaM2 - profile.footprintOriginal.areaM2) /
                          profile.footprintOriginal.areaM2) * 100,
                      ),
                    )}
                    % {profile.footprint.areaM2 >= profile.footprintOriginal.areaM2 ? "larger" : "smaller"}.
                    Anything computed from floor area uses this figure now.
                  </p>
                )}
            </div>
          )}

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

          {/*
            * Screened against a footprint that has since changed. Showing the
            * results without saying so would attach findings for one shape to
            * a different one on the map.
            */}
          {constraintsStale && screening && (
            <div className="fp-stale">
              <p>
                The footprint changed after these constraints were screened, so they
                describe the <strong>previous</strong> shape.
              </p>
              <button type="button" onClick={() => void rescreen()} disabled={busy}>
                Re-screen against the current footprint
              </button>
            </div>
          )}

          {screening && <ConstraintList screening={screening} />}

          {epc && <EpcPanel report={epc} />}

          {performance && <PerformancePanel report={performance} />}

          {grid && <GridPanel report={grid} />}

          {voa && <VoaPanel report={voa} />}

          {ownership && <OwnershipList report={ownership} />}

          {picking && (
            <p className="site-hint">
              Click the building on the map. The pin moves to the nearest OS Open
              UPRN within 25 m — the click itself is not stored, and beyond 25 m
              nothing changes.
            </p>
          )}

          {drawPoints !== null && (
            <div className="site-hint">
              <p>
                {drawPoints} point{drawPoints === 1 ? "" : "s"}.{" "}
                {editing
                  ? "Drag a solid handle to move that corner, or a wall to move the whole "
                    + "side; click a hollow handle to add a corner"
                  : "Click the map to place a corner, or drag a solid handle to move one"}
                , alt- or shift-click a solid one to remove it
                {drawPoints < 3 ? " — three is the minimum for an area." : "."}
              </p>
              <label className="site-snap">
                <input
                  type="checkbox"
                  checked={snapOn}
                  onChange={(e) => { setSnapOn(e.target.checked); mapApi.setSnap(e.target.checked); }}
                />
                Snap to nearby corners and walls
                {neighbours?.nearby === 0 &&
                  (neighbours.loaded === 0
                    ? " — no building polygons are loaded, so nothing to snap to"
                    : " — none within 150 m of this site, so nothing to snap to")}
              </label>
              <label className="site-snap">
                <input
                  type="checkbox"
                  checked={squareOn}
                  onChange={(e) => { setSquareOn(e.target.checked); mapApi.setSquare(e.target.checked); }}
                />
                Keep walls square and parallel
              </label>
              <p className="site-snap-note">
                A snapped corner takes the neighbour&rsquo;s exact coordinate, and a
                snapped wall puts the point exactly on it — which is how a party wall
                ends up agreeing with the building next door. That does not make the
                shape source data — it is still your drawing.
              </p>
              <p className="site-snap-note">
                An aligned wall is different again: nothing published says it is square
                to the wall beside it or parallel to the one opposite, only that
                buildings usually are. Amber marks it for that reason — blue is data,
                amber is our assumption — and the wall it was lined up with is lit
                too, so you can see what to.
                {drawPoints === 3 &&
                  " At three points a corner cannot be removed: it would leave no area."}
              </p>
            </div>
          )}

          <div className="site-actions">
            {!confirmed && selected.uprn && drawPoints === null && (
              <button type="button" className="primary" onClick={() => void confirm()} disabled={busy}>
                Confirm
              </button>
            )}

            {/* Brief §3.4 asks for Move pin and Redraw beside Confirm. */}
            {drawPoints === null && (
              picking ? (
                <button
                  type="button"
                  onClick={() => { mapApi.cancelPick(); setPicking(false); }}
                >
                  Cancel move
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setPicking(true); mapApi.startPick(pickAt); }}
                >
                  Move pin
                </button>
              )
            )}

            {drawPoints === null ? (
              <>
                {/*
                  * Editing the existing shape is the common correction - the
                  * published polygon is right except for one corner - so it
                  * comes first. It produces the same T4 override, because a
                  * footprint with a moved corner is not what OS published.
                  */}
                {profile?.footprint.geometry && (
                  <button
                    type="button"
                    onClick={() => {
                      setPicking(false);
                      const ok = mapApi.startEdit(
                        profile.footprint.geometry,
                        setDrawPoints,
                      );
                      if (!ok) setError("That footprint has no editable outline.");
                      setEditing(ok);
                    }}
                    disabled={busy || !selected.uprn || picking}
                  >
                    Edit shape
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setPicking(false);
                    setEditing(false);
                    mapApi.startDraw(setDrawPoints);
                  }}
                  disabled={busy || !selected.uprn || picking}
                  title={selected.uprn ? undefined : "A drawing needs a UPRN to be saved against"}
                >
                  Redraw footprint
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || drawPoints < 3}
                  onClick={() => {
                    const polygon = mapApi.finishDraw();
                    setDrawPoints(null);
                    setEditing(false);
                    if (polygon) void patchFootprint({ footprint: polygon });
                  }}
                >
                  Save shape
                </button>
                {/*
                  * Undo belongs to a drawing being built up. In edit mode
                  * there is nothing of the user's to undo, and the button
                  * would chop a corner off the published ring under a label
                  * that says otherwise. Removal there is alt- or shift-click,
                  * which names the corner it takes.
                  */}
                {!editing && (
                  <button
                    type="button"
                    disabled={busy || drawPoints === 0}
                    onClick={() => mapApi.undoDrawPoint()}
                  >
                    Undo point
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    mapApi.cancelDraw();
                    setDrawPoints(null);
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </>
            )}

            {profile?.footprintOriginal && drawPoints === null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patchFootprint({ revertFootprint: true })}
              >
                Revert to published
              </button>
            )}

            <button type="button" onClick={() => {
              mapApi.cancelDraw();
              mapApi.cancelPick();
              setDrawPoints(null);
              setEditing(false);
              setPicking(false);
              setSelected(null);
              setProfile(null);
              mapApi.clearSite();
            }}>
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
