// Deterministic intent matcher — specs.md §5.1 (INF-5). Tried before any provider
// call. Target: >= 35% of turns resolved with zero inference. Handles: rename,
// resize by percentage/area, swap, delete, add room of known program, undo/redo,
// change units.

import type { Patch, PlanDocument, RoomId, RoomProgram, Units } from "./types.js";
import { activeLevel } from "./patch.js";

export type IntentResult = { kind: "patch"; patch: Patch } | { kind: "undo" } | { kind: "redo" } | null;

const PROGRAM_SYNONYMS: Record<string, RoomProgram> = {
  kitchen: "kitchen",
  "living room": "living",
  living: "living",
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
  pantry: "pantry",
  entry: "entry",
  foyer: "entry",
  mudroom: "mudroom",
};

const DEFAULT_AREA_WEIGHT: Record<RoomProgram, number> = {
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

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

function findRoomByName(doc: PlanDocument, text: string): RoomId | null {
  const level = activeLevel(doc);
  const needle = normalize(text);
  if (!needle) return null;
  let best: RoomId | null = null;
  let bestScore = -1;
  for (const [roomId, room] of Object.entries(level.graph.rooms)) {
    const hay = normalize(room.name);
    let score = -1;
    if (hay === needle) score = 100;
    else if (hay.includes(needle) || needle.includes(hay)) score = 50 + Math.min(hay.length, needle.length);
    if (score > bestScore) {
      bestScore = score;
      best = roomId;
    }
  }
  return bestScore >= 50 ? best : null;
}

function findProgram(text: string): RoomProgram | null {
  const needle = normalize(text);
  // Longest synonym match first, so "half bath" beats "bath".
  const keys = Object.keys(PROGRAM_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (needle === key || needle.includes(key)) return PROGRAM_SYNONYMS[key]!;
  }
  return null;
}

function patch(ops: Patch["ops"]): IntentResult {
  return { kind: "patch", patch: { ops, source: "deterministic" } };
}

export function matchDeterministicIntent(doc: PlanDocument, utteranceRaw: string): IntentResult {
  const utterance = utteranceRaw.trim();
  const lower = utterance.toLowerCase();

  if (/^(undo)\b/.test(lower)) return { kind: "undo" };
  if (/^(redo)\b/.test(lower)) return { kind: "redo" };

  let m: RegExpMatchArray | null;

  // "rename X to Y" / "call the X Y" / "rename X as Y"
  m = utterance.match(/rename\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+(.+)/i);
  if (!m) m = utterance.match(/call\s+(?:the\s+)?(.+?)\s+(.+)/i);
  if (m) {
    const roomId = findRoomByName(doc, m[1]!);
    if (roomId) return patch([{ op: "renameRoom", roomId, name: m[2]!.trim() }]);
  }

  // "swap X and Y"
  m = utterance.match(/swap\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)/i);
  if (m) {
    const a = findRoomByName(doc, m[1]!);
    const b = findRoomByName(doc, m[2]!);
    if (a && b) return patch([{ op: "swapRooms", roomIdA: a, roomIdB: b }]);
  }

  // "remove/delete the X"
  m = utterance.match(/(?:remove|delete)\s+(?:the\s+)?(.+)/i);
  if (m) {
    const roomId = findRoomByName(doc, m[1]!);
    if (roomId) return patch([{ op: "removeRoom", roomId }]);
  }

  // "make the X N% bigger/smaller" / "increase/decrease X by N%"
  m = utterance.match(/make\s+(?:the\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s*%\s*(bigger|larger|smaller)/i);
  if (!m) m = utterance.match(/(increase|decrease)\s+(?:the\s+)?(.+?)\s+by\s+(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    let roomText: string, pct: number, growing: boolean;
    if (/^(increase|decrease)$/i.test(m[1]!)) {
      growing = /increase/i.test(m[1]!);
      roomText = m[2]!;
      pct = Number(m[3]);
    } else {
      roomText = m[1]!;
      pct = Number(m[2]);
      growing = /bigger|larger/i.test(m[3]!);
    }
    const roomId = findRoomByName(doc, roomText);
    if (roomId) {
      const level = activeLevel(doc);
      const leaf = level.generator?.tree;
      const current = leaf ? findLeafWeight(leaf, roomId) : null;
      if (current !== null) {
        const factor = 1 + (growing ? 1 : -1) * (pct / 100);
        return patch([{ op: "resizeRoom", roomId, areaWeight: Math.max(current * factor, 0.01) }]);
      }
    }
  }

  // "add a pantry" / "add a bedroom next to the kitchen"
  m = utterance.match(/add\s+(?:a|an|another)?\s*([a-z ]+?)(?:\s+(?:next to|near|adjacent to)\s+(?:the\s+)?(.+))?$/i);
  if (m) {
    const program = findProgram(m[1]!);
    if (program) {
      const adjacentText = m[2];
      const adjacentTo = adjacentText ? findRoomByName(doc, adjacentText) ?? undefined : undefined;
      return patch([
        {
          op: "addRoom",
          program,
          areaWeight: DEFAULT_AREA_WEIGHT[program],
          adjacentTo,
        },
      ]);
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
