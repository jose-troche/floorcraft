// Deterministic dimension parsing — specs.md §5.5 (DIM-1..DIM-7), FR-2.
//
// This runs before intent matching and before any provider is invoked (DIM-5), because
// a dimension the user stated is a fact, not a suggestion: "kitchen 4x5 feet" has one
// correct reading, and asking a model to re-derive it can only make it worse. What is
// left of the utterance afterwards is what the model is asked about.
//
// Everything leaves here in canonical integer millimetres (DM-4, SLV-9).

import { activeLevel } from "./patch.js";
import { solveSlicingTree } from "./slicingSolver.js";
import { generatorTree, type DimensionType, type PatchOp, type PlanDocument, type RoomId, type Units } from "./types.js";

const MM_PER_FOOT = 304.8;
const MM_PER_INCH = 25.4;
const MM_PER_METRE = 1000;
const MM2_PER_SQ_FOOT = 92903.04;

export type ParsedUnit = "ft" | "m" | "in" | "cm" | "mm";

export type DimensionWarning = {
  /** The fragment the warning is about, quoted back so the UI can show what it read. */
  fragment: string;
  message: string;
};

export type DimensionParseResult = {
  ops: PatchOp[];
  /** Human-readable account of what was pinned, for the change summary (FR-4). */
  applied: string[];
  /**
   * What is left of the utterance once the dimension clauses are removed. Empty when the
   * whole turn was dimensions; otherwise this is what the provider is asked about (DIM-4).
   */
  remainder: string;
  warnings: DimensionWarning[];
};

const UNIT_WORDS: Record<string, ParsedUnit> = {
  ft: "ft",
  foot: "ft",
  feet: "ft",
  "'": "ft",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
  m: "m",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  cm: "cm",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  mm: "mm",
  millimeter: "mm",
  millimeters: "mm",
  millimetre: "mm",
  millimetres: "mm",
};

// Longest alternatives first so "mm" is never read as "m" with a stray letter left over.
export const UNIT_PATTERN =
  "(?:ft|foot|feet|'|inches|inch|in|\"|millimet(?:er|re)s?|mm|centimet(?:er|re)s?|cm|met(?:er|re)s?|m)";
export const NUMBER = "\\d+(?:\\.\\d+)?";
export const CROSS = "(?:x|×|by)";

export function toMm(value: number, unit: ParsedUnit): number {
  switch (unit) {
    case "ft":
      return Math.round(value * MM_PER_FOOT);
    case "in":
      return Math.round(value * MM_PER_INCH);
    case "cm":
      return Math.round(value * 10);
    case "mm":
      return Math.round(value);
    default:
      return Math.round(value * MM_PER_METRE);
  }
}

function normalizeUnit(word: string | undefined): ParsedUnit | null {
  if (!word) return null;
  return UNIT_WORDS[word.toLowerCase()] ?? null;
}

/** DIM-3: an explicit unit always wins; otherwise the plan's own unit system is assumed. */
export function unitFor(explicit: string | undefined, units: Units): { unit: ParsedUnit; assumed: boolean } {
  const parsed = normalizeUnit(explicit);
  if (parsed) return { unit: parsed, assumed: false };
  return { unit: units === "metric" ? "m" : "ft", assumed: true };
}

