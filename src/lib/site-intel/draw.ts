/**
 * S-01 footprint editing: ring manipulation and snapping.
 *
 * A leaf module — no imports, no React, no MapLibre — so the geometry can be
 * tested without a browser. The component supplies a projection function and
 * owns the pointer events; everything that decides *what the shape becomes*
 * lives here.
 *
 * SNAPPING IS MEASURED IN SCREEN PIXELS, NOT METRES. A tolerance in metres is
 * generous when zoomed out and unusably tight when zoomed in — it would snap
 * to the wrong building at one zoom and refuse to snap at all at another. What
 * the user is actually doing is "putting this handle on that corner", which is
 * a screen-space judgement, so the threshold is too.
 *
 * WHAT SNAPPING DOES NOT DO. A snapped vertex takes the other polygon's exact
 * coordinate, which is the point: shared party walls line up instead of
 * disagreeing by half a metre. It does NOT change the provenance of the result.
 * A shape built entirely from OS vertices is still a user drawing at T4,
 * because the user chose which vertices and in what order.
 *
 * CORNERS AND WALLS ARE DIFFERENT TARGETS. A corner is a point you aim at; a
 * wall is a line you cross. Walls are continuous and cover far more of the map
 * than corners do, so a vertex dragged across a street would stick to every
 * one it passed at the same tolerance. Walls therefore have a tighter
 * threshold, and a corner in range always beats a wall in range.
 */

export type Vertex = [number, number];
export type ScreenPoint = { x: number; y: number };

/** Projects a lng/lat to screen pixels. Supplied by the map. */
export type Project = (vertex: Vertex) => ScreenPoint;

/** Default snap radius for corners, in screen pixels. */
export const SNAP_PX = 12;

/**
 * Screen distance at which the shape's OWN wall can be grabbed and dragged.
 *
 * Wider than the drawn line, like the vertex threshold: a wall you can see but
 * cannot reliably grab is worse than one that grabs slightly early.
 */
export const GRAB_EDGE_PX = 8;

/**
 * How far the pointer must travel before a press on a wall becomes a drag.
 *
 * Below it the press is still a click — which is what inserts a vertex at a
 * midpoint. Without the distinction the midpoint would have to choose between
 * being clickable and being draggable, and on a short wall its grab radius
 * covers most of the wall, so choosing "clickable" would make short walls
 * undraggable.
 */
export const DRAG_START_PX = 3;

/**
 * Snap radius for walls, in screen pixels. Tighter than SNAP_PX on purpose
 * (see the header). Keeping it BELOW SNAP_PX also means a wall snap can never
 * land on a corner: at the ends of a segment the closest point is the corner
 * itself, and any corner that close was already claimed by the corner rule.
 */
export const SNAP_EDGE_PX = 8;

/** Minimum vertices for a polygon. Below this there is no area. */
export const MIN_VERTICES = 3;

/* ------------------------------------------------------------- geometry --- */

/**
 * The outer ring of a polygon, without its closing duplicate.
 *
 * Editing works on an open list — a closing vertex that is really the first
 * one again would show a handle the user could drag away from its twin,
 * silently unclosing the ring.
 */
export function outerRing(geometry: GeoJSON.Geometry | null): Vertex[] {
  if (!geometry) return [];

  const ring =
    geometry.type === "Polygon"
      ? (geometry.coordinates[0] as Vertex[] | undefined)
      : geometry.type === "MultiPolygon"
        // The largest part, by vertex count: editing the biggest piece of a
        // multipart building is the only defensible default, and holes and
        // outbuildings are dropped rather than silently merged.
        ? ((geometry.coordinates as Vertex[][][])
            .map((poly) => poly[0])
            .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0] as Vertex[] | undefined)
        : undefined;

  if (!ring?.length) return [];

  const open = [...ring];
  const first = open[0];
  const last = open[open.length - 1];
  if (open.length > 1 && first[0] === last[0] && first[1] === last[1]) open.pop();
  return open;
}

/** Closes an open ring into a GeoJSON Polygon. Null below three vertices. */
export function toPolygon(vertices: Vertex[]): GeoJSON.Polygon | null {
  if (vertices.length < MIN_VERTICES) return null;
  return { type: "Polygon", coordinates: [[...vertices, vertices[0]]] };
}

