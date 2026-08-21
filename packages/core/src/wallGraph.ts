// Converts solved leaf rectangles (guillotine layout, Phase 1) into the canonical
// planar WallGraph (DM-1, DM-5): shared centerlines with thickness, rooms referencing
// ordered boundary edge cycles. Face polygons are derived at render time, never stored.

import type { EdgeId, NodeId, Room, RoomId, WallEdge, WallGraph } from "./types.js";
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
      labelAnchor: meta?.labelAnchor ?? { x: r.x + r.w / 2, y: r.y + r.d / 2 },
      constraints: meta?.constraints,
    };
  }

  return { nodes: nodes.all, edges, rooms };
}

export function roomRect(leaves: LeafRect[], roomId: RoomId): LeafRect | undefined {
  return leaves.find((l) => l.roomId === roomId);
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
