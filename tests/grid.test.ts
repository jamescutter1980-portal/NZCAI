import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  asAreaGeometry,
  bboxForRadius,
  bboxOf,
  contains,
  haversineM,
  inBbox,
  type AreaGeometry,
} from "../src/lib/geo-polygon";
import {
  fixedCaveat,
  freshness,
  loadGridRules,
  ragFor,
  screen,
  summariseEcr,
  unapprovedGridRules,
  type EcrEntry,
} from "../src/lib/site-intel/grid-screen";
import { levelFromVoltage, normaliseEcrStatus } from "../src/ingest/adapters/base";
import { chooseResource, normaliseLevel, parseCsvRecords, pick } from "../src/ingest/adapters/ckan";
import { firstString, matchDno } from "../src/ingest/dno-boundaries";

const NOW = new Date("2026-09-12T00:00:00Z");

/* ------------------------------------------------------ point in polygon --- */

/** A unit square around Doncaster, roughly. GeoJSON order is [lng, lat]. */
const SQUARE: AreaGeometry = {
  type: "Polygon",
  coordinates: [[[-1.5, 53.4], [-0.5, 53.4], [-0.5, 53.8], [-1.5, 53.8], [-1.5, 53.4]]],
};

/** The same square with a hole in the middle. */
const WITH_HOLE: AreaGeometry = {
  type: "Polygon",
  coordinates: [
    [[-1.5, 53.4], [-0.5, 53.4], [-0.5, 53.8], [-1.5, 53.8], [-1.5, 53.4]],
    [[-1.1, 53.55], [-0.9, 53.55], [-0.9, 53.65], [-1.1, 53.65], [-1.1, 53.55]],
  ],
};

describe("point in polygon", () => {
  test("a point inside is inside", () => {
    assert.equal(contains(SQUARE, 53.6, -1.0), true);
  });

  test("a point outside is outside", () => {
    assert.equal(contains(SQUARE, 53.9, -1.0), false);
    assert.equal(contains(SQUARE, 53.6, -2.0), false);
  });

  test("arguments are lat then lng, and transposing them changes the answer", () => {
    // Every UK latitude is also a plausible longitude, so a transposed pair
    // does not throw - it silently answers about somewhere else.
    assert.equal(contains(SQUARE, 53.6, -1.0), true);
    assert.equal(contains(SQUARE, -1.0, 53.6), false);
  });

  test("a point in a hole is outside the polygon", () => {
    // A licence area can enclose another. Reporting the enclosing DNO for a
    // site inside the hole would be a wrong answer, not a missing one.
    assert.equal(contains(WITH_HOLE, 53.6, -1.0), false);
    assert.equal(contains(WITH_HOLE, 53.45, -1.0), true);
  });

  test("a multipolygon is inside if any part contains the point", () => {
    const multi: AreaGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[-1.5, 53.4], [-1.4, 53.4], [-1.4, 53.5], [-1.5, 53.5], [-1.5, 53.4]]],
        [[[0.0, 51.4], [0.1, 51.4], [0.1, 51.5], [0.0, 51.5], [0.0, 51.4]]],
      ],
    };
    assert.equal(contains(multi, 53.45, -1.45), true);
    assert.equal(contains(multi, 51.45, 0.05), true);
    assert.equal(contains(multi, 52.0, -0.5), false);
  });

  test("a vertex-crossing ray does not double count", () => {
    // A triangle whose apex sits at the test latitude: a naive crossing test
    // counts the vertex twice and reports outside.
    const triangle: AreaGeometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 2], [4, 0], [0, 0]]],
    };
    assert.equal(contains(triangle, 1, 2), true);
  });

  test("bbox is computed over every ring", () => {
    const box = bboxOf(SQUARE);
    assert.deepEqual(box, { minLat: 53.4, maxLat: 53.8, minLng: -1.5, maxLng: -0.5 });
    assert.equal(inBbox(box, 53.6, -1.0), true);
    assert.equal(inBbox(box, 54.0, -1.0), false);
  });

  test("asAreaGeometry rejects anything that is not a polygon", () => {
    assert.equal(asAreaGeometry({ type: "Point", coordinates: [0, 0] }), null);
    assert.equal(asAreaGeometry(null), null);
    assert.equal(asAreaGeometry({ type: "Polygon" }), null);
    assert.ok(asAreaGeometry(SQUARE));
  });
});

/* ------------------------------------------------------------- distance --- */

