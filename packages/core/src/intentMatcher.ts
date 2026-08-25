// Deterministic intent matcher — specs.md §5.1 (INF-5). Tried before any provider
// call. Target: >= 35% of turns resolved with zero inference. Handles: rename,
// resize by percentage/area, swap, delete, add rooms (one or several, with a program,
// an optional count, optional dimensions, and optional placement relative to another
// room), move, undo/redo, change units.
//
// The governing rule here is that a *partial* understanding is never promoted to a
// guess. Fuzzy room matching used to return the best-scoring candidate, so "delete the
// bedroom" in a plan with two bedrooms silently destroyed whichever one happened to be
// enumerated first. Anything ambiguous now returns a `clarify` result instead: the plan
// is left untouched and the user is asked one question (FR-5).

import { toMm, unitFor, CROSS, NUMBER, UNIT_PATTERN } from "./dimensionParser.js";
import { DEFAULT_AREA_WEIGHT, generatorTree, type LevelId, type Patch, type PlanDocument, type RoomConstraints, type RoomId, type RoomProgram, type SpatialDirection, type Units } from "./types.js";
import { activeLevel } from "./patch.js";

export type IntentResult =
  | { kind: "patch"; patch: Patch }
  | { kind: "undo" }
  | { kind: "redo" }
  /** Understood the shape of the request but not its target; ask rather than act. */
  | { kind: "clarify"; question: string; options?: string[] }
  | null;