/** Rooms by name, longest name first so "master bath" is preferred over "bath". */
function roomIndex(doc: PlanDocument): Array<{ roomId: RoomId; name: string; normalized: string }> {
  const level = activeLevel(doc);
  return Object.entries(level.graph.rooms)
    .map(([roomId, room]) => ({ roomId, name: room.name, normalized: normalize(room.name) }))
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findRoom(index: ReturnType<typeof roomIndex>, text: string): { roomId: RoomId; name: string } | null {
  const needle = normalize(text);
  if (!needle) return null;
  for (const entry of index) {
    if (needle === entry.normalized || needle.endsWith(entry.normalized) || needle.includes(entry.normalized)) {
      return { roomId: entry.roomId, name: entry.name };
    }
  }
  return null;
}

type Clause = { text: string; start: number; end: number };

/**
 * A clause asking for a room to be created. Creation is the intent matcher's job (or the
 * provider's), including any dimensions it carries: "add a closet 3x4 ft" must build a
 * new closet, and letting a dimension matcher have it first would instead re-pin an
 * existing room that happened to be called Closet.
 */
const CREATION_CLAUSE = /^\s*(?:please\s+)?(?:add|create|insert|put|make\s+(?:me\s+)?(?:a|an)\b)/i;

/**
 * Splits an utterance into clauses on commas, semicolons and "and", keeping each one's
 * exact span in the original string so the unmatched remainder can be reconstructed
 * verbatim rather than re-joined with invented punctuation.
 */
function clauses(utterance: string): Clause[] {
  const out: Clause[] = [];
  const separator = /\s*(?:,|;|\band\b)\s*/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(utterance))) {
    out.push({ text: utterance.slice(cursor, match.index), start: cursor, end: match.index });
    cursor = match.index + match[0]!.length;
  }
  out.push({ text: utterance.slice(cursor), start: cursor, end: utterance.length });
  return out.filter((c) => c.text.trim().length > 0);
}

/** Rebuilds the utterance with the consumed spans cut out, then tidies dangling separators. */
function remainderAfter(utterance: string, consumed: Array<{ start: number; end: number }>): string {
  const ordered = [...consumed].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start > cursor) out += utterance.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  out += utterance.slice(cursor);
  return out
    .replace(/\s+/g, " ")
    .replace(/^(?:\s|,|;|\band\b)+/i, "")
    .replace(/(?:\s|,|;|\band\b)+$/i, "")
    .trim();
}

type Matcher = (clause: Clause, context: Context) => { ops: PatchOp[]; applied: string[] } | null;

type Context = {
  doc: PlanDocument;
  rooms: ReturnType<typeof roomIndex>;
  warnings: DimensionWarning[];
};

function describe(name: string, type: DimensionType, mm: number, units: Units): string {
  const shown = units === "metric" ? `${(mm / 1000).toFixed(2)} m` : `${(mm / MM_PER_FOOT).toFixed(1)} ft`;
  return `${name} ${type} pinned to ${shown}`;
}

/** "kitchen [is] 4x5 feet" / "master suite 16 by 20" — width x depth. */
const matchWidthByDepth: Matcher = (clause, ctx) => {
  const pattern = new RegExp(
    `^(.*?)(?:\\s+(?:is|are|must be|should be|to be))?\\s*(?:exactly\\s+)?(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*${CROSS}\\s*(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*$`,
    "i",
  );
  const m = pattern.exec(clause.text.trim());
  if (!m) return null;
  const room = findRoom(ctx.rooms, m[1]!);
  if (!room) return null;

  // "4x5 feet" states the unit once, at the end, for both numbers.
  const trailing = m[5] ?? m[3];
  const widthUnit = unitFor(m[3] ?? trailing, ctx.doc.units);
  const depthUnit = unitFor(trailing, ctx.doc.units);
  warnIfAssumed(ctx, clause, widthUnit.assumed || depthUnit.assumed);

  const widthMm = toMm(Number(m[2]), widthUnit.unit);
  const depthMm = toMm(Number(m[4]), depthUnit.unit);
  return {
    ops: [
      { op: "setDimension", roomId: room.roomId, dimensionType: "width", value: widthMm },
      { op: "setDimension", roomId: room.roomId, dimensionType: "depth", value: depthMm },
    ],
    applied: [
      describe(room.name, "width", widthMm, ctx.doc.units),
      describe(room.name, "depth", depthMm, ctx.doc.units),
    ],
  };
};

