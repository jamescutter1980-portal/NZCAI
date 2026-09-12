import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  areaM2,
  boxAround,
  distanceM,
  extractPostcode,
  normalisePostcode,
  pointInPolygon,
  toWkt,
} from "../src/lib/site-intel/geo";
import {
  applyStaleness,
  attributionsFor,
  lineage,
  loadSources,
  renderAttribution,
  ttlDays,
  unverifiedAttributions,
} from "../src/lib/site-intel/sources";
import { checkSlugs, entitiesByPoint, type FetchLike } from "../src/lib/site-intel/planning-data";
import {
  assertNoGoogleCoordinates,
  resolve,
  type ResolveDeps,
  type UprnPoint,
} from "../src/lib/site-intel/resolve";
import {
  applyOverride,
  buildProfile,
  countryFromGss,
  countryFromPostcode,
  queryGeometry,
  type FootprintStore,
} from "../src/lib/site-intel/profile";
import { needsConfirmation } from "../src/lib/site-intel/types";

const FIX = join(process.cwd(), "tests", "fixtures", "site-intel");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

/** Serves fixtures by matching on the dataset in the query string. */
function fakeFetch(routes: Record<string, unknown>, fallback: unknown = fixture("empty.json")): FetchLike {
  return async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : fallback;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const failingFetch: FetchLike = async () => ({
  ok: false,
  status: 503,
  json: async () => ({}),
  text: async () => "upstream unavailable",
});

/* ------------------------------------------------------------------ geo --- */

describe("geo", () => {
  test("distanceM matches a known separation", () => {
    // Doncaster to Sheffield city centre, roughly 28 km.
    const d = distanceM({ lat: 53.5228, lon: -1.1285 }, { lat: 53.3811, lon: -1.4701 });
    assert.ok(d > 26_000 && d < 30_000, `expected ~28 km, got ${Math.round(d)} m`);
  });

  test("distanceM is zero for identical points", () => {
    assert.equal(distanceM({ lat: 53.5, lon: -1.1 }, { lat: 53.5, lon: -1.1 }), 0);
  });

  test("areaM2 approximates a small rectangle", () => {
    // ~0.001 deg lat (111 m) by 0.001 deg lon at 53.5N (~66 m) -> ~7,400 m2.
    const poly: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[
        [-1.122, 53.507], [-1.121, 53.507],
        [-1.121, 53.508], [-1.122, 53.508], [-1.122, 53.507],
      ]],
    };
    const area = areaM2(poly);
    assert.ok(area !== null && area > 6_000 && area < 9_000, `got ${area}`);
  });

  test("areaM2 subtracts holes", () => {
    const withHole: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [[-1.122, 53.507], [-1.121, 53.507], [-1.121, 53.508], [-1.122, 53.508], [-1.122, 53.507]],
        [[-1.1218, 53.5072], [-1.1212, 53.5072], [-1.1212, 53.5078], [-1.1218, 53.5078], [-1.1218, 53.5072]],
      ],
    };
    const solid = areaM2({ type: "Polygon", coordinates: [withHole.coordinates[0]] });
    const holed = areaM2(withHole);
    assert.ok(holed !== null && solid !== null && holed < solid);
  });

  test("areaM2 returns null for a point", () => {
    assert.equal(areaM2({ type: "Point", coordinates: [-1.1, 53.5] }), null);
  });

  test("pointInPolygon distinguishes inside from outside", () => {
    const poly = fixture("title-single.json").features[0].geometry as GeoJSON.Polygon;
    assert.equal(pointInPolygon({ lat: 53.5077, lon: -1.121 }, poly), true);
    assert.equal(pointInPolygon({ lat: 53.5000, lon: -1.121 }, poly), false);
  });

  test("pointInPolygon excludes holes", () => {
    const withHole: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [[-1.123, 53.506], [-1.120, 53.506], [-1.120, 53.509], [-1.123, 53.509], [-1.123, 53.506]],
        [[-1.1225, 53.5065], [-1.1205, 53.5065], [-1.1205, 53.5085], [-1.1225, 53.5085], [-1.1225, 53.5065]],
      ],
    };
    assert.equal(pointInPolygon({ lat: 53.5075, lon: -1.1215 }, withHole), false, "in hole");
    assert.equal(pointInPolygon({ lat: 53.5062, lon: -1.1215 }, withHole), true, "outside hole");
  });

  test("toWkt round-trips a polygon", () => {
    const wkt = toWkt(fixture("title-single.json").features[0].geometry);
    assert.match(wkt, /^POLYGON\(\(/);
    assert.ok(wkt.includes("-1.122 53.507"));
  });

  test("toWkt rejects unsupported geometry", () => {
    assert.throws(
      () => toWkt({ type: "LineString", coordinates: [[0, 0], [1, 1]] } as GeoJSON.Geometry),
      /unsupported geometry/,
    );
  });

  test("boxAround produces a box of roughly the requested half-width", () => {
    const box = boxAround({ lat: 53.5, lon: -1.1 }, 25);
    const [west, south, east] = [
      box.coordinates[0][0][0], box.coordinates[0][0][1], box.coordinates[0][1][0],
    ];
    const width = distanceM({ lat: south, lon: west }, { lat: south, lon: east });
    assert.ok(width > 40 && width < 60, `expected ~50 m across, got ${Math.round(width)}`);
  });

  test("normalisePostcode canonicalises spacing and case", () => {
    assert.equal(normalisePostcode("dn41ab"), "DN4 1AB");
    assert.equal(normalisePostcode("  SW1A   1AA "), "SW1A 1AA");
    assert.equal(normalisePostcode("not a postcode"), null);
  });

  test("extractPostcode finds a postcode inside an address", () => {
    assert.equal(extractPostcode("Unit 3, Carr Hill, Doncaster DN4 8DE"), "DN4 8DE");
    assert.equal(extractPostcode("Unit 3, Carr Hill"), null);
  });
});

