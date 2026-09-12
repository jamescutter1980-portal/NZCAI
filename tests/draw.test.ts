import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_VERTICES,
  SNAP_EDGE_PX,
  SNAP_PX,
  candidatesFrom,
  edgesFrom,
  insertAfter,
  midpoints,
  moveVertex,
  outerRing,
  removeVertex,
  snap,
  targetsFrom,
  toPolygon,
  vertexAt,
  type Project,
  type SnapCandidate,
  type SnapEdge,
  type SnapTargets,
  type Vertex,
} from "../src/lib/site-intel/draw";

const SQUARE: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [[[-1.12, 53.50], [-1.119, 53.50], [-1.119, 53.501], [-1.12, 53.501], [-1.12, 53.50]]],
};

/** A crude equirectangular projection: enough to measure screen distance. */
const project: Project = ([lng, lat]) => ({ x: lng * 100_000, y: lat * 100_000 });

/** Corners only, for the cases that are not about walls. */
const corners = (...vertices: SnapCandidate[]): SnapTargets => ({ vertices, edges: [] });
/** Walls only, for the cases that are not about corners. */
const walls = (...edges: SnapEdge[]): SnapTargets => ({ vertices: [], edges });

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
    const result = snap(near, corners({ vertex: target, source: "neighbour" }), project);
    assert.equal(result.snapped, true);
    assert.deepEqual(result.vertex, target);
    assert.equal(result.target?.source, "neighbour");
  });

  test("a vertex outside the threshold is returned untouched", () => {
    const far: Vertex = [-1.1180, 53.5020];
    const result = snap(far, corners({ vertex: target, source: "neighbour" }), project);
    assert.equal(result.snapped, false);
    assert.deepEqual(result.vertex, far);
    assert.equal(result.target, null);
  });

  test("the threshold is screen pixels, so it follows the zoom", () => {
    const v: Vertex = [-1.11895, 53.501];
    const zoomedIn: Project = ([lng, lat]) => ({ x: lng * 1_000_000, y: lat * 1_000_000 });
    const zoomedOut: Project = ([lng, lat]) => ({ x: lng * 10_000, y: lat * 10_000 });

    // Same geographic gap: out of range when zoomed in, in range when out.
    assert.equal(snap(v, corners({ vertex: target, source: "n" }), zoomedIn).snapped, false);
    assert.equal(snap(v, corners({ vertex: target, source: "n" }), zoomedOut).snapped, true);
  });

  test("the nearest candidate wins", () => {
    const v: Vertex = [-1.11900, 53.50100];
    const result = snap(
      v,
      corners(
        { vertex: [-1.11902, 53.50102], source: "further" },
        { vertex: [-1.119001, 53.501001], source: "nearer" },
      ),
      project,
    );
    assert.equal(result.target?.source, "nearer");
  });

  test("no candidates is not a snap", () => {
    const v: Vertex = [0, 0];
    assert.deepEqual(snap(v, corners(), project), {
      vertex: v,
      snapped: false,
      kind: "none",
      target: null,
      edge: null,
      source: null,
    });
  });

  test("a corner snap reports its kind and source", () => {
    const result = snap([-1.1190001, 53.501], corners({ vertex: target, source: "n" }), project);
    assert.equal(result.kind, "vertex");
    assert.equal(result.source, "n");
    assert.equal(result.edge, null);
  });

  test("the default threshold is the exported one", () => {
    assert.equal(SNAP_PX, 12);
  });
});

/* ------------------------------------------------------ snapping to walls --- */

