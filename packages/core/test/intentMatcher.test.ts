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

  it("matches adding a floor, with and without a name", () => {
    const r1 = matchDeterministicIntent(planWithRooms(), "add a second floor");
    expect(r1?.kind).toBe("patch");
    if (r1?.kind !== "patch") return;
    expect(r1.patch.ops[0]).toMatchObject({ op: "addLevel" });

    const r2 = matchDeterministicIntent(planWithRooms(), "add a floor called Attic");
    expect(r2?.kind).toBe("patch");
    if (r2?.kind !== "patch") return;
    expect(r2.patch.ops[0]).toMatchObject({ op: "addLevel", name: "Attic" });
  });

  it("matches switching to a level by ordinal and by name", () => {
    const base = planWithRooms();
    const withLevel = applyPatch(base, { ops: [{ op: "addLevel", name: "Second Floor" }], source: "user" });
    if (!withLevel.ok) throw new Error("setup failed");
    const groundId = withLevel.doc.levels.find((l) => l.name !== "Second Floor")!.id;

    const r1 = matchDeterministicIntent(withLevel.doc, "switch to the ground floor");
    expect(r1?.kind).toBe("patch");
    if (r1?.kind !== "patch") return;
    expect(r1.patch.ops[0]).toMatchObject({ op: "setActiveLevel", levelId: groundId });

    const r2 = matchDeterministicIntent(withLevel.doc, "go to Second Floor");
    expect(r2?.kind).toBe("patch");
    if (r2?.kind !== "patch") return;
    expect(r2.patch.ops[0]).toMatchObject({ op: "setActiveLevel" });
  });

  it("matches renaming a level without falling through to room rename", () => {
    const base = planWithRooms();
    const withLevel = applyPatch(base, { ops: [{ op: "addLevel", name: "Second Floor" }], source: "user" });
    if (!withLevel.ok) throw new Error("setup failed");

    const result = matchDeterministicIntent(withLevel.doc, "rename level 2 to Attic");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "renameLevel", name: "Attic" });
  });

  it("units switch still works and isn't shadowed by the level-switch matcher", () => {
    const result = matchDeterministicIntent(planWithRooms(), "switch to metric");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "setUnits", units: "metric" });
  });
});
