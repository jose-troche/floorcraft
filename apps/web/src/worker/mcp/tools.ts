// The MCP tool surface — specs.md §10.4.
//
// MCP-1: nothing here calls a model. Every tool is deterministic geometry, validation or
// export; the agent on the other end of the transport is the reasoning half, which is
// what makes this module free to run and free of the tier system entirely.
//
// MCP-2: every geometric decision is made by @floorcraft/core — the same solver,
// renderer, validator and exporters the browser runs. There is no Worker-side copy of
// any of it.

import {
  DEFAULT_AREA_WEIGHT,
  MM_PER_UNIT,
  FREEFORM_PATCH_OPS,
  FULL_PATCH_OPS,
  activeLevel,
  applyPatch,
  buildPlanSummary,
  createEmptyPlan,
  describeViolations,
  edgeLength,
  exportDxf,
  exportIfc,
  exportJson,
  formatArea,
  formatLength,
  renderSvg,
  sideOfRoom,
  validatePatchResponse,
  validatePlan,
  SPATIAL_DIRECTIONS,
  type PatchOp,
  type PlanDocument,
  type RoomProgram,
  type Units,
} from "@floorcraft/core";
import type { Env } from "../env";
import {
  MAX_ROOMS_PER_LEVEL,
  ToolError,
  openPlanArg,
  persist,
  toWireDoc,
  webUrl,
  type PlanHandle,
} from "./planIO";
import { DIMENSION_TYPES, OPENING_KINDS, ROOM_PROGRAMS, patchVocabulary, programTable } from "./vocabulary";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

export type ToolResult = { content: ContentBlock[]; isError?: boolean };

export type ToolContext = { env: Env; bearer: string | null; origin: string };

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Anything bigger is a download, not a conversation. Comfortably above a 40-room IFC. */
const MAX_INLINE_EXPORT_BYTES = 400_000;

/** A house-sized default (30 x 40 ft / 9 x 12 m) used as the floor for a fitted footprint. */
const DEFAULT_FOOTPRINT: Record<Units, { widthMm: number; depthMm: number }> = {
  imperial: { widthMm: 9144, depthMm: 12192 },
  metric: { widthMm: 9000, depthMm: 12000 },
};

/** The units a caller may state a length in. Conversion itself is core's (MM_PER_UNIT). */
const LENGTH_UNITS = ["ft", "m", "mm"] as const;
type LengthUnit = (typeof LENGTH_UNITS)[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ToolError(`\`${field}\` must be a non-empty string.`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`\`${field}\` must be a number.`);
  return value;
}

function toMm(value: number, unit: LengthUnit): number {
  return Math.round(value * MM_PER_UNIT[unit]);
}

function unitsOf(value: unknown): Units {
  if (value === undefined) return "imperial";
  if (value !== "imperial" && value !== "metric") throw new ToolError("`units` must be \"imperial\" or \"metric\".");
  return value;
}

function levelMode(doc: PlanDocument): "slicing" | "freeform" {
  return activeLevel(doc).generator?.kind === "freeform" ? "freeform" : "slicing";
}

function allowedOps(doc: PlanDocument): readonly string[] {
  return levelMode(doc) === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
}

function svgUri(doc: PlanDocument): string {
  return `floorcraft://plan/${doc.id}/${activeLevel(doc).id}.svg`;
}

/**
 * MCP-12: the drawing rides as an MCP resource so a host with inline widgets can display
 * the plan itself rather than a wall of markup. Hosts that do not render resources still
 * receive the SVG text, so nothing is lost on the ones that only read text.
 *
 * Only `render_svg` produces one. §10.4 lists `svg` among create_plan's and apply_patch's
 * outputs too, but at MCP-3's 40-room cap, rendering and serializing a 42 KB drawing
 * inside a call that is also solving the plan puts p99 within measurement noise of the
 * 7 ms ceiling (see test/mcp/budget.test.ts). MCP-4 names the mitigation — move
 * render_svg off the shared path rather than let the budget quietly slip — and this is
 * the smallest version of it: one call draws, and it is one call away.
 */
function svgBlock(doc: PlanDocument, options: Record<string, unknown> = {}): ContentBlock {
  return {
    type: "resource",
    resource: { uri: svgUri(doc), mimeType: "image/svg+xml", text: renderSvg(doc, options) },
  };
}

