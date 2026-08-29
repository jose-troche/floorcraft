import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { validatePlan, describeViolations } from "../src/validatePlan.js";
import type { PatchOp, PlanDocument } from "../src/types.js";
import { goldenPlan } from "./fixtures/plan.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(result.errors.join("; ") || JSON.stringify(result.violations));
  return result.doc;
}

function base(): PlanDocument {
  return createEmptyPlan({ id: "v", title: "Validate", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
}

function exteriorEdgeOf(doc: PlanDocument, roomId: string): string {
  const level = doc.levels[0]!;
  const edge = level.graph.rooms[roomId]!.boundary.find((e) => level.graph.edges[e]!.type === "exterior");
  if (!edge) throw new Error("no exterior edge");
  return edge;
}

describe("validatePlan", () => {
  it("reports an empty level without calling it invalid", () => {
    const result = validatePlan(base());
    expect(result.valid).toBe(true);
    expect(result.violations.map((v) => v.reason)).toEqual(["no-rooms"]);
  });

  it("treats a door-less plan as a warning, not a failure", () => {
    const doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1.2 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1.6 },
    ]);
    const result = validatePlan(doc);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.reason).toBe("missing-egress");
    expect(result.violations[0]!.severity).toBe("warning");
  });

  it("fails a plan whose doors never reach the outside", () => {
    const doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1.2 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1.6 },
      { op: "addOpening", betweenRooms: ["k", "l"], kind: "door" },
    ]);
    const result = validatePlan(doc);
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.reason)).toEqual(["missing-egress"]);
    expect(describeViolations(result)).toMatch(/no way in or out/);
  });

  it("names the rooms an exterior door cannot reach", () => {
    let doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1.2 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1.6, adjacentTo: "k" },
      { op: "addRoom", roomId: "b", program: "bedroom", name: "Back Bedroom", areaWeight: 1.2, adjacentTo: "l" },
    ]);
    doc = apply(doc, [
      { op: "addOpening", edgeId: exteriorEdgeOf(doc, "k"), kind: "door" },
      { op: "addOpening", betweenRooms: ["k", "l"], kind: "door" },
    ]);
    const result = validatePlan(doc);
    expect(result.valid).toBe(false);
    const stranded = result.violations.find((v) => v.reason === "unreachable-room");
    expect(stranded?.roomIds).toEqual(["b"]);
    expect(stranded?.message).toMatch(/Back Bedroom/);
  });

  it("does not count a window as a way through", () => {
    let doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1.2 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1.6 },
    ]);
    doc = apply(doc, [{ op: "addOpening", edgeId: exteriorEdgeOf(doc, "k"), kind: "window" }]);
    const result = validatePlan(doc);
    // The only opening is a window, so the plan is still door-less rather than reachable.
    expect(result.violations.map((v) => v.reason)).toEqual(["missing-egress"]);
    expect(result.violations[0]!.severity).toBe("warning");
  });

  it("passes a plan with an exterior door and an interior route", () => {
    let doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1.2 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1.6, adjacentTo: "k" },
    ]);
    doc = apply(doc, [
      { op: "addOpening", edgeId: exteriorEdgeOf(doc, "l"), kind: "door" },
      { op: "addOpening", betweenRooms: ["k", "l"], kind: "door" },
    ]);
    const result = validatePlan(doc);
    expect(result).toEqual({ valid: true, violations: [] });
    expect(describeViolations(result)).toBe("No problems found.");
  });

  it("flags a freeform room dragged below its program minimum", () => {
    let doc = apply(base(), [
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1 },
    ]);
    doc = apply(doc, [{ op: "detachGenerator" }]);
    // A drag the solver never got to vet: the kitchen keeps a 1 m strip, the living
    // room takes the rest of the level.
    doc = apply(doc, [
      { op: "setRoomRects", roomId: "k", rects: [{ x: 0, y: 0, w: 9144, d: 1000 }] },
      { op: "setRoomRects", roomId: "l", rects: [{ x: 0, y: 1000, w: 9144, d: 11192 }] },
    ]);
    const result = validatePlan(doc);
    expect(result.valid).toBe(false);
    const tooSmall = result.violations.find((v) => v.reason === "min-dimension");
    expect(tooSmall?.roomIds).toEqual(["k"]);
    expect(tooSmall?.message).toMatch(/needs at least 2440 x 2440 mm/);
  });

  it("never reports min-dimension on a solver-generated layout", () => {
    // SLV-2 is enforced during the solve, so the golden fixture cannot contain one.
    const violations = validatePlan(goldenPlan()).violations;
    expect(violations.filter((v) => v.reason === "min-dimension")).toEqual([]);
  });
});
