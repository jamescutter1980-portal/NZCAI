/**
 * S-05: MEES screening.
 *
 * Brief section 0 rule 4 - flags, not decisions. That rule is load-bearing
 * here in a way it is not elsewhere, because MEES is law and a wrong flag is
 * not a wrong guess, it is wrong advice about a legal duty. Three
 * consequences, all visible in the shape of this module:
 *
 * 1. NOTHING IS CALLED COMPLIANT OR NON-COMPLIANT. MEES binds a letting, not a
 *    building. Whether it bites depends on tenure, lease length and registered
 *    exemptions - none of which this system holds. So the states describe the
 *    band against the standard, and the wording is conditional.
 *
 * 2. THE PRS EXEMPTIONS REGISTER IS NOT A DATASET WE HAVE. A building below
 *    the minimum band with a registered exemption is lawfully let. Every
 *    below-minimum result says so, because a screening list that reads as an
 *    enforcement list would be worse than no list.
 *
 * 3. ALL THRESHOLDS AND WORDING COME FROM mees_rules.yaml, not from here, and
 *    every entry is `approved: false` until James signs it off. The policy
 *    changed on 18 June 2026 - the 2027 EPC C milestone was dropped and the
 *    EPC B target is 2031 for buildings over 1,000 m² only - and anything
 *    written from memory rather than from that file is likely to be wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import type { EpcCertificate } from "./epc";
import {
  type Band,
  type FuelClass,
  certificateAge,
  classifyFuel,
  parseBand,
  isAtLeast,
  bandGap,
  scoreGap,
  pvCanMoveRating,
  readRating,
} from "./performance";
import type { ResultState } from "./types";

/* ----------------------------------------------------------------- rules --- */

export interface MeesWording {
  label: string;
  finding: string;
  check: string;
  approved: boolean;
}

export interface MeesThresholds {
  minimum_band: { band: string; in_force_from: string; continuing_let_from: string; status: string; note: string };
  target_2031: { band: string; by: number; applies_above_m2: number; status: string; note: string };
  dropped_2027_c: { band: string; was: number; status: string; dropped_on: string; note: string };
  below_area_threshold: { note: string };
  area_margin_pct: number;
  high_primary_energy_kwh_m2: number;
  validity_years: number;
  expiring_soon_days: number;
}

/** Context only. Never a compliance threshold - see the YAML's caution. */
export interface MeesBenchmark {
  name: string;
  citation: string;
  at_or_above_e_pct: number;
  at_or_above_c_pct: number;
  at_or_above_b_pct: number;
  voluntary_target_b_by: number;
  caution: string;
  approved: boolean;
}

export interface MeesRules {
  meta: { jurisdiction: string; scope: string; policy_as_at: string; source: string; approved: boolean };
  thresholds: MeesThresholds;
  states: Record<string, MeesWording>;
  flags: Record<string, MeesWording>;
  benchmark: MeesBenchmark;
}

let cache: MeesRules | null = null;

export function loadMeesRules(): MeesRules {
  if (cache) return cache;
  const path = join(process.cwd(), "src", "lib", "site-intel", "mees_rules.yaml");
  const parsed = parse(readFileSync(path, "utf8")) as MeesRules;
  if (!parsed?.thresholds || !parsed.states) {
    throw new Error("mees_rules.yaml: missing `thresholds` or `states`");
  }
  cache = parsed;
  return cache;
}

/** Rule keys James has not signed off. Surfaced by `npm run site:verify`. */
export function unapprovedMeesRules(): string[] {
  const rules = loadMeesRules();
  const keys: string[] = [];
  if (!rules.meta.approved) keys.push("meta");
  for (const [key, wording] of Object.entries({ ...rules.states, ...rules.flags })) {
    if (!wording.approved) keys.push(key);
  }
  if (!rules.benchmark.approved) keys.push("benchmark");
  return keys;
}

