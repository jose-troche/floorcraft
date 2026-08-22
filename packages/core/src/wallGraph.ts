// Converts solved leaf rectangles (guillotine layout, Phase 1) into the canonical
// planar WallGraph (DM-1, DM-5): shared centerlines with thickness, rooms referencing
// ordered boundary edge cycles. Face polygons are derived at render time, never stored.

import type { EdgeId, NodeId, Opening, Room, RoomCell, RoomId, SolveViolation, WallEdge, WallGraph } from "./types.js";
export type Point = { x: number; y: number };
import type { LeafRect } from "./slicingSolver.js";

export const EXTERIOR_WALL_THICKNESS_MM = 200;
export const INTERIOR_WALL_THICKNESS_MM = 114;

type VInterval = { y0: number; y1: number; leftRoomId?: RoomId; rightRoomId?: RoomId };
type HInterval = { x0: number; x1: number; aboveRoomId?: RoomId; belowRoomId?: RoomId };

function breakpoints(intervals: Array<{ y0: number; y1: number } | { x0: number; x1: number }>): number[] {
  const set = new Set<number>();
  for (const iv of intervals) {
    if ("y0" in iv) {
      set.add(iv.y0);
      set.add(iv.y1);
    } else {
      set.add(iv.x0);
      set.add(iv.x1);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function coveringLeft(intervals: VInterval[], p0: number, p1: number): RoomId | undefined {
  const mid = (p0 + p1) / 2;
  for (const iv of intervals) {
    if (iv.leftRoomId !== undefined && iv.y0 <= mid && mid <= iv.y1) return iv.leftRoomId;
  }
  return undefined;
}
function coveringRight(intervals: VInterval[], p0: number, p1: number): RoomId | undefined {
  const mid = (p0 + p1) / 2;
  for (const iv of intervals) {
    if (iv.rightRoomId !== undefined && iv.y0 <= mid && mid <= iv.y1) return iv.rightRoomId;
  }
  return undefined;
}
function coveringAbove(intervals: HInterval[], p0: number, p1: number): RoomId | undefined {
  const mid = (p0 + p1) / 2;
  for (const iv of intervals) {
    if (iv.aboveRoomId !== undefined && iv.x0 <= mid && mid <= iv.x1) return iv.aboveRoomId;
  }
  return undefined;
}
function coveringBelow(intervals: HInterval[], p0: number, p1: number): RoomId | undefined {
  const mid = (p0 + p1) / 2;
  for (const iv of intervals) {
    if (iv.belowRoomId !== undefined && iv.x0 <= mid && mid <= iv.x1) return iv.belowRoomId;
  }
  return undefined;
}

class NodeAllocator {
  private map = new Map<string, NodeId>();
  private nodes: Record<NodeId, { x: number; y: number }> = {};
  private n = 0;
  get(x: number, y: number): NodeId {
    const key = `${x}:${y}`;
    let id = this.map.get(key);
    if (!id) {
      id = `n${this.n++}`;
      this.map.set(key, id);
      this.nodes[id] = { x, y };
    }
    return id;
  }
  get all() {
    return this.nodes;
  }
}

export type RoomMeta = Pick<Room, "name" | "program" | "constraints" | "labelAnchor">;

export type BuildWallGraphResult = { ok: true; graph: WallGraph } | { ok: false; violations: SolveViolation[] };

/**
 * Rejects cell configurations the edge-tracing pass below can't be trusted to handle
 * correctly rather than let it guess. Overlap in particular matters here, not just as a
 * correctness rule: the interval-covering sampler below picks whichever candidate it finds
 * first when two intervals overlap at the same point, so an overlap would silently produce
 * a wrong wall rather than an error.
 */
function validateCells(cells: RoomCell[], boundary: { widthMm: number; depthMm: number }): SolveViolation[] {
  const violations: SolveViolation[] = [];
  for (const c of cells) {
    if (c.w <= 0 || c.d <= 0) {
      violations.push({ roomIds: [c.roomId], reason: "min-dimension", message: `${c.roomId} has a non-positive cell.` });
    } else if (c.x < 0 || c.y < 0 || c.x + c.w > boundary.widthMm || c.y + c.d > boundary.depthMm) {
      violations.push({
        roomIds: [c.roomId],
        reason: "out-of-bounds",
        message: `${c.roomId} has a cell outside the ${boundary.widthMm}mm x ${boundary.depthMm}mm boundary.`,
      });
    }
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i]!;
      const b = cells[j]!;
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapD = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
      if (overlapW > 0 && overlapD > 0) {
        violations.push({
          roomIds: [...new Set([a.roomId, b.roomId])],
          reason: "overlapping-rooms",
          message:
            a.roomId === b.roomId
              ? `${a.roomId} has two overlapping cells.`
              : `${a.roomId} and ${b.roomId} overlap.`,
        });
      }
    }
  }
  return violations;
}

type DirectedEdge = { from: NodeId; to: NodeId; edgeId: EdgeId };

/**
 * Chains one room's directed boundary edges into a single closed cycle. A simply-connected
 * rectilinear region has exactly one outgoing edge per boundary node; two edges leaving the
 * same node means the cells touch at a single pinch point (self-intersecting, not a valid
 * simple polygon), and a cycle that closes before consuming every edge means the room has a
 * hole or is split across disconnected cells (SLV-1's "no gaps" extended to unions). Either
 * way this returns null rather than a partial boundary — SLV-3 never renders broken geometry.
 */
function chainBoundaryCycle(directed: DirectedEdge[], nodes: Record<NodeId, Point>): EdgeId[] | null {
  if (directed.length === 0) return [];
  const byFrom = new Map<NodeId, DirectedEdge>();
  for (const e of directed) {
    if (byFrom.has(e.from)) return null; // pinch point: two boundary edges leave the same node
    byFrom.set(e.from, e);
  }
  // The cycle itself doesn't care where it starts, but a stable, deterministic choice
  // (topmost, then leftmost node) keeps output reproducible run to run instead of
  // depending on edge-generation order — same reasoning a rectangular room's boundary
  // has always started at its top-left corner.
  let start = directed[0]!.from;
  for (const e of directed) {
    const a = nodes[e.from]!;
    const b = nodes[start]!;
    if (a.y < b.y || (a.y === b.y && a.x < b.x)) start = e.from;
  }
  const boundary: EdgeId[] = [];
  let current = start;
  for (let i = 0; i < directed.length; i++) {
    const edge = byFrom.get(current);
    if (!edge) return null;
    boundary.push(edge.edgeId);
    current = edge.to;
    if (current === start) return boundary.length === directed.length ? boundary : null;
  }
  return null;
}

/**
 * Builds the canonical WallGraph from a room's solved rectangles (DM-1, DM-5, FR-11).
 * `roomMeta` supplies the non-geometric fields (name/program/constraints) that persist
 * across regenerations; boundary edge cycles are always recomputed here. A room may own
 * more than one cell — an L-shape is two cells sharing a full face — so wall edges where
 * both sides resolve to the same room are internal seams and are dissolved rather than
 * drawn.
 */
export function buildWallGraph(
  cells: RoomCell[],
  boundary: { widthMm: number; depthMm: number },
  roomMeta: Record<RoomId, RoomMeta>,
): BuildWallGraphResult {
  const cellViolations = validateCells(cells, boundary);
  if (cellViolations.length > 0) return { ok: false, violations: cellViolations };

  const verticalByX = new Map<number, VInterval[]>();
  const horizontalByY = new Map<number, HInterval[]>();

  const pushV = (x: number, iv: VInterval) => {
    const arr = verticalByX.get(x) ?? [];
    arr.push(iv);
    verticalByX.set(x, arr);
  };
  const pushH = (y: number, iv: HInterval) => {
    const arr = horizontalByY.get(y) ?? [];
    arr.push(iv);
    horizontalByY.set(y, arr);
  };

  for (const r of cells) {
    pushV(r.x, { y0: r.y, y1: r.y + r.d, rightRoomId: r.roomId });
    pushV(r.x + r.w, { y0: r.y, y1: r.y + r.d, leftRoomId: r.roomId });
    pushH(r.y, { x0: r.x, x1: r.x + r.w, belowRoomId: r.roomId });
    pushH(r.y + r.d, { x0: r.x, x1: r.x + r.w, aboveRoomId: r.roomId });
  }

  const nodes = new NodeAllocator();
  const edges: Record<EdgeId, WallEdge> = {};
  const directedByRoom = new Map<RoomId, DirectedEdge[]>();
  const pushDirected = (roomId: RoomId, edge: DirectedEdge) => {
    const arr = directedByRoom.get(roomId) ?? [];
    arr.push(edge);
    directedByRoom.set(roomId, arr);
  };

  let edgeSeq = 0;

  for (const [xStr, intervals] of verticalByX) {
    const x = Number(xStr);
    const pts = breakpoints(intervals);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      if (p1 <= p0) continue;
      const leftRoomId = coveringLeft(intervals, p0, p1);
      const rightRoomId = coveringRight(intervals, p0, p1);
      if (!leftRoomId && !rightRoomId) continue; // shouldn't happen
      if (leftRoomId && rightRoomId && leftRoomId === rightRoomId) continue; // same-room seam: dissolve
      const isExterior = x === 0 || x === boundary.widthMm;
      const a = nodes.get(x, p0);
      const b = nodes.get(x, p1);
      const edgeId: EdgeId = `e${edgeSeq++}`;
      edges[edgeId] = {
        a,
        b,
        thickness: isExterior ? EXTERIOR_WALL_THICKNESS_MM : INTERIOR_WALL_THICKNESS_MM,
        type: isExterior ? "exterior" : "interior",
        openings: [],
      };
      // Room's right wall (room is to the left of this line): low-y -> high-y.
      if (leftRoomId) pushDirected(leftRoomId, { from: a, to: b, edgeId });
      // Room's left wall (room is to the right of this line): high-y -> low-y.
      if (rightRoomId) pushDirected(rightRoomId, { from: b, to: a, edgeId });
    }
  }

  for (const [yStr, intervals] of horizontalByY) {
    const y = Number(yStr);
    const pts = breakpoints(intervals);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      if (p1 <= p0) continue;
      const aboveRoomId = coveringAbove(intervals, p0, p1);
      const belowRoomId = coveringBelow(intervals, p0, p1);
      if (!aboveRoomId && !belowRoomId) continue;
      if (aboveRoomId && belowRoomId && aboveRoomId === belowRoomId) continue; // same-room seam: dissolve
      const isExterior = y === 0 || y === boundary.depthMm;
      const a = nodes.get(p0, y);
      const b = nodes.get(p1, y);
      const edgeId: EdgeId = `e${edgeSeq++}`;
      edges[edgeId] = {
        a,
        b,
        thickness: isExterior ? EXTERIOR_WALL_THICKNESS_MM : INTERIOR_WALL_THICKNESS_MM,
        type: isExterior ? "exterior" : "interior",
        openings: [],
      };
      // Room's top wall (room is below this line): low-x -> high-x.
      if (belowRoomId) pushDirected(belowRoomId, { from: a, to: b, edgeId });
      // Room's bottom wall (room is above this line): high-x -> low-x.
      if (aboveRoomId) pushDirected(aboveRoomId, { from: b, to: a, edgeId });
    }
  }

  const rooms: Record<RoomId, Room> = {};
  const violations: SolveViolation[] = [];
  const roomIds = new Set(cells.map((c) => c.roomId));
  for (const roomId of roomIds) {
    const boundaryCycle = chainBoundaryCycle(directedByRoom.get(roomId) ?? [], nodes.all);
    if (!boundaryCycle) {
      violations.push({
        roomIds: [roomId],
        reason: "disconnected-room",
        message: `${roomId} isn't a single connected shape — its cells touch at only a point, enclose a hole, or don't connect.`,
      });
      continue;
    }
    const meta = roomMeta[roomId];
    const roomCellList = cells.filter((c) => c.roomId === roomId);
    rooms[roomId] = {
      name: meta?.name ?? roomId,
      program: meta?.program ?? "other",
      boundary: boundaryCycle,
      labelAnchor: labelAnchorWithin(roomCellList, meta?.labelAnchor),
      constraints: meta?.constraints,
    };
  }
  if (violations.length > 0) return { ok: false, violations };

  return { ok: true, graph: { nodes: nodes.all, edges, rooms } };
}

