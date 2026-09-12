import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { areaM2, bufferBounds, distanceM } from "../src/lib/site-intel/geo";
import { loadRules, renderWording, ruleDatasets, unapprovedRules } from "../src/lib/site-intel/rules";
import {
  checkNarrative,
  constraintsFeeding,
  crossCheckFlood,
  screenConstraints,
  DEFAULT_BUFFER_M,
  type Constraint,
  type ConstraintScreening,
  type FloodCheck,
} from "../src/lib/site-intel/constraints";
import { boundsFromWkt, noFloodCheck } from "../src/lib/site-intel/flood";
import type { FetchLike } from "../src/lib/site-intel/planning-data";
import { emptyProfile, type SiteProfile } from "../src/lib/site-intel/types";

const FOOTPRINT: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [[
    [-1.1214, 53.5074], [-1.1206, 53.5074],
    [-1.1206, 53.5080], [-1.1214, 53.5080], [-1.1214, 53.5074],
  ]],
};

function profileWithFootprint(overrides: Partial<SiteProfile> = {}): SiteProfile {
  return {
    ...emptyProfile(),
    uprn: "100050000001",
    lat: 53.5077,
    lon: -1.121,
    country: "E",
    footprint: { geometry: FOOTPRINT, areaM2: areaM2(FOOTPRINT), method: "uprn_contained" },
    ...overrides,
  };
}

