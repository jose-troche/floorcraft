// Patch reducer — specs.md §5.2. Applies a closed vocabulary of ops (INF-6) to a
// PlanDocument: every op edits level state (the SlicingTree generator, room metadata,
// the persisted opening list), then the wall graph is regenerated once (SLV-1/2/3) and
// the openings are resolved onto the fresh edges.

import {
  MM_PER_UNIT,
  ROOM_PROGRAM_MIN_DIMENSIONS,
  emptyWallGraph,
  type DimensionType,
  type DoorSwing,
  type Generator,
  type Level,
  type LevelId,
  type OpeningKind,
  type Patch,
  type PatchOp,
  type PersistedOpening,
  type PlanDocument,
  type Rect,
  type Room,
  type RoomCell,
  type RoomConstraints,
  type RoomId,
  type RoomProgram,
  type SlicingLeaf,
  type SlicingTree,
  type SolveViolation,
  type Units,
  type WallGraph,
} from "./types.js";
import { solveSlicingTree, type LeafRect, type UnmetConstraint } from "./slicingSolver.js";
import { buildWallGraph, type RoomMeta } from "./wallGraph.js";
import { anchorForEdge, applyOpeningsToGraph } from "./openings.js";
import { findLeafPath, getNodeAt, insertLeaf, removeLeaf, setSplitAt, swapLeaves, totalAreaWeight, updateLeaf } from "./treeOps.js";
import { planNestedRoom } from "./nesting.js";

export type ApplyPatchResult =
  /**
   * `warnings` carries the pinned dimensions the layout could not honour (SLV-7). The
   * patch still applied — these are caveats about the result, not reasons to reject it —
   * and the shape matches the dimension parser's warnings so a turn can merge the two.
   */
  | { ok: true; doc: PlanDocument; changes: string[]; warnings?: { message: string }[] }
  | { ok: false; errors: string[]; violations?: SolveViolation[] };

/** Shown whenever a tree-shaped op (addRoom, resizeRoom, setSplit, dimension pins, ...) is
 * attempted against a freeform level (DM-2): there is no generator tree for it to edit. */
