// Direct-manipulation planning — specs.md §6.2 FR-7 and §4 SLV-5/SLV-8.
//
// Every canvas gesture is turned into ordinary patch ops here, so a drag goes through
// exactly the same reducer, undo stack, and validation as a chat turn (FR-3). Nothing in
// this module mutates anything: the canvas asks what a gesture *would* do, previews the
// result by applying the ops to a copy, and only commits on pointer-up.
//
// SLV-5: a wall drag edits the enclosing split's ratio, never free-floating geometry.
// SLV-8: a drag that would override an explicit dimension constraint is rejected with a
// reason, not silently corrected afterwards.

import { activeLevel } from "./patch.js";
import { solveSlicingTree, treeMinimumSize, type CutLine, type LeafRect } from "./slicingSolver.js";
import { findOpeningEdge, edgeEndpoints, OPENING_LIMITS } from "./openings.js";
import { setSplitAt } from "./treeOps.js";
import type { EdgeId, PatchOp, PlanDocument, RoomId } from "./types.js";

export type DragPlan = { ok: true; ops: PatchOp[] } | { ok: false; reason: string };

/** Distance in mm within which two coordinates are treated as the same cut line. */
const CUT_EPSILON_MM = 1;

function solveLevel(doc: PlanDocument): { leaves: LeafRect[]; cuts: CutLine[] } | null {
  const level = activeLevel(doc);
  const tree = level.generator?.tree;
  if (!tree) return null;
  const solved = solveSlicingTree(tree, level.boundary, doc.gridModule);
  return solved.ok ? { leaves: solved.leaves, cuts: solved.cuts } : null;
}

/**
 * The split whose cut line this wall edge lies on. A single cut can be shared by several
 * collinear edges, and nested splits can produce two cuts at the same coordinate — the
 * smallest rectangle covering the edge is the one the user is pointing at.
 */
export function findCutForEdge(doc: PlanDocument, edgeId: EdgeId): CutLine | null {
  const level = activeLevel(doc);
  const graph = level.graph;
  const ends = edgeEndpoints(graph, edgeId);
  const edge = graph.edges[edgeId];
  if (!ends || !edge || edge.type === "exterior") return null;
  const solved = solveLevel(doc);
  if (!solved) return null;

  const vertical = ends.a.x === ends.b.x;
  const axis = vertical ? "v" : "h";
  const position = vertical ? ends.a.x : ends.a.y;
  const lo = vertical ? Math.min(ends.a.y, ends.b.y) : Math.min(ends.a.x, ends.b.x);
  const hi = vertical ? Math.max(ends.a.y, ends.b.y) : Math.max(ends.a.x, ends.b.x);

  let best: CutLine | null = null;
  for (const cut of solved.cuts) {
    if (cut.axis !== axis) continue;
    if (Math.abs(cut.position - position) > CUT_EPSILON_MM) continue;
    const spanLo = vertical ? cut.rect.y : cut.rect.x;
    const spanHi = vertical ? cut.rect.y + cut.rect.d : cut.rect.x + cut.rect.w;
    if (spanLo > lo + CUT_EPSILON_MM || spanHi < hi - CUT_EPSILON_MM) continue;
    const area = cut.rect.w * cut.rect.d;
    if (!best || area < best.rect.w * best.rect.d) best = cut;
  }
  return best;
}

/** Rooms whose width or depth is pinned to an exact value, with the value. */
function pinnedDimensions(doc: PlanDocument): Array<{ roomId: RoomId; axis: "width" | "depth"; value: number }> {
  const level = activeLevel(doc);
  const out: Array<{ roomId: RoomId; axis: "width" | "depth"; value: number }> = [];
  for (const [roomId, room] of Object.entries(level.graph.rooms)) {
    const width = room.constraints?.width?.exact;
    const depth = room.constraints?.depth?.exact;
    if (width !== undefined) out.push({ roomId, axis: "width", value: width });
    if (depth !== undefined) out.push({ roomId, axis: "depth", value: depth });
  }
  return out;
}

/**
 * SLV-8. A room whose width or depth is pinned must not have that dimension changed by a
 * drag; the drag is rejected and the caller shows the reason rather than letting the
 * geometry move and snap back.
 */
