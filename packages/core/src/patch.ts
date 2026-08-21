// Patch reducer — specs.md §5.2. Applies a closed vocabulary of ops (INF-6) to a
// PlanDocument: tree-affecting ops mutate the SlicingTree generator and room
// metadata, then the wall graph is regenerated once (SLV-1/2/3); graph-affecting
// ops (openings) are applied against the freshly solved graph.

import {
  ROOM_PROGRAM_MIN_DIMENSIONS,
  emptyWallGraph,
  type Level,
  type Opening,
  type OpeningKind,
  type Patch,
  type PatchOp,
  type PlanDocument,
  type Room,
  type RoomConstraints,
  type RoomId,
  type RoomProgram,
  type SlicingLeaf,
  type SlicingTree,
  type SolveViolation,
  type WallGraph,
} from "./types.js";
import { solveSlicingTree, type LeafRect } from "./slicingSolver.js";
import { buildWallGraph, type RoomMeta } from "./wallGraph.js";
import { findLeafPath, getNodeAt, insertLeaf, removeLeaf, setSplitAt, swapLeaves, totalAreaWeight, updateLeaf } from "./treeOps.js";

export type ApplyPatchResult =
  | { ok: true; doc: PlanDocument; changes: string[] }
  | { ok: false; errors: string[]; violations?: SolveViolation[] };

const DEFAULT_OPENING_WIDTH: Record<OpeningKind, number> = {
  door: 810,
  window: 1220,
  cased: 1520,
  "pass-through": 910,
};

function defaultNameFor(program: RoomProgram, existingCount: number): string {
  const label = program
    .split("-")
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
  return existingCount > 0 ? `${label} ${existingCount + 1}` : label;
}

function minSizeFor(program: RoomProgram, constraints?: RoomConstraints): { minWidth: number; minDepth: number } {
  const base = ROOM_PROGRAM_MIN_DIMENSIONS[program];
  const minWidth = Math.max(base.minWidth, constraints?.width?.min ?? constraints?.width?.exact ?? 0);
  const minDepth = Math.max(base.minDepth, constraints?.depth?.min ?? constraints?.depth?.exact ?? 0);
  return { minWidth, minDepth };
}

type LevelState = {
  tree: SlicingTree | undefined;
  roomMeta: Record<RoomId, RoomMeta>;
  boundary: { widthMm: number; depthMm: number };
  units: PlanDocument["units"];
  roomSeq: number;
};

/**
 * The next auto-generated room id must exceed every id currently in use, not just
 * count how many rooms remain — removing a room out of order (e.g. room-1 out of
 * room-0..room-3) otherwise lets a fresh count-based id collide with a survivor.
 */
