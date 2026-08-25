// Patch schema validation and JSON-Schema generation for structured decoding.
// specs.md INF-3 (providers return Patch, never prose-with-JSON) and INF-4 (the
// client MUST validate every returned patch regardless of what the provider claims).

import {
  DEFAULT_AREA_WEIGHT,
  ROOM_PROGRAM_MIN_DIMENSIONS,
  type Patch,
  type PatchOp,
  type RoomProgram,
  type SpatialDirection,
} from "../types.js";

export const SPATIAL_DIRECTIONS: readonly SpatialDirection[] = ["left", "right", "above", "below", "inside"];

export const CORE_PATCH_OPS = [
  "addRoom",
  "removeRoom",
  "renameRoom",
  "resizeRoom",
  "swapRooms",
  "setBoundary",
  "setUnits",
] as const;

export const FULL_PATCH_OPS = [
  ...CORE_PATCH_OPS,
  "moveRoom",
  "setSplit",
  "addOpening",
  "removeOpening",
  "setDimension",
  "clearDimension",
  "setDimensionRange",
  "addLevel",
  "setActiveLevel",
  "renameLevel",
] as const;

/**
 * The vocabulary offered to a provider when the active level is freeform (detached — see
 * Generator in types.ts). Every tree-shaped op (addRoom, resizeRoom, setSplit, dimension
 * pins, ...) assumes a generator tree to edit and would just fail against cells, so a
 * freeform level asks the model for less rather than let it guess at a rejected op.
 */
export const FREEFORM_PATCH_OPS = [
  "renameRoom",
  "addOpening",
  "removeOpening",
  "setBoundary",
  "setUnits",
  "addLevel",
  "setActiveLevel",
  "renameLevel",
] as const;

/**
 * Ops a person produces by dragging on the canvas (FR-7) or through level-management UI,
 * deliberately kept out of FULL_PATCH_OPS. Geometry ops carry raw coordinates and ratios,
 * and the first design decision of the whole system is that the language model never emits
 * geometry (§1.2) — a model asked for a label position or an opening offset has no way to
 * know what is right. removeLevel/setLevelProps are precise/destructive-enough operations
 * that they stay a manual action too. They are listed here so the vocabulary stays
 * enumerable in one place (INF-7).
 */
export const USER_ONLY_PATCH_OPS = [
  "moveOpening",
  "setOpeningSwing",
  "setLabelAnchor",
  "detachGenerator",
  "reattachGenerator",
  "setRoomRects",
  "removeLevel",
  "setLevelProps",
  "importLevel",
] as const;

// Every op name that can legally reach validateOp: the `allowed` set passed in is always
// FULL_PATCH_OPS, FREEFORM_PATCH_OPS, or the CORE_PATCH_OPS subset of FULL. USER_ONLY_PATCH_OPS
// never appears here — those ops are constructed directly by client code (dragPlan.ts etc.)
// and applied without going through provider-response validation at all.
export type OpName = (typeof FULL_PATCH_OPS)[number] | (typeof FREEFORM_PATCH_OPS)[number];

const ROOM_PROGRAMS = Object.keys(ROOM_PROGRAM_MIN_DIMENSIONS) as RoomProgram[];

