import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { areaM2, bounds, pointInPolygon, polygonsIntersect } from "../src/lib/site-intel/geo";
import { checkCrs, featureFromLine } from "../src/ingest/buildings-load";

/** A square. GeoJSON order is [lon, lat]. */
const square = (west: number, south: number, size: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[
    [west, south], [west + size, south], [west + size, south + size],
    [west, south + size], [west, south],
  ]],
});

const A = square(-1.12, 53.50, 0.001);

/* ------------------------------------------------------- intersection --- */

describe("polygon intersection", () => {
  test("overlapping polygons intersect", () => {
    assert.equal(polygonsIntersect(A, square(-1.1195, 53.5005, 0.001)), true);
  });

  test("disjoint polygons do not", () => {
    assert.equal(polygonsIntersect(A, square(-1.10, 53.50, 0.001)), false);
    assert.equal(polygonsIntersect(A, square(-1.12, 53.52, 0.001)), false);
  });

  test("a polygon wholly inside another intersects, both ways round", () => {
    // No edges cross here, so this is the case an edge-only test would miss.
    const inner = square(-1.1197, 53.5002, 0.0003);
    assert.equal(polygonsIntersect(A, inner), true);
    assert.equal(polygonsIntersect(inner, A), true);
  });

  test("a shared edge counts as intersecting", () => {
    // Two buildings on a party wall do touch, and for "which polygon
    // intersects this title extent" that is a hit.
    assert.equal(polygonsIntersect(A, square(-1.119, 53.50, 0.001)), true);
  });

  test("a shared corner counts", () => {
    assert.equal(polygonsIntersect(A, square(-1.119, 53.501, 0.001)), true);
  });

  test("bounding boxes overlapping is not enough", () => {
    // Two thin L-shaped-ish strips whose boxes overlap but which never meet.
    const horizontal: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[-1.12, 53.50], [-1.11, 53.50], [-1.11, 53.5001], [-1.12, 53.5001], [-1.12, 53.50]]],
    };
    const vertical: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[-1.115, 53.502], [-1.1149, 53.502], [-1.1149, 53.505], [-1.115, 53.505], [-1.115, 53.502]]],
    };
    const boxesOverlap = (() => {
      const a = bounds(horizontal);
      const b = bounds(vertical);
      return a !== null && b !== null && a[0] < b[2] && b[0] < a[2];
    })();
    assert.equal(boxesOverlap, true, "the test needs overlapping x ranges");
    assert.equal(polygonsIntersect(horizontal, vertical), false);
  });

  test("a multipolygon intersects if any part does", () => {
    const multi: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [square(-1.10, 53.50, 0.0005).coordinates, square(-1.1195, 53.5005, 0.0005).coordinates],
    };
    assert.equal(polygonsIntersect(A, multi), true);
  });

  test("null on either side is not an intersection", () => {
    assert.equal(polygonsIntersect(null, A), false);
    assert.equal(polygonsIntersect(A, null), false);
  });
});

/* ---------------------------------------------------------- containment --- */

describe("containment picks the right building", () => {
  test("a UPRN point inside the polygon is contained", () => {
    assert.equal(pointInPolygon({ lat: 53.5005, lon: -1.1195 }, A), true);
    assert.equal(pointInPolygon({ lat: 53.4990, lon: -1.1195 }, A), false);
  });

  test("area is computed so the largest can be ordered", () => {
    const small = areaM2(square(-1.12, 53.50, 0.0005));
    const large = areaM2(square(-1.12, 53.50, 0.002));
    assert.ok(small !== null && large !== null);
    assert.ok((large as number) > (small as number) * 10);
  });
});

/* ------------------------------------------------------------------ CRS --- */

describe("the projection trap", () => {
  test("British National Grid is refused, with the fix", () => {
    // BNG coordinates are metres — eastings around 400000. Loaded
    // unconverted they do not error, they just fall outside every bbox query
    // and silently match nothing.
    const check = checkCrs(430000, 400000, 430100, 400100);
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /British National Grid/);
    assert.match(check.reason ?? "", /EPSG:27700/);
    assert.match(check.reason ?? "", /ogr2ogr -t_srs EPSG:4326/);
  });

  test("WGS84 over the UK is accepted", () => {
    assert.equal(checkCrs(-1.12, 53.50, -1.119, 53.501).ok, true);
    assert.equal(checkCrs(-4.2, 57.48, -4.19, 57.49).ok, true);
  });

  test("valid lat/lng outside the British Isles is refused too", () => {
    // In range for WGS84, so the magnitude check passes — but a building in
    // Spain in a UK dataset means the wrong file, not a wrong projection.
    const check = checkCrs(2.15, 41.38, 2.16, 41.39);
    assert.equal(check.ok, false);
    assert.match(check.reason ?? "", /outside the British Isles/);
  });

  test("the two refusals give different reasons", () => {
    assert.notEqual(
      checkCrs(430000, 400000, 430100, 400100).reason,
      checkCrs(2.15, 41.38, 2.16, 41.39).reason,
    );
  });
});

/* -------------------------------------------------------- line parsing --- */

describe("streaming GeoJSON features", () => {
  test("a feature per line, with a trailing comma", () => {
    const line = '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[]},"properties":{"fid":"osgb1"}},';
    const f = featureFromLine(line);
    assert.ok(f);
    assert.equal((f?.properties as Record<string, unknown>).fid, "osgb1");
  });

  test("structural lines are not features", () => {
    assert.equal(featureFromLine('{"type":"FeatureCollection","features":['), null);
    assert.equal(featureFromLine("]}"), null);
    assert.equal(featureFromLine(""), null);
  });

  test("a feature with no geometry is not usable", () => {
    assert.equal(featureFromLine('{"type":"Feature","properties":{}}'), null);
  });
});