/** Serves a different payload to the first (present) and second (proximity) call. */
function twoPassFetch(first: unknown, second: unknown): FetchLike {
  let call = 0;
  return async () => {
    call += 1;
    const body = call === 1 ? first : second;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

const EMPTY = { type: "FeatureCollection", features: [] };

function collection(...entries: [string, string][]): unknown {
  return {
    type: "FeatureCollection",
    features: entries.map(([dataset, reference], i) => ({
      type: "Feature",
      geometry: null,
      properties: { entity: 900 + i, dataset, reference, name: reference, "entry-date": "2026-03-01" },
    })),
  };
}

const noDelay = async (): Promise<void> => {};

function find(screening: ConstraintScreening, dataset: string): Constraint {
  const hit = screening.constraints.find((c) => c.dataset === dataset);
  assert.ok(hit, `no constraint for ${dataset}`);
  return hit;
}

/* ---------------------------------------------------------------- rules --- */

describe("constraint rules", () => {
  test("every dataset in the brief has wording", () => {
    const rules = loadRules();
    for (const dataset of [
      "conservation-area", "listed-building", "listed-building-outline",
      "locally-listed-building", "heritage-at-risk", "article-4-direction-area",
      "area-of-outstanding-natural-beauty", "national-park", "world-heritage-site",
      "world-heritage-site-buffer-zone", "scheduled-monument", "park-and-garden",
      "flood-risk-zone", "tree-preservation-zone", "ancient-woodland",
      "site-of-special-scientific-interest", "special-area-of-conservation",
      "special-protection-area", "ramsar-site", "green-belt",
      "air-quality-management-area",
    ]) {
      assert.ok(rules[dataset], `missing rule for ${dataset}`);
      assert.ok(rules[dataset].present, `${dataset} has no present wording`);
      assert.ok(rules[dataset].proximity, `${dataset} has no proximity wording`);
      assert.ok(rules[dataset].check, `${dataset} has no check line`);
    }
  });

  test("no rule states a legal conclusion", () => {
    // Brief 4.4: don't encode planning law. Screening prompts only.
    const forbidden = /\bGPDO\b|\bclass [A-Q]\b|you (will |must )?(need|require) (planning )?(permission|consent)|is not required|no consent (is )?(needed|required)/i;
    for (const [key, rule] of Object.entries(loadRules())) {
      for (const field of ["present", "proximity", "check"] as const) {
        assert.ok(
          !forbidden.test(rule[field]),
          `${key}.${field} states a legal conclusion: "${rule[field]}"`,
        );
      }
    }
  });

  test("wording is unapproved until James signs it off", () => {
    assert.equal(unapprovedRules().length, ruleDatasets().length);
  });

  test("renderWording substitutes the buffer and collapses block scalars", () => {
    const text = renderWording("A thing lies within {buffer} m.\n  Of   the site.", 50);
    assert.equal(text, "A thing lies within 50 m. Of the site.");
  });
});

/* ------------------------------------------------------------ screening --- */

describe("constraint screening", () => {
  test("a present constraint carries wording, entities and lineage", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(collection(["conservation-area", "CA-01"]), EMPTY),
      delay: noDelay,
    });

    const ca = find(screening, "conservation-area");
    assert.equal(ca.state, "present");
    assert.match(ca.message ?? "", /within a conservation area/);
    assert.equal(ca.entities[0].reference, "CA-01");
    assert.equal(ca.source?.tier, "T2");
    assert.equal(screening.basis, "footprint");
  });

  test("the buffer pass yields proximity, at tier T3", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(EMPTY, collection(["listed-building", "LB-99"])),
      delay: noDelay,
    });

    const lb = find(screening, "listed-building");
    assert.equal(lb.state, "proximity");
    assert.match(lb.message ?? "", /within 50 m/);
    assert.equal(lb.source?.tier, "T3");
    assert.equal(screening.bufferM, DEFAULT_BUFFER_M);
  });

  test("a hit on the site outranks a hit nearby and is not re-reported", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(
        collection(["green-belt", "GB-1"]),
        collection(["green-belt", "GB-1"]),
      ),
      delay: noDelay,
    });
    assert.equal(find(screening, "green-belt").state, "present");
  });

  test("datasets with no hit are coverage-unknown, never a bare not-found", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(EMPTY, EMPTY),
      delay: noDelay,
    });
    for (const constraint of screening.constraints) {
      assert.equal(constraint.state, "not_found_coverage_unknown", constraint.dataset);
      assert.notEqual(constraint.state, "not_found_coverage_complete");
    }
  });

  test("the buffer is configurable and reported in the wording", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(EMPTY, collection(["ancient-woodland", "AW-1"])),
      delay: noDelay,
      bufferM: 250,
    });
    assert.equal(screening.bufferM, 250);
    assert.match(find(screening, "ancient-woodland").message ?? "", /within 250 m/);
  });

  test("a source failure is source_error across the board, with the reason", async () => {
    const failing: FetchLike = async () => ({
      ok: false, status: 500, json: async () => ({}), text: async () => "boom",
    });
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: failing,
      delay: noDelay,
    });
    assert.ok(screening.constraints.every((c) => c.state === "source_error"));
    assert.ok(screening.flags.includes("constraint_source_error"));
    assert.ok(screening.unsupportedReason);
  });

  test("losing only the proximity pass keeps the present results", async () => {
    let call = 0;
    const flaky: FetchLike = async () => {
      call += 1;
      if (call === 1) {
        const body = collection(["green-belt", "GB-1"]);
        return { ok: true, status: 200, json: async () => body, text: async () => "" };
      }
      return { ok: false, status: 502, json: async () => ({}), text: async () => "gateway" };
    };
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: flaky,
      delay: noDelay,
    });
    assert.equal(find(screening, "green-belt").state, "present");
    assert.ok(screening.flags.includes("proximity_pass_failed"));
  });

  test("Wales and Scotland are not_supported, with a reason", async () => {
    for (const [country, name] of [["W", "Wales"], ["S", "Scotland"]] as const) {
      const screening = await screenConstraints(profileWithFootprint({ country }), {
        fetchImpl: twoPassFetch(EMPTY, EMPTY),
        delay: noDelay,
      });
      assert.ok(screening.constraints.every((c) => c.state === "not_supported"));
      assert.ok(screening.flags.includes("country_not_supported"));
      assert.match(screening.unsupportedReason ?? "", new RegExp(name));
    }
  });

  test("England is screened normally", async () => {
    const screening = await screenConstraints(profileWithFootprint({ country: "E" }), {
      fetchImpl: twoPassFetch(collection(["green-belt", "GB-1"]), EMPTY),
      delay: noDelay,
    });
    assert.equal(find(screening, "green-belt").state, "present");
  });

  test("no geometry means nothing is screened, and it says so", async () => {
    const screening = await screenConstraints(emptyProfile(), {
      fetchImpl: twoPassFetch(EMPTY, EMPTY),
      delay: noDelay,
    });
    assert.ok(screening.flags.includes("no_query_geometry"));
    assert.match(screening.unsupportedReason ?? "", /nothing to screen against/);
    assert.ok(screening.constraints.every((c) => c.state === "not_found_coverage_unknown"));
  });

  test("ambiguous title extents block screening rather than guessing", async () => {
    const ambiguous = profileWithFootprint({
      footprint: { geometry: null, areaM2: null, method: "unavailable" },
      titleExtents: [
        { geometry: FOOTPRINT, areaM2: 1, sourceRef: "A" },
        { geometry: FOOTPRINT, areaM2: 2, sourceRef: "B" },
      ],
    });
    const screening = await screenConstraints(ambiguous, {
      fetchImpl: twoPassFetch(EMPTY, EMPTY),
      delay: noDelay,
    });
    assert.match(screening.unsupportedReason ?? "", /Confirm the building first/);
  });

  test("constraintsFeeding selects by workstream and ignores absent ones", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(
        collection(["conservation-area", "CA-1"], ["flood-risk-zone", "FZ-3"]),
        EMPTY,
      ),
      delay: noDelay,
    });
    assert.deepEqual(
      constraintsFeeding(screening, "mees").map((c) => c.dataset),
      ["conservation-area"],
    );
    assert.deepEqual(
      constraintsFeeding(screening, "crrem").map((c) => c.dataset),
      ["flood-risk-zone"],
    );
    assert.equal(constraintsFeeding(screening, "biodiversity").length, 0);
  });
});