function nextRoomSeq(existingIds: Iterable<RoomId>): number {
  let max = -1;
  for (const id of existingIds) {
    const match = /^room-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function levelStateFromDoc(doc: PlanDocument, level: Level): LevelState {
  const roomMeta: Record<RoomId, RoomMeta> = {};
  for (const [roomId, room] of Object.entries(level.graph.rooms)) {
    roomMeta[roomId] = { name: room.name, program: room.program, constraints: room.constraints, labelAnchor: room.labelAnchor };
  }
  return {
    tree: level.generator?.tree,
    roomMeta,
    boundary: level.boundary,
    units: doc.units,
    roomSeq: nextRoomSeq(Object.keys(level.graph.rooms)),
  };
}

function applyDimensionOp(
  state: LevelState,
  roomId: RoomId,
  mutate: (leaf: SlicingLeaf, meta: RoomMeta) => { leaf: SlicingLeaf; meta: RoomMeta },
): string | null {
  if (!state.tree) return `Room ${roomId} not found`;
  const path = findLeafPath(state.tree, roomId);
  if (!path) return `Room ${roomId} not found`;
  const leaf = getNodeAt(state.tree, path) as SlicingLeaf;
  const meta = state.roomMeta[roomId];
  if (!meta) return `Room ${roomId} not found`;
  const { leaf: newLeaf, meta: newMeta } = mutate(leaf, meta);
  state.tree = updateLeaf(state.tree, roomId, () => newLeaf);
  state.roomMeta[roomId] = newMeta;
  return null;
}

/** Applies the tree/metadata-affecting ops; returns opening ops to run after the solve, and any errors. */
function applyTreeOps(
  state: LevelState,
  ops: PatchOp[],
  beforeAreas: Record<RoomId, number>,
): { openingOps: Extract<PatchOp, { op: "addOpening" | "removeOpening" }>[]; errors: string[] } {
  const openingOps: Extract<PatchOp, { op: "addOpening" | "removeOpening" }>[] = [];
  const errors: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "addRoom": {
        const roomId = op.roomId ?? `room-${state.roomSeq}`;
        state.roomSeq++;
        if (state.roomMeta[roomId]) {
          errors.push(`addRoom: roomId ${roomId} already exists`);
          break;
        }
        const { minWidth, minDepth } = minSizeFor(op.program, op.constraints);
        const leaf: SlicingLeaf = { kind: "leaf", roomId, areaWeight: op.areaWeight, minWidth, minDepth };
        state.roomMeta[roomId] = {
          name: op.name ?? defaultNameFor(op.program, Object.values(state.roomMeta).filter((m) => m.program === op.program).length),
          program: op.program,
          constraints: op.constraints,
        };
        state.tree = insertLeaf(state.tree, leaf, { adjacentTo: op.adjacentTo });
        break;
      }
      case "removeRoom": {
        if (!state.tree || !state.roomMeta[op.roomId]) {
          errors.push(`removeRoom: room ${op.roomId} not found`);
          break;
        }
        state.tree = removeLeaf(state.tree, op.roomId) ?? undefined;
        delete state.roomMeta[op.roomId];
        break;
      }
      case "renameRoom": {
        const meta = state.roomMeta[op.roomId];
        if (!meta) {
          errors.push(`renameRoom: room ${op.roomId} not found`);
          break;
        }
        state.roomMeta[op.roomId] = { ...meta, name: op.name };
        break;
      }
      case "resizeRoom": {
        if (!state.tree) {
          errors.push(`resizeRoom: room ${op.roomId} not found`);
          break;
        }
        const path = findLeafPath(state.tree, op.roomId);
        if (!path) {
          errors.push(`resizeRoom: room ${op.roomId} not found`);
          break;
        }
        if (path.length === 0) {
          // The sole room in the level already fills the whole boundary; nothing to resize against.
          break;
        }
        const leaf = getNodeAt(state.tree, path) as SlicingLeaf;
        let newWeight = leaf.areaWeight;
        if (op.areaWeight !== undefined) {
          newWeight = op.areaWeight;
        } else if (op.targetAreaMm2 !== undefined) {
          const currentArea = beforeAreas[op.roomId];
          const scale = currentArea && currentArea > 0 ? op.targetAreaMm2 / currentArea : 1;
          newWeight = leaf.areaWeight * scale;
        }
        newWeight = Math.max(newWeight, 0.01);

        // Geometry is governed by the enclosing split's ratio, not the leaf's own areaWeight — so
        // resizing must recompute that ratio against the sibling subtree's total weight.
        const parentPath = path.slice(0, -1);
        const childIndex = path[path.length - 1] as 0 | 1;
        const parent = getNodeAt(state.tree, parentPath);
        if (parent.kind !== "split") {
          errors.push(`resizeRoom: invariant violated, parent of a leaf must be a split`);
          break;
        }
        const sibling = parent.children[childIndex === 0 ? 1 : 0];
        const siblingWeight = totalAreaWeight(sibling);
        const newRatioForChild0 = childIndex === 0 ? newWeight / (newWeight + siblingWeight) : siblingWeight / (siblingWeight + newWeight);

        state.tree = updateLeaf(state.tree, op.roomId, (l) => ({ ...l, areaWeight: newWeight }));
        state.tree = setSplitAt(state.tree, parentPath, { ratio: newRatioForChild0 });
        break;
      }
      case "swapRooms": {
        if (!state.tree || !state.roomMeta[op.roomIdA] || !state.roomMeta[op.roomIdB]) {
          errors.push(`swapRooms: room not found`);
          break;
        }
        state.tree = swapLeaves(state.tree, op.roomIdA, op.roomIdB);
        break;
      }
      case "moveRoom": {
        if (!state.tree || !state.roomMeta[op.roomId] || !state.roomMeta[op.relativeTo]) {
          errors.push(`moveRoom: room not found`);
          break;
        }
        const leaf = getNodeAt(state.tree, findLeafPath(state.tree, op.roomId)!) as SlicingLeaf;
        state.tree = removeLeaf(state.tree, op.roomId) ?? undefined;
        state.tree = insertLeaf(state.tree, leaf, { adjacentTo: op.relativeTo });
        break;
      }
      case "setSplit": {
        if (!state.tree) {
          errors.push(`setSplit: no tree`);
          break;
        }
        try {
          state.tree = setSplitAt(state.tree, op.nodePath, { axis: op.axis, ratio: op.ratio });
        } catch (e) {
          errors.push(`setSplit: ${(e as Error).message}`);
        }
        break;
      }
      case "setBoundary": {
        state.boundary = { widthMm: op.widthMm, depthMm: op.depthMm };
        break;
      }
      case "setUnits": {
        state.units = op.units;
        break;
      }
      case "setDimension": {
        const err = applyDimensionOp(state, op.roomId, (leaf, meta) => {
          const constraints = { ...(meta.constraints ?? {}) };
          if (op.dimensionType === "width" || op.dimensionType === "depth" || op.dimensionType === "area") {
            constraints[op.dimensionType] = { ...(constraints[op.dimensionType] ?? {}), exact: op.value };
          } else {
            constraints.aspectRatio = { min: op.value, max: op.value };
          }
          const minWidth = op.dimensionType === "width" ? Math.max(leaf.minWidth ?? 0, op.value) : leaf.minWidth;
          const minDepth = op.dimensionType === "depth" ? Math.max(leaf.minDepth ?? 0, op.value) : leaf.minDepth;
          return { leaf: { ...leaf, minWidth, minDepth }, meta: { ...meta, constraints } };
        });
        if (err) errors.push(`setDimension: ${err}`);
        break;
      }
      case "clearDimension": {
        const meta = state.roomMeta[op.roomId];
        if (!meta) {
          errors.push(`clearDimension: room ${op.roomId} not found`);
          break;
        }
        const constraints = { ...(meta.constraints ?? {}) };
        delete constraints[op.dimensionType];
        state.roomMeta[op.roomId] = { ...meta, constraints };
        break;
      }
      case "setDimensionRange": {
        const err = applyDimensionOp(state, op.roomId, (leaf, meta) => {
          const constraints = { ...(meta.constraints ?? {}) };
          if (op.dimensionType === "width" || op.dimensionType === "depth" || op.dimensionType === "area") {
            constraints[op.dimensionType] = { ...(constraints[op.dimensionType] ?? {}), min: op.minMm, max: op.maxMm };
          }
          const minWidth = op.dimensionType === "width" && op.minMm ? Math.max(leaf.minWidth ?? 0, op.minMm) : leaf.minWidth;
          const minDepth = op.dimensionType === "depth" && op.minMm ? Math.max(leaf.minDepth ?? 0, op.minMm) : leaf.minDepth;
          return { leaf: { ...leaf, minWidth, minDepth }, meta: { ...meta, constraints } };
        });
        if (err) errors.push(`setDimensionRange: ${err}`);
        break;
      }
      case "addOpening":
      case "removeOpening":
        openingOps.push(op);
        break;
    }
  }

  return { openingOps, errors };
}

