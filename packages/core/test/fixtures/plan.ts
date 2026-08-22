// The shared fixture plan behind the golden export files. Deliberately deterministic —
// fixed ids, fixed timestamps, no randomness — because FR-17 asks for a byte comparison
// against golden output in CI, and a drifting fixture would make that check meaningless.

import { applyPatch, createEmptyPlan } from "../../src/patch.js";
import type { PatchOp, PlanDocument } from "../../src/types.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) {
    throw new Error(result.errors.join("; ") || result.violations?.map((v) => v.message).join("; ") || "fixture failed");
  }
  return result.doc;
}

/** A four-room imperial plan with a door, a window and a pinned dimension. */
export function goldenPlan(): PlanDocument {
  let doc = createEmptyPlan({
    id: "golden-plan",
    title: "Golden Fixture",
    units: "imperial",
    boundary: { widthMm: 9144, depthMm: 12192 }, // 30 x 40 ft
  });
  doc = apply(doc, [{ op: "addRoom", roomId: "living", program: "living", name: "Living Room", areaWeight: 1.6 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1.2 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "bedroom", program: "bedroom", name: "Bedroom", areaWeight: 1.2, adjacentTo: "living" }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", name: "Bath", areaWeight: 0.5, adjacentTo: "kitchen" }]);
  doc = apply(doc, [{ op: "addOpening", betweenRooms: ["kitchen", "living"], kind: "door" }]);
  doc = apply(doc, [{ op: "addOpening", betweenRooms: ["bath", "kitchen"], kind: "door", width: 760 }]);

  const level = doc.levels[0]!;
  const exterior = level.graph.rooms.living!.boundary.find((e) => level.graph.edges[e]!.type === "exterior")!;
  doc = apply(doc, [{ op: "addOpening", edgeId: exterior, kind: "window" }]);
  doc = apply(doc, [{ op: "setDimension", roomId: "bath", dimensionType: "width", value: 1830 }]);

  // Timestamps are the only part of the document a clock touches; pinning them keeps the
  // golden files stable without weakening what the comparison covers.
  return { ...doc, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
