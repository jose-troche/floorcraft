// 20-prompt fixture — specs.md Phase 1 exit criteria ("20 representative prompts").
// Each step pairs a natural-language utterance with the patch a provider or the
// deterministic matcher is expected to produce for it, so the solver/reducer/graph
// pipeline can be exercised end-to-end without a live model in CI.

import type { Patch, PatchOp } from "../src/types.js";

export type FixtureStep = { utterance: string; ops: PatchOp[] };
export type FixtureScenario = { name: string; boundary: { widthMm: number; depthMm: number }; steps: FixtureStep[] };

function patchOf(ops: PatchOp[]): Patch {
  return { ops, source: "user" };
}

export const HOUSE_SCENARIO: FixtureScenario = {
  name: "30x40 house",
  boundary: { widthMm: 9144, depthMm: 12192 },
  steps: [
    { utterance: "Start a 30 by 40 foot house", ops: [{ op: "setBoundary", widthMm: 9144, depthMm: 12192 }] },
    { utterance: "Add a kitchen", ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1.2 }] },
    {
      utterance: "Add a living room next to the kitchen",
      ops: [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1.6, adjacentTo: "kitchen" }],
    },
    { utterance: "Add two bedrooms", ops: [{ op: "addRoom", roomId: "bedroom-1", program: "bedroom", areaWeight: 1.2 }] },
    { utterance: "(second bedroom)", ops: [{ op: "addRoom", roomId: "bedroom-2", program: "bedroom", areaWeight: 1.2 }] },
    {
      utterance: "Add one bath near the first bedroom",
      ops: [{ op: "addRoom", roomId: "bath-1", program: "bath", areaWeight: 0.5, adjacentTo: "bedroom-1" }],
    },
    { utterance: "Make the kitchen 20% bigger", ops: [{ op: "resizeRoom", roomId: "kitchen", areaWeight: 1.44 }] },
    { utterance: "Rename bedroom 1 to primary bedroom", ops: [{ op: "renameRoom", roomId: "bedroom-1", name: "Primary Bedroom" }] },
    { utterance: "Swap bedroom two and the bathroom", ops: [{ op: "swapRooms", roomIdA: "bedroom-2", roomIdB: "bath-1" }] },
    { utterance: "Switch to metric", ops: [{ op: "setUnits", units: "metric" }] },
  ],
};

export const APARTMENT_SCENARIO: FixtureScenario = {
  name: "apartment",
  boundary: { widthMm: 12000, depthMm: 9000 },
  steps: [
    { utterance: "Apartment with a 12 by 9 meter footprint", ops: [{ op: "setBoundary", widthMm: 12000, depthMm: 9000 }] },
    {
      utterance: "Master suite 16x18 feet",
      ops: [{ op: "addRoom", roomId: "master", program: "primary-bedroom", areaWeight: 2.0 }],
    },
    {
      utterance: "Guest bedroom 12x12 next to the master suite",
      ops: [{ op: "addRoom", roomId: "guest-bedroom", program: "bedroom", areaWeight: 1.0, adjacentTo: "master" }],
    },
    { utterance: "Living area 20x25", ops: [{ op: "addRoom", roomId: "living-area", program: "living", areaWeight: 1.8 }] },
    {
      utterance: "Kitchen 8x10 next to the living area",
      ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 0.9, adjacentTo: "living-area" }],
    },
    {
      utterance: "Add a pass-through between the kitchen and living area",
      ops: [{ op: "addOpening", betweenRooms: ["kitchen", "living-area"], kind: "pass-through" }],
    },
    { utterance: "Shift the main split", ops: [{ op: "setSplit", nodePath: [0], axis: "v", ratio: 0.55 }] },
    { utterance: "Move the kitchen next to the guest bedroom", ops: [{ op: "moveRoom", roomId: "kitchen", relativeTo: "guest-bedroom", direction: "left" }] },
    { utterance: "Remove the guest bedroom", ops: [{ op: "removeRoom", roomId: "guest-bedroom" }] },
    {
      utterance: "Master suite must be at least 16 feet wide",
      ops: [{ op: "setDimension", roomId: "master", dimensionType: "width", value: 4880 }],
    },
  ],
};

export const PROMPT_FIXTURES: FixtureScenario[] = [HOUSE_SCENARIO, APARTMENT_SCENARIO];

export { patchOf };