/** MCP-11: a sentence a person could read, in front of the structured payload. */
function reply(summary: string, data: unknown, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text: summary }, ...extra, { type: "text", text: JSON.stringify(data) }] };
}

function headline(doc: PlanDocument): string {
  const level = activeLevel(doc);
  const rooms = Object.keys(level.graph.rooms).length;
  const storey = doc.levels.length > 1 ? ` (level ${doc.levels.findIndex((l) => l.id === level.id) + 1} of ${doc.levels.length})` : "";
  return (
    `"${doc.title}" — ${formatLength(level.boundary.widthMm, doc.units)} x ${formatLength(level.boundary.depthMm, doc.units)} ` +
    `footprint, ${rooms} room${rooms === 1 ? "" : "s"} on "${level.name}"${storey}.`
  );
}

function roomLines(doc: PlanDocument): string[] {
  const summary = buildPlanSummary(doc);
  return summary.rooms.map(
    (room) => `  ${room.name} [${room.roomId}] — ${room.program}, ${formatArea(room.approxAreaMm2, doc.units)}${room.exterior ? "" : ", interior"}`,
  );
}

/** How a caller keeps working on this plan after the call returns (MCP-6's two modes). */
function continuation(handle: Pick<PlanHandle, "stored">, doc: PlanDocument, ctx: ToolContext): { text: string; data: Record<string, unknown> } {
  if (handle.stored) {
    return {
      text: `Saved. Open it in the web app: ${webUrl(ctx.origin, handle.stored.id, handle.stored.token)}`,
      data: { planId: handle.stored.id, webUrl: webUrl(ctx.origin, handle.stored.id, handle.stored.token) },
    };
  }
  return {
    text: "This plan is not saved anywhere: pass the `doc` below back to the next call to keep editing it.",
    data: { doc: toWireDoc(doc) },
  };
}

// ---------------------------------------------------------------------------
// create_plan (MCP-9: structured input only — turning a sentence into this is the
// calling agent's job, and is the entire reason this server needs no inference)
// ---------------------------------------------------------------------------

type RoomRequest = {
  program: RoomProgram;
  name?: string;
  id?: string;
  count?: number;
  areaWeight?: number;
  width?: number;
  depth?: number;
  adjacentTo?: string;
  direction?: "left" | "right" | "above" | "below" | "inside";
};

function readRoomRequests(raw: unknown): RoomRequest[] {
  if (!Array.isArray(raw)) throw new ToolError("`rooms` must be an array.");
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new ToolError(`rooms[${i}] must be an object.`);
    const room = entry as Record<string, unknown>;
    if (!ROOM_PROGRAMS.includes(room.program as RoomProgram)) {
      throw new ToolError(`rooms[${i}].program "${String(room.program)}" is not a known program. Call list_programs for the list.`);
    }
    const count = room.count === undefined ? 1 : num(room.count, `rooms[${i}].count`);
    if (!Number.isInteger(count) || count < 1) throw new ToolError(`rooms[${i}].count must be a positive integer.`);
    if (room.direction !== undefined && !SPATIAL_DIRECTIONS.includes(room.direction as never)) {
      throw new ToolError(`rooms[${i}].direction "${String(room.direction)}" is not one of ${SPATIAL_DIRECTIONS.join(", ")}.`);
    }
    // A pinned dimension attaches to a room id, and only an explicitly identified single
    // room has one before the reducer runs. Dropping the number silently would leave the
    // agent describing a size the plan never got.
    if ((room.width !== undefined || room.depth !== undefined) && !(typeof room.id === "string" && count === 1)) {
      throw new ToolError(
        `rooms[${i}] states a width or depth, so it needs its own \`id\` and a count of 1 for the size to attach to. ` +
          "Add the room without a size, then pin it with a setDimension op through apply_patch.",
      );
    }
    return {
      program: room.program as RoomProgram,
      name: room.name === undefined ? undefined : str(room.name, `rooms[${i}].name`),
      id: room.id === undefined ? undefined : str(room.id, `rooms[${i}].id`),
      count,
      areaWeight: room.areaWeight === undefined ? undefined : num(room.areaWeight, `rooms[${i}].areaWeight`),
      width: room.width === undefined ? undefined : num(room.width, `rooms[${i}].width`),
      depth: room.depth === undefined ? undefined : num(room.depth, `rooms[${i}].depth`),
      adjacentTo: room.adjacentTo === undefined ? undefined : str(room.adjacentTo, `rooms[${i}].adjacentTo`),
      direction: room.direction as RoomRequest["direction"],
    };
  });
}