const PROGRAM_SYNONYMS: Record<string, RoomProgram> = {
  kitchen: "kitchen",
  "living room": "living",
  living: "living",
  "great room": "living",
  "family room": "family",
  family: "family",
  "dining room": "dining",
  dining: "dining",
  bedroom: "bedroom",
  "primary bedroom": "primary-bedroom",
  "master bedroom": "primary-bedroom",
  "master suite": "primary-bedroom",
  bathroom: "bath",
  bath: "bath",
  "half bath": "half-bath",
  "half bathroom": "half-bath",
  "powder room": "half-bath",
  laundry: "laundry",
  "laundry room": "laundry",
  office: "office",
  study: "office",
  garage: "garage",
  hallway: "hallway",
  hall: "hallway",
  corridor: "hallway",
  closet: "closet",
  wardrobe: "closet",
  pantry: "pantry",
  entry: "entry",
  foyer: "entry",
  mudroom: "mudroom",
  "mud room": "mudroom",
  stair: "stair",
  stairs: "stair",
  staircase: "stair",
  stairwell: "stair",
  // Generic requests ("add a room 3x4 ft") are legitimate and shouldn't need a program.
  room: "other",
  space: "other",
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- room lookup

type RoomLookup =
  | { kind: "one"; roomId: RoomId; name: string }
  | { kind: "many"; candidates: Array<{ roomId: RoomId; name: string }> }
  | { kind: "none" };

/**
 * Resolves a room reference without ever picking a winner from equally good candidates.
 * An exact name match wins outright; otherwise every substring match is a candidate, and
 * more than one is reported as ambiguous rather than silently narrowed.
 */
function resolveRoom(doc: PlanDocument, text: string): RoomLookup {
  const level = activeLevel(doc);
  const needle = normalize(text);
  if (!needle) return { kind: "none" };

  const rooms = Object.entries(level.graph.rooms).map(([roomId, room]) => ({
    roomId,
    name: room.name,
    normalized: normalize(room.name),
  }));

  // Candidates are listed by name, not by graph order: room order follows the slicing
  // tree, so an unsorted question would offer "Bedroom 2 or Bedroom 1" and look arbitrary.
  // Numeric collation keeps Bedroom 2 ahead of Bedroom 10.
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  const exact = rooms.filter((r) => r.normalized === needle).sort(byName);
  if (exact.length === 1) return { kind: "one", roomId: exact[0]!.roomId, name: exact[0]!.name };
  if (exact.length > 1) return { kind: "many", candidates: exact };

  const partial = rooms.filter((r) => r.normalized.includes(needle) || needle.includes(r.normalized)).sort(byName);
  if (partial.length === 1) return { kind: "one", roomId: partial[0]!.roomId, name: partial[0]!.name };
  if (partial.length > 1) return { kind: "many", candidates: partial };
  return { kind: "none" };
}

// ---------------------------------------------------------------- level lookup

const LEVEL_ORDINALS: Record<string, number> = {
  ground: 0,
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
};

/**
 * Resolves "level 2" / "the second floor" / "Attic" against the document's levels,
 * ordered by elevation. Unlike resolveRoom this has no clarify path: levels are few
 * (typically 1-3), so a miss just falls through to whatever matcher runs next rather
 * than spending FR-5's one-question-per-turn budget on a low-stakes reference.
 */
function resolveLevelRef(doc: PlanDocument, text: string): { levelId: LevelId; name: string } | null {
  const needle = normalize(text);
  if (!needle) return null;
  const sorted = [...doc.levels].sort((a, b) => a.elevation - b.elevation);

  const ordinalMatch = needle.match(/^(ground|1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth)(?:\s+(?:floor|level|storey|story))?$/);
  if (ordinalMatch) {
    const level = sorted[LEVEL_ORDINALS[ordinalMatch[1]!]!];
    if (level) return { levelId: level.id, name: level.name };
  }
  // Accepts a bare number too: callers like the "rename level N to X" matcher already
  // consume the "level"/"floor" word themselves before resolving what's left.
  const numMatch = needle.match(/^(?:level|floor|storey|story)\s*(\d+)$|^(\d+)$/);
  if (numMatch) {
    const level = sorted[Number(numMatch[1] ?? numMatch[2]) - 1];
    if (level) return { levelId: level.id, name: level.name };
  }
  const exact = sorted.find((l) => normalize(l.name) === needle);
  if (exact) return { levelId: exact.id, name: exact.name };
  const partial = sorted.filter((l) => normalize(l.name).includes(needle) || needle.includes(normalize(l.name)));
  if (partial.length === 1) return { levelId: partial[0]!.id, name: partial[0]!.name };
  return null;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

type Clarify = { kind: "clarify"; question: string; options?: string[] };

function ambiguous(text: string, lookup: Extract<RoomLookup, { kind: "many" }>): Clarify {
  const names = lookup.candidates.map((c) => c.name);
  return {
    kind: "clarify",
    question: `There's more than one room matching "${text.trim()}" — did you mean ${listNames(names)}?`,
    options: names,
  };
}

function unknownRoom(doc: PlanDocument, text: string): Clarify {
  const names = Object.values(activeLevel(doc).graph.rooms).map((r) => r.name);
  if (names.length === 0) {
    return { kind: "clarify", question: `There are no rooms in this plan yet, so there's no "${text.trim()}" to change.` };
  }
  return {
    kind: "clarify",
    question: `I can't find a room called "${text.trim()}". This plan has ${listNames(names)}. Which did you mean?`,
    options: names,
  };
}

/**
 * Resolves a room for a command that must not act on the wrong one. `none` and `many`
 * both become questions; only a single confident match proceeds.
 */
type RequiredRoom = { ok: true; roomId: RoomId; name: string } | { ok: false; clarify: Clarify };

function requireRoom(doc: PlanDocument, text: string): RequiredRoom {
  const lookup = resolveRoom(doc, text);
  if (lookup.kind === "one") return { ok: true, roomId: lookup.roomId, name: lookup.name };
  if (lookup.kind === "many") return { ok: false, clarify: ambiguous(text, lookup) };
  return { ok: false, clarify: unknownRoom(doc, text) };
}

// ------------------------------------------------------------------ programs

type ProgramMention = { program: RoomProgram; start: number; end: number };

// Longest synonym first, so "half bath" beats "bath" and "living room" beats "room".
const PROGRAM_KEYS = Object.keys(PROGRAM_SYNONYMS).sort((a, b) => b.length - a.length);

/**
 * Finds every kind of room named in a normalized string, as non-overlapping mentions in
 * the order they were said. Matching is on whole words and takes the longest synonym at
 * each position, so "master bedroom" is one mention rather than a "bedroom" nested in a
 * longer phrase, and a plural is part of the mention it belongs to.
 *
 * Callers are expected to look at how many came back, not just the first. Picking one
 * mention out of several used to be how "three bedrooms ... with a private bathroom"
 * became three bathrooms: "bathroom" is a longer synonym than "bedroom", so the longest
 * key won a contest it should never have been entered in. Text naming two kinds of room
 * is describing a relationship between them, which is a request for a provider.
 */
function findProgramMentions(needle: string): ProgramMention[] {
  const mentions: ProgramMention[] = [];
  for (const key of PROGRAM_KEYS) {
    const pattern = new RegExp(`\\b${key.replace(/ /g, "\\s+")}s?\\b`, "g");
    for (let m = pattern.exec(needle); m; m = pattern.exec(needle)) {
      const start = m.index;
      const end = start + m[0].length;
      // A shorter synonym sitting inside one already taken ("room" within "living room")
      // is the same mention seen again, not a second room.
      if (mentions.some((other) => start < other.end && other.start < end)) continue;
      mentions.push({ program: PROGRAM_SYNONYMS[key]!, start, end });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

/** The one kind of room this text names, or null if it names none — or more than one. */
function findProgram(text: string): RoomProgram | null {
  const needle = normalize(text);
  if (!needle) return null;
  const mentions = findProgramMentions(needle);
  return mentions.length === 1 ? mentions[0]!.program : null;
}

const SUGGESTED_PROGRAMS = ["kitchen", "living room", "bedroom", "bathroom", "office", "closet", "pantry", "hallway"];

function unknownProgram(text: string): Clarify {
  return {
    kind: "clarify",
    question:
      `I'm not sure what kind of room "${text.trim()}" is, so I haven't added anything. ` +
      `Try one of: ${SUGGESTED_PROGRAMS.join(", ")} — or say "a room" for a generic one.`,
    options: SUGGESTED_PROGRAMS,
  };
}

function patch(ops: Patch["ops"]): IntentResult {
  return { kind: "patch", patch: { ops, source: "deterministic" } };
}

// ------------------------------------------------------------------ add room

/**
 * Marks a creation request that names several rooms, or a count of them, so it is read by
 * parseRoomList rather than as a single room. Anything this flags that parseRoomList
 * cannot read exactly goes to the provider: getting it half-right (one room out of three,
 * or one bedroom where two were asked for) is precisely the wrong-inference failure.
 */
const LIST_OR_COUNT =
  /,|\band\b|\b\d+\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|couple|several|few)\b/i;

const COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * A quantifier with no correct number behind it. "a few bedrooms" has no reading this
 * matcher can defend, so those segments fail the list and the turn goes to a provider
 * (or, with no provider, comes back as a question) rather than inventing a count.
 */
const VAGUE_QUANTIFIER = /^(?:several|some|many|a\s+few|few|lots\s+of|multiple)\b/;

/**
 * Ceiling on one turn's worth of rooms. A slip of the keyboard ("add 200 bedrooms")
 * should not spend a minute in the solver producing a plan nobody asked for.
 */
const MAX_ROOMS_PER_TURN = 12;

type RoomRequest = { program: RoomProgram; count: number };

/**
 * Pulls a leading count off one segment: "three bedrooms" -> 3, "a couple of baths" -> 2,
 * a bare "kitchen" -> 1.
 */
function extractCount(text: string): { count: number; rest: string } {
  const numeric = /^(\d+)\s+(.+)$/.exec(text);
  if (numeric) return { count: Number(numeric[1]), rest: numeric[2]! };
  const pair = /^(?:a\s+)?(?:couple|pair)\s+(?:of\s+)?(.+)$/.exec(text);
  if (pair) return { count: 2, rest: pair[1]! };
  const word = /^([a-z]+)\s+(.+)$/.exec(text);
  const counted = word ? COUNT_WORDS[word[1]!] : undefined;
  if (word && counted !== undefined) return { count: counted, rest: word[2]! };
  return { count: 1, rest: text };
}

/**
 * Words a segment may carry around its room without changing what is being asked for.
 * Anything outside this set — "with a private bathroom", "facing the garden" — is a
 * description this matcher cannot express, and disqualifies the segment.
 */
const SEGMENT_FILLER = /\b(?:a|an|the|another|more|extra|additional|new|other|also|too|as\s+well)\b/g;

/** Reads one segment of a list — "a living room", "three bedrooms" — or fails. */
function parseRoomRequest(segment: string): RoomRequest | null {
  const normalized = normalize(segment);
  if (!normalized || VAGUE_QUANTIFIER.test(normalized)) return null;
  const { count, rest } = extractCount(normalized.replace(/^(?:another|the)\s+/, ""));
  if (!Number.isInteger(count) || count < 1) return null;

  const mentions = findProgramMentions(rest);
  if (mentions.length !== 1) return null;
  const mention = mentions[0]!;

  // The segment has to be spent entirely on the count and the room. A segment that says
  // more than that — "one with a private bathroom" — is stating a relationship, and
  // expanding it into bare rooms would drop the very thing that was asked for.
  const leftover = `${rest.slice(0, mention.start)} ${rest.slice(mention.end)}`.replace(SEGMENT_FILLER, " ").trim();
  if (leftover) return null;

  return { program: mention.program, count };
}

/**
 * Reads "a kitchen, a living room and three bedrooms" as a list of programs and counts.
 * All-or-nothing on purpose: one unreadable segment fails the whole list, because adding
 * the two rooms out of three that happened to parse is worse than not acting at all —
 * the user would have to work out which of their rooms went missing.
 */
function parseRoomList(text: string): RoomRequest[] | null {
  const segments = text
    .split(/\s*(?:,|;|\band\b|\bplus\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const requests: RoomRequest[] = [];
  let total = 0;
  for (const segment of segments) {
    const request = parseRoomRequest(segment);
    if (!request) return null;
    total += request.count;
    if (total > MAX_ROOMS_PER_TURN) return null;
    requests.push(request);
  }
  // A single room with no count is the plain "add a kitchen" case, which the caller
  // already handles — and handles better, since it also reads dimensions and filler.
  return total > 1 ? requests : null;
}

const ADD_PREFIX = /^(?:please\s+)?(?:add|create|insert|put)\s+(?:(?:a|an|another|the)\s+)?/i;

type DirectionWord = {
  pattern: RegExp;
  direction?: SpatialDirection;
  /**
   * Requires an explicit "the" before the room name. Set for the bare preposition "in",
   * whose alternatives are too common inside ordinary room names to match loosely — "add
   * a walk in closet" must not parse as putting a "walk" inside a "closet".
   */
  requireArticle?: boolean;
};

const DIRECTION_WORDS: DirectionWord[] = [
  { pattern: /(?:to\s+the\s+|on\s+the\s+)?left\s+of/i, direction: "left" },
  { pattern: /(?:to\s+the\s+|on\s+the\s+)?right\s+of/i, direction: "right" },
  { pattern: /(?:just\s+)?(?:above|over|north\s+of|on\s+top\s+of)/i, direction: "above" },
  { pattern: /(?:just\s+)?(?:below|underneath|beneath|under|south\s+of)/i, direction: "below" },
  { pattern: /(?:inside|within)/i, direction: "inside" },
  { pattern: /in/i, direction: "inside", requireArticle: true },
  // Adjacency naming a neighbour but not a side: no direction, so the tree picks the
  // axis exactly as it does for any unplaced adjacency.
  { pattern: /(?:next\s+to|beside|adjacent\s+to|near)/i },
];

type Placement = { direction?: SpatialDirection; targetText: string; rest: string };

/** Pulls a trailing "<direction> the <room>" phrase off a creation or move request. */
function extractPlacement(text: string): Placement | null {
  for (const { pattern, direction, requireArticle } of DIRECTION_WORDS) {
    const tail = requireArticle ? "\\s+the\\s+(.+)$" : "\\s+(?:the\\s+)?(.+)$";
    const full = new RegExp(`^(.*?)\\s+${pattern.source}${tail}`, "i");
    const m = full.exec(text.trim());
    if (!m) continue;
    const targetText = m[2]!.trim();
    const rest = m[1]!.trim();
    if (!targetText || !rest) continue;
    return { direction, targetText, rest };
  }
  return null;
}

/** Pulls an explicit "3 x 4 ft" out of a creation request, returning the constraints it implies. */
function extractDimensions(text: string, units: Units): { constraints: RoomConstraints; rest: string } | null {
  const pattern = new RegExp(`(${NUMBER})\\s*(${UNIT_PATTERN})?\\s*${CROSS}\\s*(${NUMBER})\\s*(${UNIT_PATTERN})?`, "i");
  const m = pattern.exec(text);
  if (!m) return null;
  const trailing = m[4] ?? m[2];
  const widthMm = toMm(Number(m[1]), unitFor(m[2] ?? trailing, units).unit);
  const depthMm = toMm(Number(m[3]), unitFor(trailing, units).unit);
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0]!.length)).replace(/\s+/g, " ").trim();
  return { constraints: { width: { exact: widthMm }, depth: { exact: depthMm } }, rest };
}

function matchAddRoom(doc: PlanDocument, utterance: string): IntentResult {
  if (!ADD_PREFIX.test(utterance)) return null;
  let rest = utterance.replace(ADD_PREFIX, "").trim();
  if (!rest) return null;

  let direction: SpatialDirection | undefined;
  let adjacentTo: RoomId | undefined;

  const placement = extractPlacement(rest);
  if (placement) {
    const room = requireRoom(doc, placement.targetText);
    // An unresolvable or ambiguous anchor is a question, not a reason to drop the
    // placement and put the room somewhere arbitrary.
    if (!room.ok) return room.clarify;
    adjacentTo = room.roomId;
    direction = placement.direction;
    rest = placement.rest;
  }

  const dimensions = extractDimensions(rest, doc.units);
  if (dimensions) rest = dimensions.rest;

  // Several rooms or a count of them. Read before the filler strip below, which would
  // eat the "of" out of "a couple of bedrooms". Skipped when the request also states a
  // size: "8x5" describes one room, and there is no honest way to spread it over a list.
  if (!dimensions && LIST_OR_COUNT.test(rest)) {
    const list = parseRoomList(rest);
    if (!list) return null; // Not readable exactly — provider territory.
    return patch(
      list.flatMap(({ program, count }) =>
        Array.from({ length: count }, () => ({
          op: "addRoom" as const,
          program,
          areaWeight: DEFAULT_AREA_WEIGHT[program],
          adjacentTo,
          direction: adjacentTo ? direction : undefined,
        })),
      ),
    );
  }

  // Strip filler left behind by the dimension phrase ("a room that is 3x4 ft").
  rest = rest.replace(/\b(?:that\s+is|which\s+is|measuring|sized|of|is|a|an)\b/gi, " ").replace(/\s+/g, " ").trim();

  if (!rest) return null; // "add 3x4" with no noun at all — let the provider read it.
  if (LIST_OR_COUNT.test(rest)) return null; // several rooms or a count: provider territory.

  const mentions = findProgramMentions(normalize(rest));
  // Two kinds of room in one un-listed request ("a bedroom with an ensuite bathroom")
  // relate them to each other. Only a provider can express that, and picking one of the
  // two would deliver a room the user did not ask for.
  if (mentions.length > 1) return null;
  const program = mentions[0]?.program;
  if (!program) return unknownProgram(rest);

  return patch([
    {
      op: "addRoom",
      program,
      areaWeight: DEFAULT_AREA_WEIGHT[program],
      adjacentTo,
      direction: adjacentTo ? direction : undefined,
      constraints: dimensions?.constraints,
    },
  ]);
}

// -------------------------------------------------------------------- move

const MOVE_PREFIX = /^(?:please\s+)?(?:move|relocate|shift)\s+(?:the\s+)?/i;

function matchMoveRoom(doc: PlanDocument, utterance: string): IntentResult {
  if (!MOVE_PREFIX.test(utterance)) return null;
  const rest = utterance.replace(MOVE_PREFIX, "").trim();
  const placement = extractPlacement(rest);
  if (!placement || !placement.rest) return null;

  const subject = requireRoom(doc, placement.rest);
  if (!subject.ok) return subject.clarify;
  const target = requireRoom(doc, placement.targetText);
  if (!target.ok) return target.clarify;
  if (subject.roomId === target.roomId) return null;

  return patch([
    { op: "moveRoom", roomId: subject.roomId, relativeTo: target.roomId, direction: placement.direction ?? "inside" },
  ]);
}

// ------------------------------------------------------------------- main

export function matchDeterministicIntent(doc: PlanDocument, utteranceRaw: string): IntentResult {
  const utterance = utteranceRaw.trim();
  const lower = utterance.toLowerCase();

  if (/^(undo)\b/.test(lower)) return { kind: "undo" };
  if (/^(redo)\b/.test(lower)) return { kind: "redo" };

  let m: RegExpMatchArray | null;

  // "rename the plan to Oak Street" / "call this plan Oak Street" — ahead of both renames
  // below, which would otherwise go looking for a room or level called "plan".
  m = utterance.match(/(?:rename|call)\s+(?:the\s+|this\s+)?(?:plan|project|drawing|file)\s+(?:to\s+|as\s+)?(.+)/i);
  if (m) return patch([{ op: "renamePlan", title: m[1]!.trim() }]);

  // "rename level 2 to Attic" / "rename the second floor to Attic" — checked ahead of the
  // generic room rename below, or "level 2" would be looked up as a room name and fail.
  m = utterance.match(/rename\s+(?:the\s+)?(?:level|floor|storey|story)\s+(.+?)\s+(?:to|as)\s+(.+)/i);
  if (m) {
    const level = resolveLevelRef(doc, m[1]!);
    if (level) return patch([{ op: "renameLevel", levelId: level.levelId, name: m[2]!.trim() }]);
  }

  // "rename X to Y" / "call the X Y" / "rename X as Y"
  m = utterance.match(/rename\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+(.+)/i);
  if (!m) m = utterance.match(/call\s+(?:the\s+)?(.+?)\s+(.+)/i);
  if (m) {
    const room = requireRoom(doc, m[1]!);
    if (!room.ok) return room.clarify;
    return patch([{ op: "renameRoom", roomId: room.roomId, name: m[2]!.trim() }]);
  }

  // "add a floor" / "add another level" / "add a second floor called Attic"
  m = utterance.match(
    /^add\s+(?:a\s+|another\s+)?(?:new\s+|second\s+|third\s+|fourth\s+|\d+\w*\s+)?(?:floor|level|storey|story)(?:\s+(?:called|named)\s+(.+))?$/i,
  );
  if (m) return patch([{ op: "addLevel", name: m[1]?.trim() || undefined }]);

  // "go to level 2" / "switch to the ground floor" — resolveLevelRef requires the text to
  // actually look like a level reference, so this can't shadow "switch to metric" below.
  m = utterance.match(/^(?:go to|switch to|show)\s+(?:the\s+)?(.+)$/i);
  if (m) {
    const level = resolveLevelRef(doc, m[1]!);
    if (level) return patch([{ op: "setActiveLevel", levelId: level.levelId }]);
  }

  // "swap X and Y"
  m = utterance.match(/swap\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)/i);
  if (m) {
    const a = requireRoom(doc, m[1]!);
    if (!a.ok) return a.clarify;
    const b = requireRoom(doc, m[2]!);
    if (!b.ok) return b.clarify;
    return patch([{ op: "swapRooms", roomIdA: a.roomId, roomIdB: b.roomId }]);
  }

  // Creation and movement, both of which can name a spatial relationship.
  const added = matchAddRoom(doc, utterance);
  if (added) return added;
  const moved = matchMoveRoom(doc, utterance);
  if (moved) return moved;

  // "remove/delete the X" — destructive, so an unclear target is always a question.
  m = utterance.match(/(?:remove|delete|demolish|get\s+rid\s+of)\s+(?:the\s+)?(.+)/i);
  if (m) {
    const room = requireRoom(doc, m[1]!);
    if (!room.ok) return room.clarify;
    return patch([{ op: "removeRoom", roomId: room.roomId }]);
  }

  // "make the X N% bigger/smaller" / "increase|reduce X by N%"
  m = utterance.match(/make\s+(?:the\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s*%\s*(bigger|larger|smaller)/i);
  if (!m) m = utterance.match(/(increase|decrease|reduce|shrink|grow|expand)\s+(?:the\s+)?(.+?)\s+by\s+(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    let roomText: string, pct: number, growing: boolean;
    if (/^(increase|decrease|reduce|shrink|grow|expand)$/i.test(m[1]!)) {
      growing = /increase|grow|expand/i.test(m[1]!);
      roomText = m[2]!;
      pct = Number(m[3]);
    } else {
      roomText = m[1]!;
      pct = Number(m[2]);
      growing = /bigger|larger/i.test(m[3]!);
    }
    const room = requireRoom(doc, roomText);
    if (!room.ok) return room.clarify;
    const leaf = generatorTree(activeLevel(doc));
    const current = leaf ? findLeafWeight(leaf, room.roomId) : null;
    if (current !== null) {
      const factor = 1 + (growing ? 1 : -1) * (pct / 100);
      return patch([{ op: "resizeRoom", roomId: room.roomId, areaWeight: Math.max(current * factor, 0.01) }]);
    }
  }

  // "switch to metric" / "use imperial units" / "change units to feet"
  m = utterance.match(/(?:switch to|use|change (?:the )?units? to)\s+(metric|imperial|feet|meters|meter)/i);
  if (m) {
    const word = m[1]!.toLowerCase();
    const units: Units = word === "metric" || word.startsWith("meter") ? "metric" : "imperial";
    return patch([{ op: "setUnits", units }]);
  }

  return null;
}

function findLeafWeight(tree: import("./types.js").SlicingTree, roomId: RoomId): number | null {
  if (tree.kind === "leaf") return tree.roomId === roomId ? tree.areaWeight : null;
  return findLeafWeight(tree.children[0], roomId) ?? findLeafWeight(tree.children[1], roomId);
}
