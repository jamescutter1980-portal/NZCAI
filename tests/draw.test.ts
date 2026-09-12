import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DRAG_START_PX,
  GRAB_EDGE_PX,
  MIN_VERTICES,
  SNAP_EDGE_PX,
  SNAP_PX,
  ALIGN_PX,
  candidatesFrom,
  edgeAt,
  edgesFrom,
  hingesForAppend,
  hingesForEdge,
  hingesForVertex,
  linesForAppend,
  linesForEdge,
  linesForVertex,
  insertAfter,
  midpoints,
  moveEdge,
  moveVertex,
  outerRing,
  removeVertex,
  snap,
  snapDraggedEdge,
  targetsFrom,
  toPolygon,
  vertexAt,
  type Project,
  type AlignHinge,
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

/** Degrees are small and sums of them are not exact; compare to a micron. */
const close = (got: Vertex, want: Vertex, why = "") => {
  assert.ok(
    Math.abs(got[0] - want[0]) < 1e-12 && Math.abs(got[1] - want[1]) < 1e-12,
    `${why} expected [${want}], got [${got}]`,
  );
};

/** Corners only, for the cases that are not about walls. */
const corners = (...vertices: SnapCandidate[]): SnapTargets => ({ vertices, edges: [] });
/** Walls only, for the cases that are not about corners. */
const walls = (...edges: SnapEdge[]): SnapTargets => ({ vertices: [], edges });
/** Bearings to align to, with no lines offered. */
const bearings = (...hinges: AlignHinge[]) => ({ hinges, lines: [] });
/** Lines to sit on, with no bearings offered. */
const onLines = (...lines: SnapEdge[]) => ({ hinges: [], lines });

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
      align: null,
      line: null,
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

/* --------------------------------------------------------- dragging a wall --- */

describe("grabbing a wall", () => {
  // A unit square, 100,000 px to the degree under `project`.
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];

  test("a pointer on a wall grabs it, indexed from its first corner", () => {
    // Halfway along the south wall, which runs from vertex 0 to vertex 1.
    assert.equal(edgeAt(ring, project([0.0005, 0]), project), 0);
    // The east wall, from vertex 1 to vertex 2.
    assert.equal(edgeAt(ring, project([0.001, 0.0005]), project), 1);
  });

  test("the closing wall is grabbable like any other", () => {
    // From the last corner back to the first: a side, not a seam.
    assert.equal(edgeAt(ring, project([0, 0.0005]), project), 3);
  });

  test("a pointer in open space grabs nothing", () => {
    assert.equal(edgeAt(ring, project([0.0005, 0.0005]), project), -1);
  });

  test("the nearest wall wins where two are close", () => {
    // Near the south-east corner, both walls are within the threshold; the
    // one actually under the pointer is the one that gets grabbed.
    assert.equal(edgeAt(ring, { x: 99.97, y: 10 }, project), 1, "hard against the east wall");
    assert.equal(edgeAt(ring, { x: 90, y: 0.03 }, project), 0, "hard against the south wall");
  });

  test("the grab threshold is the exported one", () => {
    assert.equal(GRAB_EDGE_PX, 8);
    // Below it a press is still a click, which is what inserts a vertex.
    assert.equal(DRAG_START_PX, 3);
  });

  test("two corners make one grabbable wall, not two", () => {
    const line: Vertex[] = [[0, 0], [0.001, 0]];
    assert.equal(edgeAt(line, project([0.0005, 0]), project), 0);
  });

  test("a single corner has no wall to grab", () => {
    assert.equal(edgeAt([[0, 0]], project([0, 0]), project), -1);
  });
});

describe("moving a wall", () => {
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];

  test("both ends move, and nothing else does", () => {
    const next = moveEdge(ring, 0, [0.0002, 0.0003]);
    close(next[0], [0.0002, 0.0003]);
    close(next[1], [0.0012, 0.0003]);
    assert.deepEqual(next[2], ring[2], "untouched");
    assert.deepEqual(next[3], ring[3], "untouched");
  });

  test("the wall keeps its length and its angle", () => {
    // The whole reason to drag a wall rather than its two corners: moving them
    // separately cannot help but change the wall.
    const before = [ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]];
    const next = moveEdge(ring, 0, [0.0002, -0.0009]);
    const after = [next[1][0] - next[0][0], next[1][1] - next[0][1]];
    assert.deepEqual(after, before);
  });

  test("the closing wall carries the last corner and the first", () => {
    const next = moveEdge(ring, 3, [0.0005, 0]);
    close(next[3], [0.0005, 0.001]);
    close(next[0], [0.0005, 0]);
    assert.deepEqual(next[1], ring[1]);
  });

  test("an index off the end changes nothing", () => {
    assert.equal(moveEdge(ring, 9, [1, 1]), ring);
    assert.equal(moveEdge(ring, -1, [1, 1]), ring);
  });
});