/** Collapses YAML block-scalar whitespace and substitutes {placeholders}. */
export function render(text: string, values: Record<string, string | number>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out.replace(/\s+/g, " ").trim();
}

/* ---------------------------------------------------------------- result --- */

export type MeesStateKey =
  | "below_minimum"
  | "meets_minimum_below_2031_target"
  | "meets_minimum_no_further_target"
  | "meets_2031_target"
  | "area_indeterminate"
  | "certificate_expired"
  | "no_certificate_coverage_complete"
  | "no_certificate_coverage_unknown"
  | "not_supported_operational"
  | "not_supported_domestic";

export interface MeesFlag {
  key: string;
  label: string;
  finding: string;
  check: string;
  approved: boolean;
}

export interface MeesScreening {
  state: MeesStateKey;
  /** Maps onto the shared per-dataset outcome vocabulary. */
  resultState: ResultState;
  label: string;
  finding: string;
  check: string;
  /** False while the wording still needs James's sign-off. */
  approved: boolean;

  band: Band | null;
  score: number | null;
  fuel: FuelClass;
  /** The area used for the 1,000 m² test, and where it came from. */
  areaM2: number | null;
  areaSource: string | null;

  /**
   * Distance to the minimum band in force TODAY. This is the urgent number for
   * anything below it - a building at F has a letting problem now, and its
   * distance to the proposed 2031 target is the lesser question.
   */
  bandsToMinimum: number | null;
  scorePointsToMinimum: number | null;
  /** Whole bands from the current band to B. Null when there is no band. */
  bandsToTarget: number | null;
  /** BER points above the top of band B. The honest unit. Null when no score. */
  scorePointsToTarget: number | null;
  /**
   * Whether rooftop PV can move this building's band at all. False on a
   * gas-heated building, because the rating is a CO2 rate and PV displaces
   * electricity. This is about the BAND only - it is not a view on whether the
   * roof is a good PV site, which is a separate question.
   */
  pvCanMoveBand: boolean;

  flags: MeesFlag[];
  /**
   * Statements that must travel with the result. These are not caveats to be
   * trimmed - each one names something the screening does not know.
   */
  caveats: string[];
}

/** The area used for the threshold test, with its provenance. */
export interface AreaInput {
  m2: number;
  /** e.g. "EPC total floor area" or "VOA survey lines, GIA". */
  source: string;
}

const RESULT_STATE: Record<MeesStateKey, ResultState> = {
  below_minimum: "present",
  meets_minimum_below_2031_target: "present",
  meets_minimum_no_further_target: "present",
  meets_2031_target: "present",
  area_indeterminate: "present",
  certificate_expired: "present",
  no_certificate_coverage_complete: "not_found_coverage_complete",
  no_certificate_coverage_unknown: "not_found_coverage_unknown",
  not_supported_operational: "not_supported",
  not_supported_domestic: "not_supported",
};

function wording(
  rules: MeesRules,
  key: MeesStateKey,
  values: Record<string, string | number>,
): { label: string; finding: string; check: string; approved: boolean } {
  const entry = rules.states[key];
  if (!entry) throw new Error(`mees_rules.yaml: no wording for state "${key}"`);
  return {
    label: entry.label,
    finding: render(entry.finding, values),
    check: render(entry.check, values),
    approved: entry.approved,
  };
}

function flag(
  rules: MeesRules,
  key: string,
  values: Record<string, string | number> = {},
): MeesFlag {
  const entry = rules.flags[key];
  if (!entry) throw new Error(`mees_rules.yaml: no wording for flag "${key}"`);
  return {
    key,
    label: entry.label,
    finding: render(entry.finding, values),
    check: render(entry.check, values),
    approved: entry.approved,
  };
}

/**
 * The caveats that apply to every screening result, whatever it found.
 *
 * They are assembled here rather than written into each state's wording so
 * that none of them can be dropped by editing one entry.
 */
