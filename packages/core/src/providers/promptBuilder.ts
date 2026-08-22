// Shared prompt construction for Tier 0 and Tier 1 — specs.md T0-3 (budget, history
// truncated before summary) and INF-6/INF-7 (the vocabulary doc lives here, one of
// the three artifacts that must be updated when an op is added).

import type { PlanSummary, Turn } from "../types.js";
import { estimateTokens } from "../planSummary.js";
import type { OpName } from "./schema.js";

const OP_DOCS: Record<OpName, string> = {
  addRoom: `addRoom {program, name?, areaWeight, adjacentTo?, direction?} — add a room of a known program; areaWeight is relative, not absolute mm2. direction is one of "left"|"right"|"above"|"below"|"inside" and positions the new room against adjacentTo; "inside" partitions that room to make space.`,
  removeRoom: `removeRoom {roomId} — delete a room.`,
  renameRoom: `renameRoom {roomId, name} — rename a room.`,
  resizeRoom: `resizeRoom {roomId, areaWeight? | targetAreaMm2?} — change a room's relative size.`,
  swapRooms: `swapRooms {roomIdA, roomIdB} — exchange two rooms' positions/sizes.`,
  setBoundary: `setBoundary {widthMm, depthMm} — set the outer footprint.`,
  setUnits: `setUnits {units: "imperial"|"metric"} — change the display unit system.`,
  moveRoom: `moveRoom {roomId, relativeTo, direction: "left"|"right"|"above"|"below"|"inside"} — reposition a room next to another.`,
  setSplit: `setSplit {nodePath: number[], axis?, ratio?} — directly edit one split node of the generator tree.`,
  addOpening: `addOpening {betweenRooms: [a,b] | edgeId, kind: "door"|"window"|"cased"|"pass-through", width?} — add a wall opening.`,
  removeOpening: `removeOpening {openingId} — remove a wall opening.`,
  setDimension: `setDimension {roomId, dimensionType: "width"|"depth"|"area"|"aspectRatio", value, unit?} — pin an exact dimension.`,
  clearDimension: `clearDimension {roomId, dimensionType} — remove a pinned dimension.`,
  setDimensionRange: `setDimensionRange {roomId, dimensionType, minMm?, maxMm?} — bound a dimension by range.`,
};

export function buildSystemPrompt(allowedOps: readonly OpName[]): string {
  const vocab = allowedOps.map((op) => `- ${OP_DOCS[op]}`).join("\n");
  return [
    "You are the layout assistant for Floorcraft, a floor plan editor.",
    "You NEVER emit geometry or prose-with-JSON. You ONLY emit a JSON object: {\"ops\": [...], \"narration\"?: string}.",
    "Each entry in ops must be one of exactly these operations:",
    vocab,
    "Respond with strict JSON only, no markdown fences, no commentary outside the narration field.",
  ].join("\n");
}

export type PromptInput = {
  summary: PlanSummary;
  utterance: string;
  history: Turn[];
  tokenBudget: number;
};

/** Truncates history first when over budget (T0-3), then assembles the user-turn text. */
export function buildUserPrompt(input: PromptInput): string {
  const summaryText = JSON.stringify(input.summary);
  const summaryTokens = estimateTokens(summaryText);
  let budgetForHistory = Math.max(input.tokenBudget - summaryTokens - estimateTokens(input.utterance) - 50, 0);

  const keptHistory: Turn[] = [];
  for (let i = input.history.length - 1; i >= 0; i--) {
    const turn = input.history[i]!;
    const cost = estimateTokens(turn.text) + 5;
    if (cost > budgetForHistory) break;
    budgetForHistory -= cost;
    keptHistory.unshift(turn);
  }

  const historyText = keptHistory.map((t) => `${t.role}: ${t.text}`).join("\n");

  return [
    `PLAN_SUMMARY: ${summaryText}`,
    keptHistory.length > 0 ? `HISTORY:\n${historyText}` : "",
    `USER: ${input.utterance}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
