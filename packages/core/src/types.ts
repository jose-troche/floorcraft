// Domain model — specs.md §3.2 (DM-1..DM-5). All lengths are integer millimetres (DM-4).
// Wall geometry is stored as centerlines + thickness; face polygons are derived, never persisted (DM-5).

export type NodeId = string;
export type EdgeId = string;
export type RoomId = string;
export type OpeningId = string;
export type LevelId = string;

export const SCHEMA_VERSION = 1 as const;

export type Units = "imperial" | "metric";

/**
 * DM-4: every length in a document is an integer millimetre count. These are the factors
 * into it, kept here — beside the rule they serve — so both the dimension parser and the
 * patch reducer convert with the same numbers.
 */
export const MM_PER_UNIT = { ft: 304.8, in: 25.4, cm: 10, mm: 1, m: 1000 } as const;

export type RoomProgram =
  | "kitchen"
  | "living"
  | "family"
  | "dining"
  | "bedroom"
  | "primary-bedroom"
  | "bath"
  | "half-bath"
  | "laundry"
  | "office"
  | "garage"
  | "hallway"
  | "closet"
  | "pantry"
  | "entry"
  | "mudroom"
  | "stair"
  | "other";

/** SLV-2 required tier 1: minimum room dimensions per program, in mm. */
export const ROOM_PROGRAM_MIN_DIMENSIONS: Record<RoomProgram, { minWidth: number; minDepth: number }> = {
  kitchen: { minWidth: 2440, minDepth: 2440 },
  living: { minWidth: 3050, minDepth: 3050 },
  family: { minWidth: 3050, minDepth: 2740 },
  dining: { minWidth: 2740, minDepth: 2740 },
  bedroom: { minWidth: 2740, minDepth: 2740 },
  "primary-bedroom": { minWidth: 3350, minDepth: 3350 },
  bath: { minWidth: 1520, minDepth: 2130 },
  "half-bath": { minWidth: 910, minDepth: 1520 },
  laundry: { minWidth: 1520, minDepth: 1520 },
  office: { minWidth: 2130, minDepth: 2130 },
  garage: { minWidth: 3050, minDepth: 5490 },
  hallway: { minWidth: 910, minDepth: 910 },
  closet: { minWidth: 610, minDepth: 610 },
  pantry: { minWidth: 760, minDepth: 760 },
  entry: { minWidth: 1220, minDepth: 1220 },
  mudroom: { minWidth: 1220, minDepth: 1520 },
  // Standard single-flight run: ~915mm clear width, ~3050mm to clear a 2440 floor-to-floor
  // rise at a 7"/11" rise/run (stairs.ts's alignment check treats this as the footprint a
  // stair core needs to line up between levels).
  stair: { minWidth: 915, minDepth: 3050 },
  other: { minWidth: 910, minDepth: 910 },
};

/**
 * Relative area weight used when a room is added without one. areaWeight is a ratio
 * between siblings, not a real dimension, so it is the kind of value a weak model has
 * no good way to invent — callers that omit it get a sensible per-program default.
 */
export const DEFAULT_AREA_WEIGHT: Record<RoomProgram, number> = {
  kitchen: 1.2,
  living: 1.6,
  family: 1.4,
  dining: 1.0,
  bedroom: 1.2,
  "primary-bedroom": 1.6,
  bath: 0.5,
  "half-bath": 0.25,
  laundry: 0.4,
  office: 0.8,
  garage: 1.8,
  hallway: 0.4,
  closet: 0.2,
  pantry: 0.3,
  entry: 0.4,
  mudroom: 0.4,
  stair: 0.6,
  other: 1.0,
};

/** Wet programs preferentially share a wall (SLV-2 item 4). */
export const WET_PROGRAMS: ReadonlySet<RoomProgram> = new Set(["kitchen", "bath", "half-bath", "laundry"]);

export type OpeningKind = "door" | "window" | "cased" | "pass-through";
export type DoorSwing = "left-in" | "left-out" | "right-in" | "right-out";