/**
 * A dragged label (FR-7) is stored in absolute mm, so a later layout change can leave it
 * outside its own room. Rather than persist a position that renders somewhere confusing,
 * an out-of-room anchor falls back to the centre of the room's largest cell — for an
 * L-shape, the bounding-box centre of the whole union can land outside the room entirely.
 */
const LABEL_INSET_MM = 150;

function labelAnchorWithin(roomCellList: RoomCell[], anchor: Point | undefined): Point {
  const largest = roomCellList.reduce((best, c) => (c.w * c.d > best.w * best.d ? c : best));
  const centre = { x: largest.x + largest.w / 2, y: largest.y + largest.d / 2 };
  if (!anchor) return centre;
  // Any cell the point falls inside (with a small inset from its edges) keeps the anchor;
  // only a stale position that no longer lands in the room at all falls back to centre.
  const inside = roomCellList.some((c) => {
    const inset = Math.min(LABEL_INSET_MM, c.w / 2, c.d / 2);
    return (
      anchor.x >= c.x + inset && anchor.x <= c.x + c.w - inset && anchor.y >= c.y + inset && anchor.y <= c.y + c.d - inset
    );
  });
  return inside ? anchor : centre;
}

/** Ray-casting point-in-polygon test, even-odd rule. Used for L-shape-aware side/label tests. */
export function polygonContains(pts: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i]!;
    const pj = pts[j]!;
    const intersects = pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** All cells belonging to one room, in no particular order. */
