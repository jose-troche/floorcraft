// Multi-storey (Phase 3). Level-management ops are document-scoped and run before the
// rest of a patch (patch.ts's applyLevelManagementOps) — this is what makes "add a second
// floor with two bedrooms" work as a single patch.

import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import { generatorTree, type Patch, type PlanDocument } from "../src/types.js";

function basePlan() {
  return createEmptyPlan({ id: "p1", title: "Test Plan", units: "imperial", boundary: { widthMm: 8000, depthMm: 8000 } });
}

function apply(doc: PlanDocument, ops: Patch["ops"]) {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(`patch failed: ${result.errors.join("; ")} ${JSON.stringify(result.violations)}`);
  return result;
}

describe("multi-storey ops", () => {
  it("addLevel creates a new level, stacked above, and switches to it", () => {
    const doc = basePlan();
    const { doc: d } = apply(doc, [{ op: "addLevel", name: "Second Floor" }]);
    expect(d.levels.length).toBe(2);
    const newLevel = d.levels.find((l) => l.name === "Second Floor")!;
    expect(newLevel).toBeDefined();
    expect(d.activeLevelId).toBe(newLevel.id);
    expect(newLevel.elevation).toBe(d.levels[0]!.elevation + d.levels[0]!.floorToCeiling);
  });

  it("a single patch can add a level and then populate it, in one turn", () => {
    const doc = basePlan();
    const { doc: d, changes } = apply(doc, [
      { op: "addLevel", name: "Second Floor" },
      { op: "addRoom", roomId: "bed1", program: "bedroom", areaWeight: 1 },
      { op: "addRoom", roomId: "bed2", program: "bedroom", areaWeight: 1 },
    ]);
    const level = activeLevel(d);
    expect(level.name).toBe("Second Floor");
    expect(Object.keys(level.graph.rooms).sort()).toEqual(["bed1", "bed2"]);
    expect(changes.some((c) => c.includes("Added Second Floor"))).toBe(true);
  });

  it("addLevel with copyFromLevelId carries over room metadata and geometry", () => {
    let doc = basePlan();
    ({ doc } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "My Kitchen", areaWeight: 1 }]));
    const groundLevelId = doc.activeLevelId;
    const { doc: d } = apply(doc, [{ op: "addLevel", name: "Upstairs", copyFromLevelId: groundLevelId }]);
    const level = activeLevel(d);
    expect(level.graph.rooms.kitchen?.name).toBe("My Kitchen");
    expect(level.graph.rooms.kitchen?.program).toBe("kitchen");
    expect(generatorTree(level)).toMatchObject({ kind: "leaf", roomId: "kitchen" });
    // The copy must not alias the source's openings.
    expect(level.openings ?? []).toEqual([]);
  });

  it("setActiveLevel switches without touching either level's contents", () => {
    let doc = basePlan();
    const groundId = doc.activeLevelId;
    ({ doc } = apply(doc, [{ op: "addLevel", name: "Second Floor" }]));
    const secondId = doc.activeLevelId;
    ({ doc } = apply(doc, [{ op: "setActiveLevel", levelId: groundId }]));
    expect(doc.activeLevelId).toBe(groundId);
    ({ doc } = apply(doc, [{ op: "setActiveLevel", levelId: secondId }]));
    expect(doc.activeLevelId).toBe(secondId);
  });

  it("renameLevel and setLevelProps update the target level", () => {
    let doc = basePlan();
    const levelId = doc.activeLevelId;
    ({ doc } = apply(doc, [{ op: "renameLevel", levelId, name: "Ground Floor" }]));
    ({ doc } = apply(doc, [{ op: "setLevelProps", levelId, elevation: 100, floorToCeiling: 3000 }]));
    const level = doc.levels.find((l) => l.id === levelId)!;
    expect(level.name).toBe("Ground Floor");
    expect(level.elevation).toBe(100);
    expect(level.floorToCeiling).toBe(3000);
  });

  it("removeLevel refuses to remove the only level", () => {
    const doc = basePlan();
    const result = applyPatch(doc, { ops: [{ op: "removeLevel", levelId: doc.activeLevelId }], source: "user" });
    expect(result.ok).toBe(false);
  });

  it("removeLevel re-points activeLevelId to the nearest surviving level by elevation", () => {
    let doc = basePlan();
    ({ doc } = apply(doc, [{ op: "addLevel", name: "L2" }])); // elevation ~2440
    ({ doc } = apply(doc, [{ op: "addLevel", name: "L3" }])); // elevation ~4880
    const l2 = doc.levels.find((l) => l.name === "L2")!;
    const l3 = doc.levels.find((l) => l.name === "L3")!;
    ({ doc } = apply(doc, [{ op: "setActiveLevel", levelId: l3.id }]));
    ({ doc } = apply(doc, [{ op: "removeLevel", levelId: l3.id }]));
    expect(doc.levels.length).toBe(2);
    expect(doc.activeLevelId).toBe(l2.id);
  });
});
