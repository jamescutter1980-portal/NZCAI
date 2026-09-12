import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_VERTICES,
  SNAP_PX,
  candidatesFrom,
  insertAfter,
  midpoints,
  moveVertex,
  outerRing,
  removeVertex,
  snap,
  toPolygon,
  vertexAt,
  type Project,
  type Vertex,
} from "../src/lib/site-intel/draw";

const SQUARE: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [[[-1.12, 53.50], [-1.119, 53.50], [-1.119, 53.501], [-1.12, 53.501], [-1.12, 53.50]]],
};

/** A crude equirectangular projection: enough to measure screen distance. */
const project: Project = ([lng, lat]) => ({ x: lng * 100_000, y: lat * 100_000 });

/* -------------------------------------------------------------- rings --- */

describe("rings", () => {
  test("the closing duplicate is dropped for editing", () => {
    // A closing vertex that is really the first one again would show a handle
    // the user could drag away from its twin, silently unclosing the ring.
    const ring = outerRing(SQUARE);
    assert.equal(ring.length, 4);
    assert.notDeepEqual(ring[0], ring[ring.length - 1]);
  });

  test("a ring that is not explicitly closed is left alone", () => {
    const open: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1]]],
    };
    assert.equal(outerRing(open).length, 3);
  });

  test("a multipolygon edits its largest part, not a merge of all of them", () => {
    const multi: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
      ],
    };
    const ring = outerRing(multi);
    assert.equal(ring.length, 4, "expected the four-vertex part");
    assert.deepEqual(ring[0], [5, 5]);
  });

  test("nothing editable returns an empty ring", () => {
    assert.deepEqual(outerRing(null), []);
    assert.deepEqual(outerRing({ type: "Point", coordinates: [0, 0] } as GeoJSON.Geometry), []);
  });

  test("closing back to a polygon needs three vertices", () => {
    assert.equal(toPolygon([[0, 0], [1, 0]]), null);
    const poly = toPolygon([[0, 0], [1, 0], [1, 1]]);
    assert.equal(poly?.coordinates[0].length, 4, "closed ring repeats the first vertex");
    assert.deepEqual(poly?.coordinates[0][3], [0, 0]);
  });

  test("a ring survives a round trip", () => {
    const ring = outerRing(SQUARE);
    assert.deepEqual(outerRing(toPolygon(ring) as GeoJSON.Geometry), ring);
  });
});

/* ------------------------------------------------------------- editing --- */