describe("snapping a wall that is being dragged", () => {
  // The wall being dragged: 100 px long, running east.
  const A: Vertex = [0, 0];
  const B: Vertex = [0.001, 0];

  test("a snap moves the WHOLE wall, keeping it rigid", () => {
    // A target 5 px north of the wall's west end.
    const corner: Vertex = [0, 0.00005];
    const out = snapDraggedEdge(A, B, corners({ vertex: corner, source: "n" }), project);

    assert.equal(out.result.snapped, true);
    assert.deepEqual(out.a, corner);
    // The far end moved by the same delta — same length, same angle.
    close(out.b, [0.001, 0.00005]);
  });

  test("the far end can be the one that snaps", () => {
    const corner: Vertex = [0.001, 0.00005];
    const out = snapDraggedEdge(A, B, corners({ vertex: corner, source: "n" }), project);
    assert.deepEqual(out.b, corner);
    close(out.a, [0, 0.00005]);
  });

  test("the nearer end wins when both are in range", () => {
    // West end 6 px from its target, east end 2 px from its own.
    const out = snapDraggedEdge(
      A, B,
      corners(
        { vertex: [0, 0.00006], source: "west" },
        { vertex: [0.001, 0.00002], source: "east" },
      ),
      project,
    );
    assert.equal(out.result.source, "east");
    assert.deepEqual(out.b, [0.001, 0.00002]);
    close(out.a, [0, 0.00002], "the west end came along, it did not stay put");
  });

  test("the ends are never pulled to different targets", () => {
    /*
     * Two targets, one at each end, both in range. Snapping the ends
     * independently would put each on its own and SHEAR the wall — which is
     * exactly what dragging the two corners already does, and the reason to
     * have a separate gesture at all.
     */
    const out = snapDraggedEdge(
      A, B,
      corners(
        { vertex: [0, 0.00004], source: "west" },
        { vertex: [0.001, -0.00005], source: "east" },
      ),
      project,
    );
    const length = Math.hypot(out.b[0] - out.a[0], out.b[1] - out.a[1]);
    assert.ok(Math.abs(length - 0.001) < 1e-15, "same length");
    assert.ok(Math.abs(out.b[1] - out.a[1]) < 1e-15, "still horizontal");
  });

  test("nothing in range leaves the wall exactly where it was", () => {
    const out = snapDraggedEdge(A, B, corners({ vertex: [0, 0.001], source: "far" }), project);
    assert.equal(out.result.snapped, false);
    assert.deepEqual(out.a, A);
    assert.deepEqual(out.b, B);
  });

  test("a wall snaps onto a neighbour's wall too", () => {
    const target = { a: [-0.001, 0.00005] as Vertex, b: [0.002, 0.00005] as Vertex, source: "terrace" };
    const out = snapDraggedEdge(A, B, walls(target), project);
    assert.equal(out.result.kind, "edge");
    assert.deepEqual(out.result.edge, target);
    assert.equal(out.a[1], 0.00005, "flush against it");
    assert.equal(out.b[1], 0.00005);
  });
});

/* ------------------------------------------------------- right angles --- */

/*
 * `project` is 100,000 px to the degree in BOTH axes, which is not what the
 * globe does. Squaring works in a frame where longitude is scaled by
 * cos(latitude), so these run at the equator, where the two agree and a
 * screen distance is a real one. The latitude case is covered separately.
 */
