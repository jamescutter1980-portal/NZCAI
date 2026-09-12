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
 * ALIGNMENT IS AN ASSUMPTION, NOT EVIDENCE. Snapping to a corner or a wall puts
 * the point on something a source published. Aligning a wall — square or
 * parallel to another one — puts it where no source says anything, on the
 * grounds that buildings are usually regular: usually, and this one may not be.
 * So it is last in precedence, it has its own toggle rather than riding on the
 * snap one, and it is drawn in its own colour: blue means published, amber
 * means inferred.
 *
 * SQUARE AND PARALLEL ARE ONE MECHANISM, not two. Both fix the BEARING of the
 * wall being moved to a quarter turn from some reference wall; all that differs
 * is which wall the reference is. Square-to-the-wall-beside-it is the case
 * where the reference happens to adjoin the pivot.
 *
 * IN LINE is a different mechanism and a different claim. It fixes the vertex's
 * POSITION onto a wall's line rather than its bearing — the building line
 * continuing past the end of the wall that establishes it. The boundary with
 * snapping is exactly where the wall stops: a point ON the wall is published
 * data and belongs to the blue tier, so alignment offers only the EXTENSION,
 * and draws it dashed to say which half is which.
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
 * Screen distance at which a wall is pulled into alignment. Below SNAP_PX,
 * because a published coordinate is better evidence than a guess about
 * buildings.
 *
 * A DISTANCE, not an angle, and that has a consequence worth knowing: the same
 * angular error is a bigger correction further from the pivot, so a long wall
 * has to be aimed more precisely than a short one. That is the right way round
 * — on a short wall the angle cannot be judged by eye anyway, and on a long
 * one it can.
 */
export const ALIGN_PX = 8;

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

/**
 * One way a moving vertex can be brought into alignment.
 *
 * `pivot` is the fixed end of the wall being moved — the vertex slides along an
 * arc around it. `reference` is the wall whose bearing is copied; only its
 * DIRECTION is used, so it need not touch the pivot, and that is exactly what
 * makes parallel-to-a-distant-wall the same operation as square-to-the-one-
 * beside-it. `adjoining` is the pivot's other neighbour: the wall already
 * running out of the pivot, which the moving wall must never be laid on top of.
 */
export interface AlignHinge {
  pivot: Vertex;
  reference: [Vertex, Vertex];
  adjoining: Vertex;
}

/**
 * Everything the alignment assist may use. Kept apart from `SnapTargets`
 * because that is the published tier and this is the inferred one.
 */
export interface Assist {
  /** Walls whose BEARING a moving wall may be brought to a quarter turn of. */
  hinges: AlignHinge[];
  /** Walls whose LINE, extended past its ends, a moving vertex may sit on. */
  lines: SnapEdge[];
  /**
   * How a hinge corrects a point, which depends on what the user chose.
   *
   * "arc" turns the point about the pivot and KEEPS its distance, because when
   * a vertex is dragged the user picked that wall's length and only its bearing
   * is wrong.
   *
   * "projection" drops the point onto the aligned line by the shortest route,
   * because when a WALL is dragged the adjacent walls' lengths are a
   * consequence of the drag rather than a choice. Keeping their length there
   * would swing the corner round an arc and, for a rectangle dragged square-on,
   * hold it exactly where it started — the wall would simply refuse to move.
   */
  by?: "arc" | "projection";
}

export const NO_ASSIST: Assist = { hinges: [], lines: [] };

export interface SnapResult {
  vertex: Vertex;
  snapped: boolean;
  /** What was taken. The indicator draws each of these differently. */
  kind: "none" | "vertex" | "edge" | "align" | "inline";
  /** The corner taken, when `kind` is "vertex". */
  target: SnapCandidate | null;
  /** The wall taken, when `kind` is "edge". Drawn, so the jump is explained. */
  edge: SnapEdge | null;
  /** The bearing taken, when `kind` is "align". Drawn, in its own colour. */
  align: AlignHinge | null;
  /**
   * The wall whose line was taken, when `kind` is "inline". Drawn solid as far
   * as the wall goes and dashed beyond it, because only the solid part is
   * something a source published.
   */
  line: SnapEdge | null;
  /** Whatever was taken belongs to this, for a label. */
  source: string | null;
}

