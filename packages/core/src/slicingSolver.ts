// Layout solver — specs.md §4. Evaluates a SlicingTree against an outer boundary
// into axis-aligned leaf rectangles with no overlaps, no gaps, and no zero/negative
// area rooms (SLV-1), enforcing per-program minimum dimensions and grid-snapped
// centerlines (SLV-2 required tiers). Unsatisfiable minimums fail structured (SLV-3).

import type { NodePath, RoomId, SlicingTree, SolveViolation } from "./types.js";
import { ROOM_PROGRAM_MIN_DIMENSIONS } from "./types.js";

export type Rect = { x: number; y: number; w: number; d: number };

export type LeafRect = Rect & { roomId: RoomId; path: NodePath };

/**
 * An internal split's realised cut line. Dragging a wall in the canvas is an edit to
 * exactly one of these (SLV-5), so the solver reports where each landed and how far it
 * can travel before a child room falls under its minimum.
 */
export type CutLine = {
  path: NodePath;
  axis: "h" | "v";
  /** x for a vertical cut, y for a horizontal one, in level-local mm. */
  position: number;
  /** The rectangle this split subdivides. */
  rect: Rect;
  /** Range `position` may take without violating either child's minimum size. */
  min: number;
  max: number;
};

export type SlicingSolveResult =
  | { ok: true; leaves: LeafRect[]; cuts: CutLine[] }
  | { ok: false; violations: SolveViolation[] };

type MinSize = { w: number; d: number };

const FALLBACK_MIN = { minWidth: 300, minDepth: 300 };

function leafMin(node: Extract<SlicingTree, { kind: "leaf" }>): { minWidth: number; minDepth: number } {
  return {
    minWidth: node.minWidth ?? FALLBACK_MIN.minWidth,
    minDepth: node.minDepth ?? FALLBACK_MIN.minDepth,
  };
}

function computeMin(node: SlicingTree): MinSize {
  if (node.kind === "leaf") {
    const m = leafMin(node);
    return { w: m.minWidth, d: m.minDepth };
  }
  const m0 = computeMin(node.children[0]);
  const m1 = computeMin(node.children[1]);
  if (node.axis === "v") {
    // Vertical cut line: children sit side by side, each spans the full depth.
    return { w: m0.w + m1.w, d: Math.max(m0.d, m1.d) };
  }
  // Horizontal cut line: children stack top/bottom, each spans the full width.
  return { w: Math.max(m0.w, m1.w), d: m0.d + m1.d };
}

function snapWithinRange(value: number, lo: number, hi: number, grid: number): number {
  if (grid <= 0 || hi <= lo) return Math.min(Math.max(value, lo), hi);
  const candidate = Math.round(value / grid) * grid;
  if (candidate >= lo && candidate <= hi) return candidate;
  const upFromLo = Math.ceil(lo / grid) * grid;
  const downFromHi = Math.floor(hi / grid) * grid;
  if (upFromLo <= hi) return upFromLo;
  if (downFromHi >= lo) return downFromHi;
  return Math.min(Math.max(value, lo), hi);
}

function collectRoomIds(node: SlicingTree, out: RoomId[]): void {
  if (node.kind === "leaf") {
    out.push(node.roomId);
    return;
  }
  collectRoomIds(node.children[0], out);
  collectRoomIds(node.children[1], out);
}

/** Assigns rectangles top-down, snapping each internal cut line to the grid module while keeping every leaf >= its min size. */
function snapCutLines(
  node: SlicingTree,
  rect: Rect,
  grid: number,
  path: NodePath,
  out: LeafRect[],
  cuts: CutLine[],
): void {
  if (node.kind === "leaf") {
    out.push({ ...rect, roomId: node.roomId, path });
    return;
  }
  const [c0, c1] = node.children;
  const m0 = computeMin(c0);
  const m1 = computeMin(c1);
  if (node.axis === "v") {
    const lo = m0.w;
    const hi = rect.w - m1.w;
    const ideal = node.ratio * rect.w;
    const raw = Math.min(Math.max(ideal, lo), hi);
    const w0 = snapWithinRange(raw, lo, hi, grid);
    const w1 = rect.w - w0;
    cuts.push({ path, axis: "v", position: rect.x + w0, rect, min: rect.x + lo, max: rect.x + hi });
    snapCutLines(c0, { x: rect.x, y: rect.y, w: w0, d: rect.d }, grid, [...path, 0], out, cuts);
    snapCutLines(c1, { x: rect.x + w0, y: rect.y, w: w1, d: rect.d }, grid, [...path, 1], out, cuts);
  } else {
    const lo = m0.d;
    const hi = rect.d - m1.d;
    const ideal = node.ratio * rect.d;
    const raw = Math.min(Math.max(ideal, lo), hi);
    const d0 = snapWithinRange(raw, lo, hi, grid);
    const d1 = rect.d - d0;
    cuts.push({ path, axis: "h", position: rect.y + d0, rect, min: rect.y + lo, max: rect.y + hi });
    snapCutLines(c0, { x: rect.x, y: rect.y, w: rect.w, d: d0 }, grid, [...path, 0], out, cuts);
    snapCutLines(c1, { x: rect.x, y: rect.y + d0, w: rect.w, d: d1 }, grid, [...path, 1], out, cuts);
  }
}

export function solveSlicingTree(
  tree: SlicingTree,
  boundary: { widthMm: number; depthMm: number },
  gridModule: number,
): SlicingSolveResult {
  const rootMin = computeMin(tree);
  if (rootMin.w > boundary.widthMm || rootMin.d > boundary.depthMm) {
    const roomIds: RoomId[] = [];
    collectRoomIds(tree, roomIds);
    return {
      ok: false,
      violations: [
        {
          roomIds,
          reason: "boundary-too-small",
          message:
            `The requested rooms need at least ${rootMin.w}mm x ${rootMin.d}mm, ` +
            `but the boundary is only ${boundary.widthMm}mm x ${boundary.depthMm}mm. ` +
            `Enlarge the footprint or reduce/shrink rooms.`,
        },
      ],
    };
  }

  const rootRect: Rect = { x: 0, y: 0, w: boundary.widthMm, d: boundary.depthMm };
  const leaves: LeafRect[] = [];
  const cuts: CutLine[] = [];
  snapCutLines(tree, rootRect, gridModule, [], leaves, cuts);

  const violations: SolveViolation[] = [];
  for (const leaf of leaves) {
    if (leaf.w <= 0 || leaf.d <= 0) {
      violations.push({
        roomIds: [leaf.roomId],
        reason: "min-dimension",
        message: `Room could not be assigned a positive-area rectangle.`,
      });
    }
  }
  if (violations.length > 0) return { ok: false, violations };

  return { ok: true, leaves, cuts };
}

/** Smallest boundary that can hold this tree — the floor for an outer-boundary resize drag. */
export function treeMinimumSize(tree: SlicingTree): { widthMm: number; depthMm: number } {
  const m = computeMin(tree);
  return { widthMm: m.w, depthMm: m.d };
}

export function defaultMinFor(program: keyof typeof ROOM_PROGRAM_MIN_DIMENSIONS): { minWidth: number; minDepth: number } {
  return ROOM_PROGRAM_MIN_DIMENSIONS[program] ?? FALLBACK_MIN;
}
