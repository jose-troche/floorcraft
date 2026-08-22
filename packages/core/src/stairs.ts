// Stair alignment (Phase 3, per specs.md open question 6). Vertical circulation has to
// line up between levels, but the slicing tree has no cross-level vocabulary for that —
// rather than build a full cross-level constraint layer, this checks alignment after the
// fact and offers a one-click best-effort fix, non-blocking either way (D2 in the Phase 3
// plan: "check and assist, not solve").
//
// A "stair core" is implicit: every room with program "stair" that shares a name is
// treated as one vertical run. No linking op, no UI to manage cores — name two stairs
// the same thing and they're the same core.

import { generatorTree } from "./types.js";
import type { LevelId, PatchOp, PlanDocument, Rect, RoomId } from "./types.js";
import { solveSlicingTree } from "./slicingSolver.js";
import { roomCells } from "./wallGraph.js";
import { activeLevel } from "./patch.js";
import { ROOM_PROGRAM_MIN_DIMENSIONS } from "./types.js";

export type StairAlignmentWarning = {
  coreName: string;
  levelIds: [LevelId, LevelId];
  /** How much the overlap falls short of the stair's minimum footprint, in mm. */
  shortfallWidthMm: number;
  shortfallDepthMm: number;
  message: string;
};

/** Bounding box of a room's footprint on one level — its one rect if generated, or the
 * bounding box of its cells if freeform (an L-shaped stair still gets a sane check). */
function levelRoomBBox(doc: PlanDocument, level: PlanDocument["levels"][number], roomId: RoomId): Rect | null {
  if (level.generator?.kind === "freeform") {
    const cells = roomCells(level.generator.cells, roomId);
    if (cells.length === 0) return null;
    const x0 = Math.min(...cells.map((c) => c.x));
    const y0 = Math.min(...cells.map((c) => c.y));
    const x1 = Math.max(...cells.map((c) => c.x + c.w));
    const y1 = Math.max(...cells.map((c) => c.y + c.d));
    return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
  }
  const tree = generatorTree(level);
  if (!tree) return null;
  const solved = solveSlicingTree(tree, level.boundary, doc.gridModule);
  if (!solved.ok) return null;
  const leaf = solved.leaves.find((l) => l.roomId === roomId);
  return leaf ? { x: leaf.x, y: leaf.y, w: leaf.w, d: leaf.d } : null;
}

type CoreMember = { levelId: LevelId; roomId: RoomId; rect: Rect };

/** Every stair core (rooms sharing a name and program "stair"), one level below the next. */
function stairCores(doc: PlanDocument): Map<string, CoreMember[]> {
  const cores = new Map<string, CoreMember[]>();
  const sortedLevels = [...doc.levels].sort((a, b) => a.elevation - b.elevation);
  for (const level of sortedLevels) {
    for (const [roomId, room] of Object.entries(level.graph.rooms)) {
      if (room.program !== "stair") continue;
      const rect = levelRoomBBox(doc, level, roomId);
      if (!rect) continue;
      const arr = cores.get(room.name) ?? [];
      arr.push({ levelId: level.id, roomId, rect });
      cores.set(room.name, arr);
    }
  }
  return cores;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.d, b.y + b.d);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, d: y1 - y0 } : null;
}

/**
 * Checks every stair core for adjacent-level overlap below the stair minimum footprint.
 * Non-blocking by design (D2): a misaligned stair is a warning to surface in the UI, not
 * a solve failure — the plan must still render.
 */
export function checkStairAlignment(doc: PlanDocument): StairAlignmentWarning[] {
  const { minWidth, minDepth } = ROOM_PROGRAM_MIN_DIMENSIONS.stair;
  const warnings: StairAlignmentWarning[] = [];
  for (const [coreName, members] of stairCores(doc)) {
    for (let i = 0; i < members.length - 1; i++) {
      const lower = members[i]!;
      const upper = members[i + 1]!;
      const overlap = intersect(lower.rect, upper.rect);
      const w = overlap?.w ?? 0;
      const d = overlap?.d ?? 0;
      if (w >= minWidth && d >= minDepth) continue;
      warnings.push({
        coreName,
        levelIds: [lower.levelId, upper.levelId],
        shortfallWidthMm: Math.max(0, Math.round(minWidth - w)),
        shortfallDepthMm: Math.max(0, Math.round(minDepth - d)),
        message:
          overlap === null
            ? `"${coreName}" doesn't line up between levels at all — the stair openings don't overlap.`
            : `"${coreName}" only overlaps by ${Math.round(w)}mm x ${Math.round(d)}mm between levels, short of the ${minWidth}mm x ${minDepth}mm a stair needs.`,
      });
    }
  }
  return warnings;
}

export type StairAlignmentPlan = { ok: true; ops: PatchOp[]; note?: string } | { ok: false; reason: string };

/**
 * Best-effort alignment of one stair core's room on `targetLevelId` to match its nearest
 * neighbouring level. Freeform levels get an exact copy of the reference room's cells —
 * true position-and-shape alignment. A generated (tree) level can only be pinned to the
 * reference's width and depth (setDimension); the tree's split ratios still decide where
 * that pinned room lands, so position may still need a manual nudge afterwards — this is
 * D2's "assist, don't solve" boundary, and the returned note says as much.
 */
export function planStairAlignment(doc: PlanDocument, coreName: string, targetLevelId: LevelId): StairAlignmentPlan {
  const cores = stairCores(doc);
  const members = cores.get(coreName);
  if (!members || members.length === 0) return { ok: false, reason: `No stair core named "${coreName}" found.` };

  const target = members.find((m) => m.levelId === targetLevelId);
  if (!target) return { ok: false, reason: `"${coreName}" has no stair on this level to align.` };

  const targetIndex = members.indexOf(target);
  // Prefer the level below (already-placed reference); fall back to the one above.
  const reference = members[targetIndex - 1] ?? members[targetIndex + 1];
  if (!reference) return { ok: false, reason: `"${coreName}" only exists on one level — nothing to align it to.` };

  const targetLevel = doc.levels.find((l) => l.id === targetLevelId)!;
  const referenceLevel = doc.levels.find((l) => l.id === reference.levelId)!;

  if (targetLevel.generator?.kind === "freeform") {
    const referenceCells =
      referenceLevel.generator?.kind === "freeform"
        ? roomCells(referenceLevel.generator.cells, reference.roomId)
        : [reference.rect];
    return {
      ok: true,
      ops: [{ op: "setRoomRects", roomId: target.roomId, rects: referenceCells.map((c) => ({ x: c.x, y: c.y, w: c.w, d: c.d })) }],
    };
  }

  return {
    ok: true,
    ops: [
      { op: "setDimension", roomId: target.roomId, dimensionType: "width", value: Math.round(reference.rect.w) },
      { op: "setDimension", roomId: target.roomId, dimensionType: "depth", value: Math.round(reference.rect.d) },
    ],
    note: "Size now matches — if position still looks off, drag the stair or its walls to line it up.",
  };
}

/** Convenience for the common UI case: align the stair core on the currently active level. */
export function planStairAlignmentOnActiveLevel(doc: PlanDocument, coreName: string): StairAlignmentPlan {
  return planStairAlignment(doc, coreName, activeLevel(doc).id);
}