export type Opening = {
  id: OpeningId;
  kind: OpeningKind;
  /** mm from edge.a along the edge centerline. */
  offset: number;
  width: number;
  height: number;
  sill?: number;
  swing?: DoorSwing;
};

/** Which side of a room's bounding rectangle a wall run sits on. y increases downward. */
export type RoomSide = "top" | "right" | "bottom" | "left";

/**
 * How an opening is anchored to the plan, independently of any particular edge id.
 *
 * Edge ids are regenerated from scratch every time the wall graph is rebuilt (which is
 * every patch), so an opening that remembered an EdgeId would be orphaned by the next
 * edit. Anchors are semantic — "the wall between the kitchen and the hall", "the north
 * wall of the living room" — and are re-resolved against the fresh graph after each solve.
 */
export type OpeningAnchor =
  | { kind: "between"; rooms: [RoomId, RoomId] }
  | { kind: "exterior"; roomId: RoomId; side: RoomSide };

/**
 * The persisted form of an opening (DM-5's spirit: store intent, derive geometry).
 * `offsetRatio` positions it along the resolved wall run as a fraction of the run's
 * slidable range, so it keeps its relative placement when the wall changes length.
 */
export type PersistedOpening = {
  id: OpeningId;
  kind: OpeningKind;
  anchor: OpeningAnchor;
  /** 0..1 along the resolved wall run's slidable range. */
  offsetRatio: number;
  width: number;
  height: number;
  sill?: number;
  swing?: DoorSwing;
};

export type EdgeType = "exterior" | "interior" | "partition";

export type WallEdge = {
  a: NodeId;
  b: NodeId;
  thickness: number;
  type: EdgeType;
  openings: Opening[];
};

export type DimensionRange = { exact?: number; min?: number; max?: number };

export type RoomConstraints = {
  width?: DimensionRange;
  depth?: DimensionRange;
  area?: DimensionRange;
  aspectRatio?: { min?: number; max?: number };
};

export type Room = {
  name: string;
  program: RoomProgram;
  /** Ordered cycle of edge ids bounding the room, CCW. */
  boundary: EdgeId[];
  labelAnchor?: { x: number; y: number };
  constraints?: RoomConstraints;
};

export type WallGraph = {
  nodes: Record<NodeId, { x: number; y: number }>;
  edges: Record<EdgeId, WallEdge>;
  rooms: Record<RoomId, Room>;
};

export function emptyWallGraph(): WallGraph {
  return { nodes: {}, edges: {}, rooms: {} };
}

export type SlicingLeaf = {
  kind: "leaf";
  roomId: RoomId;
  areaWeight: number;
  minWidth?: number;
  minDepth?: number;
  /**
   * A dimension the user pinned outright (SLV-6). Distinct from minWidth/minDepth: a
   * minimum only stops a room getting too small and otherwise lets areaWeight decide,
   * whereas an exact value fixes the cut line regardless of the weights around it.
   */
  exactWidth?: number;
  exactDepth?: number;
};

export type SlicingSplit = {
  kind: "split";
  axis: "h" | "v";
  /** Fraction (0..1) of the parent rectangle allotted to children[0]. */
  ratio: number;
  children: [SlicingTree, SlicingTree];
};

export type SlicingTree = SlicingLeaf | SlicingSplit;

/** A path of child indices from the tree root, e.g. [0, 1] = root.children[0].children[1]. */
export type NodePath = number[];

/** An axis-aligned rectangle in level-local mm. */
export type Rect = { x: number; y: number; w: number; d: number };

/**
 * One rectangular piece of a room. A room with a single cell is an ordinary rectangular
 * room; a room with several is a rectilinear union (FR-11) — an L-shape is two cells that
 * share a full face.
 */
export type RoomCell = Rect & { roomId: RoomId };

/**
 * A level's layout source (DM-2). `slicing` is generated: the tree is evaluated fresh by
 * the solver on every patch. `freeform` is the "detached" state DM-2 describes: an edit the
 * tree can't express (a partial wall drag, an L-shape) freezes the last-solved rectangles
 * into `cells` and edits apply to those directly from then on. `savedTree` is what makes
 * "restore generated layout" a single click instead of a redraw from scratch.
 */