function buildCreateOps(rooms: RoomRequest[], unit: LengthUnit): PatchOp[] {
  const ops: PatchOp[] = [];
  const dimensionOps: PatchOp[] = [];
  let total = 0;

  for (const room of rooms) {
    const count = room.count ?? 1;
    for (let i = 0; i < count; i++) {
      total++;
      if (total > MAX_ROOMS_PER_LEVEL) {
        throw new ToolError(`This server caps a level at ${MAX_ROOMS_PER_LEVEL} rooms (MCP-3); the request asks for more.`);
      }
      // An explicit id is honoured only for a single room — a count of three cannot all
      // be called "kitchen", and silently suffixing the caller's id would give it back
      // ids it did not choose. Auto-allocated ids come back in the response either way.
      const roomId = room.id && count === 1 ? room.id : undefined;
      const name = room.name === undefined ? undefined : count > 1 ? `${room.name} ${i + 1}` : room.name;
      ops.push({
        op: "addRoom",
        program: room.program,
        areaWeight: room.areaWeight ?? DEFAULT_AREA_WEIGHT[room.program],
        ...(roomId ? { roomId } : {}),
        ...(name ? { name } : {}),
        ...(room.adjacentTo ? { adjacentTo: room.adjacentTo, ...(room.direction ? { direction: room.direction } : {}) } : {}),
      });
      // Dimensions are pinned against the id the reducer allocates, so they can only be
      // written once the ids are known — for anything but an explicitly identified single
      // room that means after the fact, which is why they are collected separately.
      if (roomId && room.width !== undefined) {
        dimensionOps.push({ op: "setDimension", roomId, dimensionType: "width", value: toMm(room.width, unit) });
      }
      if (roomId && room.depth !== undefined) {
        dimensionOps.push({ op: "setDimension", roomId, dimensionType: "depth", value: toMm(room.depth, unit) });
      }
    }
  }
  return [...ops, ...dimensionOps];
}

/** 15% slack over the tight minimum, for circulation, rounded to a tidy 100 mm. */
function withSlack(mm: number): number {
  return Math.ceil((mm * 1.15) / 100) * 100;
}

function describeFailure(result: { ok: false; errors: string[]; violations?: { message: string }[] }): string {
  const reasons = [...result.errors, ...(result.violations ?? []).map((v) => v.message)];
  return reasons.length > 0 ? reasons.join(" ") : "The plan could not be built.";
}

