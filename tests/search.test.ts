import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  describeQuery,
  isUnbounded,
  parseQuery,
  type ParsedQuery,
} from "../src/lib/site-intel/search";
import { describeRun } from "../src/lib/site-intel/search-describe";

const p = (q: string): ParsedQuery => parseQuery(q);

/* ---------------------------------------------------------------- basics --- */

describe("query parsing", () => {
  test("an empty query is empty, not a match-everything", () => {
    const parsed = p("   ");
    assert.equal(parsed.empty, true);
    assert.equal(parsed.understood.length, 0);
    assert.ok(isUnbounded(parsed.filter));
  });

  test("use keywords map to a canonical use", () => {
    assert.deepEqual(p("warehouses").filter.useKeywords, ["warehouse"]);
    assert.deepEqual(p("offices").filter.useKeywords, ["office"]);
    assert.deepEqual(p("show me all the shops").filter.useKeywords, ["shop"]);
  });

  test("synonyms collapse to one keyword", () => {
    assert.deepEqual(p("distribution units").filter.useKeywords, ["warehouse"]);
    assert.deepEqual(p("factory").filter.useKeywords, ["industrial"]);
  });

  test("a full postcode is normalised", () => {
    assert.deepEqual(p("anything in dn4 8de").filter.postcodes, ["DN4 8DE"]);
  });

  test("a bare outward code is a district", () => {
    const parsed = p("warehouses in DN4");
    assert.deepEqual(parsed.filter.postcodeDistricts, ["DN4"]);
    assert.deepEqual(parsed.filter.postcodes, []);
  });

  test("a full postcode is not also counted as a district", () => {
    const parsed = p("sites in DN4 8DE");
    assert.deepEqual(parsed.filter.postcodes, ["DN4 8DE"]);
    assert.deepEqual(parsed.filter.postcodeDistricts, []);
  });
});

/* ------------------------------------------------------------ floor area --- */

describe("floor area", () => {
  test("over / under / between", () => {
    assert.deepEqual(p("over 1000 sqm").filter.floorArea, {
      comparison: "at_least", min: 1000, max: null, unit: "m²",
    });
    assert.deepEqual(p("under 500 m2").filter.floorArea, {
      comparison: "at_most", min: null, max: 500, unit: "m²",
    });
    assert.deepEqual(p("between 500 and 1500 sqm").filter.floorArea, {
      comparison: "between", min: 500, max: 1500, unit: "m²",
    });
  });

  test("square feet are converted to square metres", () => {
    const area = p("over 10000 sq ft").filter.floorArea;
    // 10,000 sq ft is about 929 m².
    assert.ok(area && area.min !== null && area.min > 920 && area.min < 940, `got ${area?.min}`);
    assert.equal(area?.unit, "m²");
  });

  test("thousands separators and k suffixes parse", () => {
    assert.equal(p("over 1,500 sqm").filter.floorArea?.min, 1500);
    assert.equal(p("at least 2k sqm").filter.floorArea?.min, 2000);
  });

  test("between normalises the order of its bounds", () => {
    const area = p("between 1500 and 500 sqm").filter.floorArea;
    assert.equal(area?.min, 500);
    assert.equal(area?.max, 1500);
  });
});

/* -------------------------------------------------------------------- RV --- */

describe("rateable value", () => {
  test("reads a threshold with a k or m suffix", () => {
    assert.equal(p("rateable value over £100k").filter.rateableValue?.min, 100_000);
    assert.equal(p("rv over 1.5m").filter.rateableValue?.min, 1_500_000);
  });

  test("under becomes an upper bound", () => {
    const rv = p("rv under 50k").filter.rateableValue;
    assert.equal(rv?.comparison, "at_most");
    assert.equal(rv?.max, 50_000);
  });
});

/* ------------------------------------------------------------------- EPC --- */

describe("EPC bands", () => {
  test("an exact band", () => {
    assert.deepEqual(p("epc D").filter.epcBands, ["D"]);
  });

  test("worse than a band excludes it", () => {
    assert.deepEqual(p("epc below C").filter.epcBands, ["D", "E", "F", "G"]);
  });

  test("or worse includes it", () => {
    assert.deepEqual(p("epc E or worse").filter.epcBands, ["E", "F", "G"]);
  });

  test("better than a band excludes it", () => {
    assert.deepEqual(p("epc better than C").filter.epcBands, ["A", "B"]);
  });

  test("or better includes it", () => {
    assert.deepEqual(p("epc B or better").filter.epcBands, ["A", "B"]);
  });
});

/* ----------------------------------------------------------- constraints --- */

describe("constraints", () => {
  test("a plain mention means must be present", () => {
    assert.deepEqual(p("sites in a conservation area").filter.constraints, [
      { dataset: "conservation-area", present: true },
    ]);
  });

  test("negation means must be absent", () => {
    for (const phrasing of [
      "not in a conservation area",
      "no conservation area",
      "without a conservation area",
      "outside a conservation area",
    ]) {
      const constraints = p(phrasing).filter.constraints;
      assert.deepEqual(constraints, [{ dataset: "conservation-area", present: false }], phrasing);
    }
  });

  test("recognises the constraints that matter for PV", () => {
    assert.equal(p("in the green belt").filter.constraints[0]?.dataset, "green-belt");
    assert.equal(p("not in a flood zone").filter.constraints[0]?.present, false);
    assert.equal(p("article 4 direction").filter.constraints[0]?.dataset, "article-4-direction-area");
    assert.equal(p("sssi").filter.constraints[0]?.dataset, "site-of-special-scientific-interest");
  });
});

