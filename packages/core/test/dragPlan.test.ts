import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import {
  findCutForEdge,
  planBoundaryResize,
  planLabelDrag,
  planOpeningDrag,
  planOpeningRotate,
  planWallDrag,
} from "../src/dragPlan.js";
import { solveSlicingTree } from "../src/slicingSolver.js";
import type { EdgeId, PatchOp, PlanDocument } from "../src/types.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(result.errors.join("; ") || result.violations?.map((v) => v.message).join("; "));
  return result.doc;
}

/** Two rooms side by side across a vertical wall, in a plain metric box. */
function twoRoomPlan(): PlanDocument {
  let doc = createEmptyPlan({ id: "p", title: "T", units: "metric", boundary: { widthMm: 10000, depthMm: 8000 } });
  doc = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "living", program: "living", name: "Living", areaWeight: 1 }]);
  return doc;
}

function interiorEdge(doc: PlanDocument): EdgeId {
  const level = activeLevel(doc);
  const found = Object.entries(level.graph.edges).find(([, e]) => e.type === "interior");
  if (!found) throw new Error("expected an interior wall");
  return found[0];
}

function roomRects(doc: PlanDocument) {
  const level = activeLevel(doc);
  const solved = solveSlicingTree(level.generator!.tree!, level.boundary, doc.gridModule);
  if (!solved.ok) throw new Error("unsolvable");
  return Object.fromEntries(solved.leaves.map((l) => [l.roomId, l]));
}