describe("squaring a corner", () => {
  // A wall running east from the origin to the pivot at (0.001, 0). The wall
  // already standing at the pivot runs back to the origin, so `adjoining` and
  // the reference are the same vertex: the square-to-the-wall-beside-it case.
  const pivot: Vertex = [0.001, 0];
  const origin: Vertex = [0, 0];
  const hinge: AlignHinge = { pivot, reference: [pivot, origin], adjoining: origin };
  const square = (v: Vertex) => snap(v, corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));

  test("a corner a little off square is pulled square", () => {
    // Almost due north of the pivot, leaning 4 px east.
    const result = square([0.001004, 0.0001]);
    assert.equal(result.snapped, true);
    assert.equal(result.kind, "align");
    assert.deepEqual(result.align, hinge);
    // Due north of the pivot: the wall now meets the reference wall at 90°.
    assert.ok(Math.abs(result.vertex[0] - pivot[0]) < 1e-15, "same longitude as the pivot");
  });

  test("the wall keeps the length the user chose", () => {
    // Only the bearing is corrected; the vertex slides along an arc.
    const raw: Vertex = [0.001004, 0.0001];
    const before = Math.hypot(raw[0] - pivot[0], raw[1] - pivot[1]);
    const result = square(raw);
    const after = Math.hypot(result.vertex[0] - pivot[0], result.vertex[1] - pivot[1]);
    assert.ok(Math.abs(after - before) < 1e-15, `${before} -> ${after}`);
  });

  test("a corner well off square is left alone", () => {
    // 100 px out from the pivot and 8.5° off square, which is 15 px of
    // correction — plainly not aiming at a right angle.
    const raw: Vertex = [0.00115, 0.001];
    const result = square(raw);
    assert.equal(result.snapped, false);
    assert.deepEqual(result.vertex, raw);
  });

  test("the tolerance is a DISTANCE, so it narrows as the wall gets longer", () => {
    /*
     * The threshold is 8 px of correction, not 8° of angle. The same angular
     * error is a bigger correction further from the pivot, so a long wall has
     * to be aimed more precisely than a short one — which is right: on a short
     * wall you cannot see the angle anyway, and on a long one you can.
     */
    const offBy = (dLng: number, dLat: number): boolean =>
      square([pivot[0] + dLng, pivot[1] + dLat]).snapped;

    // ~7° off square, close in: 1.2 px of correction, taken.
    assert.equal(offBy(0.0000123, 0.0001), true);
    // The same ~7° off square, ten times further out: 12 px, refused.
    assert.equal(offBy(0.000123, 0.001), false);
  });

  test("both square corners are offered, not just the first", () => {
    assert.equal(square([0.001004, 0.0001]).kind, "align", "north of the pivot");
    assert.equal(square([0.001004, -0.0001]).kind, "align", "south of it");
  });

  test("two walls running straight on is a right angle's half turn", () => {
    // Continuing east past the pivot: a legitimate shape, and the vertex is
    // still placed exactly on the line.
    const result = square([0.002, 0.000004]);
    assert.equal(result.kind, "align");
    assert.ok(Math.abs(result.vertex[1]) < 1e-15, "back on the reference wall's line");
  });

  test("a wall folded back along the reference wall is never offered", () => {
    // West of the pivot, back along the wall: it would lay one wall on top of
    // the other and give the shape a zero-area spike.
    const raw: Vertex = [0.0005, 0.000004];
    assert.equal(square(raw).snapped, false);
    assert.deepEqual(square(raw).vertex, raw);
  });

  test("a point sitting on the pivot has no bearing to correct", () => {
    assert.equal(square(pivot).snapped, false);
  });

  test("a reference wall of no length squares nothing", () => {
    const degenerate: AlignHinge = { pivot, reference: [pivot, pivot], adjoining: origin };
    const raw: Vertex = [0.001004, 0.0001];
    assert.equal(
      snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(degenerate)).snapped,
      false,
    );
  });

  test("longitude is scaled by latitude, or the angle is not a real one", () => {
    /*
     * The same shape at 53.5°N. A wall running east and one running north meet
     * at 90° on the ground; in raw degrees they would not, because a degree of
     * longitude there is about six tenths of a degree of latitude.
     */
    const north: Vertex = [0.001, 53.5];
    const west: Vertex = [0, 53.5];
    const result = snap(
      [0.001004, 53.50006], corners(), project, SNAP_PX, SNAP_EDGE_PX,
      bearings({ pivot: north, reference: [north, west], adjoining: west }),
    );
    assert.equal(result.kind, "align");
    assert.ok(
      Math.abs(result.vertex[0] - north[0]) < 1e-15,
      "due north of the pivot, whatever the longitude scale",
    );
  });
});