/* ------------------------------------------------------------------ grid --- */

describe("grid headroom", () => {
  test("reads a headroom threshold", () => {
    const grid = p("substation headroom over 5 MVA").filter.gridHeadroomMva;
    assert.equal(grid?.min, 5);
    assert.equal(grid?.comparison, "at_least");
  });

  test("accepts MW as well as MVA", () => {
    assert.equal(p("grid capacity of 10 MW").filter.gridHeadroomMva?.min, 10);
  });
});

/* ------------------------------------------------------------- ownership --- */

describe("ownership", () => {
  test("recognises overseas ownership", () => {
    assert.equal(p("overseas owned warehouses").filter.overseasOwned, true);
    assert.equal(p("offshore ownership").filter.overseasOwned, true);
  });

  test("is null when ownership is not mentioned", () => {
    assert.equal(p("warehouses in DN4").filter.overseasOwned, null);
  });
});

/* --------------------------------------------------------------- UNPARSED --- */

describe("unparsed terms — the safety property", () => {
  test("an unrecognised clause is reported, not dropped", () => {
    // The dangerous case: return warehouses and let the reader believe the
    // motorway filter ran.
    const parsed = p("warehouses near a motorway");
    assert.deepEqual(parsed.filter.useKeywords, ["warehouse"]);
    assert.ok(
      parsed.unparsed.some((u) => /motorway/i.test(u)),
      `expected motorway to be reported, got ${JSON.stringify(parsed.unparsed)}`,
    );
  });

  test("describeQuery states what was ignored and that results are wider", () => {
    const text = describeQuery(p("warehouses near a motorway"));
    assert.match(text, /NOT understood/);
    assert.match(text, /motorway/);
    assert.match(text, /wider than the question asked/);
  });

  test("filler words are not reported as unparsed", () => {
    const parsed = p("show me all the warehouses in DN4");
    assert.deepEqual(parsed.unparsed, [], `got ${JSON.stringify(parsed.unparsed)}`);
  });

  test("a fully understood query reports nothing unparsed", () => {
    const parsed = p("warehouses in DN4 over 1000 sqm with epc below C");
    assert.deepEqual(parsed.unparsed, [], `got ${JSON.stringify(parsed.unparsed)}`);
    assert.equal(parsed.empty, false);
  });

  test("a query understood in no part says so and runs nothing", () => {
    const parsed = p("something entirely unrelated to property");
    assert.equal(parsed.empty, true);
    assert.match(describeQuery(parsed), /Nothing in that query was understood/);
  });

  test("describeQuery on a clean query does not mention omissions", () => {
    const text = describeQuery(p("offices in DN4"));
    assert.ok(!/NOT understood/.test(text));
    assert.match(text, /Searching for/);
  });
});

/* -------------------------------------------------------------- combined --- */

describe("a realistic query", () => {
  const parsed = p(
    "find warehouses in DN4 over 1000 sqm with epc below C, not in a conservation area, " +
    "substation headroom over 5 MVA",
  );

  test("understands every clause", () => {
    assert.deepEqual(parsed.filter.useKeywords, ["warehouse"]);
    assert.deepEqual(parsed.filter.postcodeDistricts, ["DN4"]);
    assert.equal(parsed.filter.floorArea?.min, 1000);
    assert.deepEqual(parsed.filter.epcBands, ["D", "E", "F", "G"]);
    assert.deepEqual(parsed.filter.constraints, [
      { dataset: "conservation-area", present: false },
    ]);
    assert.equal(parsed.filter.gridHeadroomMva?.min, 5);
  });

  test("leaves nothing unexplained", () => {
    assert.deepEqual(parsed.unparsed, [], `got ${JSON.stringify(parsed.unparsed)}`);
  });

  test("is not unbounded", () => {
    assert.equal(isUnbounded(parsed.filter), false);
  });

  test("describes itself in full", () => {
    const text = describeQuery(parsed);
    assert.match(text, /Use: warehouse/);
    assert.match(text, /Postcode district DN4/);
    assert.match(text, /Floor area at least 1000/);
    assert.match(text, /Not in a conservation area/);
  });
});

/* ------------------------------------------------------ NOT APPLIED --- */

describe("clauses that parse but cannot be executed", () => {
  test("describeRun leaves a clean run's description alone", () => {
    assert.equal(describeRun("Searching for: Use: warehouse.", []), "Searching for: Use: warehouse.");
  });

  test("describeRun names what could not be applied and says results are wider", () => {
    // A constraint parses fine. It cannot narrow a corpus, and a caller that
    // reads only the description would otherwise believe it did.
    const text = describeRun("Searching for: Postcode district DN4; Not in a conservation area.", [
      { clause: "Not in conservation area", reason: "Screened per site, not stored for a corpus." },
    ]);
    assert.match(text, /could NOT be applied/);
    assert.match(text, /Not in conservation area/);
    assert.match(text, /wider than the question asked/);
  });

  test("describeRun lists every unapplied clause", () => {
    const text = describeRun("Searching for: x.", [
      { clause: "Not in conservation area", reason: "a" },
      { clause: "Local authority: Doncaster", reason: "b" },
    ]);
    assert.match(text, /Not in conservation area/);
    assert.match(text, /Local authority: Doncaster/);
  });
});