describe("snapping to a wall", () => {
  // A wall running due east along latitude 53.501, from -1.120 to -1.119.
  // The projection above makes one degree 100,000 px, so 0.0001 deg = 10 px.
  const wall: SnapEdge = { a: [-1.120, 53.501], b: [-1.119, 53.501], source: "terrace" };

  test("a vertex near the middle of a wall lands ON the wall", () => {
    const near: Vertex = [-1.1195, 53.50105];   // 5 px north of the wall
    const result = snap(near, walls(wall), project);

    assert.equal(result.snapped, true);
    assert.equal(result.kind, "edge");
    assert.equal(result.source, "terrace");
    // Same longitude — it moved straight onto the wall, not along it.
    assert.equal(result.vertex[0], -1.1195);
    assert.ok(Math.abs(result.vertex[1] - 53.501) < 1e-12, "on the wall's latitude");
  });

  test("the wall that was taken comes back, for the indicator", () => {
    const result = snap([-1.1195, 53.50105], walls(wall), project);
    assert.deepEqual(result.edge, wall);
  });

  test("a vertex beyond the wall threshold is left alone", () => {
    // 9 px away: inside the corner threshold of 12, outside the wall's 8.
    const far: Vertex = [-1.1195, 53.50109];
    const result = snap(far, walls(wall), project);
    assert.equal(result.snapped, false);
    assert.deepEqual(result.vertex, far);
  });

  test("walls are tighter than corners on purpose", () => {
    // Not an arbitrary pair of numbers: a wall covers far more of the map than
    // a corner does, so it must be harder to stick to. The ordering also means
    // a wall snap can never land on a corner.
    assert.equal(SNAP_EDGE_PX, 8);
    assert.ok(SNAP_EDGE_PX < SNAP_PX);
  });

  test("a corner in range beats a wall in range", () => {
    // Dead on the wall, and 3 px from its end. Nearest-wins would take the
    // wall — a hair short of the corner the user was plainly aiming at.
    const near: Vertex = [-1.11903, 53.501];
    const result = snap(
      near,
      { vertices: [{ vertex: [-1.119, 53.501], source: "terrace" }], edges: [wall] },
      project,
    );
    assert.equal(result.kind, "vertex");
    assert.deepEqual(result.vertex, [-1.119, 53.501]);
  });

  test("a wall is taken when the corner is out of range", () => {
    // Mid-wall: 50 px from either end, 5 px from the wall itself.
    const near: Vertex = [-1.1195, 53.50105];
    const result = snap(
      near,
      { vertices: [{ vertex: [-1.119, 53.501], source: "terrace" }], edges: [wall] },
      project,
    );
    assert.equal(result.kind, "edge");
  });

  test("the point is clamped to the wall, never its infinite line", () => {
    // Well past the eastern end, and slightly off the line. Unclamped this
    // would snap to a point out in a field on the line's continuation.
    const beyond: Vertex = [-1.1185, 53.50105];
    const result = snap(beyond, walls(wall), project);
    assert.equal(result.snapped, false, "the end of the wall is 50 px away");
  });

  test("the nearest wall wins", () => {
    const other: SnapEdge = { a: [-1.120, 53.50108], b: [-1.119, 53.50108], source: "other" };
    const result = snap([-1.1195, 53.50105], walls(wall, other), project);
    assert.equal(result.source, "other", "3 px away beats 5 px away");
  });

  test("a zero-length wall does not produce NaN", () => {
    // A repeated coordinate in source data is not worth refusing, but dividing
    // by its length would poison the whole shape.
    const degenerate: SnapEdge = { a: [-1.119, 53.501], b: [-1.119, 53.501], source: "dup" };
    const result = snap([-1.1190, 53.50104], walls(degenerate), project);
    assert.ok(Number.isFinite(result.vertex[0]) && Number.isFinite(result.vertex[1]));
    assert.equal(result.snapped, true, "it behaves as the point it is");
    assert.deepEqual(result.vertex, [-1.119, 53.501]);
  });

  test("the snapped point lies exactly on the wall, not near it", () => {
    // The whole purpose: a party wall that agrees with the neighbour's, so the
    // two polygons share a line rather than disagreeing by half a metre.
    const diagonal: SnapEdge = { a: [0, 0], b: [0.001, 0.001], source: "diagonal" };
    const result = snap([0.0005, 0.00053], walls(diagonal), project);
    assert.equal(result.snapped, true);
    // On y = x, to floating-point exactness.
    assert.ok(Math.abs(result.vertex[0] - result.vertex[1]) < 1e-15);
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

  test("every wall is offered, including the closing side", () => {
    const edges = edgesFrom(neighbours);
    assert.equal(edges.length, 4, "four sides — the closing one is a wall too");
    assert.ok(edges.every((e) => e.source === "Neighbour"));
    // The last runs from the ring's final corner back to its first.
    assert.deepEqual(edges[3].a, [-1.12, 53.501]);
    assert.deepEqual(edges[3].b, [-1.12, 53.50]);
  });

  test("two corners are one wall, not the same wall twice", () => {
    const line: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] };
    assert.equal(edgesFrom([{ geometry: line as GeoJSON.Geometry, label: "L" }]).length, 1);
  });

  test("a single corner has no wall", () => {
    const dot: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[0, 0]]] };
    assert.deepEqual(edgesFrom([{ geometry: dot as GeoJSON.Geometry, label: "D" }]), []);
  });

  test("no neighbours means no walls either", () => {
    assert.deepEqual(edgesFrom([]), []);
    assert.deepEqual(targetsFrom([]), { vertices: [], edges: [] });
  });

  test("targetsFrom gathers both kinds from one list", () => {
    const targets = targetsFrom(neighbours);
    assert.equal(targets.vertices.length, 4);
    assert.equal(targets.edges.length, 4);
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