describe("planWallDrag", () => {
  it("moves the wall by editing the enclosing split, not the geometry (SLV-5)", () => {
    const doc = twoRoomPlan();
    const edgeId = interiorEdge(doc);
    const before = roomRects(doc);

    const plan = planWallDrag(doc, edgeId, 1000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.op).toBe("setSplit");

    const after = roomRects(apply(doc, plan.ops));
    expect(after.kitchen!.w).toBeGreaterThan(before.kitchen!.w);
    expect(after.kitchen!.w + after.living!.w).toBe(10000);
  });

  it("clamps at the point where a room would fall under its minimum", () => {
    const doc = twoRoomPlan();
    const edgeId = interiorEdge(doc);
    const plan = planWallDrag(doc, edgeId, -1_000_000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const after = roomRects(apply(doc, plan.ops));
    // Kitchen's program minimum is 2440mm wide; the drag stops there rather than passing it.
    expect(after.kitchen!.w).toBeGreaterThanOrEqual(2440);
  });

  it("refuses to drag an exterior wall, pointing at the boundary handles instead", () => {
    const doc = twoRoomPlan();
    const level = activeLevel(doc);
    const exterior = Object.entries(level.graph.edges).find(([, e]) => e.type === "exterior")![0];
    const plan = planWallDrag(doc, exterior, 500);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("boundary");
  });

  it("rejects a drag that would override a pinned dimension (SLV-8)", () => {
    let doc = twoRoomPlan();
    doc = apply(doc, [{ op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 4000 }]);
    const plan = planWallDrag(doc, interiorEdge(doc), 1500);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("Kitchen");
    expect(plan.reason).toContain("pinned");
  });

  it("finds the deepest split covering a nested wall", () => {
    let doc = twoRoomPlan();
    doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", areaWeight: 0.6, adjacentTo: "living" }]);
    const level = activeLevel(doc);
    for (const [edgeId, edge] of Object.entries(level.graph.edges)) {
      if (edge.type !== "interior") continue;
      const cut = findCutForEdge(doc, edgeId);
      expect(cut).not.toBeNull();
      // Whatever cut is chosen must actually cover the edge it was found for.
      const a = level.graph.nodes[edge.a]!;
      const b = level.graph.nodes[edge.b]!;
      const vertical = a.x === b.x;
      expect(cut!.axis).toBe(vertical ? "v" : "h");
      expect(Math.abs(cut!.position - (vertical ? a.x : a.y))).toBeLessThanOrEqual(1);
    }
  });
});

describe("planBoundaryResize", () => {
  it("grows the footprint from the south-east corner", () => {
    const doc = twoRoomPlan();
    const plan = planBoundaryResize(doc, "southeast", 2000, 1000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops[0]).toEqual({ op: "setBoundary", widthMm: 12000, depthMm: 9000 });
  });

  it("only moves the axis its handle owns", () => {
    const doc = twoRoomPlan();
    const east = planBoundaryResize(doc, "east", 1000, 5000);
    expect(east.ok && east.ops[0]).toEqual({ op: "setBoundary", widthMm: 11000, depthMm: 8000 });
    const south = planBoundaryResize(doc, "south", 5000, 1000);
    expect(south.ok && south.ops[0]).toEqual({ op: "setBoundary", widthMm: 10000, depthMm: 9000 });
  });

  it("stops at the smallest footprint the rooms can occupy", () => {
    const doc = twoRoomPlan();
    const plan = planBoundaryResize(doc, "southeast", -100_000, -100_000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const op = plan.ops[0] as { widthMm: number; depthMm: number };
    // Kitchen (2440) + Living (3050) must still fit side by side.
    expect(op.widthMm).toBeGreaterThanOrEqual(2440 + 3050);
    expect(applyPatch(doc, { ops: plan.ops, source: "user" }).ok).toBe(true);
  });
});

describe("opening and label gestures", () => {
  function planWithDoor(): { doc: PlanDocument; openingId: string } {
    const doc = apply(twoRoomPlan(), [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
    return { doc, openingId: activeLevel(doc).openings![0]!.id };
  }

  it("slides an opening to where the pointer is", () => {
    const { doc, openingId } = planWithDoor();
    const plan = planOpeningDrag(doc, openingId, { x: 5000, y: 500 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = apply(doc, plan.ops);
    const opening = Object.values(activeLevel(moved).graph.edges).flatMap((e) => e.openings)[0]!;
    // Pointer near the top of an 8m wall puts the door near the top.
    expect(opening.offset).toBeLessThan(1500);
  });

  it("cycles a door's swing and leaves windows alone", () => {
    const { doc, openingId } = planWithDoor();
    const rotate = planOpeningRotate(doc, openingId);
    expect(rotate.ok).toBe(true);
    if (!rotate.ok) return;
    const rotated = apply(doc, rotate.ops);
    expect(activeLevel(rotated).openings![0]!.swing).not.toBe(activeLevel(doc).openings![0]!.swing);

    const withWindow = apply(doc, [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "window" }]);
    const windowId = activeLevel(withWindow).openings![1]!.id;
    expect(planOpeningRotate(withWindow, windowId).ok).toBe(false);
  });

  it("keeps a dragged room label inside its own room", () => {
    const doc = twoRoomPlan();
    const plan = planLabelDrag(doc, "kitchen", { x: -50_000, y: 99_999 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = apply(doc, plan.ops);
    const rect = roomRects(moved).kitchen!;
    const anchor = activeLevel(moved).graph.rooms.kitchen!.labelAnchor!;
    expect(anchor.x).toBeGreaterThanOrEqual(rect.x);
    expect(anchor.x).toBeLessThanOrEqual(rect.x + rect.w);
    expect(anchor.y).toBeGreaterThanOrEqual(rect.y);
    expect(anchor.y).toBeLessThanOrEqual(rect.y + rect.d);
  });
});

/** Phase 2 exit criterion: "wall drag re-solves within one frame at 20 rooms." */
describe("wall drag performance (SLV-4)", () => {
  function twentyRoomPlan(): PlanDocument {
    let doc = createEmptyPlan({ id: "p", title: "T", units: "metric", boundary: { widthMm: 40000, depthMm: 34000 } });
    for (let i = 0; i < 20; i++) {
      doc = apply(doc, [{ op: "addRoom", roomId: `r${i}`, program: "bedroom", areaWeight: 1 }]);
    }
    return doc;
  }

  it("solves a 20-room level well inside one animation frame", () => {
    const doc = twentyRoomPlan();
    const level = activeLevel(doc);
    const start = performance.now();
    for (let i = 0; i < 20; i++) solveSlicingTree(level.generator!.tree!, level.boundary, doc.gridModule);
    expect((performance.now() - start) / 20).toBeLessThan(16);
  });

  it("plans and applies a full drag frame at 20 rooms inside 16ms", () => {
    const doc = twentyRoomPlan();
    const edgeId = interiorEdge(doc);
    // What one pointermove actually costs: plan the gesture, then apply it to get the
    // document the canvas re-renders from.
    const frames = 20;
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      const plan = planWallDrag(doc, edgeId, 100 + i * 10);
      if (!plan.ok) throw new Error(plan.reason);
      const applied = applyPatch(doc, { ops: plan.ops, source: "user" });
      if (!applied.ok) throw new Error("drag frame failed to apply");
    }
    expect((performance.now() - start) / frames).toBeLessThan(16);
  });

  it("still fits the frame budget when a room is pinned and the drag must be checked", () => {
    let doc = twentyRoomPlan();
    doc = apply(doc, [{ op: "setDimension", roomId: "r0", dimensionType: "width", value: 3000 }]);
    const edgeId = interiorEdge(doc);
    const start = performance.now();
    for (let i = 0; i < 20; i++) planWallDrag(doc, edgeId, 100 + i * 10);
    expect((performance.now() - start) / 20).toBeLessThan(16);
  });
});
