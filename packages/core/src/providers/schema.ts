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
] as const;

/**
 * Ops a person produces by dragging on the canvas (FR-7), deliberately kept out of
 * FULL_PATCH_OPS. They carry raw coordinates and ratios, and the first design decision
 * of the whole system is that the language model never emits geometry (§1.2) — a model
 * asked for a label position or an opening offset has no way to know what is right.
 * They are listed here so the vocabulary stays enumerable in one place (INF-7).
 */
export const USER_ONLY_PATCH_OPS = ["moveOpening", "setOpeningSwing", "setLabelAnchor"] as const;

export type OpName = (typeof FULL_PATCH_OPS)[number];

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
    default:
      return `unhandled op '${op}'`;
  }
}

export function validatePatchResponse(raw: unknown, allowedOps: readonly string[]): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "response is not a JSON object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.ops)) return { ok: false, error: "response missing 'ops' array" };
  if (r.ops.length === 0) return { ok: false, error: "response 'ops' array is empty" };

  const allowed = new Set(allowedOps);
  const ops: PatchOp[] = [];
  for (const entry of r.ops) {
    const result = validateOp(entry, allowed);
    if (typeof result === "string") return { ok: false, error: result };
    ops.push(result);
  }

  const narration = typeof r.narration === "string" ? r.narration : undefined;
  return { ok: true, patch: { ops, narration, source: "provider" } };
}

/** JSON Schema (subset) for structured/constrained decoding — T0-4. */
export function buildPatchJsonSchema(allowedOps: readonly string[]): Record<string, unknown> {
  const opSchemas: Record<string, unknown> = {
    addRoom: {
      type: "object",
      properties: {
        op: { const: "addRoom" },
        program: { type: "string", enum: ROOM_PROGRAMS },
        name: { type: "string" },
        areaWeight: { type: "number" },
        adjacentTo: { type: "string" },
        direction: { type: "string", enum: SPATIAL_DIRECTIONS },
      },
      required: ["op", "program"],
    },
    removeRoom: { type: "object", properties: { op: { const: "removeRoom" }, roomId: { type: "string" } }, required: ["op", "roomId"] },
    renameRoom: {
      type: "object",
      properties: { op: { const: "renameRoom" }, roomId: { type: "string" }, name: { type: "string" } },
      required: ["op", "roomId", "name"],
    },
    resizeRoom: {
      type: "object",
      properties: { op: { const: "resizeRoom" }, roomId: { type: "string" }, areaWeight: { type: "number" }, targetAreaMm2: { type: "number" } },
      required: ["op", "roomId"],
    },
    swapRooms: {
      type: "object",
      properties: { op: { const: "swapRooms" }, roomIdA: { type: "string" }, roomIdB: { type: "string" } },
      required: ["op", "roomIdA", "roomIdB"],
    },
    setBoundary: {
      type: "object",
      properties: { op: { const: "setBoundary" }, widthMm: { type: "number" }, depthMm: { type: "number" } },
      required: ["op", "widthMm", "depthMm"],
    },
    setUnits: {
      type: "object",
      properties: { op: { const: "setUnits" }, units: { type: "string", enum: ["imperial", "metric"] } },
      required: ["op", "units"],
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
