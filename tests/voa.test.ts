import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildVoaResult,
  compareAreas,
  headlineArea,
  inferUseClass,
  matchAssessments,
  totalAreaByBasis,
  voaAreaEstimates,
  AREA_DIVERGENCE_THRESHOLD,
  type AreaEstimate,
  type VoaAssessment,
} from "../src/lib/site-intel/voa";

function assessment(over: Partial<VoaAssessment> = {}): VoaAssessment {
  return {
    uarn: "101234567890",
    billingAuthorityCode: "4635",
    billingAuthorityReference: "12345678901",
    primaryDescription: "WAREHOUSE AND PREMISES",
    scatCode: "217",
    propertyAddress: "Unit 3, Carr Hill Industrial Estate, Doncaster",
    postcode: "DN4 8DE",
    rateableValue: 185_000,
    effectiveDate: "2023-04-01",
    listYear: 2023,
    surveyLines: [
      { description: "Ground Floor Store", areaM2: 1250.5, basis: "GIA", pricePerM2: 48, value: 60024 },
      { description: "First Floor Offices", areaM2: 180.25, basis: "GIA", pricePerM2: 95, value: 17123.75 },
    ],
    ...over,
  };
}

/* ---------------------------------------------------------- floor areas --- */

describe("floor area totals", () => {
  test("sums lines sharing a basis", () => {
    const totals = totalAreaByBasis(assessment());
    assert.equal(totals.length, 1);
    assert.equal(totals[0].basis, "GIA");
    assert.equal(totals[0].areaM2, 1430.75);
    assert.equal(totals[0].lineCount, 2);
  });

  test("keeps different bases apart rather than adding them", () => {
    // GIA and NIA are not interchangeable, so summing them would be arithmetic
    // on incompatible quantities.
    const totals = totalAreaByBasis(assessment({
      surveyLines: [
        { description: "Store", areaM2: 1000, basis: "GIA", pricePerM2: null, value: null },
        { description: "Offices", areaM2: 300, basis: "NIA", pricePerM2: null, value: null },
      ],
    }));
    assert.equal(totals.length, 2);
    assert.deepEqual(totals.map((t) => t.basis).sort(), ["GIA", "NIA"]);
    assert.ok(!totals.some((t) => t.areaM2 === 1300), "must not produce a combined total");
  });

  test("ignores lines with no area", () => {
    const totals = totalAreaByBasis(assessment({
      surveyLines: [
        { description: "Store", areaM2: 500, basis: "GIA", pricePerM2: null, value: null },
        { description: "Yard", areaM2: null, basis: "GIA", pricePerM2: null, value: null },
      ],
    }));
    assert.equal(totals[0].areaM2, 500);
    assert.equal(totals[0].lineCount, 1);
  });

  test("no survey lines yields no totals", () => {
    assert.deepEqual(totalAreaByBasis(assessment({ surveyLines: [] })), []);
    assert.equal(headlineArea(assessment({ surveyLines: [] })), null);
  });

  test("headlineArea prefers a stated basis over a larger unknown", () => {
    const headline = headlineArea(assessment({
      surveyLines: [
        { description: "Unstated", areaM2: 9000, basis: "unknown", pricePerM2: null, value: null },
        { description: "Store", areaM2: 500, basis: "GIA", pricePerM2: null, value: null },
      ],
    }));
    assert.equal(headline?.basis, "GIA");
    assert.equal(headline?.areaM2, 500);
  });
});

/* ---------------------------------------------------- area reconciliation --- */

describe("floor area comparison", () => {
  const est = (areaM2: number, basis: AreaEstimate["basis"], source = "s"): AreaEstimate =>
    ({ areaM2, basis, source, tier: "T3" });

  test("flags divergence beyond the threshold", () => {
    const result = compareAreas([est(1000, "GIA"), est(1400, "GIA")]);
    assert.ok(result.spread !== null && result.spread > AREA_DIVERGENCE_THRESHOLD);
    assert.ok(result.flags.includes("floor_area_check"));
    assert.match(result.note ?? "", /differ by 29%/);
  });

  test("close agreement on one basis raises nothing", () => {
    const result = compareAreas([est(1000, "GIA"), est(1050, "GIA")]);
    assert.deepEqual(result.flags, []);
    assert.equal(result.note, null);
  });

  test("different bases are flagged even when the numbers agree", () => {
    const result = compareAreas([est(1000, "GIA"), est(1020, "NIA")]);
    assert.ok(result.flags.includes("mixed_basis"));
    assert.match(result.note ?? "", /different bases/);
  });

  test("divergence plus mixed bases says both", () => {
    const result = compareAreas([est(1000, "GIA"), est(1600, "NIA")]);
    assert.ok(result.flags.includes("floor_area_check"));
    assert.ok(result.flags.includes("mixed_basis"));
    assert.match(result.note ?? "", /different bases/);
    assert.match(result.note ?? "", /not necessarily all of it/);
  });

  test("a single estimate cannot be cross-checked, and says so", () => {
    const result = compareAreas([est(1000, "GIA")]);
    assert.equal(result.spread, null);
    assert.match(result.note ?? "", /cannot be cross-checked/);
  });

  test("no estimates is reported, not treated as zero", () => {
    const result = compareAreas([]);
    assert.ok(result.flags.includes("no_floor_area"));
    assert.match(result.note ?? "", /No floor area is available/);
  });

  test("zero and negative areas are discarded", () => {
    const result = compareAreas([est(0, "GIA"), est(-5, "GIA"), est(900, "GIA")]);
    assert.equal(result.estimates.length, 1);
    assert.equal(result.spread, null);
  });

  test("every estimate is kept - none is silently chosen", () => {
    const result = compareAreas([est(1000, "GIA", "VOA"), est(1500, "GEA", "footprint")]);
    assert.equal(result.estimates.length, 2);
    assert.deepEqual(result.estimates.map((e) => e.source).sort(), ["VOA", "footprint"]);
  });
});

