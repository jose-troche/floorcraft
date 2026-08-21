// Domain model — specs.md §3.2 (DM-1..DM-5). All lengths are integer millimetres (DM-4).
// Wall geometry is stored as centerlines + thickness; face polygons are derived, never persisted (DM-5).

export type NodeId = string;
export type EdgeId = string;
export type RoomId = string;
export type OpeningId = string;
export type LevelId = string;

export const SCHEMA_VERSION = 1 as const;

export type Units = "imperial" | "metric";

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

export type Generator = {
  tree: SlicingTree;
  detached?: false;
} | {
  tree?: SlicingTree;
  detached: true;
};

export type Level = {
  id: LevelId;
  name: string;
  elevation: number;
  floorToCeiling: number;
  /** Outer boundary of the level, mm. Origin at (0,0), rectangle width x depth. */
  boundary: { widthMm: number; depthMm: number };
  generator?: Generator;
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

export type PatchOp =
  | { op: "addRoom"; roomId?: RoomId; program: RoomProgram; name?: string; areaWeight: number; adjacentTo?: RoomId; constraints?: RoomConstraints }
  | { op: "removeRoom"; roomId: RoomId }
  | { op: "renameRoom"; roomId: RoomId; name: string }
  | { op: "resizeRoom"; roomId: RoomId; areaWeight?: number; targetAreaMm2?: number }
  | { op: "swapRooms"; roomIdA: RoomId; roomIdB: RoomId }
  | { op: "moveRoom"; roomId: RoomId; relativeTo: RoomId; direction: "left" | "right" | "above" | "below" }
  | { op: "setSplit"; nodePath: NodePath; axis?: "h" | "v"; ratio?: number }
  | { op: "addOpening"; betweenRooms?: [RoomId, RoomId]; edgeId?: EdgeId; kind: OpeningKind; width?: number }
  | { op: "removeOpening"; openingId: OpeningId }
  | { op: "setBoundary"; widthMm: number; depthMm: number }
  | { op: "setUnits"; units: Units }
  | { op: "setDimension"; roomId: RoomId; dimensionType: DimensionType; value: number; unit?: "ft" | "m" }
  | { op: "clearDimension"; roomId: RoomId; dimensionType: DimensionType }
  | { op: "setDimensionRange"; roomId: RoomId; dimensionType: DimensionType; minMm?: number; maxMm?: number };

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
  reason: "min-dimension" | "unsatisfiable-ratio" | "boundary-too-small" | "conflicting-constraints";
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
  generatorTree: SlicingTree | null;
};