describe("alignment never outranks published data", () => {
  const pivot: Vertex = [0.001, 0];
  const origin: Vertex = [0, 0];
  const hinge: AlignHinge = { pivot, reference: [pivot, origin], adjoining: origin };
  // The raw point is 4 px off square, and a published corner sits 9 px away -
  // further, but real.
  const raw: Vertex = [0.001004, 0.0001];

  test("a corner in range wins however much nearer the right angle is", () => {
    const result = snap(
      raw,
      corners({ vertex: [0.001013, 0.0001], source: "neighbour" }),
      project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge),
    );
    assert.equal(result.kind, "vertex");
    assert.equal(result.source, "neighbour");
  });

  test("a wall in range wins too", () => {
    const result = snap(
      raw,
      walls({ a: [0.00102, -0.001] as Vertex, b: [0.00102, 0.001] as Vertex, source: "terrace" }),
      project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge),
    );
    assert.equal(result.kind, "edge");
  });

  test("no hinges means the assist is simply off", () => {
    assert.equal(snap(raw, corners(), project).snapped, false);
  });

  test("the threshold sits below the corner one, deliberately", () => {
    assert.equal(ALIGN_PX, 8);
    assert.ok(ALIGN_PX < SNAP_PX);
  });
});

describe("which walls a moving vertex can be aligned to", () => {
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];

  test("one pivot on each side of the vertex", () => {
    const hinges = hingesForVertex(ring, 0);
    assert.deepEqual(new Set(hinges.map((h) => h.pivot)), new Set([ring[3], ring[1]]));
  });

  test("the wall beside the pivot comes first, so ties report it", () => {
    // Every wall of a rectangle carries one of two bearings, so several
    // references give the same answer. The nearby one is the relationship the
    // user can actually see, so it is the one kept.
    const hinges = hingesForVertex(ring, 0);
    const first = hinges.find((h) => h.pivot === ring[3]);
    assert.deepEqual(first?.reference, [ring[3], ring[2]]);
    assert.deepEqual(first?.adjoining, ring[2]);
  });

  test("the far walls are offered too, which is what parallel needs", () => {
    /*
     * Dragging vertex 0 moves walls 3 (v3->v0) and 0 (v0->v1). The walls that
     * stand still are 1 (v1->v2) and 2 (v2->v3). For the pivot at v3, wall 2
     * IS the adjoining wall — offered first, and not offered twice — so the
     * far wall 1 is the one this adds.
     */
    const forPivot3 = hingesForVertex(ring, 0).filter((h) => h.pivot === ring[3]);
    const refs = forPivot3.map((h) => `${h.reference[0]}|${h.reference[1]}`);
    assert.deepEqual(refs, [`${ring[3]}|${ring[2]}`, `${ring[1]}|${ring[2]}`]);
  });

  test("a reference is never listed twice, whichever way round it runs", () => {
    // The adjoining wall reaches the builder once as [pivot, adjoining] and
    // again walking the ring as [adjoining, pivot]. It is one wall.
    for (const index of [0, 1, 2, 3]) {
      const seen = hingesForVertex(ring, index).map(
        (h) => `${h.pivot}::${[h.reference[0], h.reference[1]].sort().join("|")}`,
      );
      assert.equal(new Set(seen).size, seen.length, `duplicate reference at ${index}`);
    }
  });

  test("the two walls touching the dragged vertex are never references", () => {
    // They are the ones moving: their bearing is the answer, not the question.
    for (const h of hingesForVertex(ring, 0)) {
      const pair = [h.reference[0], h.reference[1]];
      assert.ok(!(pair.includes(ring[0])), "no reference touches the dragged vertex");
    }
  });

  test("the ring wraps, so the first vertex is not a special case", () => {
    const hinges = hingesForVertex(ring, 2);
    assert.deepEqual(new Set(hinges.map((h) => h.pivot)), new Set([ring[1], ring[3]]));
    for (const h of hinges) assert.ok(![h.reference[0], h.reference[1]].includes(ring[2]));
  });

  test("a triangle aligns against its one standing wall", () => {
    const tri: Vertex[] = [[0, 0], [0.001, 0], [0, 0.001]];
    const hinges = hingesForVertex(tri, 0);
    assert.deepEqual(new Set(hinges.map((h) => h.pivot)), new Set([tri[2], tri[1]]));
    for (const h of hinges) assert.ok(![h.reference[0], h.reference[1]].includes(tri[0]));
  });

  test("below three vertices there is nothing to align to", () => {
    assert.deepEqual(hingesForVertex([[0, 0], [1, 1]], 0), []);
    assert.deepEqual(hingesForVertex(ring, 9), []);
  });

  test("placing a corner aligns to every wall already drawn", () => {
    const placed: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001]];
    const hinges = hingesForAppend(placed);
    assert.ok(hinges.every((h) => h.pivot === placed[2] && h.adjoining === placed[1]));
    assert.deepEqual(hinges[0].reference, [placed[2], placed[1]], "the last wall first");
    assert.deepEqual(hinges[1].reference, [placed[0], placed[1]], "and the one before it");
  });

  test("the first two points have only the wall between them", () => {
    const hinges = hingesForAppend([[0, 0], [0.001, 0]]);
    assert.equal(hinges.length, 1);
    assert.deepEqual(hinges[0].reference, [[0.001, 0], [0, 0]]);
  });

  test("nothing to align to below two points", () => {
    assert.deepEqual(hingesForAppend([]), []);
    assert.deepEqual(hingesForAppend([[0, 0]]), []);
  });
});

