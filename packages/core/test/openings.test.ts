import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import type { PatchOp, PlanDocument } from "../src/types.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(result.errors.join("; ") || result.violations?.map((v) => v.message).join("; "));
  return result.doc;
}

function twoRoomPlan(): PlanDocument {
  let doc = createEmptyPlan({ id: "p", title: "T", units: "metric", boundary: { widthMm: 8000, depthMm: 6000 } });
  doc = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "living", program: "living", name: "Living", areaWeight: 1 }]);
  return doc;
}

function allOpenings(doc: PlanDocument) {
  return Object.values(activeLevel(doc).graph.edges).flatMap((e) => e.openings);
}

describe("openings", () => {
  it("places a door on the wall shared by two rooms", () => {
    const doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    const openings = allOpenings(doc);
    expect(openings).toHaveLength(1);
    expect(openings[0]!.kind).toBe("door");
    expect(openings[0]!.swing).toBeDefined();

    const level = activeLevel(doc);
    const [edgeId] = Object.entries(level.graph.edges).find(([, e]) => e.openings.length > 0)!;
    expect(level.graph.rooms.kitchen!.boundary).toContain(edgeId);
    expect(level.graph.rooms.living!.boundary).toContain(edgeId);
  });

  it("keeps openings across later patches that regenerate the whole graph", () => {
    let doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    const idBefore = allOpenings(doc)[0]!.id;

    // Every one of these rebuilds the wall graph from the tree, discarding all edge ids.
    doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", areaWeight: 0.5 }]);
    doc = apply(doc, [{ op: "renameRoom", roomId: "kitchen", name: "Galley" }]);
    doc = apply(doc, [{ op: "setBoundary", widthMm: 9000, depthMm: 7000 }]);

    const after = allOpenings(doc);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(idBefore);
  });

  it("anchors an exterior opening to a side of its room", () => {
    const doc = twoRoomPlan();
    const level = activeLevel(doc);
    const exteriorEdge = level.graph.rooms.kitchen!.boundary.find((e) => level.graph.edges[e]!.type === "exterior")!;
    const withWindow = apply(doc, [{ op: "addOpening", edgeId: exteriorEdge, kind: "window" }]);
    const persisted = activeLevel(withWindow).openings!;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.anchor.kind).toBe("exterior");
    expect(allOpenings(withWindow)[0]!.sill).toBeGreaterThan(0);
  });

  it("slides along its wall when moved, staying inside the run", () => {
    let doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    const openingId = allOpenings(doc)[0]!.id;
    const centred = allOpenings(doc)[0]!.offset;

    doc = apply(doc, [{ op: "moveOpening", openingId, offsetRatio: 0 }]);
    const atStart = allOpenings(doc)[0]!;
    expect(atStart.offset).toBeLessThan(centred);
    expect(atStart.offset).toBeGreaterThanOrEqual(0);

    // Out-of-range ratios are clamped rather than rejected: a drag that runs past the end
    // of a wall should stop at the end, not fail the gesture.
    doc = apply(doc, [{ op: "moveOpening", openingId, offsetRatio: 5 }]);
    const atEnd = allOpenings(doc)[0]!;
    expect(atEnd.offset).toBeGreaterThan(centred);
  });

  it("removes an opening by id", () => {
    let doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    const openingId = allOpenings(doc)[0]!.id;
    doc = apply(doc, [{ op: "removeOpening", openingId }]);
    expect(allOpenings(doc)).toHaveLength(0);
    expect(activeLevel(doc).openings).toHaveLength(0);
  });

  it("reports a missing wall instead of silently dropping the op", () => {
    const result = applyPatch(twoRoomPlan(), {
      ops: [{ op: "addOpening", betweenRooms: ["kitchen", "nope"], kind: "door" }],
      source: "user",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("addOpening");
  });

  it("gives every opening a fresh id even after one is removed out of order", () => {
    let doc = twoRoomPlan();
    doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", areaWeight: 0.5, adjacentTo: "living" }]);
    doc = apply(doc, [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    doc = apply(doc, [{ op: "addOpening", betweenRooms: ["living", "bath"], kind: "door" }]);
    const first = activeLevel(doc).openings![0]!.id;
    doc = apply(doc, [{ op: "removeOpening", openingId: first }]);
    doc = apply(doc, [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "cased" }]);
    const ids = activeLevel(doc).openings!.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops openings whose room is deleted rather than keeping them invisible", () => {
    let doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", areaWeight: 0.5, adjacentTo: "living" }]);
    doc = apply(doc, [{ op: "addOpening", betweenRooms: ["living", "bath"], kind: "door" }]);
    expect(activeLevel(doc).openings).toHaveLength(2);

    doc = apply(doc, [{ op: "removeRoom", roomId: "bath" }]);
    const remaining = activeLevel(doc).openings!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.anchor).toMatchObject({ kind: "between", rooms: ["kitchen", "living"] });
  });
});