const NO_SNAP = (vertex: Vertex): SnapResult => ({
  vertex,
  snapped: false,
  kind: "none",
  target: null,
  edge: null,
  align: null,
  line: null,
  source: null,
});

/**
 * Where `moving` would have to be for the wall pivot→moving to run at a quarter
 * turn from the hinge's reference wall, keeping the distance the user chose.
 *
 * This is the whole of both assists. A quarter turn from the wall beside it is
 * "square"; a half turn or none from a wall elsewhere on the building is
 * "parallel". The arithmetic does not distinguish them and neither should the
 * code — what varies is only which wall the bearing is copied from.
 *
 * WORKED IN A LOCAL FLAT FRAME, NOT IN RAW DEGREES. A degree of longitude is
 * about six tenths of a degree of latitude on the ground here, so a corner
 * that is 90° in raw lng/lat is not 90° on the ground or on the screen.
 * Scaling longitude by cos(latitude) makes the frame locally isotropic, so an
 * angle in it is a true angle. (Screen space would do as well — Web Mercator
 * is conformal, so it preserves angles — but that would need an unprojection
 * this module deliberately does not have.)
 *
 * ONE FRAME FOR BOTH WALLS, the pivot's. The longitude scale differs very
 * slightly between two walls at different latitudes, so measuring each in its
 * own frame would make "parallel" depend on which end you measured from. Using
 * the pivot's scale throughout keeps the comparison self-consistent; the two
 * readings differ by around 1e-4 degrees over a building, which is under a
 * fifth of a millimetre on a 100 m wall.
 *
 * The vertex slides along an arc centred on the pivot: its distance from the
 * pivot is preserved, so the wall length the user chose survives and only its
 * bearing is corrected.
 *
 * Returns null when there is no angle to speak of — a moving point sitting on
 * the pivot, or a reference wall of no length — and when the result would lay
 * the moving wall on top of the wall already running out of the pivot, giving
 * the shape a zero-area spike.
 *
 * That last check is GEOMETRIC rather than a rule about which reference was
 * used, and it has to be. In a rectilinear building the wall opposite is
 * parallel to the wall beside, so it offers the very same bearings — including
 * the folded-back one. Excluding it per-reference would let a different
 * reference quietly re-admit it.
 */
function alignPosition(moving: Vertex, hinge: AlignHinge): Vertex | null {
  const { pivot, reference, adjoining } = hinge;

  const k = Math.cos((pivot[1] * Math.PI) / 180);
  if (k === 0) return null;
  const flat = (v: Vertex, from: Vertex = pivot) =>
    ({ x: (v[0] - from[0]) * k, y: v[1] - from[1] });

  const m = flat(moving);
  const radius = Math.hypot(m.x, m.y);
  if (radius === 0) return null;

  const ref = flat(reference[1], reference[0]);
  if (Math.hypot(ref.x, ref.y) === 0) return null;

  const QUARTER = Math.PI / 2;
  const referenceAngle = Math.atan2(ref.y, ref.x);
  const turns = Math.round((Math.atan2(m.y, m.x) - referenceAngle) / QUARTER);
  const angle = referenceAngle + turns * QUARTER;

  void adjoining;   // the fold-back check is global; see `foldsBack`
  return [pivot[0] + (radius * Math.cos(angle)) / k, pivot[1] + radius * Math.sin(angle)];
}

/**
 * The nearest point to `moving` on the aligned line through the pivot.
 *
 * Same family as `alignPosition` and the same set of bearings; what differs is
 * what is preserved. `alignPosition` keeps the point's DISTANCE from the pivot
 * and turns it — right for a dragged vertex, where the user chose that wall's
 * length. This keeps nothing and takes the shortest route onto the line —
 * right for a dragged WALL, where the adjacent wall's length is a consequence
 * of the drag rather than a choice.
 *
 * The difference is not cosmetic. Drag the north wall of a rectangle east: the
 * north-west corner's distance from the south-west corner is nearly unchanged,
 * so keeping it would hold that corner almost exactly where it began and the
 * wall would refuse to move at all. Projecting instead strips the eastward part
 * of the drag and leaves the northward part, which is the wall sliding square —
 * the behaviour the assist exists to give.
 */