function findSharedEdge(graph: WallGraph, roomA: RoomId, roomB: RoomId): string | undefined {
  const a = graph.rooms[roomA];
  const b = graph.rooms[roomB];
  if (!a || !b) return undefined;
  const setB = new Set(b.boundary);
  return a.boundary.find((e) => setB.has(e));
}

function applyOpeningOps(graph: WallGraph, ops: Extract<PatchOp, { op: "addOpening" | "removeOpening" }>[]): void {
  let seq = 0;
  for (const op of ops) {
    if (op.op === "addOpening") {
      const edgeId = op.edgeId ?? (op.betweenRooms ? findSharedEdge(graph, op.betweenRooms[0], op.betweenRooms[1]) : undefined);
      const edge = edgeId ? graph.edges[edgeId] : undefined;
      if (!edge) continue;
      const width = op.width ?? DEFAULT_OPENING_WIDTH[op.kind];
      const a = graph.nodes[edge.a]!;
      const b = graph.nodes[edge.b]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const clampedWidth = Math.min(width, Math.max(length - 1, 1));
      const offset = Math.max(0, (length - clampedWidth) / 2);
      const opening: Opening = { id: `o${seq++}-${edgeId}`, kind: op.kind, offset, width: clampedWidth, height: op.kind === "window" ? 1220 : 2030 };
      edge.openings.push(opening);
    } else {
      for (const edge of Object.values(graph.edges)) {
        const idx = edge.openings.findIndex((o) => o.id === op.openingId);
        if (idx >= 0) {
          edge.openings.splice(idx, 1);
          break;
        }
      }
    }
  }
}

function leafAreas(leaves: LeafRect[]): Record<RoomId, number> {
  const out: Record<RoomId, number> = {};
  for (const l of leaves) out[l.roomId] = l.w * l.d;
  return out;
}