export type ValidateResult = { ok: true; patch: Patch } | { ok: false; error: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateOp(raw: unknown, allowed: ReadonlySet<string>): PatchOp | string {
  if (typeof raw !== "object" || raw === null) return "op entry is not an object";
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (typeof op !== "string") return "op entry missing string 'op' field";
  if (!allowed.has(op)) return `op '${op}' is not in the allowed vocabulary for this tier`;

  switch (op as OpName) {
    case "addRoom": {
      if (typeof o.program !== "string" || !ROOM_PROGRAMS.includes(o.program as RoomProgram)) {
        return `addRoom: unknown program '${String(o.program)}'`;
      }
      // areaWeight is a ratio between sibling rooms, not a dimension the user asked for,
      // so a model omitting it is not a reason to fail the turn — fall back to the
      // program's default rather than rejecting an otherwise well-formed op.
      const areaWeight =
        isFiniteNumber(o.areaWeight) && o.areaWeight > 0 ? o.areaWeight : DEFAULT_AREA_WEIGHT[o.program as RoomProgram];
      if (o.name !== undefined && typeof o.name !== "string") return "addRoom: name must be a string";
      if (o.adjacentTo !== undefined && typeof o.adjacentTo !== "string") return "addRoom: adjacentTo must be a string";
      if (o.roomId !== undefined && typeof o.roomId !== "string") return "addRoom: roomId must be a string";
      if (o.direction !== undefined && !SPATIAL_DIRECTIONS.includes(o.direction as SpatialDirection)) {
        return `addRoom: unknown direction '${String(o.direction)}'`;
      }
      // A direction without something to be relative to places nothing, so it is dropped
      // rather than failing the op — the room still gets added, just wherever it fits.
      return {
        op: "addRoom",
        program: o.program as RoomProgram,
        areaWeight,
        name: o.name as string | undefined,
        adjacentTo: o.adjacentTo as string | undefined,
        direction: o.adjacentTo ? (o.direction as SpatialDirection | undefined) : undefined,
        roomId: o.roomId as string | undefined,
      };
    }
    case "removeRoom": {
      if (!isNonEmptyString(o.roomId)) return "removeRoom: roomId is required";
      return { op: "removeRoom", roomId: o.roomId };
    }
    case "renameRoom": {
      if (!isNonEmptyString(o.roomId)) return "renameRoom: roomId is required";
      if (!isNonEmptyString(o.name)) return "renameRoom: name is required";
      return { op: "renameRoom", roomId: o.roomId, name: o.name };
    }
    case "resizeRoom": {
      if (!isNonEmptyString(o.roomId)) return "resizeRoom: roomId is required";
      if (o.areaWeight === undefined && o.targetAreaMm2 === undefined) {
        return "resizeRoom: one of areaWeight or targetAreaMm2 is required";
      }
      if (o.areaWeight !== undefined && !isFiniteNumber(o.areaWeight)) return "resizeRoom: areaWeight must be a number";
      if (o.targetAreaMm2 !== undefined && !isFiniteNumber(o.targetAreaMm2)) return "resizeRoom: targetAreaMm2 must be a number";
      return { op: "resizeRoom", roomId: o.roomId, areaWeight: o.areaWeight as number | undefined, targetAreaMm2: o.targetAreaMm2 as number | undefined };
    }
    case "swapRooms": {
      if (!isNonEmptyString(o.roomIdA) || !isNonEmptyString(o.roomIdB)) return "swapRooms: roomIdA and roomIdB are required";
      return { op: "swapRooms", roomIdA: o.roomIdA, roomIdB: o.roomIdB };
    }
    case "moveRoom": {
      if (!isNonEmptyString(o.roomId) || !isNonEmptyString(o.relativeTo)) return "moveRoom: roomId and relativeTo are required";
      if (!SPATIAL_DIRECTIONS.includes(o.direction as SpatialDirection)) return "moveRoom: invalid direction";
      return { op: "moveRoom", roomId: o.roomId, relativeTo: o.relativeTo, direction: o.direction as SpatialDirection };
    }
    case "setSplit": {
      if (!Array.isArray(o.nodePath) || !o.nodePath.every((n) => typeof n === "number")) {
        return "setSplit: nodePath must be an array of numbers";
      }
      return { op: "setSplit", nodePath: o.nodePath as number[], axis: o.axis as "h" | "v" | undefined, ratio: o.ratio as number | undefined };
    }
    case "addOpening": {
      if (!["door", "window", "cased", "pass-through"].includes(o.kind as string)) return "addOpening: invalid kind";
      if (!o.betweenRooms && !o.edgeId) return "addOpening: betweenRooms or edgeId is required";
      // offsetRatio and swing are reachable on this op from the canvas but are not
      // copied through from a provider: placement along the wall is geometry, and the
      // reducer's centred default is better than a number a model guessed.
      return {
        op: "addOpening",
        kind: o.kind as "door" | "window" | "cased" | "pass-through",
        betweenRooms: o.betweenRooms as [string, string] | undefined,
        edgeId: o.edgeId as string | undefined,
        width: o.width as number | undefined,
      };
    }
    case "removeOpening": {
      if (!isNonEmptyString(o.openingId)) return "removeOpening: openingId is required";
      return { op: "removeOpening", openingId: o.openingId };
    }
    case "setBoundary": {
      if (!isFiniteNumber(o.widthMm) || o.widthMm <= 0) return "setBoundary: widthMm must be a positive number";
      if (!isFiniteNumber(o.depthMm) || o.depthMm <= 0) return "setBoundary: depthMm must be a positive number";
      return { op: "setBoundary", widthMm: o.widthMm, depthMm: o.depthMm };
    }
    case "setUnits": {
      if (o.units !== "imperial" && o.units !== "metric") return "setUnits: units must be 'imperial' or 'metric'";
      return { op: "setUnits", units: o.units };
    }
    case "setDimension": {
      if (!isNonEmptyString(o.roomId)) return "setDimension: roomId is required";
      if (!["width", "depth", "area", "aspectRatio"].includes(o.dimensionType as string)) return "setDimension: invalid dimensionType";
      if (!isFiniteNumber(o.value)) return "setDimension: value must be a number";
      return { op: "setDimension", roomId: o.roomId, dimensionType: o.dimensionType as any, value: o.value, unit: o.unit as "ft" | "m" | undefined };
    }
    case "clearDimension": {
      if (!isNonEmptyString(o.roomId)) return "clearDimension: roomId is required";
      if (!["width", "depth", "area", "aspectRatio"].includes(o.dimensionType as string)) return "clearDimension: invalid dimensionType";
      return { op: "clearDimension", roomId: o.roomId, dimensionType: o.dimensionType as any };
    }
    case "setDimensionRange": {
      if (!isNonEmptyString(o.roomId)) return "setDimensionRange: roomId is required";
      if (!["width", "depth", "area", "aspectRatio"].includes(o.dimensionType as string)) return "setDimensionRange: invalid dimensionType";
      return {
        op: "setDimensionRange",
        roomId: o.roomId,
        dimensionType: o.dimensionType as any,
        minMm: o.minMm as number | undefined,
        maxMm: o.maxMm as number | undefined,
      };
    }
    case "addLevel": {
      if (o.name !== undefined && typeof o.name !== "string") return "addLevel: name must be a string";
      if (o.levelId !== undefined && typeof o.levelId !== "string") return "addLevel: levelId must be a string";
      if (o.copyFromLevelId !== undefined && typeof o.copyFromLevelId !== "string") return "addLevel: copyFromLevelId must be a string";
      return {
        op: "addLevel",
        levelId: o.levelId as string | undefined,
        name: o.name as string | undefined,
        copyFromLevelId: o.copyFromLevelId as string | undefined,
      };
    }
    case "setActiveLevel": {
      if (!isNonEmptyString(o.levelId)) return "setActiveLevel: levelId is required";
      return { op: "setActiveLevel", levelId: o.levelId };
    }
    case "renameLevel": {
      if (!isNonEmptyString(o.levelId)) return "renameLevel: levelId is required";
      if (!isNonEmptyString(o.name)) return "renameLevel: name is required";
      return { op: "renameLevel", levelId: o.levelId, name: o.name };
    }
    default:
      return `unhandled op '${op}'`;
  }
}

/**
 * Finds the ops array in a response that is *nearly* the agreed shape. Small models
 * reliably produce a handful of near misses — a bare op object, a bare array, the object
 * nested under `patch`, the key spelled `operations` — and rejecting those costs a repair
 * round trip (or the whole turn) over a rename we can do here for free. This only ever
 * relaxes where the ops live; every op inside is still validated exactly as before, so a
 * tolerated wrapper cannot smuggle in an op the tier isn't allowed to use.
 */
function findOpsArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // A single op returned on its own rather than wrapped in a one-element list.
  if (typeof r.op === "string") return [r];
  for (const key of ["ops", "operations", "patch", "result"]) {
    const value = r[key];
    if (Array.isArray(value)) return value;
    // `patch` and `result` usually hold the whole object, not the array — one level down.
    if (value && typeof value === "object") {
      const nested = findOpsArray(value);
      if (nested) return nested;
    }
  }
  return null;
}