describe("distance", () => {
  test("haversine is symmetric and roughly right", () => {
    // Doncaster to Sheffield is about 30 km.
    const d = haversineM(53.52, -1.13, 53.38, -1.47);
    assert.ok(d > 25_000 && d < 35_000, `got ${Math.round(d)} m`);
    assert.equal(Math.round(d), Math.round(haversineM(53.38, -1.47, 53.52, -1.13)));
  });

  test("the radius box widens in longitude with latitude", () => {
    // The flat 111.32 km/degree used elsewhere makes the box too NARROW in
    // longitude at UK latitudes, which silently drops candidates at its edge.
    const { dLat, dLng } = bboxForRadius(53.5, 10_000);
    assert.ok(dLng > dLat, `expected a wider longitude delta, got ${dLng} vs ${dLat}`);
    assert.ok(dLng > 0.13 && dLng < 0.2, `got ${dLng}`);
  });

  test("the box does not diverge at the pole", () => {
    assert.ok(Number.isFinite(bboxForRadius(90, 10_000).dLng));
  });
});

/* ---------------------------------------------------------------- rules --- */

describe("grid rules config", () => {
  const rules = loadGridRules();

  test("the brief's own figures are the ones in the file", () => {
    assert.equal(rules.staleness.stale_after_days, 90);
    assert.equal(rules.ecr.radius_m, 2000);
    assert.equal(rules.ecr.min_export_kw, 50);
  });

  test("the G98/G99 values are null, not guessed", () => {
    // Writing a connection threshold from memory is how you ship a wrong
    // answer about someone's grid application. Null fails loudly.
    assert.equal(rules.connection_thresholds.verified, false);
    assert.equal(rules.connection_thresholds.g98_max_kw_per_phase, null);
    assert.equal(rules.connection_thresholds.g99_applies_above, null);
    assert.match(rules.connection_thresholds.source, /PLACEHOLDER/);
  });

  test("nothing is approved yet", () => {
    const unapproved = unapprovedGridRules();
    assert.ok(unapproved.includes("meta"));
    assert.ok(unapproved.includes("rag_bands"));
    assert.ok(unapproved.includes("wording"));
    assert.ok(unapproved.length >= 8, `got ${unapproved.length}`);
  });

  test("the fixed caveat is the brief's wording", () => {
    const text = fixedCaveat("Northern Powergrid", "2026-06-01");
    assert.match(text, /^Indicative only/);
    assert.match(text, /Not a connection offer/);
    assert.match(text, /connection application to Northern Powergrid is required/);
    assert.match(text, /01\/06\/2026/);
  });

  test("the caveat still appears when the date is unknown", () => {
    const text = fixedCaveat(null, null);
    assert.match(text, /an unstated date/);
    assert.match(text, /the relevant DNO/);
  });
});

/* ------------------------------------------------------------------ RAG --- */

describe("RAG bands", () => {
  const bands = { green_mva: 10, amber_mva: 2 };

  test("bands apply at their boundaries", () => {
    assert.equal(ragFor(10, bands), "green");
    assert.equal(ragFor(9.99, bands), "amber");
    assert.equal(ragFor(2, bands), "amber");
    assert.equal(ragFor(1.99, bands), "red");
    assert.equal(ragFor(0, bands), "red");
  });

  test("no published headroom is null, never red", () => {
    // Red means constrained. Absent means unknown, and they are different.
    assert.equal(ragFor(null, bands), null);
    assert.equal(ragFor(NaN, bands), null);
  });
});

/* -------------------------------------------------------------- freshness --- */

describe("freshness", () => {
  test("measured against the publisher's date, not our fetch date", () => {
    // Fetching old data today does not make it fresh.
    const f = freshness("2026-01-01", "2026-09-11T00:00:00Z", NOW);
    assert.equal(f.basis, "published");
    assert.equal(f.stale, true);
    assert.equal(f.tier, "stale");
    assert.match(f.warning ?? "", /older than 90 days/);
  });

  test("falls back to the ingest date only when no source date exists", () => {
    const f = freshness(null, "2026-09-01T00:00:00Z", NOW);
    assert.equal(f.basis, "ingested");
    assert.equal(f.stale, false);
    assert.equal(f.tier, "T2");
  });

  test("no date at all is unknown, not fresh", () => {
    const f = freshness(null, null, NOW);
    assert.equal(f.basis, "unknown");
    assert.equal(f.stale, false);
    assert.match(f.warning ?? "", /age of this figure is unknown/);
  });

  test("the boundary is exclusive at exactly 90 days", () => {
    assert.equal(freshness("2026-06-14", null, NOW).stale, false);
    assert.equal(freshness("2026-06-13", null, NOW).stale, true);
  });
});

