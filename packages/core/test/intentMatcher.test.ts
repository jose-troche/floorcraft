import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { matchDeterministicIntent } from "../src/intentMatcher.js";
import type { PlanDocument } from "../src/types.js";

function planWithRooms(): PlanDocument {
  const doc = createEmptyPlan({ id: "p1", title: "T", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
  const r1 = applyPatch(doc, { ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 }], source: "user" });
  if (!r1.ok) throw new Error("setup failed");
  const r2 = applyPatch(r1.doc, {
    ops: [{ op: "addRoom", roomId: "family", program: "family", name: "Family Room", areaWeight: 1 }],
    source: "user",
  });
  if (!r2.ok) throw new Error("setup failed");
  return r2.doc;
}

describe("matchDeterministicIntent", () => {
  it("matches undo/redo", () => {
    expect(matchDeterministicIntent(planWithRooms(), "undo")).toEqual({ kind: "undo" });
    expect(matchDeterministicIntent(planWithRooms(), "redo")).toEqual({ kind: "redo" });
  });

  it("matches rename by fuzzy room name", () => {
    const result = matchDeterministicIntent(planWithRooms(), "rename the kitchen to Cook Room");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "renameRoom", roomId: "kitchen", name: "Cook Room" });
  });

  it("matches swap", () => {
    const result = matchDeterministicIntent(planWithRooms(), "swap the kitchen and the family room");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "swapRooms", roomIdA: "kitchen", roomIdB: "family" });
  });

  it("matches delete", () => {
    const result = matchDeterministicIntent(planWithRooms(), "remove the family room");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "removeRoom", roomId: "family" });
  });

  it("matches percentage resize", () => {
    const result = matchDeterministicIntent(planWithRooms(), "make the kitchen 30% bigger");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "resizeRoom", roomId: "kitchen" });
    const op = result.patch.ops[0] as { areaWeight: number };
    expect(op.areaWeight).toBeCloseTo(1.3, 5);
  });

  it("matches add room of known program", () => {
    const result = matchDeterministicIntent(planWithRooms(), "add a pantry");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "addRoom", program: "pantry" });
  });

  it("matches change units", () => {
    const result = matchDeterministicIntent(planWithRooms(), "switch to metric");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "setUnits", units: "metric" });
  });

  it("returns null for free-form creation prompts (routed to a provider)", () => {
    const doc = createEmptyPlan({ id: "p1", title: "T", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
    const result = matchDeterministicIntent(doc, "A 30x40 foot house with kitchen, living room, 2 bedrooms, 1 bath");
    expect(result).toBeNull();
  });
});