function standingCaveats(rules: MeesRules): string[] {
  const t = rules.thresholds;
  return [
    "This is a screening flag for review by a qualified person, not a compliance determination. " +
      "MEES applies to a letting, not to a building: whether it bites depends on tenure, lease length " +
      "and the terms of the lease, none of which are held here.",
    "The PRS Exemptions Register has not been consulted. A building below the minimum band may be " +
      "lawfully let under a registered exemption.",
    `The EPC ${t.target_2031.band} standard for ${t.target_2031.by} is proposed, not law. It applies to ` +
      `buildings over ${t.target_2031.applies_above_m2.toLocaleString()} m² and still requires secondary legislation.`,
    `There is no EPC ${t.dropped_2027_c.band} requirement: the ${t.dropped_2027_c.was} interim milestone was ` +
      `dropped on ${t.dropped_2027_c.dropped_on} and will not be taken forward.`,
    `Policy position as at ${rules.meta.policy_as_at}, ${rules.meta.jurisdiction}, ${rules.meta.scope} only.`,
  ];
}

/* --------------------------------------------------------------- screening --- */

export interface ScreenOptions {
  /** Area for the 1,000 m² test. Falls back to the certificate's floor area. */
  area?: AreaInput;
  /** Set when the register could not be consulted. */
  unavailable?: string | null;
  now?: Date;
}

/**
 * Screens the certificate that best describes a building.
 *
 * Pass `null` for the certificate when none was found - the result then
 * distinguishes "the register answered and there is none" from "the register
 * could not be reached", which is the difference between a finding and a gap.
 */
