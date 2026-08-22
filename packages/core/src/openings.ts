// Opening placement — specs.md §3.2 (Opening), FR-7 (drag/rotate openings), INF-6
// (addOpening/removeOpening). Openings persist on the Level as semantic anchors and
// are resolved onto concrete edges after every solve, because edge ids are rebuilt
// from scratch each time the wall graph is regenerated.

import type {
  EdgeId,
  Opening,
  OpeningAnchor,
  PersistedOpening,
  RoomId,
  RoomSide,
  WallGraph,
} from "./types.js";
import { polygonFromBoundary, type Point } from "./wallGraph.js";

/** Openings never sit flush against a corner; walls need a bit of structure at the ends. */
const END_CLEARANCE_MM = 100;
/** Below this an opening is not placeable on the run at all. */
const MIN_OPENING_WIDTH_MM = 450;

/** Axis-aligned bounds of a room, in level-local mm. */
export type RoomBounds = { x0: number; y0: number; x1: number; y1: number };

export function roomBounds(graph: WallGraph, roomId: RoomId): RoomBounds | null {
  const room = graph.rooms[roomId];
  if (!room) return null;
  const pts = polygonFromBoundary(graph, room.boundary);
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export function edgeLength(graph: WallGraph, edgeId: EdgeId): number {
  const edge = graph.edges[edgeId];
  if (!edge) return 0;
  const a = graph.nodes[edge.a];
  const b = graph.nodes[edge.b];
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function edgeEndpoints(graph: WallGraph, edgeId: EdgeId): { a: Point; b: Point } | null {
  const edge = graph.edges[edgeId];
  if (!edge) return null;
  const a = graph.nodes[edge.a];
  const b = graph.nodes[edge.b];
  if (!a || !b) return null;
  return { a, b };
}

/** Which side of `roomId`'s bounding box this edge lies on, if any. */
export function sideOfRoom(graph: WallGraph, roomId: RoomId, edgeId: EdgeId): RoomSide | null {
  const bounds = roomBounds(graph, roomId);
  const ends = edgeEndpoints(graph, edgeId);
  if (!bounds || !ends) return null;
  const midX = (ends.a.x + ends.b.x) / 2;
  const midY = (ends.a.y + ends.b.y) / 2;
  const vertical = ends.a.x === ends.b.x;
  const eps = 1;
  if (vertical) {
    if (Math.abs(midX - bounds.x0) <= eps) return "left";
    if (Math.abs(midX - bounds.x1) <= eps) return "right";
    return null;
  }
  if (Math.abs(midY - bounds.y0) <= eps) return "top";
  if (Math.abs(midY - bounds.y1) <= eps) return "bottom";
  return null;
}

/** Every edge shared by both rooms — a party wall can be split into several collinear runs. */
export function sharedEdges(graph: WallGraph, roomA: RoomId, roomB: RoomId): EdgeId[] {
  const a = graph.rooms[roomA];
  const b = graph.rooms[roomB];
  if (!a || !b) return [];
  const setB = new Set(b.boundary);
  return a.boundary.filter((e) => setB.has(e));
}

function exteriorEdgesOnSide(graph: WallGraph, roomId: RoomId, side: RoomSide): EdgeId[] {
  const room = graph.rooms[roomId];
  if (!room) return [];
  return room.boundary.filter((edgeId) => {
    const edge = graph.edges[edgeId];
    if (!edge || edge.type !== "exterior") return false;
    return sideOfRoom(graph, roomId, edgeId) === side;
  });
}

/** Candidate edges for an anchor, longest first — the longest run is where an opening fits best. */
export function candidateEdges(graph: WallGraph, anchor: OpeningAnchor): EdgeId[] {
  const edges =
    anchor.kind === "between"
      ? sharedEdges(graph, anchor.rooms[0], anchor.rooms[1])
      : exteriorEdgesOnSide(graph, anchor.roomId, anchor.side);
  return edges.slice().sort((x, y) => edgeLength(graph, y) - edgeLength(graph, x));
}

export type ResolvedOpening = {
  opening: PersistedOpening;
  edgeId: EdgeId;
  /** Distance from edge.a along the centerline, in mm. */
  offset: number;
  /** The width actually used, after clamping to what the run can hold. */
  width: number;
};

/**
 * Places one persisted opening on a concrete edge, or returns null when no wall run in
 * the current geometry can hold it (a shared wall can disappear entirely when rooms are
 * rearranged — the opening stays in the document and reappears if the wall comes back).
 */
export function resolveOpening(graph: WallGraph, opening: PersistedOpening): ResolvedOpening | null {
  for (const edgeId of candidateEdges(graph, opening.anchor)) {
    const length = edgeLength(graph, edgeId);
    const usable = length - END_CLEARANCE_MM * 2;
    if (usable < MIN_OPENING_WIDTH_MM) continue;
    const width = Math.min(opening.width, usable);
    const slide = usable - width;
    const ratio = Math.min(Math.max(opening.offsetRatio, 0), 1);
    const offset = END_CLEARANCE_MM + slide * ratio;
    return { opening, edgeId, offset, width };
  }
  return null;
}

/**
 * Mutates `graph` so every edge carries the openings anchored to it. Called once per
 * solve; the graph's own `openings` arrays are always rebuilt, never merged into.
 */
export function applyOpeningsToGraph(graph: WallGraph, persisted: readonly PersistedOpening[]): void {
  for (const edge of Object.values(graph.edges)) edge.openings = [];
  for (const p of persisted) {
    const resolved = resolveOpening(graph, p);
    if (!resolved) continue;
    const edge = graph.edges[resolved.edgeId];
    if (!edge) continue;
    const opening: Opening = {
      id: p.id,
      kind: p.kind,
      offset: resolved.offset,
      width: resolved.width,
      height: p.height,
      ...(p.sill !== undefined ? { sill: p.sill } : {}),
      ...(p.swing !== undefined ? { swing: p.swing } : {}),
    };
    edge.openings.push(opening);
  }
  for (const edge of Object.values(graph.edges)) edge.openings.sort((a, b) => a.offset - b.offset);
}

/** Finds the edge an opening currently occupies, for hit-testing and drag math. */
export function findOpeningEdge(graph: WallGraph, openingId: string): { edgeId: EdgeId; opening: Opening } | null {
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    const opening = edge.openings.find((o) => o.id === openingId);
    if (opening) return { edgeId, opening };
  }
  return null;
}

/**
 * Derives an anchor from an edge id in the *current* graph, so a caller holding an
 * edge (a click on the canvas, or a provider's `edgeId`) can create an opening that
 * survives the regeneration that immediately follows.
 */
export function anchorForEdge(graph: WallGraph, edgeId: EdgeId): OpeningAnchor | null {
  const edge = graph.edges[edgeId];
  if (!edge) return null;
  const owners: RoomId[] = [];
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    if (room.boundary.includes(edgeId)) owners.push(roomId);
  }
  if (owners.length >= 2) {
    const [a, b] = owners as [RoomId, RoomId];
    return { kind: "between", rooms: a < b ? [a, b] : [b, a] };
  }
  const roomId = owners[0];
  if (!roomId) return null;
  const side = sideOfRoom(graph, roomId, edgeId);
  if (!side) return null;
  return { kind: "exterior", roomId, side };
}

export const OPENING_LIMITS = {
  END_CLEARANCE_MM,
  MIN_OPENING_WIDTH_MM,
};