export function roomCells(cells: RoomCell[], roomId: RoomId): RoomCell[] {
  return cells.filter((c) => c.roomId === roomId);
}

export function roomRect(leaves: LeafRect[], roomId: RoomId): LeafRect | undefined {
  return leaves.find((l) => l.roomId === roomId);
}

/**
 * A maximal run of collinear, end-to-end connected wall edges. The graph splits walls at
 * every T-junction, so a single visual wall is usually several edges; FR-8's "dimension
 * string on every wall run" means one string per run, not one per edge.
 */
export type WallRun = {
  axis: "h" | "v";
  /** y for a horizontal run, x for a vertical one. */
  coord: number;
  /** Extent along the run's own axis. */
  from: number;
  to: number;
  edgeIds: EdgeId[];
  type: WallEdge["type"];
};

export function wallRuns(graph: WallGraph): WallRun[] {
  type Segment = { start: number; end: number; edgeId: EdgeId; type: WallEdge["type"] };
  const groups = new Map<string, Segment[]>();

  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const vertical = a.x === b.x;
    const horizontal = a.y === b.y;
    if (!vertical && !horizontal) continue; // Phase 2 geometry is axis-aligned throughout.
    const axis: "h" | "v" = vertical ? "v" : "h";
    const coord = vertical ? a.x : a.y;
    const start = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const end = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    const key = `${axis}:${coord}:${edge.type}`;
    const arr = groups.get(key) ?? [];
    arr.push({ start, end, edgeId, type: edge.type });
    groups.set(key, arr);
  }

  const runs: WallRun[] = [];
  for (const [key, segments] of groups) {
    const [axis, coordStr] = key.split(":") as ["h" | "v", string];
    segments.sort((p, q) => p.start - q.start);
    let current: WallRun | null = null;
    for (const seg of segments) {
      if (current && seg.start <= current.to) {
        current.to = Math.max(current.to, seg.end);
        current.edgeIds.push(seg.edgeId);
        continue;
      }
      if (current) runs.push(current);
      current = { axis, coord: Number(coordStr), from: seg.start, to: seg.end, edgeIds: [seg.edgeId], type: seg.type };
    }
    if (current) runs.push(current);
  }
  return runs;
}