/* ---------------------------------------------------------------- flood --- */

describe("flood cross-check", () => {
  const base: Constraint = {
    dataset: "flood-risk-zone",
    label: "Flood risk zone",
    state: "present",
    message: "The building intersects a mapped flood risk zone.",
    check: "check",
    feeds: ["crrem"],
    entities: [],
    source: null,
    wordingUnapproved: true,
  };

  const saying = (answer: boolean | null): FloodCheck => ({ async inFloodZone() { return answer; } });

  test("agreement confirms without raising a conflict", async () => {
    const { constraint, conflict } = await crossCheckFlood(base, "POLYGON((0 0))", saying(true));
    assert.equal(conflict, false);
    assert.match(constraint.message ?? "", /Confirmed against the Environment Agency/);
  });

  test("EA says yes, planning.data says no -> conflict, both reported", async () => {
    const absent: Constraint = { ...base, state: "not_found_coverage_unknown", message: null };
    const { constraint, conflict } = await crossCheckFlood(absent, "POLYGON((0 0))", saying(true));
    assert.equal(conflict, true);
    assert.equal(constraint.state, "present");
    assert.match(constraint.message ?? "", /Sources disagree/);
    assert.match(constraint.message ?? "", /Environment Agency.*places this site in a flood zone/);
  });

  test("planning.data says yes, EA says no -> conflict, not silently dropped", async () => {
    const { constraint, conflict } = await crossCheckFlood(base, "POLYGON((0 0))", saying(false));
    assert.equal(conflict, true);
    assert.equal(constraint.state, "present", "risk is not cleared by a disagreement");
    assert.match(constraint.message ?? "", /Sources disagree/);
  });

  test("an unreachable EA is stated, never treated as an all-clear", async () => {
    const { constraint, conflict } = await crossCheckFlood(base, "POLYGON((0 0))", noFloodCheck);
    assert.equal(conflict, false);
    assert.match(constraint.message ?? "", /could not be reached/);
    assert.notEqual(constraint.state, "not_found_coverage_complete");
  });

  test("screening raises source_conflict when the two disagree", async () => {
    const screening = await screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(EMPTY, EMPTY),
      delay: noDelay,
      flood: saying(true),
    });
    assert.ok(screening.flags.includes("source_conflict"));
  });

  test("boundsFromWkt reads a polygon envelope", () => {
    const box = boundsFromWkt("POLYGON((-1.1214 53.5074, -1.1206 53.5074, -1.1206 53.5080, -1.1214 53.5074))");
    assert.ok(box);
    assert.ok(box[0] < box[2] && box[1] < box[3]);
  });

  test("boundsFromWkt declines garbage rather than inventing a box", () => {
    assert.equal(boundsFromWkt("not wkt at all"), null);
  });
});