export type Generator =
  | { kind: "slicing"; tree: SlicingTree }
  | { kind: "freeform"; cells: RoomCell[]; savedTree?: SlicingTree };

/** The generator tree driving a level, if it has one — undefined for a freeform level. */
export function generatorTree(level: Level): SlicingTree | undefined {
  return level.generator?.kind === "slicing" ? level.generator.tree : undefined;
}

export type Level = {
  id: LevelId;
  name: string;
  elevation: number;
  floorToCeiling: number;
  /** Outer boundary of the level, mm. Origin at (0,0), rectangle width x depth. */
  boundary: { widthMm: number; depthMm: number };
  generator?: Generator;
  /**
   * Openings survive regeneration here, not in the graph: `graph.edges[].openings` is
   * derived from this list after every solve. Optional so documents written before
   * Phase 2 load unchanged.
   */
  openings?: PersistedOpening[];
  graph: WallGraph;
};

export type PlanDocument = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  units: Units;
  gridModule: number;
  levels: Level[];
  activeLevelId: LevelId;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Patch vocabulary — specs.md §5.2 (INF-6). Closed and small; adding an op
// requires updating exactly this union, the reducer, and the provider prompt
// fixture (INF-7).
// ---------------------------------------------------------------------------

export type DimensionType = "width" | "depth" | "area" | "aspectRatio";

/**
 * Where a room goes relative to another one.
 *
 * "inside" is a deliberate approximation. A slicing tree is a guillotine partition and
 * cannot express true containment — a room fully enclosed by another needs the L-shaped
 * geometry of FR-11 (Phase 3). What it can express, and what "a closet inside the
 * office" actually means architecturally, is partitioning the host room and giving the
 * new room a share of it. The host keeps its identity and the remainder of its area.
 */
export type SpatialDirection = "left" | "right" | "above" | "below" | "inside";

export type PatchOp =
  | { op: "addRoom"; roomId?: RoomId; program: RoomProgram; name?: string; areaWeight: number; adjacentTo?: RoomId; direction?: SpatialDirection; constraints?: RoomConstraints }
  | { op: "removeRoom"; roomId: RoomId }
  | { op: "renameRoom"; roomId: RoomId; name: string }
  | { op: "resizeRoom"; roomId: RoomId; areaWeight?: number; targetAreaMm2?: number }
  | { op: "swapRooms"; roomIdA: RoomId; roomIdB: RoomId }
  | { op: "moveRoom"; roomId: RoomId; relativeTo: RoomId; direction: SpatialDirection }
  | { op: "setSplit"; nodePath: NodePath; axis?: "h" | "v"; ratio?: number }
  | { op: "addOpening"; betweenRooms?: [RoomId, RoomId]; edgeId?: EdgeId; kind: OpeningKind; width?: number; offsetRatio?: number; swing?: DoorSwing }
  | { op: "removeOpening"; openingId: OpeningId }
  // Direct-manipulation ops (FR-7). Never emitted by a provider — see USER_ONLY_PATCH_OPS
  // in providers/schema.ts for why the model is kept away from coordinates.
  | { op: "moveOpening"; openingId: OpeningId; offsetRatio: number }
  | { op: "setOpeningSwing"; openingId: OpeningId; swing: DoorSwing }
  | { op: "setLabelAnchor"; roomId: RoomId; x: number; y: number }
  // Nested rooms (FR-11's other consumer). Carves `program` from one corner of
  // `hostRoomId` — the only shape a rect-union room or a guillotine tree can express for
  // "a closet inside the bedroom" (see nesting.ts) — and switches the level to freeform,
  // since the host is no longer a single rectangle a generator tree can produce. Distinct
  // from addRoom's `direction: "inside"`, which partitions the host by a full-width or
  // full-depth cut and keeps it rectangular (see SpatialDirection) — nestRoom is the one
  // that actually produces the L-shape and an enclosed-looking nook.
  | { op: "nestRoom"; hostRoomId: RoomId; roomId?: RoomId; program: RoomProgram; name?: string; constraints?: RoomConstraints }
  // Detached/freeform editing (DM-2, FR-11). setRoomRects is the one primitive every
  // freeform gesture (wall drag, L-shape split) reduces to; see dragPlan.ts.
  | { op: "detachGenerator" }
  | { op: "reattachGenerator" }
  | { op: "setRoomRects"; roomId: RoomId; rects: Rect[] }
  | { op: "setBoundary"; widthMm: number; depthMm: number }
  | { op: "setUnits"; units: Units }
  | { op: "setDimension"; roomId: RoomId; dimensionType: DimensionType; value: number; unit?: "ft" | "m" }
  | { op: "clearDimension"; roomId: RoomId; dimensionType: DimensionType }
  | { op: "setDimensionRange"; roomId: RoomId; dimensionType: DimensionType; minMm?: number; maxMm?: number }
  // Document-scoped ops: applied before the rest of the patch, against whichever level is
  // active once they've run — see applyPatch in patch.ts. renamePlan names the plan itself,
  // which is what an export's filename and the PDF title block are drawn from.
  | { op: "renamePlan"; title: string }
  // Multi-storey (Phase 3).
  | { op: "addLevel"; levelId?: LevelId; name?: string; copyFromLevelId?: LevelId }
  | { op: "removeLevel"; levelId: LevelId }
  | { op: "setActiveLevel"; levelId: LevelId }
  | { op: "renameLevel"; levelId: LevelId; name: string }
  | { op: "setLevelProps"; levelId: LevelId; elevation?: number; floorToCeiling?: number }
  // Raster import (Phase 4, FR-24). Always creates a new level in freeform mode — the
  // imported geometry has no generator tree by construction — and switches to it.
  | {
      op: "importLevel";
      levelId?: LevelId;
      name?: string;
      boundaryMm: { widthMm: number; depthMm: number };
      rooms: Array<{ roomId?: RoomId; program: RoomProgram; name?: string; rects: Rect[] }>;
    };