export function validatePatchResponse(raw: unknown, allowedOps: readonly string[]): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "response is not a JSON object" };
  const ops_ = findOpsArray(raw);
  if (!ops_) return { ok: false, error: "response missing 'ops' array" };
  if (ops_.length === 0) return { ok: false, error: "response 'ops' array is empty" };
  const r = raw as Record<string, unknown>;

  const allowed = new Set(allowedOps);
  const ops: PatchOp[] = [];
  for (const entry of ops_) {
    const result = validateOp(entry, allowed);
    if (typeof result === "string") return { ok: false, error: result };
    ops.push(result);
  }

  const narration = typeof r.narration === "string" ? r.narration : undefined;
  return { ok: true, patch: { ops, narration, source: "provider" } };
}

/**
 * JSON Schema (subset) for structured/constrained decoding — T0-4.
 *
 * The `op` discriminator is written as a single-value `enum` rather than `const`: both say
 * the same thing, but `enum` is the one every constrained-decoding backend we go through
 * (Chrome's Prompt API, OpenRouter, the hosted vendors) actually compiles. A backend that
 * chokes on the schema falls back to unconstrained generation, which is where the
 * prose-wrapped answers that fail validation come from.
 */
export function buildPatchJsonSchema(allowedOps: readonly string[]): Record<string, unknown> {
  const opSchemas: Record<string, unknown> = {
    addRoom: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["addRoom"] },
        program: { type: "string", enum: ROOM_PROGRAMS },
        name: { type: "string" },
        areaWeight: { type: "number" },
        adjacentTo: { type: "string" },
        direction: { type: "string", enum: SPATIAL_DIRECTIONS },
      },
      required: ["op", "program"],
    },
    removeRoom: { type: "object", properties: { op: { type: "string", enum: ["removeRoom"] }, roomId: { type: "string" } }, required: ["op", "roomId"] },
    renameRoom: {
      type: "object",
      properties: { op: { type: "string", enum: ["renameRoom"] }, roomId: { type: "string" }, name: { type: "string" } },
      required: ["op", "roomId", "name"],
    },
    resizeRoom: {
      type: "object",
      properties: { op: { type: "string", enum: ["resizeRoom"] }, roomId: { type: "string" }, areaWeight: { type: "number" }, targetAreaMm2: { type: "number" } },
      required: ["op", "roomId"],
    },
    swapRooms: {
      type: "object",
      properties: { op: { type: "string", enum: ["swapRooms"] }, roomIdA: { type: "string" }, roomIdB: { type: "string" } },
      required: ["op", "roomIdA", "roomIdB"],
    },
    setBoundary: {
      type: "object",
      properties: { op: { type: "string", enum: ["setBoundary"] }, widthMm: { type: "number" }, depthMm: { type: "number" } },
      required: ["op", "widthMm", "depthMm"],
    },
    setUnits: {
      type: "object",
      properties: { op: { type: "string", enum: ["setUnits"] }, units: { type: "string", enum: ["imperial", "metric"] } },
      required: ["op", "units"],
    },
    addLevel: {
      type: "object",
      properties: { op: { type: "string", enum: ["addLevel"] }, name: { type: "string" }, copyFromLevelId: { type: "string" } },
      required: ["op"],
    },
    setActiveLevel: {
      type: "object",
      properties: { op: { type: "string", enum: ["setActiveLevel"] }, levelId: { type: "string" } },
      required: ["op", "levelId"],
    },
    renameLevel: {
      type: "object",
      properties: { op: { type: "string", enum: ["renameLevel"] }, levelId: { type: "string" }, name: { type: "string" } },
      required: ["op", "levelId", "name"],
    },
  };

  const included = allowedOps.map((name) => opSchemas[name]).filter(Boolean);

  return {
    type: "object",
    properties: {
      ops: { type: "array", items: { anyOf: included }, minItems: 1 },
      narration: { type: "string" },
    },
    required: ["ops"],
  };
}