export function screenMees(
  certificate: EpcCertificate | null,
  options: ScreenOptions = {},
): MeesScreening {
  const rules = loadMeesRules();
  const t = rules.thresholds;
  const minimum = parseBand(t.minimum_band.band) ?? "E";
  const target = parseBand(t.target_2031.band) ?? "B";
  const caveats = standingCaveats(rules);

  const base = {
    band: null as Band | null,
    score: null as number | null,
    fuel: "unknown" as FuelClass,
    areaM2: options.area?.m2 ?? null,
    areaSource: options.area?.source ?? null,
    bandsToMinimum: null as number | null,
    scorePointsToMinimum: null as number | null,
    bandsToTarget: null as number | null,
    scorePointsToTarget: null as number | null,
    pvCanMoveBand: false,
    flags: [] as MeesFlag[],
    caveats,
  };

  /* -- nothing to screen ------------------------------------------------- */
  if (!certificate) {
    const key: MeesStateKey = options.unavailable
      ? "no_certificate_coverage_unknown"
      : "no_certificate_coverage_complete";
    return { state: key, resultState: RESULT_STATE[key], ...wording(rules, key, {}), ...base };
  }

  const rating = readRating(certificate);

  /* -- wrong kind of certificate ----------------------------------------- */
  // A DEC is a measured operational rating and a domestic EPC is a different
  // regime. Banding either against the non-domestic scale would be wrong, so
  // neither gets a band in the result.
  if (rating.kind !== "asset") {
    const key: MeesStateKey =
      rating.kind === "operational" ? "not_supported_operational" : "not_supported_domestic";
    return { state: key, resultState: RESULT_STATE[key], ...wording(rules, key, {}), ...base };
  }

  const fuel = classifyFuel(certificate.mainFuel);
  const age = certificateAge(certificate, options.now);
  const area = options.area ?? (
    certificate.floorAreaM2 !== null
      ? { m2: certificate.floorAreaM2, source: "EPC total floor area" }
      : null
  );

  const flags: MeesFlag[] = [];
  if (rating.disagreement) {
    const entry = flag(rules, "band_score_disagreement");
    flags.push({ ...entry, finding: rating.disagreement });
  }
  if (fuel === "gas") {
    flags.push(flag(rules, "gas_or_lpg_fuel", { fuel: certificate.mainFuel ?? "gas or LPG" }));
  }
  if (
    certificate.primaryEnergy !== null &&
    certificate.primaryEnergy > t.high_primary_energy_kwh_m2 &&
    (fuel === "gas" || fuel === "oil")
  ) {
    flags.push(
      flag(rules, "high_primary_energy", {
        value: certificate.primaryEnergy,
        fuel: certificate.mainFuel ?? fuel,
        threshold: t.high_primary_energy_kwh_m2,
      }),
    );
  }
  if (age.validity === "valid" && age.daysRemaining !== null && age.daysRemaining <= t.expiring_soon_days) {
    flags.push(
      flag(rules, "expiring_soon", { expires: age.expiresOn ?? "unknown", days: t.expiring_soon_days }),
    );
  }

  const common = {
    band: rating.band,
    score: rating.score,
    fuel,
    areaM2: area?.m2 ?? null,
    areaSource: area?.source ?? null,
    bandsToMinimum: rating.band ? bandGap(rating.band, minimum) : null,
    scorePointsToMinimum: rating.score !== null ? scoreGap(rating.score, minimum) : null,
    bandsToTarget: rating.band ? bandGap(rating.band, target) : null,
    scorePointsToTarget: rating.score !== null ? scoreGap(rating.score, target) : null,
    pvCanMoveBand: pvCanMoveRating(fuel),
    flags,
    caveats,
  };

  /* -- expired ------------------------------------------------------------ */
  // Checked before the band, because an expired certificate's band is not the
  // finding: the absence of a valid certificate is.
  if (age.validity === "expired") {
    const key: MeesStateKey = "certificate_expired";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, {
        lodged: certificate.lodgementDate ?? certificate.inspectionDate ?? "an unknown date",
        expires: age.expiresOn ?? "an unknown date",
      }),
      ...common,
    };
  }

  /* -- no readable band --------------------------------------------------- */
  if (!rating.band) {
    const key: MeesStateKey = "no_certificate_coverage_unknown";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, {}),
      ...common,
      caveats: [
        ...caveats,
        "A certificate was found but carries no readable rating, so it could not be screened.",
      ],
    };
  }

  const band = rating.band;

  /* -- below the minimum in force ----------------------------------------- */
  if (!isAtLeast(band, minimum)) {
    const key: MeesStateKey = "below_minimum";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, { band, minimum }),
      ...common,
    };
  }

  /* -- already at or above the proposed target ----------------------------- */
  if (isAtLeast(band, target)) {
    const key: MeesStateKey = "meets_2031_target";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, { band }),
      ...common,
    };
  }

  /* -- meets the minimum; does the 2031 target reach it? ------------------- */
  // The 1,000 m² test is a gross internal area of the demise. Our areas come
  // from an EPC or from VOA survey lines on a stated basis, and those are not
  // the same measurement, so a figure near the threshold cannot decide which
  // regime applies. Saying so is the answer; guessing is not.
  const limit = t.target_2031.applies_above_m2;
  const margin = (limit * t.area_margin_pct) / 100;

  if (area === null) {
    const key: MeesStateKey = "area_indeterminate";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, { band, area: "no floor area" }),
      ...common,
    };
  }

  if (Math.abs(area.m2 - limit) <= margin) {
    const key: MeesStateKey = "area_indeterminate";
    return {
      state: key,
      resultState: RESULT_STATE[key],
      ...wording(rules, key, {
        band,
        area: `${area.m2} m² from ${area.source}, within ${t.area_margin_pct}% of the ${limit.toLocaleString()} m² threshold`,
      }),
      ...common,
    };
  }

  const key: MeesStateKey =
    area.m2 > limit ? "meets_minimum_below_2031_target" : "meets_minimum_no_further_target";

  const result: MeesScreening = {
    state: key,
    resultState: RESULT_STATE[key],
    ...wording(rules, key, { band, minimum, area: area.m2 }),
    ...common,
  };

  // Only worth saying where someone might still be planning against it: a
  // building that already meets the target has no use for the note.
  if (key === "meets_minimum_below_2031_target") {
    result.flags = [...result.flags, flag(rules, "dropped_milestone_note")];
  }
  return result;
}