/** Midpoints of each edge, including the closing one. Insertion handles. */
export function midpoints(vertices: Vertex[]): { after: number; vertex: Vertex }[] {
  if (vertices.length < 2) return [];
  return vertices.map((v, i) => {
    const next = vertices[(i + 1) % vertices.length];
    return { after: i, vertex: [(v[0] + next[0]) / 2, (v[1] + next[1]) / 2] as Vertex };
  });
}

export function insertAfter(vertices: Vertex[], index: number, vertex: Vertex): Vertex[] {
  const next = [...vertices];
  next.splice(index + 1, 0, vertex);
  return next;
}

export function moveVertex(vertices: Vertex[], index: number, vertex: Vertex): Vertex[] {
  if (index < 0 || index >= vertices.length) return vertices;
  const next = [...vertices];
  next[index] = vertex;
  return next;
}

/**
 * Removes a vertex, refusing to go below three.
 *
 * Returning the list unchanged rather than throwing: the caller is a pointer
 * handler, and the right behaviour when a delete would destroy the polygon is
 * for nothing to happen.
 */
export function removeVertex(vertices: Vertex[], index: number): Vertex[] {
  if (vertices.length <= MIN_VERTICES) return vertices;
  if (index < 0 || index >= vertices.length) return vertices;
  return vertices.filter((_, i) => i !== index);
}

/* -------------------------------------------------------------- snapping --- */

export interface SnapCandidate {
  vertex: Vertex;
  /** What it belongs to, for the indicator's label. */
  source: string;
}

/** One wall: a segment of a neighbour's outline. */
export interface SnapEdge {
  a: Vertex;
  b: Vertex;
  source: string;
}

/** Everything a dragged vertex may snap to. */
export interface SnapTargets {
  vertices: SnapCandidate[];
  edges: SnapEdge[];
}

export interface SnapResult {
  vertex: Vertex;
  snapped: boolean;
  /** What was taken. The indicator draws a corner and a wall differently. */
  kind: "none" | "vertex" | "edge";
  /** The corner taken, when `kind` is "vertex". */
  target: SnapCandidate | null;
  /** The wall taken, when `kind` is "edge". Drawn, so the jump is explained. */
  edge: SnapEdge | null;
  /** Whatever was taken belongs to this, for a label. */
  source: string | null;
}

const NO_SNAP = (vertex: Vertex): SnapResult => ({
  vertex,
  snapped: false,
  kind: "none",
  target: null,
  edge: null,
  source: null,
});

/**
 * The closest point on segment a-b to `point`, measured in SCREEN space.
 *
 * Returns the position as a fraction along the segment rather than as a
 * coordinate, because the caller then applies that fraction to the segment's
 * OWN lng/lat. Two reasons for the detour:
 *
 *  - the result has to lie exactly on the neighbour's wall as stored, and
 *    un-projecting a screen point back would land fractionally off it;
 *  - the perpendicular is taken on screen because that is where the user is
 *    aiming and where the threshold is measured. A perpendicular computed in
 *    degrees is not the one they can see: a degree of longitude is about six
 *    tenths of a degree of latitude on the ground at these latitudes.
 *
 * `t` is clamped to the segment. Without that, a vertex dragged past the end
 * of a short wall would snap to a point on its infinite line, out in a field.
 */
function footOnSegment(
  point: ScreenPoint,
  a: ScreenPoint,
  b: ScreenPoint,
): { t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  // A zero-length segment is a point. Guarding here rather than filtering them
  // out: a repeated coordinate in source data is not an error worth refusing,
  // and dividing by its length would be NaN.
  if (lengthSq === 0) {
    return { t: 0, distance: Math.hypot(point.x - a.x, point.y - a.y) };
  }

  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return {
    t,
    distance: Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)),
  };
}