function alignProjection(moving: Vertex, hinge: AlignHinge): Vertex | null {
  const { pivot, reference } = hinge;

  const k = Math.cos((pivot[1] * Math.PI) / 180);
  if (k === 0) return null;

  const rx = (reference[1][0] - reference[0][0]) * k;
  const ry = reference[1][1] - reference[0][1];
  if (Math.hypot(rx, ry) === 0) return null;

  const mx = (moving[0] - pivot[0]) * k;
  const my = moving[1] - pivot[1];
  if (Math.hypot(mx, my) === 0) return null;

  const QUARTER = Math.PI / 2;
  const referenceAngle = Math.atan2(ry, rx);
  const turns = Math.round((Math.atan2(my, mx) - referenceAngle) / QUARTER);
  const angle = referenceAngle + turns * QUARTER;

  // The foot of the perpendicular from `moving` onto the line through the
  // pivot at that bearing.
  const along = mx * Math.cos(angle) + my * Math.sin(angle);
  return [
    pivot[0] + (along * Math.cos(angle)) / k,
    pivot[1] + along * Math.sin(angle),
  ];
}

/**
 * Would putting the vertex here lay a moving wall back along the wall already
 * standing at its pivot, giving the shape a spike of no area?
 *
 * CHECKED AGAINST EVERY HINGE, not just the one that produced the candidate.
 * A vertex has two moving walls, and a correction computed for one of them can
 * perfectly well fold the other. It is also why the check asks where the point
 * ENDED UP rather than which reference produced it: in a rectilinear building
 * the wall opposite is parallel to the wall beside, so it offers the very same
 * bearings — the folded-back one included — and a rule about references would
 * let a different one quietly re-admit the spike.
 */
function foldsBack(vertex: Vertex, hinges: AlignHinge[]): boolean {
  for (const { pivot, adjoining } of hinges) {
    const k = Math.cos((pivot[1] * Math.PI) / 180);
    if (k === 0) continue;

    const vx = (vertex[0] - pivot[0]) * k;
    const vy = vertex[1] - pivot[1];
    const bx = (adjoining[0] - pivot[0]) * k;
    const by = adjoining[1] - pivot[1];
    if (Math.hypot(vx, vy) === 0 || Math.hypot(bx, by) === 0) continue;

    const apart = Math.atan2(vy, vx) - Math.atan2(by, bx);
    // Within a thousandth of a radian: the two walls would be one line.
    if (Math.abs(Math.atan2(Math.sin(apart), Math.cos(apart))) < 1e-3) return true;
  }
  return false;
}

/**
 * How far along the infinite line through a-b the closest point to `point`
 * lies, and how far off that line the point is. Measured in SCREEN space, for
 * the reasons in `footOnSegment` below; `t` is NOT clamped, so 0 and 1 are the
 * segment's own ends and anything outside is its extension.
 */
function footOnLine(
  point: ScreenPoint,
  a: ScreenPoint,
  b: ScreenPoint,
): { t: number; distance: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return null;   // a point has no line

  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  return {
    t,
    distance: Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)),
  };
}

/**
 * How far past its own ends a wall vouches for its line.
 *
 * Expressed as a multiple of the wall's own length, so it scales with the
 * thing making the claim: a 10 m wall speaks for the next 10 m either side, a
 * 60 m one for 60. A line extended without limit would tile the map — with a
 * street's worth of neighbours every drag would click to some distant wall's
 * continuation, which is meaningless and unusable.
 */
const LINE_REACH = 1;

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
 *
 * ALIGNMENT LAST, and never on distance. A corner or a wall is somewhere a
 * source published; square and parallel are guesses about how buildings are
 * usually built. Where both are in range the published one wins however much
 * nearer the guess happens to be, because taking the guess would quietly move
 * the point off real data.
 */
