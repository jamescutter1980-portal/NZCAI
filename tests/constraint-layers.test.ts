import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  categoryOf,
  categorySpec,
  colorOf,
  hasCategory,
  summariseCoverage,
  type ConstraintCategory,
  type CoverageInput,
} from "../src/lib/site-intel/constraint-layers";
import { ruleDatasets } from "../src/lib/site-intel/rules";

/* ------------------------------------------------------------ categories --- */

describe("constraint categories", () => {
  test("every dataset with wording has an explicit category", () => {
    // A new constraint rule falling silently into "other" would be drawn in a
    // colour that means nothing, and grouped under a toggle nobody expects.
    const uncategorised = ruleDatasets().filter((d) => !hasCategory(d));
    assert.deepEqual(uncategorised, [], `add these to constraint-layers.ts: ${uncategorised.join(", ")}`);
  });

  test("categories map to the expected groups", () => {
    assert.equal(categoryOf("conservation-area"), "heritage");
    assert.equal(categoryOf("listed-building"), "heritage");
    assert.equal(categoryOf("green-belt"), "designated");
    assert.equal(categoryOf("site-of-special-scientific-interest"), "ecology");
    assert.equal(categoryOf("flood-risk-zone"), "flood");
  });

  test("an unknown dataset falls back rather than throwing", () => {
    assert.equal(categoryOf("something-new"), "other");
    assert.ok(colorOf("something-new"));
  });

  test("every category has a distinct colour", () => {
    const colors = CATEGORIES.map((c) => c.color);
    assert.equal(new Set(colors).size, colors.length, "two categories share a colour");
  });

  test("categorySpec rejects an unknown key rather than returning a blank", () => {
    assert.throws(() => categorySpec("made-up" as ConstraintCategory), /unknown constraint category/);
  });
});

/* -------------------------------------------------------------- coverage --- */

function row(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    dataset: "conservation-area",
    label: "Conservation area",
    state: "present",
    entityCount: 1,
    entityGeometryCount: 1,
    ...over,
  };
}

describe("layer coverage — an empty map must not read as an all-clear", () => {
  test("a clean screen counts what was checked", () => {
    const c = summariseCoverage([
      row({ state: "present" }),
      row({ state: "proximity", label: "Listed building" }),
      row({ state: "not_found_coverage_complete", entityCount: 0, entityGeometryCount: 0 }),
      row({ state: "not_found_coverage_complete", entityCount: 0, entityGeometryCount: 0 }),
    ]);
    assert.equal(c.drawnPresent, 1);
    assert.equal(c.drawnProximity, 1);
    assert.equal(c.checkedNothingFound, 2);
    assert.equal(c.couldNotCheck, 0);
    assert.match(c.statement, /1 drawn on the site, 1 nearby/);
    assert.match(c.statement, /2 checked and clear/);
  });

  test("anything not established is called out, loudly", () => {
    const c = summariseCoverage([
      row({ state: "not_found_coverage_unknown", label: "Green belt", entityCount: 0, entityGeometryCount: 0 }),
      row({ state: "source_error", label: "Flood risk zone", entityCount: 0, entityGeometryCount: 0 }),
    ]);
    assert.equal(c.couldNotCheck, 2);
    assert.deepEqual(c.couldNotCheckDatasets, ["Green belt", "Flood risk zone"]);
    assert.match(c.statement, /COULD NOT BE CHECKED/);
    assert.match(c.statement, /an empty map is not an all-clear/);
  });

  test("coverage_unknown and source_error are both gaps, not absences", () => {
    // They mean different things about why, but the same thing about what the
    // map can claim: nothing.
    const unknown = summariseCoverage([row({ state: "not_found_coverage_unknown", entityCount: 0, entityGeometryCount: 0 })]);
    const error = summariseCoverage([row({ state: "source_error", entityCount: 0, entityGeometryCount: 0 })]);
    assert.equal(unknown.couldNotCheck, 1);
    assert.equal(error.couldNotCheck, 1);
    assert.equal(unknown.checkedNothingFound, 0);
    assert.equal(error.checkedNothingFound, 0);
  });

  test("a flag with no published extent is counted, not silently undrawn", () => {
    // The constraint is real and in the panel; the source just published no
    // geometry. A map that omits it without saying so understates the site.
    const c = summariseCoverage([row({ state: "present", entityCount: 2, entityGeometryCount: 0 })]);
    assert.equal(c.drawnPresent, 0);
    assert.equal(c.flaggedWithoutGeometry, 1);
    assert.match(c.statement, /published no extent to draw/);
  });

  test("a partially drawable constraint is both drawn and flagged", () => {
    const c = summariseCoverage([row({ state: "present", entityCount: 3, entityGeometryCount: 1 })]);
    assert.equal(c.drawnPresent, 1);
    assert.equal(c.flaggedWithoutGeometry, 1);
  });

  test("not_supported is its own count, never folded into 'clear'", () => {
    // Wales and Scotland are not covered by planning.data. That is not the
    // same as checking and finding nothing.
    const c = summariseCoverage([row({ state: "not_supported", entityCount: 0, entityGeometryCount: 0 })]);
    assert.equal(c.notSupported, 1);
    assert.equal(c.checkedNothingFound, 0);
    assert.match(c.statement, /1 not covered here/);
  });

  test("an empty screening says so rather than implying a clean result", () => {
    const c = summariseCoverage([]);
    assert.match(c.statement, /Nothing screened yet/);
  });
});