/** "master suite at least 16x20" — the same shape, but bounded rather than pinned. */
const matchRangeByDepth: Matcher = (clause, ctx) => {
  const pattern = new RegExp(
    `^(.*?)\\s*(?:is|must be|should be)?\\s*(at least|no less than|minimum(?: of)?|at most|no more than|maximum(?: of)?)\\s*(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*${CROSS}\\s*(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*$`,
    "i",
  );
  const m = pattern.exec(clause.text.trim());
  if (!m) return null;
  const room = findRoom(ctx.rooms, m[1]!);
  if (!room) return null;

  const isMin = /least|less|minimum/i.test(m[2]!);
  const trailing = m[6] ?? m[4];
  const unit = unitFor(trailing, ctx.doc.units);
  warnIfAssumed(ctx, clause, unit.assumed);
  const widthMm = toMm(Number(m[3]), unitFor(m[4] ?? trailing, ctx.doc.units).unit);
  const depthMm = toMm(Number(m[5]), unit.unit);

  return {
    ops: [
      { op: "setDimensionRange", roomId: room.roomId, dimensionType: "width", ...(isMin ? { minMm: widthMm } : { maxMm: widthMm }) },
      { op: "setDimensionRange", roomId: room.roomId, dimensionType: "depth", ...(isMin ? { minMm: depthMm } : { maxMm: depthMm }) },
    ],
    applied: [`${room.name} bounded to ${isMin ? "at least" : "at most"} ${m[3]}${CROSS_SYMBOL}${m[5]}`],
  };
};

const CROSS_SYMBOL = "×";

/** "living room at least 300 sq ft" / "bedroom no more than 20 m2". */
const matchArea: Matcher = (clause, ctx) => {
  const pattern = new RegExp(
    `^(.*?)\\s*(?:is|must be|should be|of)?\\s*(at least|no less than|minimum(?: of)?|at most|no more than|maximum(?: of)?|exactly)?\\s*(${NUMBER})\\s*(sq\\.?\\s*(?:ft|feet)|square\\s*(?:ft|feet)|sqft|m2|m²|sq\\.?\\s*m|square\\s*met(?:er|re)s?)\\s*$`,
    "i",
  );
  const m = pattern.exec(clause.text.trim());
  if (!m) return null;
  const room = findRoom(ctx.rooms, m[1]!);
  if (!room) return null;

  const metric = /m2|m²|m\b|met/i.test(m[4]!);
  const areaMm2 = Math.round(Number(m[3]) * (metric ? 1_000_000 : MM2_PER_SQ_FOOT));
  const bound = m[2]?.toLowerCase() ?? "";

  if (!bound || bound === "exactly") {
    return {
      ops: [{ op: "setDimension", roomId: room.roomId, dimensionType: "area", value: areaMm2 }],
      applied: [`${room.name} area pinned to ${m[3]} ${m[4]}`],
    };
  }
  const isMin = /least|less|minimum/.test(bound);
  return {
    ops: [
      { op: "setDimensionRange", roomId: room.roomId, dimensionType: "area", ...(isMin ? { minMm: areaMm2 } : { maxMm: areaMm2 }) },
    ],
    applied: [`${room.name} area ${isMin ? "at least" : "at most"} ${m[3]} ${m[4]}`],
  };
};

/** "make the hallway 3 feet wide" / "kitchen 12 ft deep". */
const matchSingleAxis: Matcher = (clause, ctx) => {
  const pattern = new RegExp(
    `^(?:make\\s+)?(.*?)\\s*(?:is|are|must be|should be)?\\s*(at least|no less than|minimum(?: of)?|at most|no more than|maximum(?: of)?|exactly)?\\s*(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*(wide|width|deep|depth|long|tall)\\s*$`,
    "i",
  );
  const m = pattern.exec(clause.text.trim());
  if (!m) return null;
  const room = findRoom(ctx.rooms, m[1]!);
  if (!room) return null;

  const unit = unitFor(m[4], ctx.doc.units);
  warnIfAssumed(ctx, clause, unit.assumed);
  const mm = toMm(Number(m[3]), unit.unit);
  const axis: DimensionType = /wide|width/i.test(m[5]!) ? "width" : "depth";
  const bound = m[2]?.toLowerCase() ?? "";

  if (!bound || bound === "exactly") {
    return {
      ops: [{ op: "setDimension", roomId: room.roomId, dimensionType: axis, value: mm }],
      applied: [describe(room.name, axis, mm, ctx.doc.units)],
    };
  }
  const isMin = /least|less|minimum/.test(bound);
  return {
    ops: [{ op: "setDimensionRange", roomId: room.roomId, dimensionType: axis, ...(isMin ? { minMm: mm } : { maxMm: mm }) }],
    applied: [`${room.name} ${axis} ${isMin ? "at least" : "at most"} ${m[3]}${m[4] ?? ""}`],
  };
};