export function snap(
  vertex: Vertex,
  targets: SnapTargets,
  project: Project,
  thresholdPx: number = SNAP_PX,
  edgeThresholdPx: number = SNAP_EDGE_PX,
  assist: Assist = NO_ASSIST,
  alignThresholdPx: number = ALIGN_PX,
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
      align: null,
      line: null,
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
      align: null,
      line: null,
      source: bestEdge.source,
    };
  }

  /*
   * Strictly nearer wins, so where several references offer the same bearing -
   * which is the normal case in a rectilinear building, where every wall is
   * parallel or square to every other - the FIRST one offered is kept. The
   * builders below put the wall adjoining the pivot first for that reason: it
   * is the one the user can see the relationship to.
   */
  /*
   * The two assists are one tier and NEAREST WINS between them. They are the
   * same kind of guess, unlike the boundary with published data above, which
   * is categorical. In-line is gathered first so that it takes a tie: it puts
   * the point on a real wall's line, where a bearing takes only a direction
   * and leaves the position to the user.
   */
  let best: { vertex: Vertex; hinge?: AlignHinge; line?: SnapEdge } | null = null;
  let bestDist = Infinity;

  for (const edge of assist.lines) {
    const foot = footOnLine(at, project(edge.a), project(edge.b));
    if (!foot) continue;
    /*
     * Only the EXTENSION. Between the wall's own ends the point would be on
     * the wall itself, which is published data and belongs to the edge-snap
     * tier above - offering it here would put a blue claim behind an amber
     * indicator. Past LINE_REACH the wall no longer vouches for its line.
     */
    if (foot.t >= 0 && foot.t <= 1) continue;
    if (foot.t < -LINE_REACH || foot.t > 1 + LINE_REACH) continue;
    if (foot.distance >= bestDist) continue;

    // The fraction is taken on screen; the point is placed on the wall's own
    // coordinates, so it lands exactly on the line the wall establishes.
    const onLine: Vertex = [
      edge.a[0] + foot.t * (edge.b[0] - edge.a[0]),
      edge.a[1] + foot.t * (edge.b[1] - edge.a[1]),
    ];
    if (foldsBack(onLine, assist.hinges)) continue;
    bestDist = foot.distance;
    best = { vertex: onLine, line: edge };
  }

  const correct = assist.by === "projection" ? alignProjection : alignPosition;
  for (const hinge of assist.hinges) {
    const aligned = correct(vertex, hinge);
    if (!aligned || foldsBack(aligned, assist.hinges)) continue;
    const p = project(aligned);
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d < bestDist) {
      bestDist = d;
      best = { vertex: aligned, hinge };
    }
  }

  if (best && bestDist <= alignThresholdPx) {
    return {
      vertex: best.vertex,
      snapped: true,
      kind: best.line ? "inline" : "align",
      target: null,
      edge: null,
      align: best.hinge ?? null,
      line: best.line ?? null,
      source: best.line?.source ?? null,
    };
  }

  return NO_SNAP(vertex);
}

/**
 * Every alignment a vertex being dragged can be brought into.
 *
 * Two walls move when a vertex does — the one on each side of it — and each
 * turns on the vertex beyond. For each of those two pivots, the bearing can be
 * copied from ANY wall of the shape that is standing still.
 *
 * WHY EVERY FIXED WALL, not just the one beside the pivot. Square-to-the-
 * neighbour keeps a corner honest but says nothing about the rest of the
 * building: drag the north-west corner of a rectangle and there is no way to
 * ask for the west wall to stay parallel to the east one. Offering the far
 * walls too costs nothing, because in a rectilinear building they carry the
 * bearings the near ones already have — the extra references only bite on a
 * building that genuinely has more than two bearings, which is when they are
 * wanted. The assist is self-limiting: it can only ever align the shape to its
 * own grain.
 *
 * The two walls touching the dragged vertex are excluded — they are the ones
 * moving, so their bearings are not a reference, they are the answer.
 *
 * The wall adjoining each pivot comes FIRST, so that where several references
 * offer the same bearing it is the one reported and drawn.
 */