/* --------------------------------------------------- parallel alignment --- */

describe("aligning a wall parallel to a distant one", () => {
  /*
   * The case square-to-the-neighbour cannot reach. Drag the north-west corner
   * of a rectangle and there is no way to ask for the west wall to stay
   * parallel to the EAST one — they share no corner, so no right angle between
   * adjoining walls expresses it.
   */
  const pivot: Vertex = [0, 0];            // the corner the moving wall turns on
  const adjoining: Vertex = [0.001, 0];    // the wall already standing there

  // A wall somewhere else entirely, running north-north-east.
  const far: [Vertex, Vertex] = [[0.005, 0.005], [0.0051, 0.006]];
  const hinge: AlignHinge = { pivot, reference: far, adjoining };

  const bearing = (a: Vertex, b: Vertex) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const parallelish = (a: number, b: number) => {
    const d = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    return Math.min(d, Math.PI - d) < 1e-12;
  };

  test("the moved wall comes out exactly parallel to the reference", () => {
    // Aimed roughly along the far wall's bearing, a few pixels off.
    const raw: Vertex = [0.00011, 0.001];
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));

    assert.equal(result.snapped, true);
    assert.equal(result.kind, "align");
    assert.ok(
      parallelish(bearing(pivot, result.vertex), bearing(far[0], far[1])),
      "the two walls now carry the same bearing",
    );
  });

  test("the reference wall comes back, so the indicator can show what to", () => {
    const result = snap([0.00011, 0.001], corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));
    assert.deepEqual(result.align?.reference, far);
  });

  test("the reference's position is irrelevant, only its bearing", () => {
    // The same wall translated far away gives the same answer.
    const moved: [Vertex, Vertex] = [[9, 9], [9.0001, 9.001]];
    const a = snap([0.00011, 0.001], corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));
    const b = snap(
      [0.00011, 0.001], corners(), project, SNAP_PX, SNAP_EDGE_PX,
      bearings({ pivot, reference: moved, adjoining }),
    );
    close(a.vertex, b.vertex);
  });

  test("perpendicular to a distant wall works the same way", () => {
    // A quarter turn from the far wall rather than none.
    const raw: Vertex = [0.001, -0.00009];
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));
    assert.equal(result.kind, "align");
    const between = Math.abs(bearing(pivot, result.vertex) - bearing(far[0], far[1]));
    assert.ok(
      Math.abs((between % (Math.PI / 2))) < 1e-12,
      "a whole number of quarter turns from the reference",
    );
  });

  test("the wall keeps its length here too", () => {
    const raw: Vertex = [0.00011, 0.001];
    const before = Math.hypot(raw[0] - pivot[0], raw[1] - pivot[1]);
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, bearings(hinge));
    const after = Math.hypot(result.vertex[0] - pivot[0], result.vertex[1] - pivot[1]);
    assert.ok(Math.abs(after - before) < 1e-15);
  });

  test("a far wall can never re-admit the folded-back bearing", () => {
    /*
     * The real reason the fold-back check is geometric. In a rectilinear
     * building the wall opposite is parallel to the wall beside, so it offers
     * the very same four bearings — including the one that lays the moving
     * wall on top of the wall already at the pivot. A rule about which
     * reference was used would not catch it; a rule about where the point ends
     * up does.
     */
    const opposite: [Vertex, Vertex] = [[0.002, 0.001], [0.003, 0.001]];  // parallel to adjoining
    const foldedBack: Vertex = [0.0005, 0.000002];   // straight along pivot -> adjoining
    const result = snap(
      foldedBack, corners(), project, SNAP_PX, SNAP_EDGE_PX,
      bearings({ pivot, reference: opposite, adjoining }),
    );
    assert.equal(result.snapped, false, "refused, whichever wall offered the bearing");
  });

  test("parallel is defined in ONE frame, the pivot's", () => {
    /*
     * The longitude scale is cos(latitude), so it differs very slightly
     * between two walls at different latitudes. The code uses the PIVOT's
     * scale for both the moving wall and the reference, which makes the
     * comparison self-consistent: "parallel" does not depend on which end you
     * measure from. Measuring each wall in its own frame instead disagrees by
     * around 1e-4 degrees over a building — under a fifth of a millimetre on a
     * 100 m wall, and the wrong question besides.
     */
    const atLat = 53.5;
    const pv: Vertex = [0, atLat];
    const adj: Vertex = [0.001, atLat];
    const ref: [Vertex, Vertex] = [[0.005, atLat + 0.002], [0.0051, atLat + 0.003]];
    const result = snap(
      [0.00011, atLat + 0.001], corners(), project, SNAP_PX, SNAP_EDGE_PX,
      bearings({ pivot: pv, reference: ref, adjoining: adj }),
    );
    assert.equal(result.kind, "align");

    const k = Math.cos((pv[1] * Math.PI) / 180);
    const inPivotFrame = (a: Vertex, b: Vertex) => Math.atan2(b[1] - a[1], (b[0] - a[0]) * k);
    const apart = Math.abs(
      inPivotFrame(pv, result.vertex) - inPivotFrame(ref[0], ref[1]),
    ) % Math.PI;
    assert.ok(Math.min(apart, Math.PI - apart) < 1e-12, `off by ${apart}`);
  });

  test("a whole rectangle can be kept parallel by dragging one corner", () => {
    // v0 dragged: with the east wall as reference the west wall comes out
    // parallel to it, which is the shape staying a parallelogram.
    const ring: Vertex[] = [[0, 0], [0.001, 0], [0.0011, 0.001], [0.0001, 0.001]];
    const hinges = hingesForVertex(ring, 0);
    const raw: Vertex = [0.00006, -0.0004];
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, { hinges, lines: [] });
    assert.equal(result.snapped, true);
    assert.equal(result.kind, "align");
  });
});