/**
 * Snaps a vertex to the nearest corner, or failing that the nearest wall,
 * within the screen thresholds.
 *
 * Returns the ORIGINAL vertex untouched when nothing is in range, so a caller
 * can use this unconditionally. `snapped` says which happened, because the UI
 * has to show the user that their point moved — a handle that jumps without
 * explanation reads as a bug.
 *
 * CORNERS FIRST, and not merely because they are usually nearer. Near a corner
 * the foot of the wall is almost exactly the corner too, so "nearest wins"
 * would have the point stick to the wall a hair short of the corner — which is
 * precisely the corner the user was aiming at. A corner in range settles it.
 */
export function snap(
  vertex: Vertex,
  targets: SnapTargets,
  project: Project,
  thresholdPx: number = SNAP_PX,
  edgeThresholdPx: number = SNAP_EDGE_PX,
): SnapResult {
  const at = project(vertex);

  let bestCorner: SnapCandidate | null = null;
  let bestCornerDist = Infinity;
  for (const candidate of targets.vertices) {
    const p = project(candidate.vertex);
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d < bestCornerDist) {
      bestCornerDist = d;
      bestCorner = candidate;
    }
  }

  if (bestCorner && bestCornerDist <= thresholdPx) {
    return {
      vertex: bestCorner.vertex,
      snapped: true,
      kind: "vertex",
      target: bestCorner,
      edge: null,
      source: bestCorner.source,
    };
  }

  let bestEdge: SnapEdge | null = null;
  let bestEdgeDist = Infinity;
  let bestT = 0;
  for (const edge of targets.edges) {
    const { t, distance } = footOnSegment(at, project(edge.a), project(edge.b));
    if (distance < bestEdgeDist) {
      bestEdgeDist = distance;
      bestEdge = edge;
      bestT = t;
    }
  }

  if (bestEdge && bestEdgeDist <= edgeThresholdPx) {
    // The fraction is taken on screen; the point is placed on the wall's own
    // coordinates, so it lands exactly on the neighbour's outline.
    const onWall: Vertex = [
      bestEdge.a[0] + bestT * (bestEdge.b[0] - bestEdge.a[0]),
      bestEdge.a[1] + bestT * (bestEdge.b[1] - bestEdge.a[1]),
    ];
    return {
      vertex: onWall,
      snapped: true,
      kind: "edge",
      target: null,
      edge: bestEdge,
      source: bestEdge.source,
    };
  }

  return NO_SNAP(vertex);
}

/**
 * Index of the wall under a screen point, or -1. Wall `i` runs from vertex `i`
 * to vertex `i + 1`, wrapping, so it is indexed like `midpoints`.
 *
 * Vertices are NOT excluded here. The caller hit-tests vertices first and only
 * asks about walls when none was grabbed, which keeps the precedence in one
 * place instead of splitting it across two functions.
 */
export function edgeAt(
  vertices: Vertex[],
  point: ScreenPoint,
  project: Project,
  thresholdPx = GRAB_EDGE_PX,
): number {
  if (vertices.length < 2) return -1;

  let found = -1;
  let bestDist = Infinity;
  const sides = vertices.length === 2 ? 1 : vertices.length;
  for (let i = 0; i < sides; i += 1) {
    const { distance } = footOnSegment(
      point,
      project(vertices[i]),
      project(vertices[(i + 1) % vertices.length]),
    );
    if (distance <= thresholdPx && distance < bestDist) {
      bestDist = distance;
      found = i;
    }
  }
  return found;
}

/**
 * Translates both ends of one wall, leaving every other vertex where it is.
 *
 * A RIGID move: the wall keeps its length and its angle. That is the whole
 * reason to drag a wall rather than its two corners in turn — moving them
 * separately is already possible and cannot help but change the wall.
 */
export function moveEdge(vertices: Vertex[], index: number, delta: Vertex): Vertex[] {
  if (index < 0 || index >= vertices.length) return vertices;
  const next = [...vertices];
  const end = (index + 1) % vertices.length;
  for (const i of index === end ? [index] : [index, end]) {
    next[i] = [next[i][0] + delta[0], next[i][1] + delta[1]];
  }
  return next;
}

/**
 * Index of the vertex under a screen point, or -1.
 *
 * Used to decide what a pointer-down grabbed. The threshold is deliberately
 * larger than the rendered handle: a handle you can see but not reliably grab
 * is worse than one that grabs slightly early.
 */
