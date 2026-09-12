import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { EpcCertificate } from "../src/lib/site-intel/epc";
import {
  BAND_MAX_SCORE,
  bandForScore,
  bandGap,
  certificateAge,
  classifyFuel,
  compareBands,
  intensity,
  isAtLeast,
  parseBand,
  pvCanMoveRating,
  ratingKind,
  readRating,
  scoreGap,
} from "../src/lib/site-intel/performance";
import {
  loadMeesRules,
  screenMees,
  unapprovedMeesRules,
} from "../src/lib/site-intel/mees";

function cert(over: Partial<EpcCertificate> = {}): EpcCertificate {
  return {
    lmkKey: "LMK-TEST",
    register: "non-domestic",
    address: "Unit 3, Carr Hill Industrial Estate, Doncaster",
    postcode: "DN4 8DE",
    uprn: "100050000001",
    uprnSource: "address_matched",
    rating: "C",
    assetRating: 88,
    floorAreaM2: 1520.75,
    inspectionDate: "2024-06-11",
    lodgementDate: "2024-06-20",
    propertyType: "B8 Storage or Distribution",
    buildingReference: "BR-1",
    mainFuel: "Natural Gas",
    buildingEmissions: 52.4,
    targetEmissions: 59.5,
    standardEmissions: 71.2,
    primaryEnergy: 268,
    transactionType: "Mandatory issue (Marketed sale)",
    ...over,
  };
}

/** A fixed "now" so expiry tests do not drift. */
const NOW = new Date("2026-09-12T00:00:00Z");

/* ---------------------------------------------------------------- bands --- */

describe("band scale", () => {
  test("boundaries match the published non-domestic table", () => {
    assert.equal(bandForScore(0), "A+");
    assert.equal(bandForScore(25), "A+");
    assert.equal(bandForScore(26), "A");
    assert.equal(bandForScore(50), "A");
    assert.equal(bandForScore(51), "B");
    assert.equal(bandForScore(75), "B");
    assert.equal(bandForScore(76), "C");
    assert.equal(bandForScore(100), "C");
    assert.equal(bandForScore(101), "D");
    assert.equal(bandForScore(125), "D");
    assert.equal(bandForScore(126), "E");
    assert.equal(bandForScore(150), "E");
    assert.equal(bandForScore(151), "F");
    assert.equal(bandForScore(175), "F");
    assert.equal(bandForScore(176), "G");
    assert.equal(bandForScore(400), "G");
  });

  test("a net exporter scores at or below zero and lands in A+", () => {
    assert.equal(bandForScore(-12), "A+");
    assert.equal(BAND_MAX_SCORE.G, null, "G must have no upper bound");
  });

  test("lower is better, and the ordering says so", () => {
    assert.ok(compareBands("B", "D") < 0);
    assert.ok(isAtLeast("B", "B"));
    assert.ok(isAtLeast("A", "B"));
    assert.equal(isAtLeast("C", "B"), false);
  });

  test("parseBand accepts A+ and rejects anything that is not a band", () => {
    assert.equal(parseBand("a+"), "A+");
    assert.equal(parseBand(" c "), "C");
    assert.equal(parseBand("Very Good"), null);
    assert.equal(parseBand(null), null);
  });

  test("a band gap and a score gap are different measurements", () => {
    // Both of these are one band off B. They are not the same distance.
    assert.equal(bandGap("C", "B"), 1);
    assert.equal(scoreGap(76, "B"), 1);
    assert.equal(scoreGap(100, "B"), 25);
    assert.equal(scoreGap(60, "B"), 0, "already inside B");
  });
});

/* ------------------------------------------------------- rating readings --- */

describe("reading a rating", () => {
  test("a non-domestic certificate is an asset rating", () => {
    assert.equal(ratingKind("non-domestic"), "asset");
    assert.equal(ratingKind("display"), "operational");
    assert.equal(ratingKind("domestic"), "domestic");
  });

  test("band and score agreeing produces no disagreement", () => {
    const reading = readRating(cert({ rating: "C", assetRating: 88 }));
    assert.equal(reading.band, "C");
    assert.equal(reading.disagreement, null);
  });

  test("band and score disagreeing is reported, not resolved", () => {
    // 58 is band B. The register says C. We do not pick a winner.
    const reading = readRating(cert({ rating: "C", assetRating: 58 }));
    assert.equal(reading.publishedBand, "C");
    assert.equal(reading.derivedBand, "B");
    assert.equal(reading.band, "C", "the published band is what we screen on");
    assert.match(reading.disagreement ?? "", /published band C/);
    assert.match(reading.disagreement ?? "", /band B/);
  });

  test("a score alone derives a band", () => {
    const reading = readRating(cert({ rating: null, assetRating: 132 }));
    assert.equal(reading.band, "E");
  });

  test("a DEC band is never read on the non-domestic scale", () => {
    const reading = readRating(cert({ register: "display", rating: "E", assetRating: 132 }));
    assert.equal(reading.kind, "operational");
    assert.equal(reading.derivedBand, null, "an operational rating must not be banded as an asset rating");
  });
});

