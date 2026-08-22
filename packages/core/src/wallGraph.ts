// Converts solved leaf rectangles (guillotine layout, Phase 1) into the canonical
// planar WallGraph (DM-1, DM-5): shared centerlines with thickness, rooms referencing
// ordered boundary edge cycles. Face polygons are derived at render time, never stored.

import type { EdgeId, NodeId, Opening, Room, RoomId, WallEdge, WallGraph } from "./types.js";
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

/**
 * Builds the canonical WallGraph from solved leaf rectangles.
 * `roomMeta` supplies the non-geometric fields (name/program/constraints) that persist
 * across regenerations; boundary edge cycles are always recomputed here.
 */
export function buildWallGraph(
  leaves: LeafRect[],
  boundary: { widthMm: number; depthMm: number },
  roomMeta: Record<RoomId, RoomMeta>,
): WallGraph {
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

  for (const r of leaves) {
    pushV(r.x, { y0: r.y, y1: r.y + r.d, rightRoomId: r.roomId });
    pushV(r.x + r.w, { y0: r.y, y1: r.y + r.d, leftRoomId: r.roomId });
    pushH(r.y, { x0: r.x, x1: r.x + r.w, belowRoomId: r.roomId });
    pushH(r.y + r.d, { x0: r.x, x1: r.x + r.w, aboveRoomId: r.roomId });
  }

  const nodes = new NodeAllocator();
  const edges: Record<EdgeId, WallEdge> = {};
  // Per room, per side, collect the ordered list of {pos, edgeId} to assemble a CCW boundary cycle.
  const topEdgesByRoom = new Map<RoomId, Array<{ x0: number; edgeId: EdgeId }>>();
  const rightEdgesByRoom = new Map<RoomId, Array<{ y0: number; edgeId: EdgeId }>>();
  const bottomEdgesByRoom = new Map<RoomId, Array<{ x0: number; edgeId: EdgeId }>>();
  const leftEdgesByRoom = new Map<RoomId, Array<{ y0: number; edgeId: EdgeId }>>();

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
      if (leftRoomId) {
        const arr = rightEdgesByRoom.get(leftRoomId) ?? [];
        arr.push({ y0: p0, edgeId });
        rightEdgesByRoom.set(leftRoomId, arr);
      }
      if (rightRoomId) {
        const arr = leftEdgesByRoom.get(rightRoomId) ?? [];
        arr.push({ y0: p0, edgeId });
        leftEdgesByRoom.set(rightRoomId, arr);
      }
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
      if (belowRoomId) {
        const arr = topEdgesByRoom.get(belowRoomId) ?? [];
        arr.push({ x0: p0, edgeId });
        topEdgesByRoom.set(belowRoomId, arr);
      }
      if (aboveRoomId) {
        const arr = bottomEdgesByRoom.get(aboveRoomId) ?? [];
        arr.push({ x0: p0, edgeId });
        bottomEdgesByRoom.set(aboveRoomId, arr);
      }
    }
  }

  const rooms: Record<RoomId, Room> = {};
  for (const r of leaves) {
    const top = (topEdgesByRoom.get(r.roomId) ?? []).sort((a, b) => a.x0 - b.x0).map((e) => e.edgeId);
    const right = (rightEdgesByRoom.get(r.roomId) ?? []).sort((a, b) => a.y0 - b.y0).map((e) => e.edgeId);
    const bottom = (bottomEdgesByRoom.get(r.roomId) ?? [])
      .sort((a, b) => b.x0 - a.x0)
      .map((e) => e.edgeId);
    const left = (leftEdgesByRoom.get(r.roomId) ?? []).sort((a, b) => b.y0 - a.y0).map((e) => e.edgeId);
    const meta = roomMeta[r.roomId];
    rooms[r.roomId] = {
      name: meta?.name ?? r.roomId,
      program: meta?.program ?? "other",
      boundary: [...top, ...right, ...bottom, ...left],
      labelAnchor: labelAnchorWithin(r, meta?.labelAnchor),
      constraints: meta?.constraints,
    };
  }

  return { nodes: nodes.all, edges, rooms };
}

/**
 * A dragged label (FR-7) is stored in absolute mm, so a later layout change can leave it
 * outside its own room. Rather than persist a position that renders somewhere confusing,
 * an out-of-room anchor falls back to the room's centre.
 */
const LABEL_INSET_MM = 150;

function labelAnchorWithin(rect: LeafRect, anchor: Point | undefined): Point {
  const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.d / 2 };
  if (!anchor) return centre;
  const inset = Math.min(LABEL_INSET_MM, rect.w / 2, rect.d / 2);
  const inside =
    anchor.x >= rect.x + inset &&
    anchor.x <= rect.x + rect.w - inset &&
    anchor.y >= rect.y + inset &&
    anchor.y <= rect.y + rect.d - inset;
  return inside ? anchor : centre;
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