export type Span = { from: number; to: number };

/**
 * Where each opening on this run sits along the run's own axis, in absolute level
 * coordinates. An opening's `offset` is measured from its edge's `a` node, which is not
 * necessarily the low end of the run, so direction has to be resolved per edge.
 */
export function openingSpansOnRun(graph: WallGraph, run: WallRun): Array<{ span: Span; opening: Opening }> {
  const out: Array<{ span: Span; opening: Opening }> = [];
  for (const edgeId of run.edgeIds) {
    const edge = graph.edges[edgeId];
    if (!edge) continue;
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const fromA = run.axis === "v" ? a.y : a.x;
    const toB = run.axis === "v" ? b.y : b.x;
    const forward = toB >= fromA;
    for (const opening of edge.openings) {
      const start = forward ? fromA + opening.offset : fromA - opening.offset - opening.width;
      out.push({ span: { from: start, to: start + opening.width }, opening });
    }
  }
  return out.sort((p, q) => p.span.from - q.span.from);
}

/** The pieces of [from,to] left after removing `holes`, in order. */
export function subtractSpans(from: number, to: number, holes: readonly Span[]): Span[] {
  const pieces: Span[] = [];
  let cursor = from;
  for (const hole of holes) {
    if (hole.to <= cursor) continue;
    if (hole.from > cursor) pieces.push({ from: cursor, to: Math.min(hole.from, to) });
    cursor = Math.max(cursor, hole.to);
    if (cursor >= to) break;
  }
  if (cursor < to) pieces.push({ from: cursor, to });
  return pieces.filter((p) => p.to - p.from > 0.5);
}

