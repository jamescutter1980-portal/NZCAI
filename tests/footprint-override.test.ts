import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { applyOverride } from "../src/lib/site-intel/profile";
import { emptyProfile, type SiteProfile } from "../src/lib/site-intel/types";

const square = (west: number, south: number, size: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[
    [west, south], [west + size, south], [west + size, south + size],
    [west, south + size], [west, south],
  ]],
});

const PUBLISHED = square(-1.12155, 53.50745, 0.0011);
const DRAWN = square(-1.1215, 53.5075, 0.0009);
const REDRAWN = square(-1.1214, 53.5076, 0.0007);

function sited(over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    ...emptyProfile(),
    uprn: "100050000001",
    lat: 53.5077,
    lon: -1.121,
    footprint: { geometry: PUBLISHED, areaM2: 4044, method: "uprn_contained" },
    ...over,
  };
}

/* ------------------------------------------------ keeping the original --- */

describe("a redraw keeps what the source published", () => {
  test("the first override captures the original", () => {
    const next = applyOverride(sited(), { footprint: DRAWN });
    assert.equal(next.footprint.method, "user_drawn");
    assert.ok(next.footprintOriginal);
    assert.equal(next.footprintOriginal?.method, "uprn_contained");
    assert.deepEqual(next.footprintOriginal?.geometry, PUBLISHED);
    assert.equal(next.footprintOriginal?.areaM2, 4044);
    assert.ok(next.footprintOriginal?.overriddenAt);
  });

  test("a SECOND redraw replaces the drawing, never the original", () => {
    // The thing worth keeping is what the source published, not the user's
    // previous attempt. Overwriting it here would quietly turn "revert to the
    // OS polygon" into "revert to my last shape".
    const once = applyOverride(sited(), { footprint: DRAWN });
    const twice = applyOverride(once, { footprint: REDRAWN });

    assert.deepEqual(twice.footprint.geometry, REDRAWN);
    assert.deepEqual(twice.footprintOriginal?.geometry, PUBLISHED);
    assert.equal(twice.footprintOriginal?.method, "uprn_contained");
  });

  test("the override is flagged so dependants know the shape moved", () => {
    const next = applyOverride(sited(), { footprint: DRAWN });
    assert.ok(next.flags.includes("footprint_overridden"));
  });

  test("the flag is not duplicated across repeated redraws", () => {
    const twice = applyOverride(applyOverride(sited(), { footprint: DRAWN }), { footprint: REDRAWN });
    assert.equal(twice.flags.filter((f) => f === "footprint_overridden").length, 1);
  });

  test("a drawing is recorded at T4, not as source data", () => {
    const next = applyOverride(sited(), { footprint: DRAWN });
    const source = next.sources.find((s) => s.method === "user redrew the footprint");
    assert.ok(source, "expected a lineage record for the redraw");
    assert.equal(source?.tier, "T4");
  });

  test("the area is recomputed from the drawn shape, not carried over", () => {
    const next = applyOverride(sited(), { footprint: DRAWN });
    assert.notEqual(next.footprint.areaM2, 4044);
    assert.ok((next.footprint.areaM2 ?? 0) > 0);
  });
});

/* ---------------------------------------------------------- reverting --- */

describe("reverting", () => {
  test("restores the published polygon and clears the override", () => {
    const drawn = applyOverride(sited(), { footprint: DRAWN });
    const back = applyOverride(drawn, { revertFootprint: true });

    assert.deepEqual(back.footprint.geometry, PUBLISHED);
    assert.equal(back.footprint.method, "uprn_contained");
    assert.equal(back.footprint.areaM2, 4044);
    assert.equal(back.footprintOriginal, null);
    assert.ok(!back.flags.includes("footprint_overridden"));
  });

  test("reverting is itself recorded, at T4", () => {
    const back = applyOverride(applyOverride(sited(), { footprint: DRAWN }), { revertFootprint: true });
    const source = back.sources.find((s) => s.method === "user reverted to the published footprint");
    assert.ok(source);
    assert.equal(source?.tier, "T4");
  });

  test("reverting with nothing to revert to is a no-op", () => {
    const next = applyOverride(sited(), { revertFootprint: true });
    assert.deepEqual(next.footprint.geometry, PUBLISHED);
    assert.equal(next.footprintOriginal, null);
  });

  test("an inferred footprint gets its inference flag back on revert", () => {
    // footprint_inferred described the SOURCE polygon's provenance. It is
    // dropped while a drawing is in force and must return with the original,
    // or the restored polygon would look better sourced than it is.
    const inferred = sited({
      footprint: { geometry: PUBLISHED, areaM2: 4044, method: "title_intersect" },
      flags: ["footprint_inferred"],
    });
    const drawn = applyOverride(inferred, { footprint: DRAWN });
    assert.ok(!drawn.flags.includes("footprint_inferred"));

    const back = applyOverride(drawn, { revertFootprint: true });
    assert.ok(back.flags.includes("footprint_inferred"));
    assert.equal(back.footprint.method, "title_intersect");
  });
});

/* ------------------------------------------------------- independence --- */

describe("overrides do not interfere", () => {
  test("moving the pin does not touch the footprint", () => {
    const next = applyOverride(sited(), { point: { lat: 53.5080, lon: -1.1205 } });
    assert.equal(next.matchConfidence, "manual");
    assert.deepEqual(next.footprint.geometry, PUBLISHED);
    assert.equal(next.footprintOriginal, null);
  });

  test("confirming does not touch the footprint", () => {
    const drawn = applyOverride(sited(), { footprint: DRAWN });
    const confirmed = applyOverride(drawn, { confirmed: true });
    assert.equal(confirmed.userConfirmed, true);
    assert.deepEqual(confirmed.footprint.geometry, DRAWN);
    assert.deepEqual(confirmed.footprintOriginal?.geometry, PUBLISHED);
  });

  test("the input profile is not mutated", () => {
    const before = sited();
    applyOverride(before, { footprint: DRAWN });
    assert.deepEqual(before.footprint.geometry, PUBLISHED);
    assert.equal(before.footprintOriginal, null);
    assert.deepEqual(before.flags, []);
  });
});