async function createPlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const units = unitsOf(args.units);
  const title = args.title === undefined ? "Untitled Plan" : str(args.title, "title");
  const rooms = readRoomRequests(args.rooms ?? []);
  const footprint = args.footprint as Record<string, unknown> | undefined;
  const unit: LengthUnit = footprint?.unit
    ? (str(footprint.unit, "footprint.unit") as LengthUnit)
    : units === "imperial"
      ? "ft"
      : "m";
  if (!LENGTH_UNITS.includes(unit)) throw new ToolError('`footprint.unit` must be "ft", "m" or "mm".');

  // Writing into a saved plan is authorized before anything is built, so a caller with
  // the wrong token is told so instead of being handed geometry it cannot store. Only the
  // destination is wanted here, not the plan being replaced.
  let handle: Pick<PlanHandle, "stored"> = { stored: null };
  if (args.planId !== undefined) {
    handle = { stored: (await openPlanArg(ctx.env, { planId: args.planId }, ctx.bearer)).stored };
    if (!handle.stored?.canWrite) throw new ToolError("That token opens the plan read-only. Creating into it needs its edit token.");
  }

  const stated = footprint
    ? { widthMm: toMm(num(footprint.width, "footprint.width"), unit), depthMm: toMm(num(footprint.depth, "footprint.depth"), unit) }
    : null;

  const planId = handle.stored?.id ?? crypto.randomUUID();
  const ops = buildCreateOps(rooms, unit);
  const build = (boundary: { widthMm: number; depthMm: number }) => {
    const empty = createEmptyPlan({ id: planId, title, units, boundary });
    return ops.length === 0 ? { ok: true as const, doc: empty } : applyPatch(empty, { ops, source: "provider" });
  };

  // Laid out against the default footprint first. When the rooms do not fit, the solver
  // refuses before it builds any geometry and says exactly how much space they need, so
  // the retry is the *only* full solve either way — MCP-3's "prefer patch-application
  // over full regeneration", applied to the one place that would otherwise solve twice
  // just to size the outer wall.
  let attempt = build(stated ?? DEFAULT_FOOTPRINT[units]);
  if (!attempt.ok) {
    const needed = attempt.violations?.find((v) => v.reason === "boundary-too-small")?.requiredMm;
    if (stated || !needed) {
      throw new ToolError(
        `${describeFailure(attempt)}${stated ? " Try a larger `footprint`, or leave it out and one will be fitted to the rooms." : ""}`,
      );
    }
    attempt = build({ widthMm: withSlack(needed.widthMm), depthMm: withSlack(needed.depthMm) });
    if (!attempt.ok) throw new ToolError(describeFailure(attempt));
  }
  const doc = attempt.doc;

  await persist(ctx.env, handle, doc);

  const next = continuation(handle, doc, ctx);
  const validation = validatePlan(doc);
  const text = [
    `Created ${headline(doc)}`,
    ...roomLines(doc),
    describeViolations(validation),
    next.text,
    "Call render_svg to draw it.",
  ].join("\n");

  return reply(text, { summary: buildPlanSummary(doc), validation, ...next.data });
}

// ---------------------------------------------------------------------------
// describe_plan
// ---------------------------------------------------------------------------

/**
 * Exterior wall segments, by room and compass-free side. `addOpening` needs an `edgeId`
 * to hang a front door on, and the PlanSummary digest (INF-2) carries no edge ids — so
 * without this list an agent can add interior doors but can never let anyone in.
 */
function exteriorWalls(doc: PlanDocument): Array<{ roomId: string; roomName: string; side: string; edgeId: string; lengthMm: number }> {
  const graph = activeLevel(doc).graph;
  const walls: Array<{ roomId: string; roomName: string; side: string; edgeId: string; lengthMm: number }> = [];
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    for (const edgeId of room.boundary) {
      if (graph.edges[edgeId]?.type !== "exterior") continue;
      walls.push({
        roomId,
        roomName: room.name,
        side: sideOfRoom(graph, roomId, edgeId) ?? "unknown",
        edgeId,
        lengthMm: Math.round(edgeLength(graph, edgeId)),
      });
    }
  }
  return walls;
}

function openingList(doc: PlanDocument): Array<Record<string, unknown>> {
  const level = activeLevel(doc);
  const graph = level.graph;
  return (level.openings ?? []).map((opening) => ({
    openingId: opening.id,
    kind: opening.kind,
    widthMm: opening.width,
    ...(opening.anchor.kind === "between"
      ? { betweenRooms: opening.anchor.rooms, betweenNames: opening.anchor.rooms.map((id) => graph.rooms[id]?.name ?? id) }
      : { roomId: opening.anchor.roomId, roomName: graph.rooms[opening.anchor.roomId]?.name ?? opening.anchor.roomId, side: opening.anchor.side }),
  }));
}

function describePayload(doc: PlanDocument) {
  const level = activeLevel(doc);
  return {
    summary: buildPlanSummary(doc),
    mode: levelMode(doc),
    allowedOps: allowedOps(doc),
    activeLevelId: level.id,
    levels: doc.levels.map((l) => ({
      levelId: l.id,
      name: l.name,
      active: l.id === level.id,
      rooms: Object.keys(l.graph.rooms).length,
      elevationMm: l.elevation,
    })),
    exteriorWalls: exteriorWalls(doc),
    openings: openingList(doc),
  };
}

async function describePlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const handle = await openPlanArg(ctx.env, args, ctx.bearer);
  const doc = handle.doc;
  const payload = describePayload(doc);
  const adjacency = payload.summary.adjacencies.length;
  const text = [
    headline(doc),
    ...roomLines(doc),
    `${adjacency} room${adjacency === 1 ? " shares a wall" : "s share walls"}; ${payload.openings.length} opening(s) placed; layout mode: ${payload.mode}.`,
    payload.mode === "freeform"
      ? "This level was edited directly, so it has no layout tree — only the freeform ops apply."
      : "Ops available: " + payload.allowedOps.join(", "),
  ].join("\n");
  return reply(text, payload);
}

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