/* -------------------------------------------------------------- validity --- */

describe("certificate validity", () => {
  test("ten years from lodgement", () => {
    const age = certificateAge(cert({ lodgementDate: "2024-06-20" }), NOW);
    assert.equal(age.validity, "valid");
    assert.equal(age.expiresOn, "2034-06-20");
  });

  test("an expired certificate is expired, not merely old", () => {
    const age = certificateAge(cert({ lodgementDate: "2013-01-05" }), NOW);
    assert.equal(age.validity, "expired");
    assert.ok((age.daysRemaining ?? 0) < 0);
  });

  test("no date means unknown, never assumed valid", () => {
    const age = certificateAge(cert({ lodgementDate: null, inspectionDate: null }), NOW);
    assert.equal(age.validity, "unknown");
    assert.equal(age.expiresOn, null);
  });

  test("inspection date is only a fallback", () => {
    const age = certificateAge(cert({ lodgementDate: null, inspectionDate: "2015-03-01" }), NOW);
    assert.equal(age.expiresOn, "2025-03-01");
    assert.equal(age.validity, "expired");
  });
});

/* ------------------------------------------------------------------ fuel --- */

describe("fuel classification", () => {
  test("gas and LPG are the same problem", () => {
    assert.equal(classifyFuel("Natural Gas"), "gas");
    assert.equal(classifyFuel("LPG"), "gas");
    assert.equal(classifyFuel("Liquid Petroleum Gas (LPG)"), "gas");
  });

  test("electric heating is separated from gas", () => {
    assert.equal(classifyFuel("Grid Supplied Electricity"), "electric");
    assert.equal(classifyFuel("Air Source Heat Pump"), "electric");
  });

  test("other carbon-bearing fuels are not collapsed into gas", () => {
    assert.equal(classifyFuel("Oil"), "oil");
    assert.equal(classifyFuel("Biomass pellets"), "biomass");
    assert.equal(classifyFuel("District Heating"), "district_heat");
    assert.equal(classifyFuel(null), "unknown");
  });

  test("PV moves the rating on electric buildings, not on gas ones", () => {
    // This is the whole reason fuel is captured: the rating is a CO2 rate and
    // PV displaces electricity.
    assert.equal(pvCanMoveRating("gas"), false);
    assert.equal(pvCanMoveRating("oil"), false);
    assert.equal(pvCanMoveRating("electric"), true);
  });
});

/* -------------------------------------------------------------- intensity --- */

describe("intensity", () => {
  test("BER against the notional building is only computed when both exist", () => {
    assert.equal(intensity(cert({ buildingEmissions: 52.4, targetEmissions: 59.5 })).againstNotionalPct, 88.1);
    assert.equal(intensity(cert({ targetEmissions: null })).againstNotionalPct, null);
    assert.equal(intensity(cert({ targetEmissions: 0 })).againstNotionalPct, null, "no divide by zero");
  });
});

/* ---------------------------------------------------------------- policy --- */

describe("the policy is data, and it is the June 2026 position", () => {
  const rules = loadMeesRules();

  test("the minimum in force is E", () => {
    assert.equal(rules.thresholds.minimum_band.band, "E");
    assert.equal(rules.thresholds.minimum_band.status, "in_force");
  });

  test("the target is B by 2031, above 1,000 m², and proposed", () => {
    const target = rules.thresholds.target_2031;
    assert.equal(target.band, "B");
    assert.equal(target.by, 2031);
    assert.equal(target.applies_above_m2, 1000);
    assert.equal(target.status, "proposed", "it still needs secondary legislation");
  });

  test("the 2027 EPC C milestone is recorded as dropped", () => {
    // Recorded rather than deleted so the system can state the negative:
    // anything written before 18 June 2026 may still assume this duty.
    const dropped = rules.thresholds.dropped_2027_c;
    assert.equal(dropped.status, "dropped");
    assert.equal(dropped.was, 2027);
  });

  test("nothing is approved yet", () => {
    const unapproved = unapprovedMeesRules();
    assert.ok(unapproved.includes("meta"));
    assert.ok(unapproved.length >= 15, `expected every rule unapproved, got ${unapproved.length}`);
  });
});

/* ------------------------------------------------------------- screening --- */