describe("editing vertices", () => {
  const ring: Vertex[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

  test("a midpoint sits between each pair, including the closing edge", () => {
    const mids = midpoints(ring);
    assert.equal(mids.length, 4, "four edges, including the one back to the start");
    assert.deepEqual(mids[0].vertex, [0.5, 0]);
    assert.deepEqual(mids[3].vertex, [0, 0.5], "the closing edge gets a handle too");
  });

  test("inserting after an index lands in the right place", () => {
    const next = insertAfter(ring, 0, [0.5, 0]);
    assert.equal(next.length, 5);
    assert.deepEqual(next[1], [0.5, 0]);
    assert.deepEqual(next[2], [1, 0]);
  });

  test("moving a vertex replaces only that one", () => {
    const next = moveVertex(ring, 2, [9, 9]);
    assert.deepEqual(next[2], [9, 9]);
    assert.deepEqual(next[1], ring[1]);
    assert.notEqual(next, ring, "must not mutate the input");
  });

  test("moving an index that does not exist changes nothing", () => {
    assert.deepEqual(moveVertex(ring, 99, [9, 9]), ring);
    assert.deepEqual(moveVertex(ring, -1, [9, 9]), ring);
  });

  test("a delete that would destroy the polygon does nothing", () => {
    // The caller is a pointer handler. Throwing would be wrong; so would
    // quietly leaving a two-point "polygon" with no area.
    const triangle: Vertex[] = [[0, 0], [1, 0], [1, 1]];
    assert.equal(triangle.length, MIN_VERTICES);
    assert.deepEqual(removeVertex(triangle, 0), triangle);
  });

  test("a delete above the minimum removes the right vertex", () => {
    const next = removeVertex(ring, 1);
    assert.equal(next.length, 3);
    assert.deepEqual(next, [[0, 0], [1, 1], [0, 1]]);
  });
});

/* ------------------------------------------------------------ snapping --- */

describe("snapping", () => {
  const target: Vertex = [-1.119, 53.501];

  test("a vertex inside the threshold takes the target's EXACT coordinate", () => {
    // The point of snapping: shared party walls line up rather than
    // disagreeing by half a metre.
    const near: Vertex = [-1.1190001, 53.5010001];
    const result = snap(near, [{ vertex: target, source: "neighbour" }], project);
    assert.equal(result.snapped, true);
    assert.deepEqual(result.vertex, target);
    assert.equal(result.target?.source, "neighbour");
  });

  test("a vertex outside the threshold is returned untouched", () => {
    const far: Vertex = [-1.1180, 53.5020];
    const result = snap(far, [{ vertex: target, source: "neighbour" }], project);
    assert.equal(result.snapped, false);
    assert.deepEqual(result.vertex, far);
    assert.equal(result.target, null);
  });

  test("the threshold is screen pixels, so it follows the zoom", () => {
    const v: Vertex = [-1.11895, 53.501];
    const zoomedIn: Project = ([lng, lat]) => ({ x: lng * 1_000_000, y: lat * 1_000_000 });
    const zoomedOut: Project = ([lng, lat]) => ({ x: lng * 10_000, y: lat * 10_000 });

    // Same geographic gap: out of range when zoomed in, in range when out.
    assert.equal(snap(v, [{ vertex: target, source: "n" }], zoomedIn).snapped, false);
    assert.equal(snap(v, [{ vertex: target, source: "n" }], zoomedOut).snapped, true);
  });

  test("the nearest candidate wins", () => {
    const v: Vertex = [-1.11900, 53.50100];
    const result = snap(
      v,
      [
        { vertex: [-1.11902, 53.50102], source: "further" },
        { vertex: [-1.119001, 53.501001], source: "nearer" },
      ],
      project,
    );
    assert.equal(result.target?.source, "nearer");
  });

  test("no candidates is not a snap", () => {
    const v: Vertex = [0, 0];
    assert.deepEqual(snap(v, [], project), { vertex: v, snapped: false, target: null });
  });

  test("the default threshold is the exported one", () => {
    assert.equal(SNAP_PX, 12);
  });
});

/* ---------------------------------------------------------- candidates --- */

describe("snap candidates", () => {
  const neighbours = [{ geometry: SQUARE as GeoJSON.Geometry, label: "Neighbour" }];

  test("every neighbour vertex is offered, labelled", () => {
    const candidates = candidatesFrom(neighbours);
    assert.equal(candidates.length, 4, "the square's four corners, not its closing duplicate");
    assert.ok(candidates.every((c) => c.source === "Neighbour"));
  });

  test("no neighbours means no candidates, so nothing snaps", () => {
    assert.deepEqual(candidatesFrom([]), []);
  });

  test("several neighbours all contribute, each keeping its own label", () => {
    const other: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    };
    const candidates = candidatesFrom([
      ...neighbours,
      { geometry: other as GeoJSON.Geometry, label: "Other" },
    ]);
    assert.equal(candidates.length, 7);
    assert.equal(candidates.filter((c) => c.source === "Other").length, 3);
  });
});

/* --------------------------------------------------------------- hit test --- */

describe("grabbing a vertex", () => {
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001]];

  test("a pointer near a vertex grabs it", () => {
    assert.equal(vertexAt(ring, project([0, 0]), project), 0);
    assert.equal(vertexAt(ring, project([0.001, 0.001]), project), 2);
  });

  test("a pointer in open space grabs nothing", () => {
    assert.equal(vertexAt(ring, { x: 99_999, y: 99_999 }, project), -1);
  });

  test("the nearest vertex wins when two are close", () => {
    const close: Vertex[] = [[0, 0], [0.00005, 0]];
    assert.equal(vertexAt(close, project([0.00004, 0]), project), 1);
  });
});
