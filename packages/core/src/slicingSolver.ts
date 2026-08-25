// Layout solver — specs.md §4. Evaluates a SlicingTree against an outer boundary
// into axis-aligned leaf rectangles with no overlaps, no gaps, and no zero/negative
// area rooms (SLV-1), enforcing per-program minimum dimensions and grid-snapped
// centerlines (SLV-2 required tiers). Unsatisfiable minimums fail structured (SLV-3).

import type { NodePath, Rect, RoomId, SlicingLeaf, SlicingTree, SolveViolation } from "./types.js";
import { ROOM_PROGRAM_MIN_DIMENSIONS } from "./types.js";

// Rect itself lives in types.ts (RoomCell reuses it for the freeform generator); not
// re-exported here too, since index.ts's `export *` from both modules would collide.
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

/**
 * A dimension the user pinned that the solved layout could not deliver (SLV-7).
 *
 * Deliberately not a `SolveViolation`: a slicing tree tiles its boundary with no gaps, so
 * a leaf's extent is only ever as free as the rooms around it leave it. The only room on
 * a level has to fill that level whatever size was asked for, and a room inside a split
 * gets to name only the axis its parent cuts. Failing the patch over that would make
 * "add a kitchen of 8x5 feet" impossible to say as the first thing in a plan; drawing the
 * 30x40 ft room it silently becomes is how a plan ends up labelled 1200 sq ft when 40 was
 * asked for. So the room is placed and the shortfall is handed back for the caller to say
 * out loud, which is what SLV-7 asks for.
 */
export type UnmetConstraint = {
  roomId: RoomId;
  axis: "width" | "depth";
  /** What the user pinned, mm. */
  requestedMm: number;
  /** What the partition could actually give it, mm. */
  actualMm: number;
};

/**
 * Slack allowed before a pinned dimension counts as unmet. Unit conversion lands on whole
 * millimetres (8 ft is 2438.4mm, stored as 2438) while the per-program minimums nearby are
 * round numbers (a kitchen's 2440mm), so a pin can miss by a millimetre or two in a way
 * nobody can see: display precision is a tenth of a foot, or 30mm.
 */
const EXACT_TOLERANCE_MM = 10;

export type SlicingSolveResult =
  | { ok: true; leaves: LeafRect[]; cuts: CutLine[]; unmet: UnmetConstraint[] }
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

/**
 * The size this subtree demands along `axis`, if it pins one.
 *
 * A leaf pins whatever the user pinned on it. A split pins along the axis it does *not*
 * cut: children of a vertical cut sit side by side and each spans the parent's full depth,
 * so a depth pinned anywhere inside is a depth pinned on the whole subtree. Along its own
 * cut axis a split pins nothing — that extent is the sum of what its children negotiate,
 * which the recursion below settles on its own.
 *
 * Stopping at the split (the obvious reading of "only a leaf has an exact size") is what
 * made a pin evaporate as soon as a second room joined the pinned one: putting a pantry
 * under a 10x12 ft kitchen buried the kitchen one level deeper, and the outer cut then saw
 * a split where it used to see the leaf, fell back to area weights, and quietly widened the
 * kitchen to 13 ft. A pin the user stated should survive its room gaining a neighbour.
 */
function exactSize(node: SlicingTree, axis: "w" | "d"): number | null {
  if (node.kind === "leaf") {
    const value = axis === "w" ? node.exactWidth : node.exactDepth;
    return value !== undefined && value > 0 ? value : null;
  }
  if (axis === (node.axis === "v" ? "w" : "d")) return null;
  // Two children pinning the same axis to different values is a genuine conflict; the
  // first wins here and the loser is reported by unmetConstraints once the solve lands.
  return exactSize(node.children[0], axis) ?? exactSize(node.children[1], axis);
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

function collectLeafNodes(node: SlicingTree, out: Map<RoomId, SlicingLeaf>): void {
  if (node.kind === "leaf") {
    out.set(node.roomId, node);
    return;
  }
  collectLeafNodes(node.children[0], out);
  collectLeafNodes(node.children[1], out);
}

/**
 * Checks each pinned dimension against the rectangle the solve actually produced. This is
 * the only place the two are compared: `snapCutLines` reads a pin while placing a *cut*,
 * so nothing there ever looks at a leaf that had no cut to influence — the root leaf of a
 * one-room level, or the axis its parent split does not divide.
 */
function unmetConstraints(tree: SlicingTree, leaves: readonly LeafRect[]): UnmetConstraint[] {
  const nodes = new Map<RoomId, SlicingLeaf>();
  collectLeafNodes(tree, nodes);

  const unmet: UnmetConstraint[] = [];
  for (const leaf of leaves) {
    const node = nodes.get(leaf.roomId);
    if (!node) continue;
    // The `> 0` guard mirrors exactSize: a zero or negative pin is not a pin.
    const pins = [
      { axis: "width" as const, pinned: node.exactWidth, actual: leaf.w },
      { axis: "depth" as const, pinned: node.exactDepth, actual: leaf.d },
    ];
    for (const { axis, pinned, actual } of pins) {
      if (pinned === undefined || pinned <= 0) continue;
      if (Math.abs(actual - pinned) <= EXACT_TOLERANCE_MM) continue;
      unmet.push({ roomId: leaf.roomId, axis, requestedMm: pinned, actualMm: actual });
    }
  }
  return unmet;
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
    // A pinned width fixes the cut outright, and is deliberately not grid-snapped: the
    // user named an exact number, and rounding it to the module would quietly return a
    // room of a different size than the one they asked for (SLV-6 over SLV-2's snap).
    const exact0 = exactSize(c0, "w");
    const exact1 = exactSize(c1, "w");
    const ideal = node.ratio * rect.w;
    const raw = Math.min(Math.max(ideal, lo), hi);
    const w0 =
      exact0 !== null
        ? Math.min(Math.max(exact0, lo), hi)
        : exact1 !== null
          ? Math.min(Math.max(rect.w - exact1, lo), hi)
          : snapWithinRange(raw, lo, hi, grid);
    const w1 = rect.w - w0;
    cuts.push({ path, axis: "v", position: rect.x + w0, rect, min: rect.x + lo, max: rect.x + hi });
    snapCutLines(c0, { x: rect.x, y: rect.y, w: w0, d: rect.d }, grid, [...path, 0], out, cuts);
    snapCutLines(c1, { x: rect.x + w0, y: rect.y, w: w1, d: rect.d }, grid, [...path, 1], out, cuts);
  } else {
    const lo = m0.d;
    const hi = rect.d - m1.d;
    const exact0 = exactSize(c0, "d");
    const exact1 = exactSize(c1, "d");
    const ideal = node.ratio * rect.d;
    const raw = Math.min(Math.max(ideal, lo), hi);
    const d0 =
      exact0 !== null
        ? Math.min(Math.max(exact0, lo), hi)
        : exact1 !== null
          ? Math.min(Math.max(rect.d - exact1, lo), hi)
          : snapWithinRange(raw, lo, hi, grid);
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

  return { ok: true, leaves, cuts, unmet: unmetConstraints(tree, leaves) };
}

/** Smallest boundary that can hold this tree — the floor for an outer-boundary resize drag. */
export function treeMinimumSize(tree: SlicingTree): { widthMm: number; depthMm: number } {
  const m = computeMin(tree);
  return { widthMm: m.w, depthMm: m.d };
}

export function defaultMinFor(program: keyof typeof ROOM_PROGRAM_MIN_DIMENSIONS): { minWidth: number; minDepth: number } {
  return ROOM_PROGRAM_MIN_DIMENSIONS[program] ?? FALLBACK_MIN;
}