/* -------------------------------------------------------------- sources --- */

describe("sources.yaml", () => {
  test("loads and exposes every source S-01 needs", () => {
    const sources = loadSources();
    for (const id of [
      "os-open-uprn", "os-code-point-open", "os-openmap-local",
      "planning-data-title-boundary", "planning-data-lpa",
    ]) {
      assert.ok(sources[id], `missing source ${id}`);
      assert.ok(sources[id].licence, `${id} has no licence`);
      assert.ok(sources[id].attribution, `${id} has no attribution`);
    }
  });

  test("renderAttribution substitutes the year and collapses whitespace", () => {
    const text = renderAttribution("os-open-uprn", 2026);
    assert.equal(text, "Contains OS data © Crown copyright and database right 2026");
    assert.ok(!text.includes("{year}"));
    assert.ok(!/\s{2,}/.test(text));
  });

  test("title boundary carries BOTH the HMLR and OS statements", () => {
    // Brief section 3.4 requires both; the OS licence number is the tell.
    const text = renderAttribution("planning-data-title-boundary", 2026);
    assert.match(text, /Open Government Licence v3\.0/);
    assert.match(text, /Ordnance Survey AC0000851063/);
    assert.match(text, /Crown copyright and database right/);
  });

  test("attributionsFor deduplicates shared OS wording", () => {
    const list = attributionsFor(["os-open-uprn", "os-code-point-open", "os-openmap-local"]);
    assert.equal(list.length, 1, "three OS products share one attribution string");
  });

  test("unverified attributions are reported, not silently trusted", () => {
    // Everything is unverified until checked against the live licence pages.
    assert.ok(unverifiedAttributions().includes("planning-data-title-boundary"));
  });

  test("unknown source ids fail loudly", () => {
    assert.throws(() => renderAttribution("does-not-exist"), /Unknown source id/);
  });

  test("ttlDays parses the refresh cadences in use", () => {
    assert.equal(ttlDays("planning-data-title-boundary"), 7);
    assert.equal(ttlDays("os-open-uprn"), 90);
    assert.equal(ttlDays("google-geocoding"), null);
  });

  test("records past their TTL are downgraded to stale", () => {
    const fresh = lineage({ sourceId: "planning-data-title-boundary", method: "test", tier: "T2" });
    assert.equal(applyStaleness(fresh).tier, "T2");

    const old = { ...fresh, retrievedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    assert.equal(applyStaleness(old).tier, "stale");
  });

  test("user overrides are never marked stale", () => {
    const override = lineage({ sourceId: "os-openmap-local", method: "user redrew", tier: "T4" });
    const old = { ...override, retrievedAt: new Date(Date.now() - 900 * 86_400_000).toISOString() };
    assert.equal(applyStaleness(old).tier, "T4");
  });
});

/* -------------------------------------------------------- planning data --- */

describe("planning.data client", () => {
  test("parses a FeatureCollection into entities", async () => {
    const entities = await entitiesByPoint(
      { lat: 53.5077, lon: -1.121, datasets: ["title-boundary"] },
      fakeFetch({ "title-boundary": fixture("title-single.json") }),
    );
    assert.equal(entities.length, 1);
    assert.equal(entities[0].reference, "SYK123456");
    assert.equal(entities[0].dataset, "title-boundary");
    assert.equal(entities[0].entryDate, "2026-04-02");
    assert.ok(entities[0].geometry);
  });

  test("repeats the dataset parameter rather than comma-joining", async () => {
    let seen = "";
    const spy: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => fixture("empty.json"), text: async () => "" };
    };
    await entitiesByPoint({ lat: 1, lon: 2, datasets: ["a", "b"] }, spy);
    assert.ok(seen.includes("dataset=a&dataset=b"), seen);
  });

  test("a non-ok response throws with the status", async () => {
    await assert.rejects(
      () => entitiesByPoint({ lat: 1, lon: 2, datasets: ["x"] }, failingFetch),
      /503/,
    );
  });

  test("checkSlugs names missing datasets instead of skipping them", async () => {
    const result = await checkSlugs(
      ["title-boundary", "not-a-real-dataset"],
      fakeFetch({ "dataset.json": fixture("dataset-list.json") }),
    );
    assert.deepEqual(result.present, ["title-boundary"]);
    assert.deepEqual(result.missing, ["not-a-real-dataset"]);
  });
});

