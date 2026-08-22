// Patch reducer — specs.md §5.2. Applies a closed vocabulary of ops (INF-6) to a
// PlanDocument: every op edits level state (the SlicingTree generator, room metadata,
// the persisted opening list), then the wall graph is regenerated once (SLV-1/2/3) and
// the openings are resolved onto the fresh edges.

import {
  ROOM_PROGRAM_MIN_DIMENSIONS,
  emptyWallGraph,
  type DoorSwing,
  type Level,
  type OpeningKind,
  type Patch,
  type PatchOp,
  type PersistedOpening,
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
import { anchorForEdge, applyOpeningsToGraph } from "./openings.js";
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

const DEFAULT_OPENING_HEIGHT: Record<OpeningKind, number> = {
  door: 2030,
  window: 1220,
  cased: 2030,
  "pass-through": 1220,
};

/** Head height of a window above the finished floor; sill follows from the height. */
const WINDOW_HEAD_MM = 2030;

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

/**
 * Recomputes a leaf's sizing fields from the room's program and its *current* constraint
 * set, rather than folding each new constraint into whatever was there before. Doing it
 * from scratch is what makes clearDimension work: accumulating maxima can only ever
 * raise a minimum, so a cleared pin used to stay silently in force.
 */
function syncLeafConstraints(leaf: SlicingLeaf, program: RoomProgram, constraints?: RoomConstraints): SlicingLeaf {
  const { minWidth, minDepth } = minSizeFor(program, constraints);
  const exactWidth = constraints?.width?.exact;
  const exactDepth = constraints?.depth?.exact;
  return {
    ...leaf,
    minWidth,
    minDepth,
    ...(exactWidth !== undefined ? { exactWidth } : { exactWidth: undefined }),
    ...(exactDepth !== undefined ? { exactDepth } : { exactDepth: undefined }),
  };
}

type LevelState = {
  tree: SlicingTree | undefined;
  roomMeta: Record<RoomId, RoomMeta>;
  openings: PersistedOpening[];
  boundary: { widthMm: number; depthMm: number };
  units: PlanDocument["units"];
  roomSeq: number;
  openingSeq: number;
  /**
   * The graph as it stood before this patch. Only read to turn an EdgeId supplied by a
   * caller into a durable anchor — the edge itself ceases to exist the moment the
   * graph is regenerated below.
   */
  graphBefore: WallGraph;
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

/**
 * Picks the id for a newly added room. Providers are untrusted (INF-4): a model shown
 * the plan summary will sometimes echo an existing roomId back on addRoom. "Add a room"
 * is never ambiguous enough to fail the turn over that, so a taken id is replaced with
 * a fresh one rather than rejected. Skips ids already claimed earlier in this patch.
 */
function allocateRoomId(state: LevelState, requested?: RoomId): RoomId {
  if (requested && !state.roomMeta[requested]) return requested;
  while (state.roomMeta[`room-${state.roomSeq}`]) state.roomSeq++;
  return `room-${state.roomSeq++}`;
}

/** Same reasoning as nextRoomSeq: ids must clear every id in use, not merely count survivors. */
function nextOpeningSeq(openings: readonly PersistedOpening[]): number {
  let max = -1;
  for (const o of openings) {
    const match = /^opening-(\d+)$/.exec(o.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function levelStateFromDoc(doc: PlanDocument, level: Level): LevelState {
  const roomMeta: Record<RoomId, RoomMeta> = {};
  for (const [roomId, room] of Object.entries(level.graph.rooms)) {
    roomMeta[roomId] = { name: room.name, program: room.program, constraints: room.constraints, labelAnchor: room.labelAnchor };
  }
  const openings = (level.openings ?? []).map((o) => ({ ...o }));
  return {
    tree: level.generator?.tree,
    roomMeta,
    openings,
    boundary: level.boundary,
    units: doc.units,
    roomSeq: nextRoomSeq(Object.keys(level.graph.rooms)),
    openingSeq: nextOpeningSeq(openings),
    graphBefore: level.graph,
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

/** Applies every op to level state. Geometry is not touched here — the caller re-solves once afterwards. */
function applyTreeOps(
  state: LevelState,
  ops: PatchOp[],
  beforeAreas: Record<RoomId, number>,
): { errors: string[]; addedRoomIds: RoomId[]; addedOpeningIds: string[] } {
  const errors: string[] = [];
  const addedOpeningIds: string[] = [];
  /** Ids actually allocated by addRoom ops, in order, so the change summary can name them. */
  const addedRoomIds: RoomId[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "addRoom": {
        const roomId = allocateRoomId(state, op.roomId);
        addedRoomIds.push(roomId);
        const leaf = syncLeafConstraints(
          { kind: "leaf", roomId, areaWeight: op.areaWeight },
          op.program,
          op.constraints,
        );
        state.roomMeta[roomId] = {
          name: op.name ?? defaultNameFor(op.program, Object.values(state.roomMeta).filter((m) => m.program === op.program).length),
          program: op.program,
          constraints: op.constraints,
        };
        state.tree = insertLeaf(state.tree, leaf, { adjacentTo: op.adjacentTo, direction: op.direction });
        break;
      }
      case "removeRoom": {
        if (!state.tree || !state.roomMeta[op.roomId]) {
          errors.push(`removeRoom: room ${op.roomId} not found`);
          break;
        }
        state.tree = removeLeaf(state.tree, op.roomId) ?? undefined;
        delete state.roomMeta[op.roomId];
        // An opening anchored to a room that no longer exists can never resolve again.
        // Undo restores the whole document, so dropping them here loses nothing.
        state.openings = state.openings.filter((o) =>
          o.anchor.kind === "between" ? !o.anchor.rooms.includes(op.roomId) : o.anchor.roomId !== op.roomId,
        );
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
        state.tree = insertLeaf(state.tree, leaf, { adjacentTo: op.relativeTo, direction: op.direction });
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
          return { leaf: syncLeafConstraints(leaf, meta.program, constraints), meta: { ...meta, constraints } };
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
        const err = applyDimensionOp(state, op.roomId, (leaf, m) => ({
          leaf: syncLeafConstraints(leaf, m.program, constraints),
          meta: { ...m, constraints },
        }));
        if (err) errors.push(`clearDimension: ${err}`);
        break;
      }
      case "setDimensionRange": {
        const err = applyDimensionOp(state, op.roomId, (leaf, meta) => {
          const constraints = { ...(meta.constraints ?? {}) };
          if (op.dimensionType === "width" || op.dimensionType === "depth" || op.dimensionType === "area") {
            constraints[op.dimensionType] = { ...(constraints[op.dimensionType] ?? {}), min: op.minMm, max: op.maxMm };
          }
          return { leaf: syncLeafConstraints(leaf, meta.program, constraints), meta: { ...meta, constraints } };
        });
        if (err) errors.push(`setDimensionRange: ${err}`);
        break;
      }
      case "addOpening": {
        const anchor = resolveAnchorForAdd(state, op);
        if (!anchor) {
          errors.push(`addOpening: no wall found for the requested location`);
          break;
        }
        const id = `opening-${state.openingSeq++}`;
        const height = DEFAULT_OPENING_HEIGHT[op.kind];
        state.openings.push({
          id,
          kind: op.kind,
          anchor,
          offsetRatio: op.offsetRatio !== undefined ? Math.min(Math.max(op.offsetRatio, 0), 1) : 0.5,
          width: op.width ?? DEFAULT_OPENING_WIDTH[op.kind],
          height,
          ...(op.kind === "window" ? { sill: Math.max(WINDOW_HEAD_MM - height, 0) } : {}),
          ...(op.kind === "door" ? { swing: op.swing ?? "left-in" } : op.swing ? { swing: op.swing } : {}),
        });
        addedOpeningIds.push(id);
        break;
      }
      case "removeOpening": {
        const idx = state.openings.findIndex((o) => o.id === op.openingId);
        if (idx < 0) {
          errors.push(`removeOpening: opening ${op.openingId} not found`);
          break;
        }
        state.openings.splice(idx, 1);
        break;
      }
      case "moveOpening": {
        const opening = state.openings.find((o) => o.id === op.openingId);
        if (!opening) {
          errors.push(`moveOpening: opening ${op.openingId} not found`);
          break;
        }
        opening.offsetRatio = Math.min(Math.max(op.offsetRatio, 0), 1);
        break;
      }
      case "setOpeningSwing": {
        const opening = state.openings.find((o) => o.id === op.openingId);
        if (!opening) {
          errors.push(`setOpeningSwing: opening ${op.openingId} not found`);
          break;
        }
        opening.swing = op.swing;
        break;
      }
      case "setLabelAnchor": {
        const meta = state.roomMeta[op.roomId];
        if (!meta) {
          errors.push(`setLabelAnchor: room ${op.roomId} not found`);
          break;
        }
        state.roomMeta[op.roomId] = { ...meta, labelAnchor: { x: op.x, y: op.y } };
        break;
      }
    }
  }

  return { errors, addedRoomIds, addedOpeningIds };
}

/**
 * Turns an addOpening op into a durable anchor. `betweenRooms` is already durable;
 * an `edgeId` refers to the pre-patch graph and has to be translated before that
 * graph is thrown away.
 */
function resolveAnchorForAdd(state: LevelState, op: Extract<PatchOp, { op: "addOpening" }>) {
  if (op.betweenRooms) {
    const [a, b] = op.betweenRooms;
    if (!state.roomMeta[a] || !state.roomMeta[b]) return null;
    return { kind: "between" as const, rooms: (a < b ? [a, b] : [b, a]) as [RoomId, RoomId] };
  }
  if (op.edgeId) return anchorForEdge(state.graphBefore, op.edgeId);
  return null;
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
  addedRoomIds: RoomId[],
  after: { graph: WallGraph; openings: PersistedOpening[]; addedOpeningIds: string[] },
): string[] {
  const changes: string[] = [];
  const resized = new Set<RoomId>();
  let addedOpeningIndex = 0;

  /** "the kitchen/hall wall" or "the living room's north wall" — how a person locates an opening. */
  const describeOpening = (openingId: string): string => {
    const opening = after.openings.find((o) => o.id === openingId);
    if (!opening) return "wall";
    if (opening.anchor.kind === "between") {
      return `between ${nameOf(opening.anchor.rooms[0])} and ${nameOf(opening.anchor.rooms[1])}`;
    }
    return `on the ${opening.anchor.side} wall of ${nameOf(opening.anchor.roomId)}`;
  };
  // addRoom ops consume allocated ids in order — the op's own roomId is often absent
  // (or, from a provider, a duplicate the reducer replaced), so it can't name the room.
  let addedIndex = 0;

  for (const op of ops) {
    switch (op.op) {
      case "addRoom": {
        const addedId = addedRoomIds[addedIndex++];
        changes.push(addedId ? `Added ${nameOf(addedId)}` : "Added a room");
        break;
      }
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
      case "addOpening": {
        const id = after.addedOpeningIds[addedOpeningIndex++];
        changes.push(id ? `Added ${op.kind} ${describeOpening(id)}` : `Added ${op.kind}`);
        break;
      }
      case "removeOpening":
        changes.push("Removed an opening");
        break;
      case "moveOpening":
        changes.push(`Moved ${describeOpening(op.openingId)}`);
        break;
      case "setOpeningSwing":
        changes.push(`Door swing set to ${op.swing}`);
        break;
      case "setSplit":
        changes.push("Moved a wall");
        break;
      case "setLabelAnchor":
        // A label position is a rendering nicety; announcing it would only add noise
        // to the transcript beside the edits that changed the plan itself.
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
  const { errors, addedRoomIds, addedOpeningIds } = applyTreeOps(state, patch.ops, beforeAreas);
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
    applyOpeningsToGraph(graph, state.openings);
  }

  const newLevel: Level = {
    ...level,
    boundary: state.boundary,
    generator: state.tree ? { tree: state.tree } : undefined,
    openings: state.openings,
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
  const changes = summarizeChanges(patch.ops, beforeAreas, afterAreas, nameOf, addedRoomIds, {
    graph,
    openings: state.openings,
    addedOpeningIds,
  });

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
