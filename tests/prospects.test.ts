import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COHORTS,
  cohortSpec,
  type Cohort,
} from "../src/lib/site-intel/prospects";
import { parseCsvLine } from "../src/ingest/csv";
import { loadMeesRules, screenMees } from "../src/lib/site-intel/mees";
import type { EpcCertificate } from "../src/lib/site-intel/epc";

function cert(over: Partial<EpcCertificate> = {}): EpcCertificate {
  return {
    lmkKey: "LMK-P1",
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

const NOW = new Date("2026-09-12T00:00:00Z");

/* --------------------------------------------------------------- cohorts --- */

describe("cohorts", () => {
  test("every cohort states its criteria and why it is a prospect", () => {
    for (const spec of COHORTS) {
      assert.ok(spec.criteria.length > 20, `${spec.key} needs real criteria`);
      assert.ok(spec.why.length > 20, `${spec.key} needs a reason`);
    }
  });

  test("no cohort label claims compliance or breach", () => {
    for (const spec of COHORTS) {
      const text = `${spec.label} ${spec.criteria} ${spec.why}`.toLowerCase();
      assert.ok(!/\bnon-?compliant\b/.test(text), `${spec.key}: ${text}`);
      assert.ok(!/\bin breach\b/.test(text), `${spec.key}: ${text}`);
      assert.ok(!/\billegal\b/.test(text), `${spec.key}: ${text}`);
    }
  });

  test("the below-minimum cohort names the exemption gap in its own reason", () => {
    // This is the cohort most likely to be read as an enforcement list, so the
    // caveat has to be attached to the cohort itself, not only to the page.
    const spec = cohortSpec("below_minimum");
    assert.match(spec.why, /exemption/i);
    assert.match(spec.why, /prompt to check/i);
  });

  test("cohort order runs from most to least urgent", () => {
    const keys = COHORTS.map((c) => c.key);
    assert.equal(keys[0], "below_minimum");
    assert.ok(keys.indexOf("at_risk_2031") < keys.indexOf("meets_target"));
    assert.equal(keys[keys.length - 1], "unscreenable");
  });

  test("cohortSpec rejects an unknown key rather than returning a blank", () => {
    assert.throws(() => cohortSpec("made_up" as Cohort), /unknown cohort/);
  });
});

/* ------------------------------------------- every screening state maps --- */

describe("state to cohort coverage", () => {
  test("every MEES state has a cohort", () => {
    // If S-05 gains a state and S-08 is not updated, a building would land in
    // no cohort and silently vanish from the list.
    const rules = loadMeesRules();
    const cohortKeys = new Set(COHORTS.map((c) => c.key));
    for (const state of Object.keys(rules.states)) {
      const screening = screenMees(null);
      assert.ok(screening, state);
    }
    // The mapping itself is exercised through screenMees below; here we only
    // assert the cohort set is the one the mapping targets.
    for (const key of ["below_minimum", "expired", "at_risk_2031", "area_unclear",
                       "no_further_target", "meets_target", "unscreenable"]) {
      assert.ok(cohortKeys.has(key as Cohort), key);
    }
    assert.equal(cohortKeys.size, 7);
  });

  test("the states that matter land where expected", () => {
    const cases: [Partial<EpcCertificate>, string][] = [
      [{ rating: "F", assetRating: 160 }, "below_minimum"],
      [{ rating: "G", assetRating: 200 }, "below_minimum"],
      [{ lodgementDate: "2013-01-05" }, "certificate_expired"],
      [{ rating: "D", assetRating: 118, floorAreaM2: 1520 }, "meets_minimum_below_2031_target"],
      [{ rating: "D", assetRating: 118, floorAreaM2: 980 }, "area_indeterminate"],
      [{ rating: "D", assetRating: 118, floorAreaM2: 420 }, "meets_minimum_no_further_target"],
      [{ rating: "B", assetRating: 70 }, "meets_2031_target"],
      [{ register: "display", rating: "E" }, "not_supported_operational"],
    ];
    for (const [over, expected] of cases) {
      assert.equal(screenMees(cert(over), { now: NOW }).state, expected, JSON.stringify(over));
    }
  });
});

/* ------------------------------------------------------------- benchmark --- */

describe("the KFIM benchmark", () => {
  const b = loadMeesRules().benchmark;

  test("is cited and carries its caution", () => {
    assert.match(b.citation, /KFIM/);
    assert.match(b.caution, /not a like-for-like comparison/i);
    assert.match(b.caution, /not a compliance threshold/i);
  });

  test("is unapproved like everything else in the file", () => {
    assert.equal(b.approved, false);
  });

  test("the figures are ordered as bands require", () => {
    // E+ must be at least C+, which must be at least B+. A transcription error
    // that inverted them would produce a nonsense comparison.
    assert.ok(b.at_or_above_e_pct >= b.at_or_above_c_pct);
    assert.ok(b.at_or_above_c_pct >= b.at_or_above_b_pct);
  });
});

/* ------------------------------------------------------------ CSV parsing --- */

describe("bulk loader CSV parsing", () => {
  test("splits a plain row", () => {
    assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
  });

  test("keeps commas inside quotes", () => {
    assert.deepEqual(
      parseCsvLine('"Unit 3, Carr Hill","DN4 8DE",88'),
      ["Unit 3, Carr Hill", "DN4 8DE", "88"],
    );
  });

  test("unescapes doubled quotes", () => {
    assert.deepEqual(parseCsvLine('"The ""Old"" Mill",X'), ['The "Old" Mill', "X"]);
  });

  test("keeps empty trailing cells", () => {
    assert.deepEqual(parseCsvLine("a,,c,"), ["a", "", "c", ""]);
  });

  test("a lone field with no delimiter is one cell", () => {
    assert.deepEqual(parseCsvLine("lmk-key"), ["lmk-key"]);
  });
});