export function hingesForVertex(vertices: Vertex[], index: number): AlignHinge[] {
  const n = vertices.length;
  if (n < 3 || index < 0 || index >= n) return [];
  const at = (i: number) => vertices[((i % n) + n) % n];

  const hinges: AlignHinge[] = [];
  for (const step of [-1, 1]) {
    const pivot = at(index + step);
    const adjoining = at(index + 2 * step);

    // The wall beside the pivot first, then the rest of the standing walls.
    const references: [Vertex, Vertex][] = [[pivot, adjoining]];
    for (let w = 0; w < n; w += 1) {
      // Wall w runs from vertex w to w + 1. The two touching the dragged
      // vertex are moving, so they cannot be references.
      if (w === index || w === ((index - 1) % n + n) % n) continue;
      const a = at(w);
      const b = at(w + 1);
      if (a === pivot && b === adjoining) continue;   // already first
      if (a === adjoining && b === pivot) continue;
      references.push([a, b]);
    }

    for (const reference of references) hinges.push({ pivot, reference, adjoining });
  }
  return hinges;
}

/**
 * The shape's own walls whose LINE a dragged vertex may sit on: every wall
 * standing still, which is every wall but the two the vertex is moving.
 *
 * Used for a building with a step in it — a recessed entrance, an L with a
 * notch — where two faces should read as one line even though a jog separates
 * them. The two moving walls are excluded for the same reason as in the
 * bearing case: their position is the answer, not the question.
 */
export function linesForVertex(vertices: Vertex[], index: number): SnapEdge[] {
  const n = vertices.length;
  if (n < 3 || index < 0 || index >= n) return [];
  const at = (i: number) => vertices[((i % n) + n) % n];

  const out: SnapEdge[] = [];
  for (let w = 0; w < n; w += 1) {
    if (w === index || w === ((index - 1) % n + n) % n) continue;
    out.push({ a: at(w), b: at(w + 1), source: "this shape" });
  }
  return out;
}

/**
 * The alignments available while a whole WALL is being dragged.
 *
 * The dragged wall's own bearing cannot be corrected — a translation preserves
 * it, and that is the point of the gesture. What a translation does change is
 * the two walls either side, so those are what the assist works on: each hinges
 * on the vertex beyond the end it touches, and can be brought square or
 * parallel to any wall standing still.
 *
 * THREE walls move when one is dragged, not two: the wall itself and the one at
 * each end. All three are excluded as references.
 */
export function hingesForEdge(vertices: Vertex[], index: number): AlignHinge[] {
  const n = vertices.length;
  if (n < 4 || index < 0 || index >= n) return [];
  const at = (i: number) => vertices[((i % n) + n) % n];
  const changing = new Set([
    ((index - 1) % n + n) % n,
    index,
    (index + 1) % n,
  ]);

  const hinges: AlignHinge[] = [];
  for (const [pivotAt, adjoiningAt] of [
    [index - 1, index - 2],
    [index + 2, index + 3],
  ] as const) {
    const pivot = at(pivotAt);
    const adjoining = at(adjoiningAt);

    const references: [Vertex, Vertex][] = [[pivot, adjoining]];
    for (let w = 0; w < n; w += 1) {
      if (changing.has(w)) continue;
      const a = at(w);
      const b = at(w + 1);
      if ((a === pivot && b === adjoining) || (a === adjoining && b === pivot)) continue;
      references.push([a, b]);
    }
    for (const reference of references) hinges.push({ pivot, reference, adjoining });
  }
  return hinges;
}

/** The shape's own walls a dragged WALL's ends may come to rest on the line of. */
export function linesForEdge(vertices: Vertex[], index: number): SnapEdge[] {
  const n = vertices.length;
  if (n < 4 || index < 0 || index >= n) return [];
  const at = (i: number) => vertices[((i % n) + n) % n];
  const changing = new Set([((index - 1) % n + n) % n, index, (index + 1) % n]);

  const out: SnapEdge[] = [];
  for (let w = 0; w < n; w += 1) {
    if (changing.has(w)) continue;
    out.push({ a: at(w), b: at(w + 1), source: "this shape" });
  }
  return out;
}

/** The same for a vertex being placed: every wall already drawn. */
export function linesForAppend(vertices: Vertex[]): SnapEdge[] {
  const out: SnapEdge[] = [];
  for (let w = 0; w < vertices.length - 1; w += 1) {
    out.push({ a: vertices[w], b: vertices[w + 1], source: "this shape" });
  }
  return out;
}