function summarizeChanges(
  ops: PatchOp[],
  beforeAreas: Record<RoomId, number>,
  afterAreas: Record<RoomId, number>,
  nameOf: (roomId: RoomId) => string,
): string[] {
  const changes: string[] = [];
  const resized = new Set<RoomId>();

  for (const op of ops) {
    switch (op.op) {
      case "addRoom":
        changes.push(`Added ${nameOf(op.roomId ?? "")}`.trim());
        break;
      case "removeRoom":
        changes.push(`Removed ${nameOf(op.roomId)}`);
        break;
      case "renameRoom":
        changes.push(`Renamed room to ${op.name}`);
        break;
      case "swapRooms":
        changes.push(`Swapped ${nameOf(op.roomIdA)} and ${nameOf(op.roomIdB)}`);
        resized.add(op.roomIdA);
        resized.add(op.roomIdB);
        break;
      case "resizeRoom":
        resized.add(op.roomId);
        break;
      case "setBoundary":
        changes.push(`Boundary set to ${op.widthMm}mm x ${op.depthMm}mm`);
        break;
      case "setUnits":
        changes.push(`Units changed to ${op.units}`);
        break;
      case "setDimension":
        changes.push(`${nameOf(op.roomId)} ${op.dimensionType} pinned to ${op.value}mm`);
        break;
      case "setDimensionRange":
        changes.push(`${nameOf(op.roomId)} ${op.dimensionType} constrained`);
        break;
    }
  }

  for (const roomId of resized) {
    const before = beforeAreas[roomId];
    const after = afterAreas[roomId];
    if (before && after) {
      const pct = Math.round(((after - before) / before) * 100);
      if (pct !== 0) changes.push(`${nameOf(roomId)} ${pct > 0 ? "+" : ""}${pct}%`);
    }
  }

  return changes;
}

export function applyPatch(doc: PlanDocument, patch: Patch): ApplyPatchResult {
  const levelIndex = doc.levels.findIndex((l) => l.id === doc.activeLevelId);
  if (levelIndex < 0) return { ok: false, errors: [`active level ${doc.activeLevelId} not found`] };
  const level = doc.levels[levelIndex]!;

  const beforeLeaves = level.generator?.tree ? solveSlicingTree(level.generator.tree, level.boundary, doc.gridModule) : null;
  const beforeAreas = beforeLeaves && beforeLeaves.ok ? leafAreas(beforeLeaves.leaves) : {};
  const namesBefore: Record<RoomId, string> = {};
  for (const [id, r] of Object.entries(level.graph.rooms)) namesBefore[id] = r.name;

  const state = levelStateFromDoc(doc, level);
  const { openingOps, errors } = applyTreeOps(state, patch.ops, beforeAreas);
  if (errors.length > 0) return { ok: false, errors };

  let graph: WallGraph;
  let afterLeaves: LeafRect[] = [];

  if (!state.tree) {
    graph = emptyWallGraph();
  } else {
    const solved = solveSlicingTree(state.tree, state.boundary, doc.gridModule);
    if (!solved.ok) return { ok: false, errors: [], violations: solved.violations };
    afterLeaves = solved.leaves;
    graph = buildWallGraph(solved.leaves, state.boundary, state.roomMeta);
    applyOpeningOps(graph, openingOps);
  }

  const newLevel: Level = {
    ...level,
    boundary: state.boundary,
    generator: state.tree ? { tree: state.tree } : undefined,
    graph,
  };

  const newLevels = [...doc.levels];
  newLevels[levelIndex] = newLevel;

  const newDoc: PlanDocument = {
    ...doc,
    units: state.units,
    levels: newLevels,
    updatedAt: new Date().toISOString(),
  };

  const nameOf = (roomId: RoomId) => graph.rooms[roomId]?.name ?? namesBefore[roomId] ?? roomId;
  const afterAreas = leafAreas(afterLeaves);
  const changes = summarizeChanges(patch.ops, beforeAreas, afterAreas, nameOf);

  return { ok: true, doc: newDoc, changes };
}

export function createEmptyPlan(input: {
  id: string;
  title: string;
  units: PlanDocument["units"];
  gridModule?: number;
  boundary: { widthMm: number; depthMm: number };
}): PlanDocument {
  const levelId = "level-0";
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: input.id,
    title: input.title,
    units: input.units,
    gridModule: input.gridModule ?? 101.6,
    activeLevelId: levelId,
    createdAt: now,
    updatedAt: now,
    levels: [
      {
        id: levelId,
        name: "Level 1",
        elevation: 0,
        floorToCeiling: 2440,
        boundary: input.boundary,
        graph: emptyWallGraph(),
      },
    ],
  };
}

export function activeLevel(doc: PlanDocument): Level {
  const level = doc.levels.find((l) => l.id === doc.activeLevelId);
  if (!level) throw new Error(`active level ${doc.activeLevelId} not found`);
  return level;
}

export type { Room };