/* -------------------------------------------------------------- screens --- */

describe("screens — unrated is a fourth state", () => {
  test("no proposed figure leaves the screen unrated, and says why", () => {
    const s = screen("pv_export", 12, null);
    assert.equal(s.result, "unrated");
    assert.match(s.explanation, /Not assessed/);
    assert.match(s.explanation, /No proposed export capacity/);
  });

  test("no published headroom leaves the screen unrated", () => {
    const s = screen("pv_export", null, 3);
    assert.equal(s.result, "unrated");
    assert.match(s.explanation, /No published headroom/);
  });

  test("unrated never reads as a pass", () => {
    // The dangerous simplification is collapsing unrated into green.
    const s = screen("electrification", null, null);
    assert.equal(s.result, "unrated");
    assert.ok(!/green|fine|ok|acceptable/i.test(s.explanation), s.explanation);
    assert.match(s.explanation, /absence of assessment/);
  });

  test("a proposal well inside headroom is green", () => {
    const s = screen("pv_export", 10, 3);
    assert.equal(s.result, "green");
    assert.equal(s.fraction, 30);
  });

  test("the band boundaries are the configured fractions", () => {
    assert.equal(screen("pv_export", 10, 5).result, "green");
    assert.equal(screen("pv_export", 10, 5.1).result, "amber");
    assert.equal(screen("pv_export", 10, 9).result, "amber");
    assert.equal(screen("pv_export", 10, 9.1).result, "red");
  });

  test("zero headroom is red, not a division by zero", () => {
    const s = screen("pv_export", 0, 3);
    assert.equal(s.result, "red");
    assert.equal(s.fraction, null);
    assert.match(s.explanation, /none of the proposed/);
  });
});

/* ------------------------------------------------------------------ ECR --- */

function ecr(over: Partial<EcrEntry> = {}): EcrEntry {
  return {
    sourceRef: "E1", siteName: "Solar Farm", technology: "Solar",
    status: "connected", exportMva: 5, importMva: null,
    lat: 53.5, lng: -1.1, distanceM: 800, sourceDate: "2026-06-01",
    ...over,
  };
}

describe("ECR summary", () => {
  test("totals by technology and by status", () => {
    const s = summariseEcr([
      ecr({ technology: "Solar", exportMva: 5, status: "connected" }),
      ecr({ technology: "Solar", exportMva: 2.5, status: "accepted" }),
      ecr({ technology: "Wind", exportMva: 10, status: "connected" }),
    ]);
    assert.equal(s.totalExportMva, 17.5);
    assert.deepEqual(s.byTechnology[0], { technology: "Wind", count: 1, exportMva: 10 });
    assert.equal(s.byTechnology.find((t) => t.technology === "Solar")?.exportMva, 7.5);
    assert.equal(s.byStatus.find((x) => x.status === "connected")?.exportMva, 15);
  });

  test("an unmapped technology is its own bucket, not folded into a named one", () => {
    const s = summariseEcr([ecr({ technology: null, exportMva: 4 })]);
    assert.equal(s.byTechnology[0].technology, "unknown");
  });

  test("the radius and floor come from config", () => {
    const s = summariseEcr([]);
    assert.equal(s.radiusM, 2000);
    assert.equal(s.minExportKw, 50);
    assert.equal(s.totalExportMva, 0);
  });
});

/* -------------------------------------------------------------- adapters --- */