/**
 * Wall runs resolved into drawable solids: the stretches of wall that are actually built,
 * with the openings knocked out. Shared by every exporter that draws walls with thickness
 * rather than as centerlines (ARC-2 — one implementation, several outputs).
 */
export function wallRunSolids(graph: WallGraph): Array<{ run: WallRun; thickness: number; solids: Span[]; holes: Span[] }> {
  return wallRuns(graph).map((run) => {
    const thickness = graph.edges[run.edgeIds[0]!]?.thickness ?? INTERIOR_WALL_THICKNESS_MM;
    const holes = openingSpansOnRun(graph, run).map((o) => o.span);
    // Exterior runs are extended half a thickness at each end so the building's corners
    // close; interior runs stop at their nodes and are closed by whatever they meet.
    const extend = run.type === "exterior" ? thickness / 2 : 0;
    const from = run.from - extend;
    const to = run.to + extend;
    return { run, thickness, solids: subtractSpans(from, to, holes), holes };
  });
}

/**
 * Walks an ordered boundary edge cycle into a polygon, tolerant of either edge
 * direction (edge.a/edge.b are not guaranteed to align with cycle traversal order).
 */
export function polygonFromBoundary(graph: WallGraph, boundary: EdgeId[]): Point[] {
  if (boundary.length === 0) return [];
  const firstId = boundary[0]!;
  const e0 = graph.edges[firstId];
  if (!e0) return [];
  let current: NodeId;
  if (boundary.length === 1) {
    current = e0.a;
  } else {
    const e1 = graph.edges[boundary[1]!];
    const e1Nodes = new Set(e1 ? [e1.a, e1.b] : []);
    current = e1Nodes.has(e0.a) ? e0.b : e0.a;
  }
  const pts: Point[] = [];
  for (const edgeId of boundary) {
    const e = graph.edges[edgeId];
    if (!e) continue;
    const next = e.a === current ? e.b : e.a;
    const p = graph.nodes[current];
    if (p) pts.push(p);
    current = next;
  }
  return pts;
}
