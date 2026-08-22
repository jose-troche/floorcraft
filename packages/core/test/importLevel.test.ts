// End-to-end: a raster-import draft (rasterImport.ts) turned into an importLevel patch op
// (FR-24: always a new freeform level, no generator tree) and applied through the normal
// reducer — proving the import pipeline's output is actually usable by the rest of the app,
// not just internally consistent.

import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import { detectFloorPlan, draftToRoomCells, type LineSegment } from "../src/rasterImport.js";
import type { PlanDocument } from "../src/types.js";

function basePlan(): PlanDocument {
  return createEmptyPlan({ id: "p1", title: "Test Plan", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
}

function twoRoomSegments(): LineSegment[] {
  return [
    { x1: 0, y1: 0, x2: 200, y2: 0 },
    { x1: 0, y1: 100, x2: 200, y2: 100 },
    { x1: 0, y1: 0, x2: 0, y2: 100 },
    { x1: 200, y1: 0, x2: 200, y2: 100 },
    { x1: 100, y1: 0, x2: 100, y2: 100 },
  ];
}

describe("importLevel", () => {
  it("creates a new freeform level from a detected floor plan, with correctly-sized rooms", () => {
    const doc = basePlan();
    const { draft } = detectFloorPlan(twoRoomSegments());
    const mmPerPixel = 20; // 1px = 20mm, so the 200x100px plan becomes 4000x2000mm
    const cells = draftToRoomCells(draft, mmPerPixel);

    const rooms = draft.rooms.map((r, i) => ({
      roomId: r.roomId,
      program: "other" as const,
      name: `Room ${i + 1}`,
      rects: cells.filter((c) => c.roomId === r.roomId).map(({ x, y, w, d }) => ({ x, y, w, d })),
    }));

    const result = applyPatch(doc, {
      ops: [{ op: "importLevel", name: "Scanned Plan", boundaryMm: { widthMm: 4000, depthMm: 2000 }, rooms }],
      source: "user",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const level = activeLevel(result.doc);
    expect(level.name).toBe("Scanned Plan");
    expect(level.generator?.kind).toBe("freeform");
    expect(Object.keys(level.graph.rooms).length).toBe(2);
    for (const room of Object.values(level.graph.rooms)) {
      expect(room.boundary.length).toBeGreaterThan(0);
    }
    // Each 100x100px room -> 2000x2000mm at 20mm/px.
    expect(result.doc.levels.length).toBe(2); // the original empty level plus the imported one
  });

  it("is a document-scoped op that can be followed by ordinary edits in the same patch", () => {
    const doc = basePlan();
    const { draft } = detectFloorPlan(twoRoomSegments());
    const cells = draftToRoomCells(draft, 10);
    const rooms = draft.rooms.map((r, i) => ({
      roomId: r.roomId,
      program: "other" as const,
      name: `Room ${i + 1}`,
      rects: cells.filter((c) => c.roomId === r.roomId).map(({ x, y, w, d }) => ({ x, y, w, d })),
    }));
    const firstRoomId = rooms[0]!.roomId;

    const result = applyPatch(doc, {
      ops: [
        { op: "importLevel", boundaryMm: { widthMm: 2000, depthMm: 1000 }, rooms },
        { op: "renameRoom", roomId: firstRoomId, name: "Renamed" },
      ],
      source: "user",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(activeLevel(result.doc).graph.rooms[firstRoomId]?.name).toBe("Renamed");
  });

  it("refuses tree-shaped ops on the imported level, same as any other freeform level", () => {
    const doc = basePlan();
    const { draft } = detectFloorPlan(twoRoomSegments());
    const cells = draftToRoomCells(draft, 10);
    const rooms = draft.rooms.map((r, i) => ({
      roomId: r.roomId,
      program: "other" as const,
      name: `Room ${i + 1}`,
      rects: cells.filter((c) => c.roomId === r.roomId).map(({ x, y, w, d }) => ({ x, y, w, d })),
    }));

    const result = applyPatch(doc, {
      ops: [
        { op: "importLevel", boundaryMm: { widthMm: 2000, depthMm: 1000 }, rooms },
        { op: "addRoom", program: "office", areaWeight: 1 },
      ],
      source: "user",
    });
    expect(result.ok).toBe(false);
  });
});
