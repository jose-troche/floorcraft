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
import { findOpeningEdge, edgeEndpoints, OPENING_LIMITS, sideOfRoom } from "./openings.js";
import { roomCells } from "./wallGraph.js";
import { getNodeAt } from "./treeOps.js";
import { ROOM_PROGRAM_MIN_DIMENSIONS, generatorTree, type EdgeId, type PatchOp, type PlanDocument, type Rect, type RoomCell, type RoomId } from "./types.js";

export type DragPlan = { ok: true; ops: PatchOp[] } | { ok: false; reason: string };

/** Distance in mm within which two coordinates are treated as the same cut line. */
const CUT_EPSILON_MM = 1;

function solveLevel(doc: PlanDocument): { leaves: LeafRect[]; cuts: CutLine[] } | null {
  const level = activeLevel(doc);
  const tree = generatorTree(level);
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

/**
 * SLV-8. A cut line with a pinned room on either side is what *sets* that room's size, so
 * moving it is not a drag the solver can honour -- an exact dimension overrides the split
 * ratio outright, and the gesture would be discarded with no visible effect. The drag is
 * refused instead, naming the constraint in the way, which is SLV-8's "rejected with
 * visual feedback" rather than a drag that silently does nothing.
 */
function pinnedAcrossCut(doc: PlanDocument, cut: CutLine, nameOf: (id: RoomId) => string): string | null {
  const tree = generatorTree(activeLevel(doc));
  if (!tree) return null;
  const node = getNodeAt(tree, cut.path);
  if (node.kind !== "split") return null;
  const axis = cut.axis === "v" ? "width" : "depth";

  for (const child of node.children) {
    if (child.kind !== "leaf") continue;
    const pinned = cut.axis === "v" ? child.exactWidth : child.exactDepth;
    if (pinned === undefined) continue;
    return (
      `${nameOf(child.roomId)} is pinned to a ${axis} of ${Math.round(pinned)}mm, which is what fixes this wall. ` +
      `Clear that constraint to move it.`
    );
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

  // Checked before offering any ops: SLV-8 asks for the drag to be prevented, not
  // corrected after the fact. This is a structural look at the two subtrees either side
  // of the cut, so it costs nothing on a live drag's per-frame path.
  const nameOf = (id: RoomId) => level.graph.rooms[id]?.name ?? id;
  const pinned = pinnedAcrossCut(doc, cut, nameOf);
  if (pinned) return { ok: false, reason: pinned };

  return { ok: true, ops: [{ op: "setSplit", nodePath: cut.path, ratio }] };
}

export type BoundaryHandle = "east" | "south" | "southeast";

/**
 * Plans an outer-boundary resize (FR-7). The level origin stays at (0,0) — only the far
 * edges move — so a resize never has to translate the whole graph.
 */
export function planBoundaryResize(doc: PlanDocument, handle: BoundaryHandle, dxMm: number, dyMm: number): DragPlan {
  const level = activeLevel(doc);
  const tree = generatorTree(level);
  // A freeform level's floor is whatever its cells currently occupy — treeMinimumSize
  // doesn't apply since there's no tree to ask, and setBoundary's own freeform validation
  // (patch.ts) will refuse a shrink that actually cuts a cell regardless of this floor.
  const cellsFloor = level.generator?.kind === "freeform" ? boundsOfCells(level.generator.cells) : null;
  const floor = tree ? treeMinimumSize(tree) : (cellsFloor ?? { widthMm: 1000, depthMm: 1000 });
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

/** Every rectangle currently making up `roomId`, whichever generator mode is active. */
function currentRoomCells(doc: PlanDocument, roomId: RoomId): Rect[] {
  const level = activeLevel(doc);
  if (level.generator?.kind === "freeform") return roomCells(level.generator.cells, roomId);
  const solved = solveLevel(doc);
  const leaf = solved?.leaves.find((l) => l.roomId === roomId);
  return leaf ? [leaf] : [];
}

/**
 * Plans a room-label drag (FR-7). The anchor is clamped into whichever of the room's
 * cells the pointer is actually over — for an L-shape there can be more than one — or
 * the largest cell if the pointer has drifted outside the room entirely.
 */
export function planLabelDrag(doc: PlanDocument, roomId: RoomId, pointMm: { x: number; y: number }): DragPlan {
  const cells = currentRoomCells(doc, roomId);
  if (cells.length === 0) return { ok: false, reason: "That room is no longer part of the plan." };
  const target =
    cells.find((c) => pointMm.x >= c.x && pointMm.x <= c.x + c.w && pointMm.y >= c.y && pointMm.y <= c.y + c.d) ??
    cells.reduce((best, c) => (c.w * c.d > best.w * best.d ? c : best));
  const inset = Math.min(200, target.w / 2, target.d / 2);
  const x = Math.round(Math.min(Math.max(pointMm.x, target.x + inset), target.x + target.w - inset));
  const y = Math.round(Math.min(Math.max(pointMm.y, target.y + inset), target.y + target.d - inset));
  return { ok: true, ops: [{ op: "setLabelAnchor", roomId, x, y }] };
}

function boundsOfCells(cells: RoomCell[]): { widthMm: number; depthMm: number } {
  let widthMm = 0;
  let depthMm = 0;
  for (const c of cells) {
    widthMm = Math.max(widthMm, c.x + c.w);
    depthMm = Math.max(depthMm, c.y + c.d);
  }
  return { widthMm, depthMm };
}

type AlongAcross = { lo: number; hi: number };

function along(axis: "h" | "v", r: Rect): AlongAcross {
  return axis === "v" ? { lo: r.x, hi: r.x + r.w } : { lo: r.y, hi: r.y + r.d };
}
function across(axis: "h" | "v", r: Rect): AlongAcross {
  return axis === "v" ? { lo: r.y, hi: r.y + r.d } : { lo: r.x, hi: r.x + r.w };
}
function rectOf(axis: "h" | "v", a: AlongAcross, c: AlongAcross): Rect {
  return axis === "v" ? { x: a.lo, w: a.hi - a.lo, y: c.lo, d: c.hi - c.lo } : { y: a.lo, d: a.hi - a.lo, x: c.lo, w: c.hi - c.lo };
}
function minAlong(axis: "h" | "v", program: keyof typeof ROOM_PROGRAM_MIN_DIMENSIONS): number {
  const m = ROOM_PROGRAM_MIN_DIMENSIONS[program];
  return axis === "v" ? m.minWidth : m.minDepth;
}

const DRAG_EPSILON_MM = 1;

/**
 * Plans a wall drag on a freeform level (DM-2, FR-11). Unlike a tree drag — one split
 * ratio, two subtrees — a freeform wall segment can border cells that only partly span
 * it, so a cell whose across-range strictly contains the dragged span is cut into up to
 * three pieces: the parts outside the span stay put, the part inside moves with the
 * wall. That split is how an L-shape is born from a plain rectangular room.
 */
export function planDetachedWallDrag(doc: PlanDocument, edgeId: EdgeId, deltaMm: number): DragPlan {
  const level = activeLevel(doc);
  if (level.generator?.kind !== "freeform") {
    return { ok: false, reason: "This level uses a generated layout — switch it to freeform first." };
  }
  const generator = level.generator;
  const edge = level.graph.edges[edgeId];
  if (!edge) return { ok: false, reason: "That wall is no longer part of the plan." };
  if (edge.type === "exterior") {
    return { ok: false, reason: "That is an outer wall — drag the boundary handles to resize the footprint." };
  }
  const ends = edgeEndpoints(level.graph, edgeId);
  if (!ends) return { ok: false, reason: "That wall is no longer part of the plan." };

  const axis: "h" | "v" = ends.a.x === ends.b.x ? "v" : "h";
  const linePos = axis === "v" ? ends.a.x : ends.a.y;
  const spanLo = Math.min(axis === "v" ? ends.a.y : ends.a.x, axis === "v" ? ends.b.y : ends.b.x);
  const spanHi = Math.max(axis === "v" ? ends.a.y : ends.a.x, axis === "v" ? ends.b.y : ends.b.x);

  // Which room(s) border this edge, and which side of the line each sits on. "low" means
  // the room occupies the low-along side (this edge is its high-along wall); "high" the
  // mirror. sideOfRoom's "left"/"top" mean the edge IS that wall, i.e. the room is on the
  // opposite (high/high) side of the line.
  const owners: Array<{ roomId: RoomId; side: "low" | "high" }> = [];
  for (const [roomId, room] of Object.entries(level.graph.rooms)) {
    if (!room.boundary.includes(edgeId)) continue;
    const s = sideOfRoom(level.graph, roomId, edgeId);
    if (axis === "v") {
      if (s === "left") owners.push({ roomId, side: "high" });
      else if (s === "right") owners.push({ roomId, side: "low" });
    } else {
      if (s === "top") owners.push({ roomId, side: "high" });
      else if (s === "bottom") owners.push({ roomId, side: "low" });
    }
  }
  if (owners.length === 0) return { ok: false, reason: "That wall isn't adjacent to any room." };

  const isTouched = (side: "low" | "high", cell: Rect) => {
    const a = along(axis, cell);
    const c = across(axis, cell);
    const overlapsSpan = c.hi > spanLo + DRAG_EPSILON_MM && c.lo < spanHi - DRAG_EPSILON_MM;
    const onLine = side === "low" ? Math.abs(a.hi - linePos) <= DRAG_EPSILON_MM : Math.abs(a.lo - linePos) <= DRAG_EPSILON_MM;
    return overlapsSpan && onLine;
  };

  // Clamp deltaMm so every touched cell on every owning room stays at or above its
  // program minimum — SLV-8's "reject or snap to the constraint boundary", never a
  // silently broken result.
  let deltaMin = -Infinity;
  let deltaMax = Infinity;
  for (const o of owners) {
    const room = level.graph.rooms[o.roomId]!;
    const min = minAlong(axis, room.program);
    for (const cell of roomCells(generator.cells, o.roomId)) {
      if (!isTouched(o.side, cell)) continue;
      const a = along(axis, cell);
      if (o.side === "low") deltaMin = Math.max(deltaMin, a.lo + min - linePos);
      else deltaMax = Math.min(deltaMax, a.hi - min - linePos);
    }
  }
  if (deltaMin > deltaMax) {
    return { ok: false, reason: "Both rooms are already at their minimum size, so this wall can't move." };
  }
  const clamped = Math.min(Math.max(deltaMm, deltaMin), deltaMax);
  if (Math.abs(clamped) < DRAG_EPSILON_MM) return { ok: true, ops: [] };
  const newLinePos = linePos + clamped;

  const ops: PatchOp[] = [];
  for (const o of owners) {
    const nextCells: Rect[] = [];
    for (const cell of roomCells(generator.cells, o.roomId)) {
      if (!isTouched(o.side, cell)) {
        nextCells.push(cell);
        continue;
      }
      const a = along(axis, cell);
      const c = across(axis, cell);
      const insideLo = Math.max(c.lo, spanLo);
      const insideHi = Math.min(c.hi, spanHi);
      if (c.lo < spanLo) nextCells.push(rectOf(axis, a, { lo: c.lo, hi: spanLo }));
      if (c.hi > spanHi) nextCells.push(rectOf(axis, a, { lo: spanHi, hi: c.hi }));
      const movedAlong = o.side === "low" ? { lo: a.lo, hi: newLinePos } : { lo: newLinePos, hi: a.hi };
      nextCells.push(rectOf(axis, movedAlong, { lo: insideLo, hi: insideHi }));
    }
    ops.push({ op: "setRoomRects", roomId: o.roomId, rects: nextCells });
  }
  return { ok: true, ops };
}

/** Detaches the active level's generator, freezing its current layout into cells (DM-2). */
export function planDetach(doc: PlanDocument): DragPlan {
  const level = activeLevel(doc);
  if (level.generator?.kind === "freeform") return { ok: true, ops: [] };
  if (!generatorTree(level)) return { ok: false, reason: "This level has no layout to detach." };
  return { ok: true, ops: [{ op: "detachGenerator" }] };
}

/** Nudge distance for keyboard-driven edits (NFR-6), in mm — one grid module by default. */
export function keyboardStepMm(doc: PlanDocument, coarse = false): number {
  const step = Math.max(Math.round(doc.gridModule), 1);
  return coarse ? step * 10 : step;
}