const RELATIVE_VERB = "(increase|decrease|reduce|grow|shrink|expand)";
const RELATIVE_AXIS = "(width|depth|length|long)";
const RELATIVE_AMOUNT = `(${NUMBER})\\s*(%|percent|${UNIT_PATTERN})?`;

/** "increase the bedroom depth by 2 m" — the room named before the axis it owns. */
const RELATIVE_ROOM_FIRST = new RegExp(
  `^(?:please\\s+)?${RELATIVE_VERB}\\s+(?:the\\s+)?(.*?)\\s*(?:'s)?\\s*${RELATIVE_AXIS}\\s*(?:by)\\s*${RELATIVE_AMOUNT}\\s*$`,
  "i",
);

/**
 * "reduce the length of the kitchen by 2 meters" — the same request with the axis
 * fronted. Both readings are ordinary English and neither is more precise than the
 * other, so a parser that only understood one was sending the other to a model to
 * re-derive a length the user had already stated exactly (DIM-5).
 */
const RELATIVE_AXIS_FIRST = new RegExp(
  `^(?:please\\s+)?${RELATIVE_VERB}\\s+(?:the\\s+)?${RELATIVE_AXIS}\\s+of\\s+(?:the\\s+)?(.*?)\\s*(?:by)\\s*${RELATIVE_AMOUNT}\\s*$`,
  "i",
);

/**
 * "increase the bedroom depth by 2 meters", "increase office length by 30%", "reduce the
 * length of the kitchen by 2 m" — relative, so the current geometry is measured first and
 * the result pinned as an absolute value. A percentage scales the current dimension; a
 * length adds to it.
 */
const matchRelative: Matcher = (clause, ctx) => {
  const text = clause.text.trim();
  // Axis-first is tried first: its "<axis> of <room>" shape is the more specific of the
  // two, and room-first's lazy `(.*?)` would otherwise swallow "the length of the" as
  // the room name and then fail to find a room by it.
  const axisFirst = RELATIVE_AXIS_FIRST.exec(text);
  const m = axisFirst ?? RELATIVE_ROOM_FIRST.exec(text);
  if (!m) return null;
  // The two patterns differ only in which of groups 2/3 is the room and which the axis.
  const roomText = axisFirst ? m[3]! : m[2]!;
  const axisWord = axisFirst ? m[2]! : m[3]!;

  const room = findRoom(ctx.rooms, roomText);
  if (!room) return null;

  const rect = roomRectOf(ctx.doc, room.roomId);
  if (!rect) return null;
  // "length" and "long" describe the front-to-back extent, matching how matchSingleAxis
  // already reads "deep"/"long".
  const axis: "width" | "depth" = /^width$/i.test(axisWord) ? "width" : "depth";
  const current = axis === "width" ? rect.w : rect.d;
  const shrinking = /decrease|reduce|shrink/i.test(m[1]!);
  const amount = Number(m[4]);
  const suffix = m[5];

  let target: number;
  if (suffix && /^(%|percent)$/i.test(suffix)) {
    target = Math.round(current * (1 + (shrinking ? -1 : 1) * (amount / 100)));
  } else {
    const unit = unitFor(suffix, ctx.doc.units);
    warnIfAssumed(ctx, clause, unit.assumed);
    target = Math.round(current + toMm(amount, unit.unit) * (shrinking ? -1 : 1));
  }
  target = Math.max(target, 1);

  return {
    ops: [{ op: "setDimension", roomId: room.roomId, dimensionType: axis, value: target }],
    applied: [describe(room.name, axis, target, ctx.doc.units)],
  };
};