export type Patch = {
  ops: PatchOp[];
  narration?: string;
  /** Which layer produced this patch, for FR-4's "what changed" summary and undo history. */
  source: "deterministic" | "provider" | "user";
};

// ---------------------------------------------------------------------------
// Structured solver failure (SLV-3) — never a broken plan, always a diagnosis.
// ---------------------------------------------------------------------------

export type SolveViolation = {
  roomIds: RoomId[];
  /**
   * For `boundary-too-small`, the smallest boundary that would hold these rooms. Present
   * so a caller can fit a footprint to the rooms without solving twice to discover it —
   * the alternative is laying the plan out against a deliberately oversized boundary just
   * to read the minimum back off the resulting tree.
   */
  requiredMm?: { widthMm: number; depthMm: number };
  reason:
    | "min-dimension"
    | "unsatisfiable-ratio"
    | "boundary-too-small"
    | "conflicting-constraints"
    | "overlapping-rooms"
    | "disconnected-room"
    | "out-of-bounds";
  message: string;
};

export type SolveResult =
  | { ok: true; graph: WallGraph }
  | { ok: false; violations: SolveViolation[] };

// ---------------------------------------------------------------------------
// Conversation / inference plumbing — specs.md §5.1
// ---------------------------------------------------------------------------

export type Turn = {
  role: "user" | "assistant";
  text: string;
};

export type ProviderId = "tier0-on-device" | "tier1-hosted" | "tier2-openrouter" | "tier3-byok";

export type PlanSummary = {
  title: string;
  units: Units;
  boundary: { widthMm: number; depthMm: number };
  rooms: Array<{
    roomId: RoomId;
    program: RoomProgram;
    name: string;
    approxAreaMm2: number;
    exterior: boolean;
  }>;
  adjacencies: Array<[RoomId, RoomId]>;
  /** Freeform levels have no generator tree to restructure — see FREEFORM_PATCH_OPS. */
  mode: "slicing" | "freeform";
  generatorTree: SlicingTree | null;
};