/* ---------------------------------------------------- in line with a wall --- */

describe("sitting on a wall's line past its end", () => {
  /*
   * The building line: a frontage that carries on past the wall establishing
   * it. Parallel gets the bearing right and leaves the position to the user;
   * this puts the point on the line itself.
   */
  const wall: SnapEdge = { a: [0, 0], b: [0.001, 0], source: "terrace" };

  test("a point past the end lands exactly on the line", () => {
    // 50 px beyond the east end, 4 px north of the line.
    const raw: Vertex = [0.0015, 0.00004];
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall));

    assert.equal(result.snapped, true);
    assert.equal(result.kind, "inline");
    assert.equal(result.source, "terrace");
    assert.equal(result.vertex[1], 0, "on the line");
    assert.equal(result.vertex[0], 0.0015, "and straight onto it, not along it");
  });

  test("it works off the other end too", () => {
    const result = snap([-0.0005, 0.00004], corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall));
    assert.equal(result.kind, "inline");
    assert.equal(result.vertex[1], 0);
  });

  test("the wall that was extended comes back, for the indicator", () => {
    const result = snap([0.0015, 0.00004], corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall));
    assert.deepEqual(result.line, wall);
  });

  test("BETWEEN the ends is snapping's job, not the assist's", () => {
    /*
     * There the point would be on the wall itself, which is published data and
     * belongs to the blue tier. Offering it here would put a blue claim behind
     * an amber indicator.
     */
    const middle: Vertex = [0.0005, 0.00004];
    assert.equal(snap(middle, corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall)).snapped, false);
    // The same point, with the wall offered as published data: taken, in blue.
    assert.equal(snap(middle, walls(wall), project).kind, "edge");
  });

  test("a wall only vouches for its line about as far as it is long", () => {
    // The wall is 100 px. Just inside one length past the end: taken.
    assert.equal(
      snap([0.00199, 0.00002], corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall)).kind,
      "inline",
    );
    // Beyond that it is a line across the map and means nothing.
    assert.equal(
      snap([0.00201, 0.00002], corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall)).snapped,
      false,
    );
  });

  test("too far off the line is left alone", () => {
    const raw: Vertex = [0.0015, 0.0002];
    const result = snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(wall));
    assert.equal(result.snapped, false);
    assert.deepEqual(result.vertex, raw);
  });

  test("a wall of no length has no line", () => {
    const dot: SnapEdge = { a: [0, 0], b: [0, 0], source: "dup" };
    assert.equal(snap([0.00001, 0], corners(), project, SNAP_PX, SNAP_EDGE_PX, onLines(dot)).snapped, false);
  });

  test("published data still outranks it", () => {
    // A corner 9 px away beats a line 4 px away, because the corner is real.
    const raw: Vertex = [0.0015, 0.00004];
    const result = snap(
      raw,
      corners({ vertex: [0.001509, 0.00004], source: "neighbour" }),
      project, SNAP_PX, SNAP_EDGE_PX, onLines(wall),
    );
    assert.equal(result.kind, "vertex");
  });

  test("nearest wins between the two assists, whichever that is", () => {
    /*
     * Both are guesses of the same kind, unlike the boundary with real data,
     * so neither outranks the other — the nearer correction is taken.
     *
     * The raw point sits 4 px off the wall's line. The pivot is 100 px due
     * west of it, so the bearing correction is whatever the reference wall's
     * tilt asks for at that radius: about 7 px at 4°, about 2 px at 1.15°.
     */
    const raw: Vertex = [0.0015, 0.00004];
    const pivot: Vertex = [0.0005, 0.00004];
    const tilted = (deg: number): AlignHinge => ({
      pivot,
      reference: [[0, 0], [0.001, 0.001 * Math.tan((deg * Math.PI) / 180)]],
      adjoining: [0.0005, 0.001],           // due north, so nothing folds back
    });
    const pick = (deg: number) =>
      snap(raw, corners(), project, SNAP_PX, SNAP_EDGE_PX,
        { hinges: [tilted(deg)], lines: [wall] }).kind;

    assert.equal(pick(4), "inline", "bearing ~7 px out, line 4 px: the line");
    assert.equal(pick(1.15), "align", "bearing ~2 px out, line 4 px: the bearing");
  });

  test("a line that would fold a wall back on itself is refused", () => {
    /*
     * The line runs straight out of the pivot along the wall already standing
     * there, so sitting on it would lay one wall on the other. The bearing
     * assist refuses that; so must this one, or the same spike arrives by a
     * different route.
     */
    const pivot: Vertex = [0, 0];
    const adjoining: Vertex = [0.001, 0];
    const hinge: AlignHinge = { pivot, reference: [pivot, adjoining], adjoining };
    const result = snap(
      [0.0015, 0.00004], corners(), project, SNAP_PX, SNAP_EDGE_PX,
      { hinges: [hinge], lines: [wall] },
    );
    assert.equal(result.snapped, false, "the line lies along the wall already there");
  });
});