function pinnedViolation(doc: PlanDocument, candidateLeaves: LeafRect[], nameOf: (id: RoomId) => string): string | null {
  const before = solveLevel(doc);
  if (!before) return null;
  const beforeById = new Map(before.leaves.map((l) => [l.roomId, l]));
  for (const pin of pinnedDimensions(doc)) {
    const was = beforeById.get(pin.roomId);
    const now = candidateLeaves.find((l) => l.roomId === pin.roomId);
    if (!was || !now) continue;
    const wasValue = pin.axis === "width" ? was.w : was.d;
    const nowValue = pin.axis === "width" ? now.w : now.d;
    if (Math.abs(nowValue - wasValue) > CUT_EPSILON_MM) {
      return `${nameOf(pin.roomId)} is pinned to a ${pin.axis} of ${pin.value}mm. Clear that constraint before dragging this wall.`;
    }
  }
  return null;
}

/**
 * Plans a wall drag. `deltaMm` is the pointer movement along the wall's normal — positive
 * is right for a vertical wall, down for a horizontal one.
 */
export function planWallDrag(doc: PlanDocument, edgeId: EdgeId, deltaMm: number): DragPlan {
  const level = activeLevel(doc);
  const edge = level.graph.edges[edgeId];
  if (!edge) return { ok: false, reason: "That wall is no longer part of the plan." };
  if (edge.type === "exterior") {
    return { ok: false, reason: "That is an outer wall — drag the boundary handles to resize the footprint." };
  }
  const cut = findCutForEdge(doc, edgeId);
  if (!cut) {
    return { ok: false, reason: "That wall isn't controlled by a single split, so it can't be dragged yet." };
  }

  const target = cut.position + deltaMm;
  const clamped = Math.min(Math.max(target, cut.min), cut.max);
  if (cut.max - cut.min < CUT_EPSILON_MM) {
    return { ok: false, reason: "Both rooms are already at their minimum size, so this wall can't move." };
  }
  const span = cut.axis === "v" ? cut.rect.w : cut.rect.d;
  const origin = cut.axis === "v" ? cut.rect.x : cut.rect.y;
  if (span <= 0) return { ok: false, reason: "That wall can't move." };
  const ratio = (clamped - origin) / span;

  const ops: PatchOp[] = [{ op: "setSplit", nodePath: cut.path, ratio }];

  // Re-solve the candidate tree to check pinned dimensions before offering the ops:
  // rejecting here is what makes SLV-8's "prevented, not corrected" true. The check
  // costs two extra solves, so it is skipped outright when nothing is pinned — this
  // runs on every frame of a live drag.
  if (pinnedDimensions(doc).length > 0) {
    const candidate = applyRatio(doc, cut, ratio);
    if (candidate) {
      const nameOf = (id: RoomId) => level.graph.rooms[id]?.name ?? id;
      const violation = pinnedViolation(doc, candidate, nameOf);
      if (violation) return { ok: false, reason: violation };
    }
  }

  return { ok: true, ops };
}

/** Solves the tree that would result from setting one split's ratio, without building a graph. */
function applyRatio(doc: PlanDocument, cut: CutLine, ratio: number): LeafRect[] | null {
  const level = activeLevel(doc);
  const tree = level.generator?.tree;
  if (!tree) return null;
  const next = setSplitAt(tree, cut.path, { ratio });
  const solved = solveSlicingTree(next, level.boundary, doc.gridModule);
  return solved.ok ? solved.leaves : null;
}

export type BoundaryHandle = "east" | "south" | "southeast";

/**
 * Plans an outer-boundary resize (FR-7). The level origin stays at (0,0) — only the far
 * edges move — so a resize never has to translate the whole graph.
 */