/* -------------------------------------------------------------- resolve --- */

const DONCASTER: UprnPoint = { uprn: "100050000001", lat: 53.5077, lon: -1.1210, postcode: "DN4 8DE" };
const NEIGHBOUR: UprnPoint = { uprn: "100050000002", lat: 53.5078, lon: -1.1211, postcode: "DN4 8DE" };
const FAR: UprnPoint = { uprn: "100050000003", lat: 53.5200, lon: -1.1400, postcode: "DN2 1AA" };

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    uprns: {
      byUprn: async (uprn) => [DONCASTER, NEIGHBOUR, FAR].find((p) => p.uprn === uprn) ?? null,
      near: async () => [DONCASTER, NEIGHBOUR, FAR],
      byPostcode: async (pc) => [DONCASTER, NEIGHBOUR, FAR].filter((p) => p.postcode === pc),
    },
    postcodes: { centroid: async () => ({ lat: 53.5075, lon: -1.1215 }) },
    ...overrides,
  };
}

describe("resolution chain", () => {
  test("step b: an explicit UPRN resolves exact", async () => {
    const r = await resolve({ uprn: "100050000001" }, deps());
    assert.equal(r.step, "uprn");
    assert.equal(r.candidates[0].confidence, "exact");
    assert.equal(r.candidates[0].source.tier, "T1");
  });

  test("step b: an unknown UPRN explains itself", async () => {
    const r = await resolve({ uprn: "999" }, deps());
    assert.equal(r.candidates.length, 0);
    assert.match(r.reason ?? "", /not in OS Open UPRN/);
  });

  test("step e: a map click takes the nearest UPRN and excludes far ones", async () => {
    const r = await resolve({ point: { lat: 53.5077, lon: -1.1210 } }, deps());
    assert.equal(r.step, "click");
    assert.equal(r.candidates[0].uprn, "100050000001");
    assert.equal(r.candidates[0].confidence, "manual");
    // FAR is ~1.5 km away and must not appear inside a 25 m radius.
    assert.ok(!r.candidates.some((c) => c.uprn === FAR.uprn));
  });

  test("step e: a click with nothing within 25 m refuses and names the radius", async () => {
    // This is the message the Move pin control surfaces. A click beyond the
    // radius must change nothing: silently keeping the old pin would leave the
    // user believing the move worked, and storing the click itself would put a
    // coordinate on the profile that no register published.
    const r = await resolve({ point: { lat: 53.6000, lon: -1.3000 } }, deps());
    assert.equal(r.candidates.length, 0);
    assert.equal(r.step, "none");
    assert.match(r.reason ?? "", /No OS Open UPRN within 25 m/);
  });

  test("step e: candidates are ordered nearest first", async () => {
    const r = await resolve({ point: { lat: 53.50775, lon: -1.12105 } }, deps());
    const distances = r.candidates.map((c) => c.distanceM ?? 0);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  test("step e: nothing within the radius is reported, not guessed", async () => {
    const r = await resolve(
      { point: { lat: 50.0, lon: -3.0 } },
      deps({ uprns: { ...deps().uprns, near: async () => [] } }),
    );
    assert.equal(r.candidates.length, 0);
    assert.match(r.reason ?? "", /within 25 m/);
  });

  test("step a: the register yields exact, and beats the geocoder", async () => {
    let geocoded = false;
    const r = await resolve(
      { address: "Unit 3, Carr Hill, Doncaster DN4 8DE" },
      deps({
        register: { lookup: async () => [{ uprn: "100050000001", address: "Unit 3, Carr Hill", postcode: "DN4 8DE" }] },
        geocoder: { geocode: async () => { geocoded = true; return { lat: 0, lon: 0 }; } },
      }),
    );
    assert.equal(r.step, "register");
    assert.equal(r.candidates[0].confidence, "exact");
    assert.equal(geocoded, false, "geocoder must not be called once the register matched");
  });

  test("step a: register coordinates still come from OS Open UPRN", async () => {
    const r = await resolve(
      { address: "Unit 3, Carr Hill, Doncaster DN4 8DE" },
      deps({ register: { lookup: async () => [{ uprn: "100050000001", address: "x", postcode: null }] } }),
    );
    assert.equal(r.candidates[0].source.sourceId, "os-open-uprn");
    assert.equal(r.candidates[0].lat, DONCASTER.lat);
  });

  test("step d: a geocode yields probable candidates, never its own coordinates", async () => {
    const r = await resolve(
      { address: "Somewhere without a register entry, DN4 8DE" },
      deps({ geocoder: { geocode: async () => ({ lat: 53.5077, lon: -1.1210 }) } }),
    );
    assert.equal(r.step, "geocode");
    assert.equal(r.candidates[0].confidence, "probable");
    assert.equal(r.candidates[0].source.sourceId, "os-open-uprn");
  });

  test("step c: postcode only returns approximate candidates", async () => {
    const r = await resolve({ postcode: "dn4 8de" }, deps());
    assert.equal(r.step, "postcode");
    assert.ok(r.candidates.every((c) => c.confidence === "approximate"));
  });

  test("step c: with no UPRNs in the postcode, a centroid is offered to pin", async () => {
    const r = await resolve(
      { postcode: "DN4 8DE" },
      deps({ uprns: { ...deps().uprns, byPostcode: async () => [] } }),
    );
    assert.equal(r.candidates[0].uprn, null);
    assert.equal(r.candidates[0].source.sourceId, "os-code-point-open");
    assert.equal(r.candidates[0].confidence, "approximate");
  });

  test("an address with no register, geocoder or postcode explains why", async () => {
    const r = await resolve({ address: "nowhere in particular" }, deps());
    assert.equal(r.candidates.length, 0);
    assert.equal(r.step, "none");
    assert.ok(r.reason);
  });

  test("approximate, probable and manual all require confirmation; exact does not", () => {
    assert.equal(needsConfirmation("exact"), false);
    for (const c of ["probable", "approximate", "manual"] as const) {
      assert.equal(needsConfirmation(c), true, c);
    }
  });

  test("persisting Google-derived coordinates is refused", () => {
    const candidate = {
      uprn: null, lat: 1, lon: 2, postcode: null, address: null,
      confidence: "probable" as const, distanceM: null,
      source: lineage({ sourceId: "google-geocoding", method: "geocode", tier: "T3" }),
    };
    assert.throws(() => assertNoGoogleCoordinates(candidate), /Refusing to persist/);
  });
});

/* -------------------------------------------------------------- profile --- */

const exactCandidate = {
  uprn: "100050000001",
  lat: 53.5077,
  lon: -1.1210,
  postcode: "DN4 8DE",
  address: "Unit 3, Carr Hill",
  confidence: "exact" as const,
  distanceM: null,
  source: lineage({ sourceId: "os-open-uprn", entityRef: "100050000001", method: "test", tier: "T1" }),
};

const buildingPolygon: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [[
    [-1.1214, 53.5074], [-1.1206, 53.5074],
    [-1.1206, 53.5080], [-1.1214, 53.5080], [-1.1214, 53.5074],
  ]],
};

describe("profile", () => {
  const planningFetch = fakeFetch({
    "dataset=title-boundary": fixture("title-single.json"),
    "dataset=local-planning-authority": fixture("lpa-england.json"),
  });

  test("builds a profile with title, LPA and lineage", async () => {
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch });
    assert.equal(p.uprn, "100050000001");
    assert.equal(p.titleExtents.length, 1);
    assert.equal(p.lpaName, "Doncaster Metropolitan Borough Council");
    assert.equal(p.states["title-boundary"], "present");
    assert.ok(p.sources.length >= 3, "every layer contributes lineage");
  });

  test("country comes from the GSS code, authoritatively", async () => {
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch });
    assert.equal(p.country, "E");
    assert.ok(!p.flags.includes("country_inferred_from_postcode"));
  });

  test("countryFromGss reads the leading letter", () => {
    assert.equal(countryFromGss("E08000017"), "E");
    assert.equal(countryFromGss("W06000015"), "W");
    assert.equal(countryFromGss("S12000036"), "S");
    assert.equal(countryFromGss(null), null);
    assert.equal(countryFromGss("X123"), null);
  });

  test("countryFromPostcode only answers for unambiguous areas", () => {
    assert.equal(countryFromPostcode("EH1 1AA"), "S");
    assert.equal(countryFromPostcode("CF10 1AA"), "W");
    // CH, SY and NP straddle the border, so they must not be guessed.
    assert.equal(countryFromPostcode("CH1 1AA"), null);
    assert.equal(countryFromPostcode("SY1 1AA"), null);
    assert.equal(countryFromPostcode("DN4 8DE"), null);
  });

  test("multiple titles at a point raise multi_title and keep them all", async () => {
    const p = await buildProfile(exactCandidate, {
      fetchImpl: fakeFetch({ "dataset=title-boundary": fixture("title-multi.json") }),
    });
    assert.equal(p.titleExtents.length, 2);
    assert.ok(p.flags.includes("multi_title"));
  });

  test("no title is coverage-unknown, never a bare not-found", async () => {
    const p = await buildProfile(exactCandidate, { fetchImpl: fakeFetch({}) });
    assert.equal(p.states["title-boundary"], "not_found_coverage_unknown");
    assert.notEqual(p.states["title-boundary"], "not_found_coverage_complete");
  });

  test("a source failure is recorded as source_error, not silence", async () => {
    const p = await buildProfile(exactCandidate, { fetchImpl: failingFetch });
    assert.equal(p.states["title-boundary"], "source_error");
    assert.equal(p.titleExtents.length, 0);
  });

  test("a footprint containing the UPRN is a match, not an inference", async () => {
    const store: FootprintStore = {
      containing: async () => buildingPolygon,
      largestIntersecting: async () => null,
    };
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch, footprints: store });
    assert.equal(p.footprint.method, "uprn_contained");
    assert.ok((p.footprint.areaM2 ?? 0) > 0);
    assert.ok(!p.flags.includes("footprint_inferred"));
  });

  test("falling back to the title intersection flags footprint_inferred", async () => {
    const store: FootprintStore = {
      containing: async () => null,
      largestIntersecting: async () => buildingPolygon,
    };
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch, footprints: store });
    assert.equal(p.footprint.method, "title_intersect");
    assert.ok(p.flags.includes("footprint_inferred"));
  });

  test("without a footprint store the footprint is unavailable, not invented", async () => {
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch });
    assert.equal(p.footprint.method, "unavailable");
    assert.equal(p.footprint.geometry, null);
  });

  test("an unconfirmed match is flagged for confirmation", async () => {
    const p = await buildProfile(
      { ...exactCandidate, confidence: "probable" },
      { fetchImpl: planningFetch },
    );
    assert.ok(p.flags.includes("needs_confirmation"));
    assert.equal(p.userConfirmed, false);
  });

  test("confirming clears the flag and keeps the original lineage", async () => {
    const p = await buildProfile(
      { ...exactCandidate, confidence: "probable" },
      { fetchImpl: planningFetch },
    );
    const confirmed = applyOverride(p, { confirmed: true });
    assert.equal(confirmed.userConfirmed, true);
    assert.ok(!confirmed.flags.includes("needs_confirmation"));
    assert.ok(confirmed.sources.length >= p.sources.length, "original sources retained");
  });

  test("a redrawn footprint becomes T4 and clears the inferred flag", async () => {
    const store: FootprintStore = {
      containing: async () => null,
      largestIntersecting: async () => buildingPolygon,
    };
    const p = await buildProfile(exactCandidate, { fetchImpl: planningFetch, footprints: store });
    assert.ok(p.flags.includes("footprint_inferred"));

    const drawn = applyOverride(p, { footprint: buildingPolygon });
    assert.equal(drawn.footprint.method, "user_drawn");
    assert.ok(!drawn.flags.includes("footprint_inferred"));
    assert.equal(drawn.sources.at(-1)?.tier, "T4");
  });

  test("queryGeometry prefers the footprint and falls back to a single title", async () => {
    const withFootprint = await buildProfile(exactCandidate, {
      fetchImpl: planningFetch,
      footprints: { containing: async () => buildingPolygon, largestIntersecting: async () => null },
    });
    assert.equal(queryGeometry(withFootprint)?.basis, "footprint");

    const titleOnly = await buildProfile(exactCandidate, { fetchImpl: planningFetch });
    assert.equal(queryGeometry(titleOnly)?.basis, "title extent");

    const nothing = await buildProfile(exactCandidate, { fetchImpl: fakeFetch({}) });
    assert.equal(queryGeometry(nothing), null);
  });

  test("multiple titles are ambiguous, so no query geometry is chosen", async () => {
    const p = await buildProfile(exactCandidate, {
      fetchImpl: fakeFetch({ "dataset=title-boundary": fixture("title-multi.json") }),
    });
    assert.equal(queryGeometry(p), null, "ambiguous extent must not be guessed");
  });
});