describe("adapter helpers", () => {
  test("level is derived only where voltage is unambiguous", () => {
    assert.equal(levelFromVoltage(400), "GSP");
    assert.equal(levelFromVoltage(132), "BSP");
    assert.equal(levelFromVoltage(33), "primary");
    assert.equal(levelFromVoltage(0.4), "secondary");
    // The overlapping range returns null rather than picking.
    assert.equal(levelFromVoltage(11), null);
    assert.equal(levelFromVoltage(null), null);
  });

  test("a stated level is mapped onto the brief's four values", () => {
    assert.equal(normaliseLevel("Grid Supply Point"), "GSP");
    assert.equal(normaliseLevel("Bulk Supply Point"), "BSP");
    assert.equal(normaliseLevel("Primary Substation"), "primary");
    assert.equal(normaliseLevel("Something else"), null);
  });

  test("ECR status normalises, and anything unrecognised is unknown", () => {
    assert.equal(normaliseEcrStatus("Connected"), "connected");
    assert.equal(normaliseEcrStatus("Accepted to Connect"), "accepted");
    assert.equal(normaliseEcrStatus("Offer Made"), "accepted");
    assert.equal(normaliseEcrStatus("Withdrawn"), "unknown");
    assert.equal(normaliseEcrStatus(null), "unknown");
  });

  test("'not connected' is not read as connected", () => {
    assert.equal(normaliseEcrStatus("Not Connected"), "unknown");
  });

  test("an offer to connect is not a connection", () => {
    // The stem "connect" appears in both. Reading "Accepted to Connect" as
    // connected puts generation on the network that is not there yet, which
    // understates the headroom a screen would find.
    assert.equal(normaliseEcrStatus("Accepted to Connect"), "accepted");
    assert.equal(normaliseEcrStatus("Due to be connected"), "unknown");
    assert.equal(normaliseEcrStatus("Connected"), "connected");
  });
});

describe("CKAN adapter", () => {
  test("picks the most recent CSV resource, not the first thing listed", () => {
    const chosen = chooseResource([
      { name: "Guidance", format: "PDF", url: "a.pdf" },
      { name: "Data 2025", format: "CSV", url: "b.csv", last_modified: "2025-01-01" },
      { name: "Data 2026", format: "CSV", url: "c.csv", last_modified: "2026-06-01" },
    ]);
    assert.equal(chosen?.url, "c.csv");
  });

  test("a package with no CSV returns null rather than a PDF", () => {
    assert.equal(chooseResource([{ name: "Guidance", format: "PDF", url: "a.pdf" }]), null);
  });

  test("records are keyed by lower-cased header", () => {
    const rows = parseCsvRecords('Substation Name,Voltage\n"Carr Hill",33');
    assert.deepEqual(rows, [{ "substation name": "Carr Hill", voltage: "33" }]);
  });

  test("pick matches ignoring case and separators", () => {
    const row = { "substation name": "Carr Hill", "generation_headroom_mva": "12.5" };
    assert.equal(pick(row, ["substationname"]), "Carr Hill");
    assert.equal(pick(row, ["GenerationHeadroomMVA"]), "12.5");
    assert.equal(pick(row, ["nope"]), null);
  });
});

/* ------------------------------------------------------------ boundaries --- */

describe("DNO boundary matching", () => {
  test("known licence areas map to registry ids", () => {
    assert.equal(matchDno("UK Power Networks (South Eastern)"), "ukpn");
    assert.equal(matchDno("Northern Powergrid (Yorkshire)"), "npg");
    assert.equal(matchDno("Electricity North West"), "enwl");
    assert.equal(matchDno("SP Distribution"), "spen");
    assert.equal(matchDno("National Grid Electricity Distribution (Midlands)"), "nged");
  });

  test("an unknown area returns null rather than a nearest guess", () => {
    // A wrong DNO on a connection enquiry is worse than no DNO.
    assert.equal(matchDno("Some Independent Network"), null);
  });

  test("firstString takes the first non-empty candidate key", () => {
    assert.equal(firstString({ Name: "", name: "Second" }, ["Name", "name"]), "Second");
    assert.equal(firstString({ id: 7 }, ["id"]), "7");
    assert.equal(firstString({}, ["Name"]), null);
  });
});

/* ---------------------------------------------------- validator shapes --- */

describe("coordinate validation — the bug that shipped and was caught", () => {
  // The grid route originally reused one "non-negative number" helper for
  // capacities AND coordinates. Most of Great Britain has a negative
  // longitude, so every site west of Greenwich became NaN, and the
  // point-in-polygon then reported "no DNO contains this point" - a confident
  // wrong answer rather than an error. These assert the two shapes differ.
  const capacity = (raw: string | null): number | null => {
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  const coordinate = (raw: string | null, limit: number): number | null => {
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
  };

  test("a negative longitude is valid and a negative capacity is not", () => {
    assert.equal(coordinate("-1.115", 180), -1.115);
    assert.ok(Number.isNaN(capacity("-4")));
  });

  test("out-of-range coordinates are rejected", () => {
    assert.ok(Number.isNaN(coordinate("999", 90)));
    assert.ok(Number.isNaN(coordinate("-200", 180)));
    assert.equal(coordinate("53.505", 90), 53.505);
  });

  test("an absent parameter stays null, distinct from invalid", () => {
    assert.equal(coordinate(null, 90), null);
    assert.equal(capacity(null), null);
  });
});