const FREEFORM_BLOCKED_MSG =
  "This level has freeform geometry and can't be restructured this way. Edit it on the canvas, " +
  "or use \"Restore generated layout\" to go back to the generated one.";

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
  /** "slicing" while a generator tree drives this level; "freeform" once detached (DM-2). */
  mode: "slicing" | "freeform";
  tree: SlicingTree | undefined;
  /** Freeform mode only — the room-cell union edited directly by setRoomRects. */
  cells: RoomCell[];
  /** Freeform mode only — the tree "Restore generated layout" switches back to. */
  savedTree: SlicingTree | undefined;
  roomMeta: Record<RoomId, RoomMeta>;
  openings: PersistedOpening[];
  boundary: { widthMm: number; depthMm: number };
  units: PlanDocument["units"];
  gridModule: number;
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
  const generator = level.generator;
  return {
    mode: generator?.kind === "freeform" ? "freeform" : "slicing",
    tree: generator?.kind === "slicing" ? generator.tree : undefined,
    cells: generator?.kind === "freeform" ? generator.cells.map((c) => ({ ...c })) : [],
    savedTree: generator?.kind === "freeform" ? generator.savedTree : undefined,
    roomMeta,
    openings,
    boundary: level.boundary,
    units: doc.units,
    gridModule: doc.gridModule,
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
  if (state.mode === "freeform") return FREEFORM_BLOCKED_MSG;
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
        if (state.mode === "freeform") {
          errors.push(FREEFORM_BLOCKED_MSG);
          break;
        }
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
        if (!state.roomMeta[op.roomId]) {
          errors.push(`removeRoom: room ${op.roomId} not found`);
          break;
        }
        // Freeform removal leaves a void where the room's cells were — a legitimate
        // freeform shape (a courtyard), unlike the tree case which has no way to express
        // "nothing here" and must close the gap structurally.
        if (state.mode === "freeform") {
          state.cells = state.cells.filter((c) => c.roomId !== op.roomId);
        } else {
          state.tree = state.tree ? (removeLeaf(state.tree, op.roomId) ?? undefined) : undefined;
        }
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
        if (state.mode === "freeform") {
          errors.push(FREEFORM_BLOCKED_MSG);
          break;
        }
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
        if (state.mode === "freeform") {
          errors.push(FREEFORM_BLOCKED_MSG);
          break;
        }
        if (!state.tree || !state.roomMeta[op.roomIdA] || !state.roomMeta[op.roomIdB]) {
          errors.push(`swapRooms: room not found`);
          break;
        }
        state.tree = swapLeaves(state.tree, op.roomIdA, op.roomIdB);
        break;
      }
      case "moveRoom": {
        if (state.mode === "freeform") {
          errors.push(FREEFORM_BLOCKED_MSG);
          break;
        }
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
        if (state.mode === "freeform") {
          errors.push(FREEFORM_BLOCKED_MSG);
          break;
        }
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
        // A tree re-solves against any boundary that fits its minimums (SLV-1), but a
        // freeform union has no such re-flow: a shrink can only be honoured if no cell
        // actually falls outside the new footprint (SLV-8's "reject, don't silently
        // correct" applied to the boundary itself).
        if (state.mode === "freeform") {
          const cutRoomIds = new Set<RoomId>();
          for (const c of state.cells) {
            if (c.x + c.w > op.widthMm || c.y + c.d > op.depthMm) cutRoomIds.add(c.roomId);
          }
          if (cutRoomIds.size > 0) {
            errors.push(
              `setBoundary: shrinking to ${op.widthMm}mm x ${op.depthMm}mm would cut ${[...cutRoomIds].join(", ")}. Move or resize those rooms first.`,
            );
            break;
          }
        }
        state.boundary = { widthMm: op.widthMm, depthMm: op.depthMm };
        break;
      }
      case "setUnits": {
        state.units = op.units;
        break;
      }
      case "nestRoom": {
        if (!state.roomMeta[op.hostRoomId]) {
          errors.push(`nestRoom: host room ${op.hostRoomId} not found`);
          break;
        }
        const { minWidth, minDepth } = minSizeFor(op.program, op.constraints);
        const nookWidth = op.constraints?.width?.exact ?? minWidth;
        const nookDepth = op.constraints?.depth?.exact ?? minDepth;
        // Orientation-independent, same comparison validatePlan uses: a room can be
        // pinned either way round, so only the pair of sides has to clear the pair of minimums.
        const shortSide = Math.min(nookWidth, nookDepth);
        const longSide = Math.max(nookWidth, nookDepth);
        const minShort = Math.min(minWidth, minDepth);
        const minLong = Math.max(minWidth, minDepth);
        if (shortSide < minShort || longSide < minLong) {
          const kind = op.program.replace(/-/g, " ");
          errors.push(`nestRoom: a ${kind} needs at least ${minWidth}mm x ${minDepth}mm for clearances, so ask for a size at or above that.`);
          break;
        }

        // A guillotine tree has no vocabulary for "one corner of this room" (only full
        // cuts), so nesting always needs the rect-union representation — freeform, not
        // slicing. Converting here is exactly detachGenerator's own conversion (solve the
        // tree once, freeze the result into cells), done inline so a caller doesn't have
        // to issue detachGenerator itself before nesting into a level that still has one.
        if (state.mode === "slicing") {
          if (!state.tree) {
            errors.push("nestRoom: no generated layout to nest into.");
            break;
          }
          const solved = solveSlicingTree(state.tree, state.boundary, state.gridModule);
          if (!solved.ok) {
            errors.push(`nestRoom: ${solved.violations.map((v) => v.message).join(" ")}`);
            break;
          }
          state.cells = solved.leaves.map((l): RoomCell => ({ x: l.x, y: l.y, w: l.w, d: l.d, roomId: l.roomId }));
          state.savedTree = state.tree;
          state.tree = undefined;
          state.mode = "freeform";
        }

        const hostCells = state.cells.filter((c) => c.roomId === op.hostRoomId);
        const hostName = state.roomMeta[op.hostRoomId]!.name;
        if (hostCells.length !== 1) {
          errors.push(
            `nestRoom: "${hostName}" already has an irregular shape (${hostCells.length} pieces) — nested placement needs a ` +
              `single-rectangle host. Reshape it on the canvas first.`,
          );
          break;
        }

        const host = hostCells[0]!;
        const plan = planNestedRoom(host, nookWidth, nookDepth);
        if (!plan) {
          errors.push(
            `nestRoom: a ${nookWidth}mm x ${nookDepth}mm room wouldn't leave any of "${hostName}" left — ask for a smaller one ` +
              `or enlarge "${hostName}" first.`,
          );
          break;
        }
        // The two remainder pieces stay one continuous floor — buildWallGraph dissolves
        // the seam between same-room cells (rectUnion.test.ts) — so a thin *piece* of the
        // decomposition is not a thin *room*: the corner strip beside the nook flows
        // straight into the rest of the host. What can genuinely leave the host unusable
        // is too little floor *overall*, so that is what gets checked, against the same
        // minimum SLV-2 already holds every generated room to.
        const hostProgram = state.roomMeta[op.hostRoomId]!.program;
        const hostMin = ROOM_PROGRAM_MIN_DIMENSIONS[hostProgram];
        const remainingArea = host.w * host.d - plan.nook.w * plan.nook.d;
        if (remainingArea < hostMin.minWidth * hostMin.minDepth) {
          const kind = hostProgram.replace(/-/g, " ");
          errors.push(
            `nestRoom: carving that out of "${hostName}" would leave too little floor for a ${kind} — make "${hostName}" ` +
              `bigger or ask for a smaller room.`,
          );
          break;
        }

        const roomId = allocateRoomId(state, op.roomId);
        addedRoomIds.push(roomId);
        state.cells = [
          ...state.cells.filter((c) => c.roomId !== op.hostRoomId),
          { ...plan.remainder[0], roomId: op.hostRoomId },
          { ...plan.remainder[1], roomId: op.hostRoomId },
          { ...plan.nook, roomId },
        ];
        state.roomMeta[roomId] = {
          name: op.name ?? defaultNameFor(op.program, Object.values(state.roomMeta).filter((m) => m.program === op.program).length),
          program: op.program,
          constraints: op.constraints,
        };
        break;
      }
      case "detachGenerator": {
        if (state.mode === "freeform") {
          errors.push("detachGenerator: level is already freeform.");
          break;
        }
        if (!state.tree) {
          errors.push("detachGenerator: no generated layout to detach.");
          break;
        }
        const solved = solveSlicingTree(state.tree, state.boundary, state.gridModule);
        if (!solved.ok) {
          errors.push(`detachGenerator: ${solved.violations.map((v) => v.message).join(" ")}`);
          break;
        }
        state.cells = solved.leaves.map((l): RoomCell => ({ x: l.x, y: l.y, w: l.w, d: l.d, roomId: l.roomId }));
        state.savedTree = state.tree;
        state.tree = undefined;
        state.mode = "freeform";
        break;
      }
      case "reattachGenerator": {
        if (state.mode === "slicing") {
          errors.push("reattachGenerator: level already has a generated layout.");
          break;
        }
        if (!state.savedTree) {
          errors.push("reattachGenerator: no generated layout to restore.");
          break;
        }
        state.tree = state.savedTree;
        state.savedTree = undefined;
        state.cells = [];
        state.mode = "slicing";
        break;
      }
      case "setRoomRects": {
        if (state.mode !== "freeform") {
          errors.push("setRoomRects: level must be freeform first — see detachGenerator.");
          break;
        }
        if (!state.roomMeta[op.roomId]) {
          errors.push(`setRoomRects: room ${op.roomId} not found`);
          break;
        }
        state.cells = [
          ...state.cells.filter((c) => c.roomId !== op.roomId),
          ...op.rects.map((r: Rect): RoomCell => ({ ...r, roomId: op.roomId })),
        ];
        break;
      }
      case "setDimension": {
        const value = dimensionValueInMm(op.dimensionType, op.value, op.unit);
        const err = applyDimensionOp(state, op.roomId, (leaf, meta) => {
          const constraints = { ...(meta.constraints ?? {}) };
          if (op.dimensionType === "width" || op.dimensionType === "depth" || op.dimensionType === "area") {
            constraints[op.dimensionType] = { ...(constraints[op.dimensionType] ?? {}), exact: value };
          } else {
            constraints.aspectRatio = { min: value, max: value };
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
      case "nestRoom": {
        const addedId = addedRoomIds[addedIndex++];
        const hostName = nameOf(op.hostRoomId);
        changes.push(
          addedId
            ? `Added ${nameOf(addedId)} inside ${hostName} (${hostName} is now L-shaped; this level is now edited freeform)`
            : `Added a room inside ${hostName}`,
        );
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
        changes.push(`${nameOf(op.roomId)} ${op.dimensionType} pinned to ${dimensionValueInMm(op.dimensionType, op.value, op.unit)}mm`);
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
      case "setRoomRects":
        changes.push("Moved a wall");
        break;
      case "detachGenerator":
        changes.push("Switched to freeform editing");
        break;
      case "reattachGenerator":
        changes.push("Restored generated layout");
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

/** Matches the cap the Worker applies to the x-fc-title header it stores (plans.ts). */
const MAX_PLAN_TITLE_LENGTH = 200;

const DOCUMENT_SCOPED_OPS = new Set<PatchOp["op"]>([
  "renamePlan",
  "addLevel",
  "removeLevel",
  "setActiveLevel",
  "renameLevel",
  "setLevelProps",
  "importLevel",
]);

/** Same reasoning as nextRoomSeq/nextOpeningSeq: ids must clear every id in use. */
function nextLevelSeq(existingIds: Iterable<LevelId>): number {
  let max = -1;
  for (const id of existingIds) {
    const match = /^level-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

type DocumentScopedResult =
  | { ok: true; doc: PlanDocument; changes: string[]; remainingOps: PatchOp[] }
  | { ok: false; errors: string[] };

/**
 * A plan rename and the multi-storey ops (Phase 3) are document-scoped, not level-scoped,
 * so they run in their own pass before the rest of the patch: `activeLevelId` may change
 * mid-patch (addLevel switches to the level it just created), and everything after this
 * pass — the tree/cell ops, the solve, the graph rebuild — operates on whichever level is
 * active once these have run. This is what makes "add a second floor with two bedrooms"
 * one patch instead of two turns.
 */
function applyDocumentScopedOps(doc: PlanDocument, ops: PatchOp[]): DocumentScopedResult {
  let levels = doc.levels;
  let activeLevelId = doc.activeLevelId;
  let title = doc.title;
  const errors: string[] = [];
  const changes: string[] = [];
  const remainingOps: PatchOp[] = [];
  let levelSeq = nextLevelSeq(levels.map((l) => l.id));

  for (const op of ops) {
    if (!DOCUMENT_SCOPED_OPS.has(op.op)) {
      remainingOps.push(op);
      continue;
    }
    switch (op.op) {
      case "renamePlan": {
        // Trimmed and capped here rather than at the call site: this op is reachable from
        // the toolbar, from chat, and from an imported patch, and a title of pure spaces
        // would leave every export named after nothing.
        const next = op.title.trim().slice(0, MAX_PLAN_TITLE_LENGTH).trim();
        if (!next) {
          errors.push("renamePlan: a plan title cannot be empty");
          break;
        }
        if (next !== title) {
          title = next;
          changes.push(`Renamed the plan to ${next}`);
        }
        break;
      }
      case "addLevel": {
        const levelId = op.levelId && !levels.some((l) => l.id === op.levelId) ? op.levelId : `level-${levelSeq++}`;
        const copyFrom = op.copyFromLevelId ? levels.find((l) => l.id === op.copyFromLevelId) : undefined;
        const reference = levels.find((l) => l.id === activeLevelId) ?? levels[0];
        // Carries the source level's room metadata (name/program/constraints) into a
        // placeholder graph with no geometry yet — levelStateFromDoc reads roomMeta off
        // graph.rooms, so without this the copied tree/cells would reference rooms with
        // no name or program the moment this level is solved below.
        const copiedRooms: Record<RoomId, Room> = {};
        if (copyFrom) {
          for (const [roomId, room] of Object.entries(copyFrom.graph.rooms)) {
            copiedRooms[roomId] = { name: room.name, program: room.program, constraints: room.constraints, boundary: [] };
          }
        }
        const highestTop = levels.length > 0 ? Math.max(...levels.map((l) => l.elevation + l.floorToCeiling)) : 0;
        const newLevel: Level = {
          id: levelId,
          name: op.name ?? `Level ${levels.length + 1}`,
          elevation: highestTop,
          floorToCeiling: copyFrom?.floorToCeiling ?? reference?.floorToCeiling ?? 2440,
          boundary: copyFrom?.boundary ?? reference?.boundary ?? { widthMm: 9000, depthMm: 9000 },
          generator: copyFrom?.generator
            ? copyFrom.generator.kind === "slicing"
              ? { kind: "slicing", tree: copyFrom.generator.tree }
              : { kind: "freeform", cells: copyFrom.generator.cells.map((c) => ({ ...c })), savedTree: copyFrom.generator.savedTree }
            : undefined,
          graph: { nodes: {}, edges: {}, rooms: copiedRooms },
        };
        levels = [...levels, newLevel];
        activeLevelId = levelId;
        changes.push(`Added ${newLevel.name}`);
        break;
      }
      case "importLevel": {
        // FR-24: always a new level in freeform mode — raster-detected geometry has no
        // generator tree to attach to, by construction.
        const levelId = op.levelId && !levels.some((l) => l.id === op.levelId) ? op.levelId : `level-${levelSeq++}`;
        const cells: RoomCell[] = [];
        const importedRooms: Record<RoomId, Room> = {};
        let roomSeq = 0;
        for (const room of op.rooms) {
          let roomId = room.roomId && !importedRooms[room.roomId] ? room.roomId : `imported-${roomSeq++}`;
          while (importedRooms[roomId]) roomId = `imported-${roomSeq++}`;
          for (const r of room.rects) cells.push({ ...r, roomId });
          importedRooms[roomId] = {
            name: room.name ?? defaultNameFor(room.program, Object.values(importedRooms).filter((m) => m.program === room.program).length),
            program: room.program,
            boundary: [],
          };
        }
        const highestTop = levels.length > 0 ? Math.max(...levels.map((l) => l.elevation + l.floorToCeiling)) : 0;
        const newLevel: Level = {
          id: levelId,
          name: op.name ?? "Imported Level",
          elevation: highestTop,
          floorToCeiling: 2440,
          boundary: op.boundaryMm,
          generator: { kind: "freeform", cells },
          graph: { nodes: {}, edges: {}, rooms: importedRooms },
        };
        levels = [...levels, newLevel];
        activeLevelId = levelId;
        changes.push(`Imported ${newLevel.name} (${Object.keys(importedRooms).length} rooms)`);
        break;
      }
      case "removeLevel": {
        if (levels.length <= 1) {
          errors.push("removeLevel: cannot remove the only level.");
          break;
        }
        const removed = levels.find((l) => l.id === op.levelId);
        if (!removed) {
          errors.push(`removeLevel: level ${op.levelId} not found`);
          break;
        }
        levels = levels.filter((l) => l.id !== op.levelId);
        if (activeLevelId === op.levelId) {
          activeLevelId = levels.reduce((nearest, l) =>
            Math.abs(l.elevation - removed.elevation) < Math.abs(nearest.elevation - removed.elevation) ? l : nearest,
          ).id;
        }
        changes.push(`Removed ${removed.name}`);
        break;
      }
      case "setActiveLevel": {
        const target = levels.find((l) => l.id === op.levelId);
        if (!target) {
          errors.push(`setActiveLevel: level ${op.levelId} not found`);
          break;
        }
        activeLevelId = target.id;
        changes.push(`Switched to ${target.name}`);
        break;
      }
      case "renameLevel": {
        if (!levels.some((l) => l.id === op.levelId)) {
          errors.push(`renameLevel: level ${op.levelId} not found`);
          break;
        }
        levels = levels.map((l) => (l.id === op.levelId ? { ...l, name: op.name } : l));
        changes.push(`Renamed level to ${op.name}`);
        break;
      }
      case "setLevelProps": {
        if (!levels.some((l) => l.id === op.levelId)) {
          errors.push(`setLevelProps: level ${op.levelId} not found`);
          break;
        }
        levels = levels.map((l) =>
          l.id === op.levelId
            ? { ...l, elevation: op.elevation ?? l.elevation, floorToCeiling: op.floorToCeiling ?? l.floorToCeiling }
            : l,
        );
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { ...doc, title, levels, activeLevelId }, changes, remainingOps };
}

const MM_PER_FOOT = 304.8;

/**
 * Prose length for a warning sentence. Deliberately not svgRenderer's `formatLength`:
 * that renders drawing notation (`8'-0"`), which reads badly mid-sentence, and importing
 * it here would close an import cycle since svgRenderer already reads `activeLevel` back
 * out of this module.
 */
function lengthInWords(mm: number, units: Units): string {
  return `${lengthNumber(mm, units)} ${units === "metric" ? "m" : "ft"}`;
}

function lengthNumber(mm: number, units: Units): string {
  return units === "metric" ? (mm / 1000).toFixed(2) : (mm / MM_PER_FOOT).toFixed(1);
}

/** "30.0 x 40.0 ft" — a pair of measurements names its unit once, the way a person says it. */
function lengthPair(widthMm: number, depthMm: number, units: Units): string {
  return `${lengthNumber(widthMm, units)} x ${lengthInWords(depthMm, units)}`;
}

function joinPhrases(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Turns the solver's unmet pins into one sentence per room (SLV-7): what the room actually
 * came out as, and the reason it could not be what was asked for. Grouped by room because
 * a room that missed on both axes missed for one reason, and saying it twice would read
 * like two separate problems.
 */
function describeUnmetConstraints(
  unmet: readonly UnmetConstraint[],
  roomMeta: Record<RoomId, RoomMeta>,
  leafCount: number,
  units: Units,
): { message: string }[] {
  const byRoom = new Map<RoomId, UnmetConstraint[]>();
  for (const item of unmet) {
    const existing = byRoom.get(item.roomId);
    if (existing) existing.push(item);
    else byRoom.set(item.roomId, [item]);
  }

  return [...byRoom].map(([roomId, items]) => {
    const meta = roomMeta[roomId];
    const name = meta?.name ?? roomId;
    const mins = meta ? ROOM_PROGRAM_MIN_DIMENSIONS[meta.program] : undefined;
    const minFor = (axis: UnmetConstraint["axis"]) => (axis === "width" ? mins?.minWidth : mins?.minDepth);
    const axisWord = (axis: UnmetConstraint["axis"]) => (axis === "width" ? "wide" : "deep");

    // Both axes missed reads far better as one pair of measurements than as two clauses
    // that each repeat "rather than the ... asked for".
    const width = items.find((i) => i.axis === "width");
    const depth = items.find((i) => i.axis === "depth");
    const got =
      width && depth
        ? `${lengthPair(width.actualMm, depth.actualMm, units)}, not the ` +
          `${lengthPair(width.requestedMm, depth.requestedMm, units)} asked for`
        : joinPhrases(
            items.map(
              (i) =>
                `${lengthInWords(i.actualMm, units)} ${axisWord(i.axis)}, not the ` +
                `${lengthInWords(i.requestedMm, units)} asked for`,
            ),
          );

    // A pin under the program minimum is refused for a reason worth naming, and naming it
    // first matters: it is the one cause the user can act on without touching the layout.
    const belowMin = items.filter((i) => {
      const min = minFor(i.axis);
      return min !== undefined && i.requestedMm < min;
    });
    let reason: string;
    if (belowMin.length > 0) {
      const needs = joinPhrases(belowMin.map((i) => `${lengthInWords(minFor(i.axis)!, units)} ${axisWord(i.axis)}`));
      // The program is spelled for a reader, not as the enum ("primary-bedroom").
      const kind = meta ? meta.program.replace(/-/g, " ") : "room";
      reason = `a ${kind} needs at least ${needs} for clearances, so ask for a size at or above that`;
    } else if (leafCount <= 1) {
      reason = "the only room on a level has to fill it — add the other rooms and this size can hold";
    } else {
      reason =
        "rooms tile the floor with no gaps, so a room can only pin the dimension its own wall line sets — " +
        "size the rooms beside it, or drag its wall on the canvas";
    }

    return { message: `${name} came out ${got}: ${reason}.` };
  });
}

/**
 * setDimension's value in millimetres. The op carries an optional `unit` (INF-6) because
 * a model asked for "a 12 ft kitchen" has a number and a unit, not a millimetre count —
 * and reading that 12 as 12 mm produces a room a hundredth of the size asked for, which
 * the solver then quietly rounds up to the program minimum. Everything stored is
 * millimetres (DM-4); this is the only place the op's unit is honoured.
 *
 * An area is a squared length, so it scales by the square of the factor: 200 sq ft is
 * 200 x 304.8^2 mm². An aspect ratio is unitless and ignores the field entirely.
 */
function dimensionValueInMm(dimensionType: DimensionType, value: number, unit?: "ft" | "m"): number {
  if (!unit || dimensionType === "aspectRatio") return value;
  const scale = MM_PER_UNIT[unit];
  return Math.round(dimensionType === "area" ? value * scale * scale : value * scale);
}

export function applyPatch(doc: PlanDocument, patch: Patch): ApplyPatchResult {
  const docOpsResult = applyDocumentScopedOps(doc, patch.ops);
  if (!docOpsResult.ok) return { ok: false, errors: docOpsResult.errors };
  const { doc: docAfterDocOps, changes: docChanges, remainingOps } = docOpsResult;

  const levelIndex = docAfterDocOps.levels.findIndex((l) => l.id === docAfterDocOps.activeLevelId);
  if (levelIndex < 0) return { ok: false, errors: [`active level ${docAfterDocOps.activeLevelId} not found`] };
  const level = docAfterDocOps.levels[levelIndex]!;

  const beforeLeaves =
    level.generator?.kind === "slicing" ? solveSlicingTree(level.generator.tree, level.boundary, docAfterDocOps.gridModule) : null;
  const beforeAreas = beforeLeaves && beforeLeaves.ok ? leafAreas(beforeLeaves.leaves) : {};
  const namesBefore: Record<RoomId, string> = {};
  for (const [id, r] of Object.entries(level.graph.rooms)) namesBefore[id] = r.name;

  const state = levelStateFromDoc(docAfterDocOps, level);
  const { errors, addedRoomIds, addedOpeningIds } = applyTreeOps(state, remainingOps, beforeAreas);
  if (errors.length > 0) return { ok: false, errors };

  let graph: WallGraph;
  let afterLeaves: LeafRect[] = [];
  let warnings: { message: string }[] = [];

  if (state.mode === "slicing") {
    if (!state.tree) {
      graph = emptyWallGraph();
    } else {
      const solved = solveSlicingTree(state.tree, state.boundary, docAfterDocOps.gridModule);
      if (!solved.ok) return { ok: false, errors: [], violations: solved.violations };
      afterLeaves = solved.leaves;
      warnings = describeUnmetConstraints(solved.unmet, state.roomMeta, solved.leaves.length, state.units);
      const built = buildWallGraph(solved.leaves, state.boundary, state.roomMeta);
      if (!built.ok) return { ok: false, errors: [], violations: built.violations };
      graph = built.graph;
      applyOpeningsToGraph(graph, state.openings);
    }
  } else {
    if (state.cells.length === 0) {
      graph = emptyWallGraph();
    } else {
      const built = buildWallGraph(state.cells, state.boundary, state.roomMeta);
      if (!built.ok) return { ok: false, errors: [], violations: built.violations };
      graph = built.graph;
      applyOpeningsToGraph(graph, state.openings);
    }
  }

  const newLevel: Level = {
    ...level,
    boundary: state.boundary,
    generator: buildGenerator(state),
    openings: state.openings,
    graph,
  };

  const newLevels = [...docAfterDocOps.levels];
  newLevels[levelIndex] = newLevel;

  const newDoc: PlanDocument = {
    ...docAfterDocOps,
    units: state.units,
    levels: newLevels,
    updatedAt: new Date().toISOString(),
  };

  const nameOf = (roomId: RoomId) => graph.rooms[roomId]?.name ?? namesBefore[roomId] ?? roomId;
  const afterAreas = leafAreas(afterLeaves);
  const changes = summarizeChanges(remainingOps, beforeAreas, afterAreas, nameOf, addedRoomIds, {
    graph,
    openings: state.openings,
    addedOpeningIds,
  });

  return {
    ok: true,
    doc: newDoc,
    changes: [...docChanges, ...changes],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function buildGenerator(state: LevelState): Generator | undefined {
  if (state.mode === "slicing") {
    return state.tree ? { kind: "slicing", tree: state.tree } : undefined;
  }
  return { kind: "freeform", cells: state.cells, savedTree: state.savedTree };
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
