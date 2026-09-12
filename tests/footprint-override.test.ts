import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { applyOverride, withStoredOverrides } from "../src/lib/site-intel/profile";
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

/* ------------------------------- surviving a re-resolve --------------------- */

describe("an override survives the site being searched for again", () => {
  /*
   * A fresh resolve is built from source data and knows nothing about what the
   * user drew. Before this was carried forward the override was write-only:
   * search the site again and the panel showed the published polygon, with no
   * "your drawing" badge and no "Revert to published" button — so the drawing
   * could not even be undone. Confirming then destroyed it, because the save
   * re-wrote whatever the resolve produced.
   */
  const stored = applyOverride(sited(), { footprint: DRAWN });

  test("the drawing is carried onto the freshly resolved profile", () => {
    const next = withStoredOverrides(sited(), stored);
    assert.equal(next.footprint.method, "user_drawn");
    assert.deepEqual(next.footprint.geometry, DRAWN);
  });

  test("the original is the one from when the drawing was made", () => {
    // Not today's published polygon under today's date: the audit trail needs
    // the shape that was there when the user drew over it, and when.
    const next = withStoredOverrides(sited(), stored);
    assert.deepEqual(next.footprintOriginal?.geometry, PUBLISHED);
    assert.equal(next.footprintOriginal?.overriddenAt, stored.footprintOriginal?.overriddenAt);
  });

  test("the flags and lineage say it is a drawing", () => {
    const next = withStoredOverrides(sited({ flags: ["footprint_inferred"] }), stored);
    assert.ok(next.flags.includes("footprint_overridden"));
    assert.ok(!next.flags.includes("footprint_inferred"), "that flag described the source polygon");
    assert.ok(next.sources.some((s) => s.method === "user redrew the footprint" && s.tier === "T4"));
  });

  test("everything else is re-resolved, not restored", () => {
    // The point of resolving again is to get what the sources say NOW.
    const fresh = sited({ address: "New address from the register", lpaName: "New LPA" });
    const next = withStoredOverrides(fresh, stored);
    assert.equal(next.address, "New address from the register");
    assert.equal(next.lpaName, "New LPA");
  });

  test("a confirmation survives too — it is the same UPRN", () => {
    const confirmed = applyOverride(sited(), { confirmed: true });
    assert.equal(withStoredOverrides(sited(), confirmed).userConfirmed, true);
  });

  test("a stored profile with no override changes nothing", () => {
    const fresh = sited();
    const next = withStoredOverrides(fresh, sited());
    assert.equal(next.footprint.method, "uprn_contained");
    assert.equal(next.footprintOriginal, null, "nothing was overridden, so there is no original");
  });

  test("no stored profile at all is returned untouched", () => {
    const fresh = sited();
    assert.equal(withStoredOverrides(fresh, null), fresh);
  });

  test("a reverted profile does not resurrect the drawing", () => {
    // Revert clears the original, which is what marks an override as in force.
    const reverted = applyOverride(stored, { revertFootprint: true });
    const next = withStoredOverrides(sited(), reverted);
    assert.equal(next.footprint.method, "uprn_contained");
    assert.deepEqual(next.footprint.geometry, PUBLISHED);
  });
});