/**
 * Whether the patch needs the plan's *previous* wall graph to be resolvable. Only one op
 * does: `addOpening` given an explicit `edgeId`, which names an edge of the graph as it
 * stood. Everything else in the vocabulary is expressed against rooms and the generator,
 * which survive transport intact.
 */
function patchNeedsPriorGraph(raw: unknown): boolean {
  const ops = (raw as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return true; // Unrecognisable shape: rebuild and let validation speak.
  return ops.some((op) => {
    if (typeof op !== "object" || op === null) return false;
    const o = op as Record<string, unknown>;
    return o.op === "addOpening" && typeof o.edgeId === "string";
  });
}

async function applyPatchTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (args.patch === undefined) throw new ToolError("`patch` is required: {\"ops\": [ ... ]}.");
  const handle = await openPlanArg(ctx.env, args, ctx.bearer, { rebuild: patchNeedsPriorGraph(args.patch) });
  const doc = handle.doc;

  // INF-4 all over again: the same validator the client runs over provider output. An
  // agent is a provider that happens to be on the other side of the transport, and it
  // gets no more trust here than one embedded in the app does.
  const validated = validatePatchResponse(args.patch, allowedOps(doc));
  if (!validated.ok) {
    throw new ToolError(
      `That patch was rejected: ${validated.error}. Ops allowed on this level: ${allowedOps(doc).join(", ")}.`,
    );
  }

  const result = applyPatch(doc, validated.patch);
  // "the ops were fine but the geometry is not" still means nothing changed, and an agent
  // told its patch "applied" will narrate an edit that did not happen.
  if (!result.ok) throw new ToolError(`That patch was not applied and the plan is unchanged: ${describeFailure(result)}`);

  await persist(ctx.env, handle, result.doc);

  const next = continuation(handle, result.doc, ctx);
  const validation = validatePlan(result.doc);
  const warnings = (result.warnings ?? []).map((w) => w.message);
  const text = [
    result.changes.length > 0 ? result.changes.join(", ") : "The patch applied but changed nothing visible.",
    headline(result.doc),
    ...roomLines(result.doc),
    ...warnings,
    describeViolations(validation),
    next.text,
  ].join("\n");

  return reply(text, { changes: result.changes, warnings, summary: buildPlanSummary(result.doc), validation, ...next.data });
}

// ---------------------------------------------------------------------------
// validate_plan / render_svg / export_plan / list_programs
// ---------------------------------------------------------------------------

async function validatePlanTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const handle = await openPlanArg(ctx.env, args, ctx.bearer);
  const validation = validatePlan(handle.doc);
  const text = [`${headline(handle.doc)}`, validation.valid ? "Valid." : "Not valid yet.", describeViolations(validation)].join("\n");
  return reply(text, validation);
}

async function renderSvgTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const handle = await openPlanArg(ctx.env, args, ctx.bearer);
  const doc = handle.doc;
  const options = (args.options ?? {}) as Record<string, unknown>;
  const render = {
    showDimensions: options.showDimensions !== false,
    showLegend: options.showLegend !== false,
    ...(options.targetWidthPx !== undefined ? { targetWidthPx: num(options.targetWidthPx, "options.targetWidthPx") } : {}),
  };
  const block = svgBlock(doc, render);
  const svg = block.type === "resource" ? block.resource.text : "";
  return {
    content: [
      { type: "text", text: `${headline(doc)}\nSVG attached as ${svgUri(doc)} (${svg.length} bytes).` },
      block,
    ],
  };
}

const EXPORT_FORMATS = {
  json: { mimeType: "application/json", extension: "json", render: (doc: PlanDocument) => exportJson(doc) },
  svg: { mimeType: "image/svg+xml", extension: "svg", render: (doc: PlanDocument) => renderSvg(doc) },
  dxf: { mimeType: "image/vnd.dxf", extension: "dxf", render: (doc: PlanDocument) => exportDxf(doc) },
  ifc: { mimeType: "application/x-step", extension: "ifc", render: (doc: PlanDocument) => exportIfc(doc) },
} as const;