export function planBoundaryResize(doc: PlanDocument, handle: BoundaryHandle, dxMm: number, dyMm: number): DragPlan {
  const level = activeLevel(doc);
  const tree = level.generator?.tree;
  const floor = tree ? treeMinimumSize(tree) : { widthMm: 1000, depthMm: 1000 };
  const wantWidth = handle === "south" ? level.boundary.widthMm : level.boundary.widthMm + dxMm;
  const wantDepth = handle === "east" ? level.boundary.depthMm : level.boundary.depthMm + dyMm;
  const widthMm = Math.round(Math.max(wantWidth, floor.widthMm));
  const depthMm = Math.round(Math.max(wantDepth, floor.depthMm));
  if (widthMm === level.boundary.widthMm && depthMm === level.boundary.depthMm) return { ok: true, ops: [] };
  return { ok: true, ops: [{ op: "setBoundary", widthMm, depthMm }] };
}

/**
 * Plans dragging an opening along the wall it already sits on. `pointMm` is the pointer
 * in level coordinates; it is projected onto the wall run and converted back to the
 * opening's stored ratio.
 */
export function planOpeningDrag(doc: PlanDocument, openingId: string, pointMm: { x: number; y: number }): DragPlan {
  const level = activeLevel(doc);
  const found = findOpeningEdge(level.graph, openingId);
  if (!found) return { ok: false, reason: "That opening is no longer on a wall." };
  const ends = edgeEndpoints(level.graph, found.edgeId);
  if (!ends) return { ok: false, reason: "That opening is no longer on a wall." };

  const vertical = ends.a.x === ends.b.x;
  const lo = vertical ? Math.min(ends.a.y, ends.b.y) : Math.min(ends.a.x, ends.b.x);
  const hi = vertical ? Math.max(ends.a.y, ends.b.y) : Math.max(ends.a.x, ends.b.x);
  const at = vertical ? pointMm.y : pointMm.x;

  // The stored ratio positions the opening's *start* within the run's slidable range, so
  // the pointer (which grabs the middle of the symbol) is offset by half its width.
  const usable = hi - lo - OPENING_LIMITS.END_CLEARANCE_MM * 2;
  const slide = usable - found.opening.width;
  if (slide <= 0) return { ok: true, ops: [{ op: "moveOpening", openingId, offsetRatio: 0.5 }] };
  const start = at - found.opening.width / 2;
  const ratio = (start - (lo + OPENING_LIMITS.END_CLEARANCE_MM)) / slide;
  return { ok: true, ops: [{ op: "moveOpening", openingId, offsetRatio: Math.min(Math.max(ratio, 0), 1) }] };
}

const SWING_CYCLE = ["left-in", "right-in", "left-out", "right-out"] as const;

/** "Rotate" a door: cycles which way it hinges and swings (FR-7). Windows don't rotate. */
export function planOpeningRotate(doc: PlanDocument, openingId: string): DragPlan {
  const level = activeLevel(doc);
  const opening = (level.openings ?? []).find((o) => o.id === openingId);
  if (!opening) return { ok: false, reason: "That opening is no longer part of the plan." };
  if (opening.kind === "window") return { ok: false, reason: "Windows don't have a swing direction." };
  const index = SWING_CYCLE.indexOf((opening.swing ?? "left-in") as (typeof SWING_CYCLE)[number]);
  const next = SWING_CYCLE[(index + 1) % SWING_CYCLE.length]!;
  return { ok: true, ops: [{ op: "setOpeningSwing", openingId, swing: next }] };
}

/** Plans a room-label drag (FR-7). The anchor is clamped into the room it belongs to. */
export function planLabelDrag(doc: PlanDocument, roomId: RoomId, pointMm: { x: number; y: number }): DragPlan {
  const solved = solveLevel(doc);
  const rect = solved?.leaves.find((l) => l.roomId === roomId);
  if (!rect) return { ok: false, reason: "That room is no longer part of the plan." };
  const inset = Math.min(200, rect.w / 2, rect.d / 2);
  const x = Math.round(Math.min(Math.max(pointMm.x, rect.x + inset), rect.x + rect.w - inset));
  const y = Math.round(Math.min(Math.max(pointMm.y, rect.y + inset), rect.y + rect.d - inset));
  return { ok: true, ops: [{ op: "setLabelAnchor", roomId, x, y }] };
}

/** Nudge distance for keyboard-driven edits (NFR-6), in mm — one grid module by default. */
export function keyboardStepMm(doc: PlanDocument, coarse = false): number {
  const step = Math.max(Math.round(doc.gridModule), 1);
  return coarse ? step * 10 : step;
}