export function vertexAt(
  vertices: Vertex[],
  point: ScreenPoint,
  project: Project,
  thresholdPx = SNAP_PX,
): number {
  let found = -1;
  let bestDist = Infinity;
  vertices.forEach((v, i) => {
    const p = project(v);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= thresholdPx && d < bestDist) {
      bestDist = d;
      found = i;
    }
  });
  return found;
}

/**
 * Snapping for a wall being dragged.
 *
 * The wall must stay RIGID — that is the entire point of dragging it rather
 * than its two corners — so a snap here can only be a TRANSLATION. Snapping
 * the two ends independently would pull them to different targets and shear
 * the wall into a different wall, which is precisely what dragging the corners
 * already does.
 *
 * So both ends are offered, and whichever lands closest to a target wins: the
 * whole wall then moves by the delta that puts THAT end exactly on it. The
 * effect is that a wall clicks into place as either of its corners meets a
 * neighbour's, which is the terrace gesture — line my wall up with theirs.
 */
export function snapDraggedEdge(
  a: Vertex,
  b: Vertex,
  targets: SnapTargets,
  project: Project,
  thresholdPx: number = SNAP_PX,
  edgeThresholdPx: number = SNAP_EDGE_PX,
): { a: Vertex; b: Vertex; result: SnapResult } {
  let best: { end: Vertex; result: SnapResult; moved: number } | null = null;

  for (const end of [a, b]) {
    const result = snap(end, targets, project, thresholdPx, edgeThresholdPx);
    if (!result.snapped) continue;
    const from = project(end);
    const to = project(result.vertex);
    const moved = Math.hypot(to.x - from.x, to.y - from.y);
    if (!best || moved < best.moved) best = { end, result, moved };
  }

  if (!best) return { a, b, result: NO_SNAP(a) };

  const delta: Vertex = [
    best.result.vertex[0] - best.end[0],
    best.result.vertex[1] - best.end[1],
  ];
  return {
    a: [a[0] + delta[0], a[1] + delta[1]],
    b: [b[0] + delta[0], b[1] + delta[1]],
    result: best.result,
  };
}

/**
 * Snap candidates: the vertices of neighbouring polygons.
 *
 * DELIBERATELY NOT THE SHAPE'S OWN VERTICES. Dragging a corner onto the one
 * beside it collapses the edge between them into nothing — and the gesture
 * that would trigger it, nudging a corner a short distance, is the commonest
 * one there is. It buys nothing either: the site's own published footprint is
 * in the neighbours list already, because it is a building like any other, so
 * "snap back to where OS put it" works through that.
 */
export function candidatesFrom(
  neighbours: { geometry: GeoJSON.Geometry; label: string }[],
): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  for (const n of neighbours) {
    for (const vertex of outerRing(n.geometry)) {
      out.push({ vertex, source: n.label });
    }
  }
  return out;
}

/**
 * Wall candidates: the segments of neighbouring polygons.
 *
 * The closing segment is included — the side between a ring's last corner and
 * its first is a wall like any other, and leaving it out would put one blind
 * side on every building.
 *
 * Not the shape's own walls, for the reason above and one more: every vertex
 * already sits on two of them, so its own walls are always at distance zero
 * and it could never be dragged anywhere at all.
 */
export function edgesFrom(
  neighbours: { geometry: GeoJSON.Geometry; label: string }[],
): SnapEdge[] {
  const out: SnapEdge[] = [];
  for (const n of neighbours) {
    const ring = outerRing(n.geometry);
    if (ring.length < 2) continue;
    // Two corners are one wall, not two: the closing segment would be the
    // same wall reversed. Above two, every step including the closing one is
    // a distinct side.
    const sides = ring.length === 2 ? 1 : ring.length;
    for (let i = 0; i < sides; i += 1) {
      out.push({ a: ring[i], b: ring[(i + 1) % ring.length], source: n.label });
    }
  }
  return out;
}

/** Both target kinds from one list of neighbours. */
export function targetsFrom(
  neighbours: { geometry: GeoJSON.Geometry; label: string }[],
): SnapTargets {
  return { vertices: candidatesFrom(neighbours), edges: edgesFrom(neighbours) };
}