/* ------------------------------------------------------------ narrative --- */

describe("narrative guard", () => {
  async function screeningWith(present: unknown, proximity: unknown = EMPTY) {
    return screenConstraints(profileWithFootprint(), {
      fetchImpl: twoPassFetch(present, proximity),
      delay: noDelay,
    });
  }

  test('rejects "no constraints" while anything is coverage-unknown', async () => {
    const screening = await screeningWith(EMPTY);
    const problems = checkNarrative("The site has no planning constraints.", screening);
    assert.ok(problems.some((p) => /no constraints/.test(p)));
  });

  test("rejects a denial of flood risk that was never confirmed absent", async () => {
    const screening = await screeningWith(EMPTY);
    const problems = checkNarrative("The building is not at risk of flooding.", screening);
    assert.ok(problems.some((p) => /flood/i.test(p)));
  });

  test("rejects an assertion that grid capacity is available", async () => {
    const screening = await screeningWith(EMPTY);
    const problems = checkNarrative("Grid capacity is available at this site.", screening);
    assert.ok(problems.some((p) => /connection offer/.test(p)));
  });

  test("rejects naming a constraint that was not found", async () => {
    const screening = await screeningWith(EMPTY);
    const problems = checkNarrative("The site lies within the Green Belt.", screening);
    assert.ok(problems.some((p) => /Green Belt/.test(p)));
  });

  test("accepts narrative that describes only what was found", async () => {
    const screening = await screeningWith(collection(["green-belt", "GB-1"]));
    const problems = checkNarrative(
      "The building sits within the Green Belt. Coverage for other datasets could not be confirmed.",
      screening,
    );
    assert.deepEqual(problems, []);
  });

  test("accepts a proximity mention", async () => {
    const screening = await screeningWith(EMPTY, collection(["ancient-woodland", "AW-1"]));
    assert.deepEqual(checkNarrative("Ancient woodland lies nearby.", screening), []);
  });
});

/* --------------------------------------------------------------- buffer --- */

describe("buffer geometry", () => {
  test("bufferBounds expands by roughly the requested distance", () => {
    const buffered = bufferBounds(FOOTPRINT, 50);
    assert.ok(buffered);
    const [west, south, , north] = [
      buffered.coordinates[0][0][0], buffered.coordinates[0][0][1],
      buffered.coordinates[0][2][0], buffered.coordinates[0][2][1],
    ];
    const grewNorth = distanceM({ lat: 53.508, lon: west }, { lat: north, lon: west });
    assert.ok(grewNorth > 45 && grewNorth < 55, `expected ~50 m, got ${Math.round(grewNorth)}`);
    assert.ok(south < 53.5074, "expanded southwards too");
  });

  test("bufferBounds declines a non-areal geometry", () => {
    assert.equal(bufferBounds({ type: "Point", coordinates: [-1.1, 53.5] }, 50), null);
  });
});
