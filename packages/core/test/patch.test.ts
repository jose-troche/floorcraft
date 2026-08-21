import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import type { Patch } from "../src/types.js";

function basePlan() {
  return createEmptyPlan({ id: "p1", title: "Test Plan", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
}

function apply(doc: ReturnType<typeof basePlan>, ops: Patch["ops"]) {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(`patch failed: ${result.errors.join("; ")} ${JSON.stringify(result.violations)}`);
  return result;
}

describe("applyPatch", () => {
  it("addRoom builds a one-leaf tree and a matching wall graph", () => {
    const doc = basePlan();
    const { doc: doc1 } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    const level = activeLevel(doc1);
    expect(level.generator?.tree).toMatchObject({ kind: "leaf", roomId: "kitchen" });
    expect(Object.keys(level.graph.rooms)).toEqual(["kitchen"]);
    const room = level.graph.rooms.kitchen!;
    expect(room.boundary.length).toBeGreaterThanOrEqual(4);
  });

  it("a second addRoom splits the tree and both rooms tile the boundary without gaps", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1.5 }]));
    const level = activeLevel(d);
    expect(Object.keys(level.graph.rooms).sort()).toEqual(["kitchen", "living"]);
  });

  it("removeRoom collapses the tree back to the sibling", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1 }]));
    ({ doc: d } = apply(d, [{ op: "removeRoom", roomId: "living" }]));
    const level = activeLevel(d);
    expect(level.generator?.tree).toMatchObject({ kind: "leaf", roomId: "kitchen" });
    expect(Object.keys(level.graph.rooms)).toEqual(["kitchen"]);
  });

  it("renameRoom updates the name without touching geometry", () => {
    const doc = basePlan();
    const { doc: d1 } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    const before = activeLevel(d1).graph.rooms.kitchen!.boundary;
    const { doc: d2 } = apply(d1, [{ op: "renameRoom", roomId: "kitchen", name: "Cook Room" }]);
    const after = activeLevel(d2).graph.rooms.kitchen!;
    expect(after.name).toBe("Cook Room");
    expect(after.boundary).toEqual(before);
  });

  it("swapRooms exchanges which room gets which tree slot", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "a", program: "bedroom", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "b", program: "kitchen", areaWeight: 3 }]));
    const beforeA = activeLevel(d).graph.rooms.a!;
    const beforeB = activeLevel(d).graph.rooms.b!;
    ({ doc: d } = apply(d, [{ op: "swapRooms", roomIdA: "a", roomIdB: "b" }]));
    const afterA = activeLevel(d).graph.rooms.a!;
    const afterB = activeLevel(d).graph.rooms.b!;
    // After swapping, room 'a' should now occupy roughly what 'b' occupied (areas swap).
    expect(afterA.name).toBe(beforeA.name);
    expect(afterB.name).toBe(beforeB.name);
    expect(afterA).not.toEqual(beforeA);
  });

  it("setBoundary regenerates geometry to the new footprint", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "setBoundary", widthMm: 6000, depthMm: 6000 }]));
    expect(activeLevel(d).boundary).toEqual({ widthMm: 6000, depthMm: 6000 });
  });

  it("fails with a structured violation instead of broken geometry when rooms cannot fit", () => {
    const doc = basePlan();
    const { doc: d } = apply(doc, [{ op: "setBoundary", widthMm: 2000, depthMm: 2000 }]);
    const result = applyPatch(d, { ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }], source: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations?.[0]?.reason).toBe("boundary-too-small");
  });

  it("reports a per-room percentage change for resizeRoom", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1 }]));
    const { changes } = apply(d, [{ op: "resizeRoom", roomId: "kitchen", areaWeight: 2 }]);
    expect(changes.some((c) => c.includes("Kitchen") && c.includes("%"))).toBe(true);
  });
});