describe("which lines a moving vertex can sit on", () => {
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];

  test("every wall of the shape that is standing still", () => {
    const lines = linesForVertex(ring, 0);
    assert.equal(lines.length, 2, "four walls, less the two the vertex moves");
    assert.deepEqual(lines[0], { a: ring[1], b: ring[2], source: "this shape" });
    assert.deepEqual(lines[1], { a: ring[2], b: ring[3], source: "this shape" });
  });

  test("the two walls the vertex moves are never offered", () => {
    for (const index of [0, 1, 2, 3]) {
      for (const line of linesForVertex(ring, index)) {
        assert.ok(![line.a, line.b].includes(ring[index]), `wall touches the dragged vertex`);
      }
    }
  });

  test("below three vertices there is no line", () => {
    assert.deepEqual(linesForVertex([[0, 0], [1, 1]], 0), []);
    assert.deepEqual(linesForVertex(ring, 9), []);
  });

  test("placing a corner can sit on any wall already drawn", () => {
    const placed: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001]];
    assert.deepEqual(linesForAppend(placed), [
      { a: placed[0], b: placed[1], source: "this shape" },
      { a: placed[1], b: placed[2], source: "this shape" },
    ]);
    assert.deepEqual(linesForAppend([[0, 0]]), []);
  });
});