describe("MEES screening — what it refuses to say", () => {
  test("every result carries the standing caveats", () => {
    const screening = screenMees(cert(), { now: NOW });
    const text = screening.caveats.join(" ");
    assert.match(text, /screening flag for review by a qualified person/);
    assert.match(text, /not a compliance determination/);
    assert.match(text, /PRS Exemptions Register has not been consulted/);
    assert.match(text, /proposed, not law/);
    assert.match(text, /no EPC C requirement/);
  });

  test("no state is ever called compliant or non-compliant", () => {
    const rules = loadMeesRules();
    for (const [key, entry] of Object.entries(rules.states)) {
      const text = `${entry.label} ${entry.finding} ${entry.check}`.toLowerCase();
      assert.ok(
        !/\bnon-?compliant\b/.test(text),
        `state "${key}" must not declare compliance: ${text}`,
      );
    }
  });

  test("a DEC is refused rather than banded", () => {
    const screening = screenMees(cert({ register: "display", rating: "E" }), { now: NOW });
    assert.equal(screening.state, "not_supported_operational");
    assert.equal(screening.resultState, "not_supported");
    assert.equal(screening.band, null, "an operational rating must not appear as a MEES band");
    assert.match(screening.finding, /Display Energy Certificate/);
  });

  test("a domestic certificate is out of scope, not screened", () => {
    const screening = screenMees(cert({ register: "domestic", rating: "D" }), { now: NOW });
    assert.equal(screening.state, "not_supported_domestic");
    assert.equal(screening.band, null);
  });

  test("no certificate says whether coverage was complete", () => {
    const answered = screenMees(null, { now: NOW });
    assert.equal(answered.state, "no_certificate_coverage_complete");
    assert.equal(answered.resultState, "not_found_coverage_complete");

    const failed = screenMees(null, { unavailable: "the register did not respond", now: NOW });
    assert.equal(failed.state, "no_certificate_coverage_unknown");
    assert.equal(failed.resultState, "not_found_coverage_unknown");
    assert.match(failed.finding, /could not be consulted/);
  });

  test("an expired certificate is reported as expired, not as its band", () => {
    const screening = screenMees(cert({ lodgementDate: "2013-01-05", rating: "B" }), { now: NOW });
    assert.equal(screening.state, "certificate_expired");
    assert.match(screening.finding, /expired on/);
    assert.match(screening.check, /valid EPC is needed before the next letting/);
  });
});

describe("MEES screening — the states", () => {
  test("F and G fall below the minimum, with the exemption caveat", () => {
    for (const band of ["F", "G"]) {
      const screening = screenMees(cert({ rating: band, assetRating: null }), { now: NOW });
      assert.equal(screening.state, "below_minimum", band);
      assert.match(screening.check, /PRS Exemptions Register/);
      assert.match(screening.check, /may be lawfully let/i);
    }
  });

  test("B or better meets the proposed target", () => {
    const screening = screenMees(cert({ rating: "B", assetRating: 70 }), { now: NOW });
    assert.equal(screening.state, "meets_2031_target");
    assert.equal(screening.bandsToTarget, 0);
    assert.equal(screening.scorePointsToTarget, 0);
  });

  test("a large building below B is inside the 2031 horizon", () => {
    const screening = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: 1520.75 }), { now: NOW });
    assert.equal(screening.state, "meets_minimum_below_2031_target");
    assert.equal(screening.bandsToTarget, 2);
    assert.equal(screening.scorePointsToTarget, 43);
    assert.match(screening.check, /planning horizon rather than a duty/);
  });

  test("a small building below B has no further target proposed", () => {
    const screening = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: 420 }), { now: NOW });
    assert.equal(screening.state, "meets_minimum_no_further_target");
    assert.match(screening.finding, /no EPC C or EPC B target is currently proposed/i);
  });

  test("the dropped-milestone note rides on the buildings whose plans might assume it", () => {
    const large = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: 1520.75 }), { now: NOW });
    assert.ok(large.flags.some((f) => f.key === "dropped_milestone_note"));

    const compliant = screenMees(cert({ rating: "A", assetRating: 40 }), { now: NOW });
    assert.ok(!compliant.flags.some((f) => f.key === "dropped_milestone_note"));
  });
});

describe("MEES screening — the area threshold", () => {
  test("an area near 1,000 m² cannot decide the regime", () => {
    // The test is a gross internal area of the demise. An EPC floor area and a
    // VOA area are different measurements, so near the line we say so.
    for (const m2 of [950, 1000, 1050]) {
      const screening = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: m2 }), { now: NOW });
      assert.equal(screening.state, "area_indeterminate", `${m2} m²`);
      assert.match(screening.check, /gross internal area/);
    }
  });

  test("outside the margin the regime is stated, with the area's source", () => {
    const big = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: 1200 }), { now: NOW });
    assert.equal(big.state, "meets_minimum_below_2031_target");
    assert.equal(big.areaSource, "EPC total floor area");

    const small = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: 800 }), { now: NOW });
    assert.equal(small.state, "meets_minimum_no_further_target");
  });

  test("no area at all is indeterminate, never assumed small", () => {
    const screening = screenMees(cert({ rating: "D", assetRating: 118, floorAreaM2: null }), { now: NOW });
    assert.equal(screening.state, "area_indeterminate");
    assert.equal(screening.areaM2, null);
  });

  test("a supplied area overrides the EPC's and keeps its basis", () => {
    const screening = screenMees(
      cert({ rating: "D", assetRating: 118, floorAreaM2: 800 }),
      { area: { m2: 1450, source: "VOA survey lines, GIA" }, now: NOW },
    );
    assert.equal(screening.state, "meets_minimum_below_2031_target");
    assert.equal(screening.areaSource, "VOA survey lines, GIA");
  });
});