function roomRectOf(doc: PlanDocument, roomId: RoomId): { w: number; d: number } | null {
  const level = activeLevel(doc);
  const tree = generatorTree(level);
  if (!tree) return null;
  const solved = solveSlicingTree(tree, level.boundary, doc.gridModule);
  if (!solved.ok) return null;
  const leaf = solved.leaves.find((l) => l.roomId === roomId);
  return leaf ? { w: leaf.w, d: leaf.d } : null;
}

function warnIfAssumed(ctx: Context, clause: Clause, assumed: boolean): void {
  if (!assumed) return;
  ctx.warnings.push({
    fragment: clause.text.trim(),
    message: `No unit given — read as ${ctx.doc.units === "metric" ? "metres" : "feet"} to match the plan.`,
  });
}

// Order matters: the most specific shapes are tried first, so "at least 16x20" is not
// consumed by the plain "16x20" matcher with the bound silently dropped.
const MATCHERS: Matcher[] = [matchRelative, matchRangeByDepth, matchArea, matchSingleAxis, matchWidthByDepth];

/** DIM-1: extract every dimension constraint the utterance states, deterministically. */
export function parseDimensions(doc: PlanDocument, utterance: string): DimensionParseResult {
  const ctx: Context = { doc, rooms: roomIndex(doc), warnings: [] };
  const ops: PatchOp[] = [];
  const applied: string[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  for (const clause of clauses(utterance)) {
    if (CREATION_CLAUSE.test(clause.text)) continue;
    for (const matcher of MATCHERS) {
      const result = matcher(clause, ctx);
      if (!result) continue;
      ops.push(...result.ops);
      applied.push(...result.applied);
      consumed.push({ start: clause.start, end: clause.end });
      break;
    }
    // DIM-4: an unmatched fragment does not stop the parsed ones from applying; it is
    // simply left in the remainder and travels on to the provider.
  }

  return { ops, applied, remainder: remainderAfter(utterance, consumed), warnings: ctx.warnings };
}

export type ImpossibleConstraint = { roomIds: RoomId[]; message: string };

/**
 * DIM-6: catches a constraint that cannot be satisfied by geometry before the solver is
 * asked, so the user is told what to relax instead of being shown a solver failure.
 */
export function checkConstraintsPossible(doc: PlanDocument, ops: readonly PatchOp[]): ImpossibleConstraint | null {
  const level = activeLevel(doc);
  const boundary = level.boundary;

  for (const op of ops) {
    if (op.op !== "setDimension" && op.op !== "setDimensionRange") continue;
    const room = level.graph.rooms[op.roomId];
    const name = room?.name ?? op.roomId;
    const value = op.op === "setDimension" ? op.value : (op.minMm ?? 0);
    if (value <= 0) continue;

    if (op.dimensionType === "width" && value > boundary.widthMm) {
      return {
        roomIds: [op.roomId],
        message: `${name} cannot be ${Math.round(value)}mm wide — the whole floor is only ${boundary.widthMm}mm across. Enlarge the footprint first, or ask for a smaller room.`,
      };
    }
    if (op.dimensionType === "depth" && value > boundary.depthMm) {
      return {
        roomIds: [op.roomId],
        message: `${name} cannot be ${Math.round(value)}mm deep — the whole floor is only ${boundary.depthMm}mm front to back. Enlarge the footprint first, or ask for a smaller room.`,
      };
    }
    if (op.dimensionType === "area" && value > boundary.widthMm * boundary.depthMm) {
      return {
        roomIds: [op.roomId],
        message: `${name} cannot cover that area — it is larger than the entire floor. Enlarge the footprint first.`,
      };
    }
  }
  return null;
}