/* ------------------------------------------------- aligning a dragged wall --- */

describe("aligning a wall that is being dragged", () => {
  // A rectangle, 100 px to the side under `project`, at the equator so the
  // longitude scale is 1 and screen distance is real distance.
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];
  // Wall 2 runs from v2 to v3: the "north" wall, running west.
  const WALL = 2;

  const drag = (delta: Vertex, on = true) => {
    const a: Vertex = [ring[2][0] + delta[0], ring[2][1] + delta[1]];
    const b: Vertex = [ring[3][0] + delta[0], ring[3][1] + delta[1]];
    return snapDraggedEdge(
      a, b, corners(), project, SNAP_PX, SNAP_EDGE_PX,
      on
        ? { hinges: hingesForEdge(ring, WALL), lines: [], by: "projection" }
        : { hinges: [], lines: [] },
    );
  };

  test("a sideways nudge is taken out, so the wall slides square", () => {
    // 40 px north and 5 px east. The east component would tilt both the walls
    // either side; the assist strips it and keeps the northward part.
    const out = drag([0.00005, 0.0004]);
    assert.equal(out.result.snapped, true);
    assert.equal(out.result.kind, "align");
    close(out.a, [0.001, 0.0014], "the east component is gone");
    close(out.b, [0, 0.0014]);
  });

  test("the wall stays rigid through the correction", () => {
    const out = drag([0.00005, 0.0004]);
    const before = [ring[3][0] - ring[2][0], ring[3][1] - ring[2][1]];
    const after = [out.b[0] - out.a[0], out.b[1] - out.a[1]];
    close(after as Vertex, before as Vertex, "same length and bearing");
  });

  test("a deliberate sideways drag is left alone", () => {
    // 20 px east: plainly meant, and past the 8 px the assist will absorb.
    const out = drag([0.0002, 0.0004]);
    assert.equal(out.result.snapped, false);
    close(out.a, [0.0012, 0.0014]);
  });

  test("moving square-on is not blocked, which the arc form would have done", () => {
    /*
     * The trap this design exists to avoid. Keeping each corner's distance
     * from its pivot would hold it almost exactly where it began, and a
     * rectangle's wall would refuse to move at all. Projecting leaves the
     * perpendicular part of the drag untouched.
     */
    const out = drag([0, 0.0004]);
    close(out.a, [0.001, 0.0014], "the full 40 px, not held back");
  });

  test("with the assist off the drag lands exactly where it was put", () => {
    const out = drag([0.00005, 0.0004], false);
    assert.equal(out.result.snapped, false);
    close(out.a, [0.00105, 0.0014]);
  });
});

describe("which alignments a dragged wall has", () => {
  const ring: Vertex[] = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]];

  test("a pivot beyond each end of the wall", () => {
    // Wall 2 runs v2 -> v3, so the pivots are v1 and v0.
    const hinges = hingesForEdge(ring, 2);
    assert.deepEqual(new Set(hinges.map((h) => h.pivot)), new Set([ring[1], ring[0]]));
  });

  test("THREE walls change, and none of them is a reference", () => {
    // The wall itself and the one at each end. Only wall 0 stands still.
    for (const h of hingesForEdge(ring, 2)) {
      const pair = [h.reference[0], h.reference[1]];
      assert.ok(!pair.includes(ring[2]) && !pair.includes(ring[3]),
        "a reference touches a moving corner");
    }
    assert.deepEqual(linesForEdge(ring, 2), [
      { a: ring[0], b: ring[1], source: "this shape" },
    ]);
  });

  test("below four corners a wall drag has nothing standing still", () => {
    // A triangle: dragging any wall moves every vertex of it.
    assert.deepEqual(hingesForEdge([[0, 0], [1, 0], [0, 1]], 0), []);
    assert.deepEqual(linesForEdge([[0, 0], [1, 0], [0, 1]], 0), []);
    assert.deepEqual(hingesForEdge(ring, 9), []);
  });

  test("the wall beside each pivot is offered first, so ties report it", () => {
    const hinges = hingesForEdge(ring, 2);
    const first = hinges.find((h) => h.pivot === ring[1]);
    assert.deepEqual(first?.reference, [ring[1], ring[0]]);
  });
});
