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
 */

export type Vertex = [number, number];
export type ScreenPoint = { x: number; y: number };

/** Projects a lng/lat to screen pixels. Supplied by the map. */
export type Project = (vertex: Vertex) => ScreenPoint;

/** Default snap radius in screen pixels. */
export const SNAP_PX = 12;

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

export interface SnapResult {
  vertex: Vertex;
  snapped: boolean;
  /** The candidate taken, for the indicator. */
  target: SnapCandidate | null;
}

/**
 * Snaps a vertex to the nearest candidate within the screen threshold.
 *
 * Returns the ORIGINAL vertex untouched when nothing is in range, so a caller
 * can use this unconditionally. `snapped` says which happened, because the UI
 * has to show the user that their point moved — a handle that jumps without
 * explanation reads as a bug.
 */
export function snap(
  vertex: Vertex,
  candidates: SnapCandidate[],
  project: Project,
  thresholdPx: number = SNAP_PX,
): SnapResult {
  if (!candidates.length) return { vertex, snapped: false, target: null };

  const at = project(vertex);
  let best: SnapCandidate | null = null;
  let bestDist = Infinity;

  for (const candidate of candidates) {
    const p = project(candidate.vertex);
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  return bestDist <= thresholdPx && best
    ? { vertex: best.vertex, snapped: true, target: best }
    : { vertex, snapped: false, target: null };
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