/* ------------------------------------------------------------ use class --- */

describe("use class inference", () => {
  test("maps unambiguous descriptions", () => {
    assert.equal(inferUseClass("WAREHOUSE AND PREMISES")?.useClass, "B8");
    assert.equal(inferUseClass("OFFICES AND PREMISES")?.useClass, "E(g)(i)");
    assert.equal(inferUseClass("FACTORY AND PREMISES")?.useClass, "B2");
    assert.equal(inferUseClass("SHOP AND PREMISES")?.useClass, "E(a)");
    assert.equal(inferUseClass("HOTEL AND PREMISES")?.useClass, "C1");
  });

  test("is always marked inferred, never a determination", () => {
    const inference = inferUseClass("WAREHOUSE AND PREMISES");
    assert.equal(inference?.inferred, true);
    assert.match(inference?.note ?? "", /not a planning Use Class/);
    assert.match(inference?.note ?? "", /Confirm before relying on it/);
  });

  test("declines to guess an unrecognised description", () => {
    const inference = inferUseClass("LAND USED FOR STORAGE OF VEHICLES AND PREMISES (EXEMPT)");
    assert.ok(inference);
    assert.equal(inference.useClass, null);
    assert.match(inference.note, /Determine the use class from the planning history/);
  });

  test("returns null for no description at all", () => {
    assert.equal(inferUseClass(null), null);
    assert.equal(inferUseClass("   "), null);
  });

  test("keeps the description it reasoned from", () => {
    assert.equal(inferUseClass("Warehouse and Premises")?.from, "Warehouse and Premises");
  });
});

/* ------------------------------------------------------------- matching --- */

describe("assessment matching", () => {
  const site = { address: "Unit 3, Carr Hill Industrial Estate", postcode: "DN4 8DE" };

  test("a postcode and address match is the best available quality", () => {
    const [candidate] = matchAssessments(site, [assessment()]);
    assert.equal(candidate.quality, "postcode_and_address");
    assert.equal(candidate.source.sourceId, "voa-rating-list");
  });

  test("every match is T3 - there is no free UPRN linkage", () => {
    const [candidate] = matchAssessments(site, [assessment()]);
    assert.equal(candidate.source.tier, "T3");
  });

  test("a different postcode is not a candidate", () => {
    assert.equal(matchAssessments(site, [assessment({ postcode: "DN4 8DF" })]).length, 0);
  });

  test("an assessment with no survey lines says so", () => {
    const [candidate] = matchAssessments(site, [assessment({ surveyLines: [] })]);
    assert.ok(candidate.reasons.some((r) => /No survey lines/.test(r)));
  });

  test("conflicting building numbers drop it to postcode only", () => {
    const [candidate] = matchAssessments(
      { address: "Unit 3, Carr Hill", postcode: "DN4 8DE" },
      [assessment({ propertyAddress: "Unit 9, Carr Hill Industrial Estate" })],
    );
    assert.equal(candidate.quality, "postcode_only");
  });

  test("stronger matches rank first", () => {
    const ranked = matchAssessments(site, [
      assessment({ uarn: "WEAK", propertyAddress: "The Gasworks, Balby Road" }),
      assessment({ uarn: "STRONG" }),
    ]);
    assert.equal(ranked[0].assessment.uarn, "STRONG");
  });
});

describe("VOA result", () => {
  const site = { address: "Unit 3, Carr Hill Industrial Estate", postcode: "DN4 8DE" };

  test("is always flagged as inferred from address", () => {
    const result = buildVoaResult(site, [assessment()]);
    assert.equal(result.inferredFromAddress, true);
    assert.match(result.note, /not a confirmed assessment/);
    assert.match(result.note, /AddressBase Premium/);
  });

  test("several candidates are flagged", () => {
    const result = buildVoaResult(site, [assessment({ uarn: "A" }), assessment({ uarn: "B" })]);
    assert.ok(result.flags.includes("multiple_assessment_candidates"));
  });

  test("no survey lines anywhere is flagged", () => {
    const result = buildVoaResult(site, [assessment({ surveyLines: [] })]);
    assert.ok(result.flags.includes("no_survey_lines"));
  });

  test("no postcode yields nothing and says why", () => {
    const result = buildVoaResult({ address: "Unit 3", postcode: null }, [assessment()]);
    assert.ok(result.flags.includes("no_postcode"));
    assert.equal(result.candidates.length, 0);
  });

  test("area estimates come from the best candidate only", () => {
    const result = buildVoaResult(site, [
      assessment({ uarn: "BEST" }),
      assessment({
        uarn: "OTHER",
        propertyAddress: "The Gasworks, Balby Road",
        surveyLines: [{ description: "X", areaM2: 99_999, basis: "GIA", pricePerM2: null, value: null }],
      }),
    ]);
    const estimates = voaAreaEstimates(result);
    assert.equal(estimates.length, 1);
    assert.equal(estimates[0].areaM2, 1430.75);
    assert.match(estimates[0].source, /UARN BEST/);
    assert.match(estimates[0].source, /2 survey lines/);
  });

  test("no candidates means no estimates, not a zero", () => {
    const result = buildVoaResult({ address: null, postcode: "ZZ1 1ZZ" }, [assessment()]);
    assert.deepEqual(voaAreaEstimates(result), []);
  });
});
