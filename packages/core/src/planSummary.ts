// Compact digest sent to providers — specs.md §5.1 (INF-2). Never includes the wall
// graph; must fit in ~600 tokens for a 20-room level (roughly 4 chars/token).

import { generatorTree, type PlanDocument, type PlanSummary, type RoomId } from "./types.js";
import { activeLevel } from "./patch.js";
import { polygonFromBoundary } from "./wallGraph.js";

const TOKEN_CHAR_BUDGET_20_ROOMS = 2400; // ~600 tokens

function isExteriorFacing(graph: PlanDocument["levels"][number]["graph"], roomId: RoomId): boolean {
  const room = graph.rooms[roomId];
  if (!room) return false;
  return room.boundary.some((edgeId) => graph.edges[edgeId]?.type === "exterior");
}

function roomArea(graph: PlanDocument["levels"][number]["graph"], roomId: RoomId): number {
  const room = graph.rooms[roomId];
  if (!room || room.boundary.length === 0) return 0;
  const pts = polygonFromBoundary(graph, room.boundary);
  // Shoelace formula over the boundary's node sequence.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    area += p0.x * p1.y - p1.x * p0.y;
  }
  return Math.abs(area) / 2;
}

function adjacentPairs(graph: PlanDocument["levels"][number]["graph"]): Array<[RoomId, RoomId]> {
  const byEdge = new Map<string, RoomId[]>();
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    for (const edgeId of room.boundary) {
      const arr = byEdge.get(edgeId) ?? [];
      arr.push(roomId);
      byEdge.set(edgeId, arr);
    }
  }
  const pairs = new Set<string>();
  const out: Array<[RoomId, RoomId]> = [];
  for (const roomIds of byEdge.values()) {
    if (roomIds.length !== 2) continue;
    const [a, b] = roomIds as [RoomId, RoomId];
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    out.push(a < b ? [a, b] : [b, a]);
  }
  return out;
}

export function buildPlanSummary(doc: PlanDocument): PlanSummary {
  const level = activeLevel(doc);
  const graph = level.graph;
  const rooms = Object.entries(graph.rooms).map(([roomId, room]) => ({
    roomId,
    program: room.program,
    name: room.name,
    approxAreaMm2: Math.round(roomArea(graph, roomId)),
    exterior: isExteriorFacing(graph, roomId),
  }));

  return {
    title: doc.title,
    units: doc.units,
    boundary: level.boundary,
    rooms,
    adjacencies: adjacentPairs(graph),
    mode: level.generator?.kind === "freeform" ? "freeform" : "slicing",
    generatorTree: generatorTree(level) ?? null,
  };
}

/** Rough token estimate (~4 chars/token); used to decide when history must be truncated first (T0-3). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function summaryWithinBudget(summary: PlanSummary): boolean {
  return JSON.stringify(summary).length <= TOKEN_CHAR_BUDGET_20_ROOMS;
}
