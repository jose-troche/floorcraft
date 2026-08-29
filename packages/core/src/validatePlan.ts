// Plan validation — specs.md §10.4 (`validate_plan`: min dimensions, unreachable rooms,
// missing egress). Pure and platform-free (ARC-2) so the MCP Worker and the browser run
// the same checks; MCP-2 forbids a forked copy on either side.
//
// This is a *review* of geometry that already exists, which is why it lives apart from
// SolveViolation: the solver rejects a layout it cannot build, whereas everything here
// describes a plan that built fine and is still missing something a person would notice.

import { ROOM_PROGRAM_MIN_DIMENSIONS, type PlanDocument, type RoomId, type WallGraph } from "./types.js";
import { activeLevel } from "./patch.js";
import { polygonFromBoundary } from "./wallGraph.js";

export type PlanViolationReason =
  | "no-rooms"
  | "empty-room"
  | "min-dimension"
  | "missing-egress"
  | "unreachable-room";

export type PlanViolation = {
  reason: PlanViolationReason;
  /**
   * `error` clears `valid`; `warning` does not. The split exists because a freshly
   * generated plan has no doors yet — reporting that as invalid would make the very
   * first `validate_plan` call after `create_plan` fail for every plan ever made.
   */
  severity: "error" | "warning";
  roomIds: RoomId[];
  message: string;
};

export type PlanValidation = { valid: boolean; violations: PlanViolation[] };

/** Openings a person can walk through. A window connects nothing. */
const PASSABLE = new Set(["door", "cased", "pass-through"]);

function boundsOf(graph: WallGraph, roomId: RoomId): { w: number; d: number } | null {
  const room = graph.rooms[roomId];
  if (!room || room.boundary.length === 0) return null;
  const pts = polygonFromBoundary(graph, room.boundary);
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
}

/** Rooms on either side of an edge, in whatever order the graph lists them. */
function roomsByEdge(graph: WallGraph): Map<string, RoomId[]> {
  const byEdge = new Map<string, RoomId[]>();
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    for (const edgeId of room.boundary) {
      const arr = byEdge.get(edgeId);
      if (arr) arr.push(roomId);
      else byEdge.set(edgeId, [roomId]);
    }
  }
  return byEdge;
}

function spell(program: string): string {
  return program.replace(/-/g, " ");
}

/**
 * Checks the *active* level — the one `describe_plan`, `render_svg` and the canvas all
 * work on. Multi-storey plans are validated a level at a time by switching the active
 * level (`setActiveLevel`), which keeps one meaning for "the plan" across every tool.
 *
 * Dimensions are measured on wall centerlines, the same lines the solver enforces its
 * own minimums against (SLV-2). A generated layout therefore never reports
 * `min-dimension` — the solver would have refused to build it. The check earns its keep
 * on freeform and imported geometry (DM-2, FR-24), where rectangles come from a drag or
 * a scanned drawing and nothing has vetted them.
 */
export function validatePlan(doc: PlanDocument): PlanValidation {
  const level = activeLevel(doc);
  const graph = level.graph;
  const violations: PlanViolation[] = [];
  const roomIds = Object.keys(graph.rooms);

  if (roomIds.length === 0) {
    return {
      valid: true,
      violations: [{ reason: "no-rooms", severity: "warning", roomIds: [], message: `Level "${level.name}" has no rooms yet.` }],
    };
  }

  // ---------------------------------------------------------------- dimensions
  const undersized: RoomId[] = [];
  for (const roomId of roomIds) {
    const room = graph.rooms[roomId]!;
    const size = boundsOf(graph, roomId);
    if (!size || size.w <= 0 || size.d <= 0) {
      violations.push({
        reason: "empty-room",
        severity: "error",
        roomIds: [roomId],
        message: `"${room.name}" has no floor area — it exists in the room list but occupies nothing on the level.`,
      });
      continue;
    }
    const min = ROOM_PROGRAM_MIN_DIMENSIONS[room.program];
    // Orientation-independent: a 2440 x 3050 kitchen and a 3050 x 2440 one are the same room.
    const shortSide = Math.min(size.w, size.d);
    const longSide = Math.max(size.w, size.d);
    const minShort = Math.min(min.minWidth, min.minDepth);
    const minLong = Math.max(min.minWidth, min.minDepth);
    if (shortSide + 0.5 < minShort || longSide + 0.5 < minLong) {
      undersized.push(roomId);
      violations.push({
        reason: "min-dimension",
        severity: "error",
        roomIds: [roomId],
        message:
          `"${room.name}" measures ${Math.round(size.w)} x ${Math.round(size.d)} mm; ` +
          `a ${spell(room.program)} needs at least ${min.minWidth} x ${min.minDepth} mm for clearances.`,
      });
    }
  }

  // ------------------------------------------------------------------- egress
  const byEdge = roomsByEdge(graph);
  const doorsBetween = new Map<RoomId, Set<RoomId>>();
  const withExteriorDoor = new Set<RoomId>();
  let passableCount = 0;

  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    const passable = edge.openings.filter((o) => PASSABLE.has(o.kind));
    if (passable.length === 0) continue;
    passableCount += passable.length;
    const sides = byEdge.get(edgeId) ?? [];
    if (edge.type === "exterior" || sides.length === 1) {
      for (const roomId of sides) withExteriorDoor.add(roomId);
      continue;
    }
    for (const a of sides) {
      for (const b of sides) {
        if (a === b) continue;
        const set = doorsBetween.get(a) ?? new Set<RoomId>();
        set.add(b);
        doorsBetween.set(a, set);
      }
    }
  }

  if (passableCount === 0) {
    // Every plan starts here, so it is stated once as a next step rather than as N
    // separate unreachable-room findings that all have the same single cause.
    violations.push({
      reason: "missing-egress",
      severity: "warning",
      roomIds: [],
      message: "No doors have been placed yet. Add an exterior door and doors between rooms with `addOpening`.",
    });
  } else if (withExteriorDoor.size === 0) {
    violations.push({
      reason: "missing-egress",
      severity: "error",
      roomIds: [],
      message: "No room opens to the outside: this level has no way in or out. Add a door on an exterior wall.",
    });
  } else {
    const reached = new Set<RoomId>(withExteriorDoor);
    const queue = [...withExteriorDoor];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of doorsBetween.get(current) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    const stranded = roomIds.filter((id) => !reached.has(id));
    if (stranded.length > 0) {
      violations.push({
        reason: "unreachable-room",
        severity: "error",
        roomIds: stranded,
        message:
          `${stranded.map((id) => `"${graph.rooms[id]!.name}"`).join(", ")} ` +
          `cannot be reached from an exterior door. Add a door between each and a room that can.`,
      });
    }
  }

  return { valid: !violations.some((v) => v.severity === "error"), violations };
}

/** One line per violation, for the human-readable half of a tool response (MCP-11). */
export function describeViolations(result: PlanValidation): string {
  if (result.violations.length === 0) return "No problems found.";
  return result.violations.map((v) => `${v.severity === "error" ? "Error" : "Note"}: ${v.message}`).join("\n");
}
