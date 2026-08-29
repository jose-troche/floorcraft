// The patch vocabulary, written out for an agent — specs.md MCP-10: "Tool descriptions
// MUST document the patch vocabulary (INF-6) inline and completely, since the agent has
// no other schema source."
//
// The op names come from core (FULL_PATCH_OPS / FREEFORM_PATCH_OPS) and the descriptions
// are keyed by `OpName`, so adding an op to the vocabulary without documenting it here is
// a type error rather than a silently undocumented tool surface.

import {
  DEFAULT_AREA_WEIGHT,
  FREEFORM_PATCH_OPS,
  FULL_PATCH_OPS,
  ROOM_PROGRAM_MIN_DIMENSIONS,
  SPATIAL_DIRECTIONS,
  type OpName,
  type RoomProgram,
} from "@floorcraft/core";

export const ROOM_PROGRAMS = Object.keys(ROOM_PROGRAM_MIN_DIMENSIONS) as RoomProgram[];
export const OPENING_KINDS = ["door", "window", "cased", "pass-through"] as const;
export const DIMENSION_TYPES = ["width", "depth", "area", "aspectRatio"] as const;

/**
 * One line per op: the exact argument shape, and what it does to the plan. Deliberately
 * terse — this text ships inside every `tools/list` response, so it is read on every
 * session by a model paying for it in context.
 */
const PATCH_OP_DOCS: Record<OpName, string> = {
  addRoom:
    '{"op":"addRoom","program":<program>,"name"?:string,"roomId"?:string,"areaWeight"?:number,"adjacentTo"?:roomId,"direction"?:<direction>} — ' +
    "adds a room. areaWeight is a share relative to its siblings (not an area); omit it for the program default. " +
    "adjacentTo + direction place it next to an existing room. Pin real dimensions with a following setDimension op.",
  removeRoom: '{"op":"removeRoom","roomId":string} — deletes the room and any openings anchored to it.',
  renameRoom: '{"op":"renameRoom","roomId":string,"name":string} — renames a room; its id is unchanged.',
  resizeRoom:
    '{"op":"resizeRoom","roomId":string,"areaWeight"?:number,"targetAreaMm2"?:number} — ' +
    "one of the two is required. targetAreaMm2 is converted to the weight that gets closest; neighbours give up the difference.",
  swapRooms: '{"op":"swapRooms","roomIdA":string,"roomIdB":string} — exchanges two rooms\' positions, keeping each room\'s size.',
  moveRoom:
    '{"op":"moveRoom","roomId":string,"relativeTo":string,"direction":<direction>} — ' +
    "re-places a room next to another one. Every other room shifts to fill the space it left.",
  setSplit:
    '{"op":"setSplit","nodePath":number[],"axis"?:"h"|"v","ratio"?:number} — ' +
    "edits one split of the layout tree (nodePath is child indices from the root, as returned in generatorTree). " +
    "ratio is the fraction 0..1 given to children[0]. Use this to restructure; use resizeRoom for ordinary sizing.",
  addOpening:
    '{"op":"addOpening","kind":<opening>,"betweenRooms"?:[roomId,roomId],"edgeId"?:string,"width"?:mm} — ' +
    "adds a door or window. Give betweenRooms for an interior opening, or edgeId (from describe_plan's wall list) for an exterior one. " +
    "Position along the wall is chosen by the solver — openings are geometry and are not yours to place.",
  removeOpening: '{"op":"removeOpening","openingId":string} — removes one opening.',
  setBoundary:
    '{"op":"setBoundary","widthMm":number,"depthMm":number} — resizes the level\'s outer footprint. Rooms re-solve into it.',
  setUnits: '{"op":"setUnits","units":"imperial"|"metric"} — display units only; geometry is always stored in millimetres.',
  setDimension:
    '{"op":"setDimension","roomId":string,"dimensionType":<dimension>,"value":number,"unit"?:"ft"|"m"} — ' +
    "pins a dimension. Without `unit`, value is millimetres. A pin the layout cannot honour comes back as a warning, not a failure.",
  clearDimension: '{"op":"clearDimension","roomId":string,"dimensionType":<dimension>} — releases a pinned dimension.',
  setDimensionRange:
    '{"op":"setDimensionRange","roomId":string,"dimensionType":<dimension>,"minMm"?:number,"maxMm"?:number} — ' +
    "bounds a dimension instead of fixing it.",
  addLevel:
    '{"op":"addLevel","name"?:string,"levelId"?:string,"copyFromLevelId"?:string} — ' +
    "adds a storey and makes it active. copyFromLevelId duplicates an existing level's layout.",
  setActiveLevel:
    '{"op":"setActiveLevel","levelId":string} — ' +
    "switches which level the other ops (and describe_plan, render_svg, validate_plan) work on.",
  renameLevel: '{"op":"renameLevel","levelId":string,"name":string} — renames a storey.',
};

function enumLine(name: string, values: readonly string[]): string {
  return `<${name}>: ${values.join(" | ")}`;
}

/**
 * The complete vocabulary text for a level in the given mode.
 *
 * A freeform level (one whose geometry came from a canvas drag or a raster import) has no
 * layout tree left to restructure, so it is offered a smaller set — the same split core
 * makes for on-device and hosted providers. Asking for an op the level cannot take is a
 * rejected patch, so the list has to be mode-accurate rather than aspirational.
 */
export function patchVocabulary(mode: "slicing" | "freeform"): string {
  const ops = mode === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
  const lines = ops.map((op) => `- ${PATCH_OP_DOCS[op]}`);
  return [
    `A patch is {"ops":[...],"narration"?:string}. Ops apply in order; if any op is rejected the whole patch is,`,
    `and the plan is left exactly as it was.`,
    mode === "freeform"
      ? "This level is FREEFORM (its geometry was edited directly), so only these ops apply:"
      : "Ops available on this level:",
    ...lines,
    "",
    enumLine("program", ROOM_PROGRAMS),
    enumLine("direction", SPATIAL_DIRECTIONS),
    enumLine("opening", OPENING_KINDS),
    enumLine("dimension", DIMENSION_TYPES),
  ].join("\n");
}

/** Room programs with the clearances the solver enforces, for `list_programs`. */
export function programTable(): Array<{
  program: RoomProgram;
  minWidthMm: number;
  minDepthMm: number;
  defaultAreaWeight: number;
}> {
  return ROOM_PROGRAMS.map((program) => ({
    program,
    minWidthMm: ROOM_PROGRAM_MIN_DIMENSIONS[program].minWidth,
    minDepthMm: ROOM_PROGRAM_MIN_DIMENSIONS[program].minDepth,
    defaultAreaWeight: DEFAULT_AREA_WEIGHT[program],
  }));
}