describe("MEES screening — the flags", () => {
  test("gas heating is flagged with the honest PV message", () => {
    const screening = screenMees(cert({ mainFuel: "Natural Gas" }), { now: NOW });
    const gas = screening.flags.find((f) => f.key === "gas_or_lpg_fuel");
    assert.ok(gas, "expected a gas flag");
    assert.match(gas.finding, /PV alone does not move the band/i);
    // And it must not be read as "this is a bad PV site", which is a different
    // question with a different answer.
    assert.match(gas.check, /separate question/);
  });

  test("an electric building gets no gas flag", () => {
    const screening = screenMees(cert({ mainFuel: "Grid Supplied Electricity" }), { now: NOW });
    assert.ok(!screening.flags.some((f) => f.key === "gas_or_lpg_fuel"));
  });

  test("high primary energy is flagged only on a carbon-bearing fuel", () => {
    const gas = screenMees(cert({ primaryEnergy: 310, mainFuel: "Natural Gas" }), { now: NOW });
    assert.ok(gas.flags.some((f) => f.key === "high_primary_energy"));

    const electric = screenMees(cert({ primaryEnergy: 310, mainFuel: "Air Source Heat Pump" }), { now: NOW });
    assert.ok(!electric.flags.some((f) => f.key === "high_primary_energy"));

    const belowThreshold = screenMees(cert({ primaryEnergy: 180, mainFuel: "Natural Gas" }), { now: NOW });
    assert.ok(!belowThreshold.flags.some((f) => f.key === "high_primary_energy"));
  });

  test("a certificate close to expiry is flagged while still valid", () => {
    const screening = screenMees(cert({ lodgementDate: "2017-01-05", rating: "C", assetRating: 88 }), { now: NOW });
    assert.notEqual(screening.state, "certificate_expired");
    const expiring = screening.flags.find((f) => f.key === "expiring_soon");
    assert.ok(expiring, "expected an expiring flag");
    assert.match(expiring.finding, /2027-01-05/);
  });

  test("a band/score disagreement travels as a flag", () => {
    const screening = screenMees(cert({ rating: "C", assetRating: 58 }), { now: NOW });
    assert.ok(screening.flags.some((f) => f.key === "band_score_disagreement"));
  });

  test("every flag reports whether its wording is approved", () => {
    const screening = screenMees(cert(), { now: NOW });
    assert.ok(screening.flags.length > 0);
    for (const f of screening.flags) {
      assert.equal(f.approved, false, `${f.key} should be unapproved until sign-off`);
    }
    assert.equal(screening.approved, false);
  });
});

describe("MEES screening — which gap is the urgent one", () => {
  test("a building below the minimum reports its distance to the minimum, not just to 2031", () => {
    // F at 160. The letting problem is E, today. B by 2031 is the lesser
    // question and reporting only that would misplace the urgency.
    const screening = screenMees(cert({ rating: "F", assetRating: 160 }), { now: NOW });
    assert.equal(screening.state, "below_minimum");
    assert.equal(screening.bandsToMinimum, 1);
    assert.equal(screening.scorePointsToMinimum, 10, "160 is 10 BER points above the top of E");
    assert.equal(screening.bandsToTarget, 4);
    assert.equal(screening.scorePointsToTarget, 85);
  });

  test("a building already above the minimum has no gap to it", () => {
    const screening = screenMees(cert({ rating: "C", assetRating: 88 }), { now: NOW });
    assert.equal(screening.bandsToMinimum, 0);
    assert.equal(screening.scorePointsToMinimum, 0);
    assert.equal(screening.bandsToTarget, 1);
  });

  test("whether PV can move the band is stated, and it is not a view on the roof", () => {
    const gas = screenMees(cert({ mainFuel: "Natural Gas" }), { now: NOW });
    assert.equal(gas.pvCanMoveBand, false);

    const electric = screenMees(cert({ mainFuel: "Air Source Heat Pump" }), { now: NOW });
    assert.equal(electric.pvCanMoveBand, true);

    // Unreadable certificates carry no claim either way.
    assert.equal(screenMees(null).pvCanMoveBand, false);
  });
});