async function exportPlanTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const format = str(args.format, "format") as keyof typeof EXPORT_FORMATS;
  const spec = EXPORT_FORMATS[format];
  if (!spec) {
    throw new ToolError(
      `\`format\` must be one of ${Object.keys(EXPORT_FORMATS).join(", ")}. PDF and glTF are binary and stay in the web app — ` +
        "open the plan's share URL and export there.",
    );
  }
  const handle = await openPlanArg(ctx.env, args, ctx.bearer);
  const text = spec.render(handle.doc);
  if (text.length > MAX_INLINE_EXPORT_BYTES) {
    throw new ToolError(`That export is ${text.length} bytes, past this server's ${MAX_INLINE_EXPORT_BYTES}-byte inline limit. Export it from the web app instead.`);
  }
  const filename = `${handle.doc.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plan"}.${spec.extension}`;
  return {
    content: [
      { type: "text", text: `${format.toUpperCase()} export of ${headline(handle.doc)} — ${text.length} bytes, attached as ${filename}.` },
      { type: "resource", resource: { uri: `floorcraft://plan/${handle.doc.id}/${filename}`, mimeType: spec.mimeType, text } },
    ],
  };
}

async function listPrograms(): Promise<ToolResult> {
  const programs = programTable();
  const text = [
    "Room programs and the clearances the solver enforces (millimetres):",
    ...programs.map((p) => `  ${p.program} — min ${p.minWidthMm} x ${p.minDepthMm}, default areaWeight ${p.defaultAreaWeight}`),
  ].join("\n");
  return reply(text, { programs, openingKinds: OPENING_KINDS, dimensionTypes: DIMENSION_TYPES });
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const PLAN_SOURCE_PROPERTIES = {
  planId: {
    type: "string",
    description: "Id of a saved plan. Requires the plan's token as an Authorization: Bearer header.",
  },
  doc: {
    type: "object",
    description: "A plan document returned by an earlier call, for working without saving anything.",
  },
} as const;

const PLAN_SOURCE_NOTE =
  "Give exactly one of `planId` (a saved plan; send its token as `Authorization: Bearer <token>`) or `doc` " +
  "(the document a previous call returned — nothing is persisted in that mode).";

export const TOOLS: ToolDefinition[] = [
  {
    name: "create_plan",
    title: "Create a floor plan",
    description:
      "Builds a floor plan from a structured room programme and returns its summary. Call render_svg to draw it. " +
      "Takes structure, not prose: you decide what rooms the user's sentence means and describe them here. " +
      "Room sizing is relative (areaWeight) unless you state real dimensions; leave `footprint` out and one is fitted to the rooms. " +
      `A level holds at most ${MAX_ROOMS_PER_LEVEL} rooms. ` +
      "With a `planId` and its edit token the new plan replaces that saved plan's contents; without one, nothing is stored and " +
      "the returned `doc` is what you pass to the next call.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title; shown in the app and used for export filenames." },
        units: { type: "string", enum: ["imperial", "metric"], description: "Display units. Default imperial." },
        footprint: {
          type: "object",
          description: "Outer boundary of the level. Omit to fit one around the requested rooms.",
          properties: {
            width: { type: "number" },
            depth: { type: "number" },
            unit: { type: "string", enum: LENGTH_UNITS, description: "Default ft for imperial plans, m for metric." },
          },
          required: ["width", "depth"],
        },
        rooms: {
          type: "array",
          description: "The room programme. Order matters only through `adjacentTo`.",
          items: {
            type: "object",
            properties: {
              program: { type: "string", enum: ROOM_PROGRAMS, description: "What kind of room; sets its minimum clearances." },
              name: { type: "string", description: "Display name. With count > 1 it is numbered." },
              id: { type: "string", description: "Stable room id to use in later patches. Honoured only when count is 1." },
              count: { type: "integer", minimum: 1, description: "How many of this room. Default 1." },
              areaWeight: { type: "number", description: "Size relative to sibling rooms, not an area. Defaults per program." },
              width: { type: "number", description: "Exact width in `footprint.unit`. Needs `id`." },
              depth: { type: "number", description: "Exact depth in `footprint.unit`. Needs `id`." },
              adjacentTo: { type: "string", description: "Room id this one should sit next to." },
              direction: { type: "string", enum: ["left", "right", "above", "below", "inside"] },
            },
            required: ["program"],
          },
        },
        planId: { type: "string", description: "Replace this saved plan's contents. Requires its edit token as a bearer token." },
      },
      required: ["rooms"],
    },
  },
  {
    name: "describe_plan",
    title: "Describe a plan",
    description:
      "Returns the plan digest: rooms with ids, programs and areas, which rooms share walls, the level list, every exterior " +
      "wall segment with its edgeId (what `addOpening` needs for a front door), and the openings already placed. " +
      "Call this before patching a plan you did not just build. " +
      PLAN_SOURCE_NOTE,
    inputSchema: { type: "object", properties: { ...PLAN_SOURCE_PROPERTIES } },
  },
  {
    name: "apply_patch",
    title: "Edit a plan",
    description:
      "Applies an ordered list of edit operations and re-solves the geometry, returning the updated summary. Ops are " +
      "all-or-nothing: one bad op rejects the patch and leaves the plan untouched.\n\n" +
      patchVocabulary("slicing") +
      "\n\nA level whose geometry was edited directly on the canvas (mode \"freeform\") accepts only: " +
      FREEFORM_PATCH_OPS.join(", ") +
      ". describe_plan reports the mode and the ops allowed.\n\n" +
      PLAN_SOURCE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        ...PLAN_SOURCE_PROPERTIES,
        patch: {
          type: "object",
          description: 'The patch: {"ops":[...],"narration"?:"one sentence for the user"}.',
          properties: {
            ops: { type: "array", items: { type: "object" } },
            narration: { type: "string" },
          },
          required: ["ops"],
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "validate_plan",
    title: "Validate a plan",
    description:
      "Checks the active level for rooms below their program's minimum dimensions, rooms no exterior door can reach, and a " +
      "level with no way in or out. Returns {valid, violations[]}; a plan with no doors yet is reported but still valid. " +
      PLAN_SOURCE_NOTE,
    inputSchema: { type: "object", properties: { ...PLAN_SOURCE_PROPERTIES } },
  },
  {
    name: "render_svg",
    title: "Draw a plan",
    description:
      "Renders the active level to SVG and attaches it as a resource, for hosts that display images inline. " +
      PLAN_SOURCE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        ...PLAN_SOURCE_PROPERTIES,
        options: {
          type: "object",
          properties: {
            showDimensions: { type: "boolean", description: "Dimension strings around the plan. Default true." },
            showLegend: { type: "boolean", description: "Room colour legend. Default true." },
            targetWidthPx: { type: "number", description: "Rendered width in CSS pixels; height follows the footprint." },
          },
        },
      },
    },
  },
  {
    name: "export_plan",
    title: "Export a plan",
    description:
      "Returns the plan in an interchange format as inline text: `json` (Floorcraft's own, re-importable), `svg`, `dxf` " +
      "(AutoCAD/Revit/ArchiCAD), or `ifc` (IFC4 subset for BIM). PDF and glTF are binary and are exported from the web app. " +
      PLAN_SOURCE_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        ...PLAN_SOURCE_PROPERTIES,
        format: { type: "string", enum: Object.keys(EXPORT_FORMATS), description: "Which format to produce." },
      },
      required: ["format"],
    },
  },
  {
    name: "list_programs",
    title: "List room programs",
    description:
      "The room programs this server understands, each with the minimum width and depth the solver enforces and the default " +
      "relative area weight. Takes no arguments.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

const HANDLERS: Record<string, Handler> = {
  create_plan: createPlan,
  describe_plan: describePlan,
  apply_patch: applyPatchTool,
  validate_plan: validatePlanTool,
  render_svg: renderSvgTool,
  export_plan: exportPlanTool,
  list_programs: listPrograms,
};

export function isKnownTool(name: string): boolean {
  return name in HANDLERS;
}

/**
 * Runs one tool. A ToolError comes back as an errored *result* rather than a protocol
 * error, because the caller is a model that can usually fix its own argument if it is
 * told what was wrong (MCP-11's summary, in the failure case).
 */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: "text", text: `No tool named "${name}".` }], isError: true };
  try {
    return await handler(args, ctx);
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}