/**
 * Every alignment a vertex being PLACED can be brought into: the bearing of
 * any wall already drawn, hinging on the last point placed. Nothing to align
 * to below two points.
 */
export function hingesForAppend(vertices: Vertex[]): AlignHinge[] {
  const n = vertices.length;
  if (n < 2) return [];
  const pivot = vertices[n - 1];
  const adjoining = vertices[n - 2];

  const references: [Vertex, Vertex][] = [[pivot, adjoining]];
  // The shape is still open while drawing, so the walls are just the
  // consecutive pairs - there is no closing one yet.
  for (let w = 0; w < n - 2; w += 1) references.push([vertices[w], vertices[w + 1]]);

  return references.map((reference) => ({ pivot, reference, adjoining }));
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
  assist: Assist = NO_ASSIST,
  alignThresholdPx: number = ALIGN_PX,
): { a: Vertex; b: Vertex; result: SnapResult } {
  let best: { end: Vertex; result: SnapResult; moved: number } | null = null;

  for (const end of [a, b]) {
    const result = snap(
      end, targets, project, thresholdPx, edgeThresholdPx, assist, alignThresholdPx,
    );
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
  const moved: { a: Vertex; b: Vertex } = {
    a: [a[0] + delta[0], a[1] + delta[1]],
    b: [b[0] + delta[0], b[1] + delta[1]],
  };

  /*
   * `snap` checked the end it was given. A wall moves BOTH ends, and a
   * correction that suits one can fold the other back onto the wall standing
   * at its pivot. Refusing outright rather than half-applying: a translation
   * that cannot be made without a spike is not one the user wanted.
   */
  if (foldsBack(moved.a, assist.hinges) || foldsBack(moved.b, assist.hinges)) {
    return { a, b, result: NO_SNAP(a) };
  }

  return { ...moved, result: best.result };
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

/* ------------------------------------------------------ regularising --- */

/**
 * How far off the building's own grid a wall may be and still be pulled onto
 * it, in degrees.
 *
 * A judgement, and the reasoning is the separation in practice: a footprint
 * traced from imagery is usually within about five degrees of square, an OS
 * polygon within one or two, and a genuinely canted wall — a splayed corner, a
 * bay, a plot that follows a bend in the road — is thirty degrees off or more.
 * Fifteen sits in the empty middle, so ragged corners are caught and real
 * diagonals are left alone.
 *
 * NOT a screen threshold, unlike every other tolerance here. Those measure a
 * pointer against what the user can see; this runs on a whole shape with no
 * pointer involved, so the question is about the geometry rather than the aim.
 */
export const REGULARISE_DEGREES = 15;

export interface Regularised {
  vertices: Vertex[];
  /** Corners that actually moved, and how far the furthest went, in metres. */
  moved: number;
  furthestM: number;
  /** Walls left as they were because they are not on the building's grid. */
  keptDiagonal: number;
  /** The grid the shape was squared to, as a bearing in degrees. */
  axisDegrees: number;
}

/** Corners nearer than this to where they started are treated as unmoved. */
const MOVED_M = 0.01;

/**
 * Squares a footprint up against its own dominant grid.
 *
 * WHAT IT IS FOR. The assists help while a point is moving. A shape traced
 * freehand, or one a source published raggedly, has every corner a degree or
 * two out and nothing fixes them together.
 *
 * THE GRID COMES FROM THE SHAPE, not from north and not from the neighbours.
 * A building sits at whatever bearing its street does, so squaring to north
 * would wreck almost every footprint in the country. The dominant bearing is
 * the length-weighted circular mean of the walls' own bearings, taken modulo a
 * quarter turn — the angles are multiplied by four before averaging and divided
 * by four after, because a right angle is a symmetry of the thing being
 * measured and a plain mean would tear at the wrap-around.
 *
 * THE CORNERS ARE REBUILT, NOT NUDGED. Each wall becomes a line: its direction
 * snapped to the grid, its position through its own midpoint, so the wall stays
 * where it was and only turns. Every corner is then the intersection of the two
 * lines that meet there. Rotating each wall and then averaging the disagreeing
 * endpoints would leave the walls not quite meeting, which is the defect this
 * is meant to remove.
 *
 * A wall further off the grid than `toleranceDeg` keeps its own bearing, so an
 * L-plan with one canted wall comes back with the cant intact.
 *
 * Returns null when there is nothing it can work on — fewer than three corners,
 * or no wall with any length.
 */
export function regularise(
  vertices: Vertex[],
  toleranceDeg: number = REGULARISE_DEGREES,
): Regularised | null {
  const n = vertices.length;
  if (n < MIN_VERTICES) return null;

  /*
   * One flat frame for the whole shape, at its mean latitude. As in
   * `alignPosition`: a right angle in raw degrees is not a right angle on the
   * ground, and using a different scale per wall would make "square" depend on
   * which end of the building you measured from.
   */
  const lat0 = vertices.reduce((sum, v) => sum + v[1], 0) / n;
  const k = Math.cos((lat0 * Math.PI) / 180);
  if (k === 0) return null;
  const flat = (v: Vertex) => ({ x: (v[0] - vertices[0][0]) * k, y: v[1] - vertices[0][1] });
  const unflat = (p: { x: number; y: number }): Vertex =>
    [vertices[0][0] + p.x / k, vertices[0][1] + p.y];

  const points = vertices.map(flat);
  const walls = points.map((p, i) => {
    const q = points[(i + 1) % n];
    return { from: p, to: q, dx: q.x - p.x, dy: q.y - p.y };
  });

  const QUARTER = Math.PI / 2;
  let sin4 = 0;
  let cos4 = 0;
  for (const w of walls) {
    const length = Math.hypot(w.dx, w.dy);
    if (length === 0) continue;
    const bearing = Math.atan2(w.dy, w.dx);
    sin4 += length * Math.sin(4 * bearing);
    cos4 += length * Math.cos(4 * bearing);
  }
  if (sin4 === 0 && cos4 === 0) return null;
  const axis = Math.atan2(sin4, cos4) / 4;

  const tolerance = (toleranceDeg * Math.PI) / 180;
  let keptDiagonal = 0;

  // Each wall as a line: a point it passes through, and a direction.
  const lines = walls.map((w) => {
    const length = Math.hypot(w.dx, w.dy);
    if (length === 0) return null;

    const bearing = Math.atan2(w.dy, w.dx);
    const turns = Math.round((bearing - axis) / QUARTER);
    const target = axis + turns * QUARTER;
    const off = Math.abs(Math.atan2(Math.sin(bearing - target), Math.cos(bearing - target)));

    // Off the grid by more than the tolerance: a real diagonal, left alone.
    const direction = off <= tolerance ? target : bearing;
    if (off > tolerance) keptDiagonal += 1;

    return {
      // Through the wall's own midpoint, so it turns where it stands rather
      // than swinging out from one end.
      at: { x: (w.from.x + w.to.x) / 2, y: (w.from.y + w.to.y) / 2 },
      dx: Math.cos(direction),
      dy: Math.sin(direction),
    };
  });

  const out: Vertex[] = [];
  let moved = 0;
  let furthestM = 0;

  for (let i = 0; i < n; i += 1) {
    // Corner i is where wall i-1 meets wall i.
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    const here = points[i];
    let placed = here;

    if (a && b) {
      const cross = a.dx * b.dy - a.dy * b.dx;
      /*
       * Near-parallel lines meet a long way off or nowhere, so the corner
       * stays where it is. That leaves a pair of near-collinear walls with the
       * jog between them intact rather than merging them, which would drop a
       * vertex the user placed.
       */
      if (Math.abs(cross) > 1e-9) {
        const t = ((b.at.x - a.at.x) * b.dy - (b.at.y - a.at.y) * b.dx) / cross;
        placed = { x: a.at.x + t * a.dx, y: a.at.y + t * a.dy };
      }
    }

    const shiftM = Math.hypot(placed.x - here.x, placed.y - here.y) * 111_320;
    if (shiftM > MOVED_M) moved += 1;
    if (shiftM > furthestM) furthestM = shiftM;
    out.push(unflat(placed));
  }

  return {
    vertices: out,
    moved,
    furthestM,
    keptDiagonal,
    axisDegrees: (axis * 180) / Math.PI,
  };
}
