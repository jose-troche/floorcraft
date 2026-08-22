import { describe, expect, it } from "vitest";
import {
  buildPlanarGraph,
  calibrateScale,
  decomposeIntoRectangles,
  detectFloorPlan,
  mergeCollinearSegments,
  rebuildAfterWallReview,
  snapToAxes,
  traceFaces,
  type LineSegment,
} from "../src/rasterImport.js";

function polygonArea(pts: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    area += p0.x * p1.y - p1.x * p0.y;
  }
  return Math.abs(area) / 2;
}

describe("snapToAxes", () => {
  it("leaves an already-axis-aligned segment unchanged", () => {
    const s: LineSegment = { x1: 0, y1: 10, x2: 50, y2: 10 };
    expect(snapToAxes([s])).toEqual([s]);
  });

  it("snaps a slightly tilted segment to horizontal", () => {
    const s: LineSegment = { x1: 0, y1: 10, x2: 100, y2: 14 }; // ~2.3 degrees
    const [out] = snapToAxes([s]);
    expect(out!.y1).toBe(out!.y2);
  });

  it("snaps a slightly tilted segment to vertical", () => {
    const s: LineSegment = { x1: 10, y1: 0, x2: 13, y2: 100 };
    const [out] = snapToAxes([s]);
    expect(out!.x1).toBe(out!.x2);
  });

  it("drops a segment too far from either axis", () => {
    const s: LineSegment = { x1: 0, y1: 0, x2: 100, y2: 100 }; // 45 degrees
    expect(snapToAxes([s])).toEqual([]);
  });
});

describe("mergeCollinearSegments", () => {
  it("merges two horizontal segments on the same line with a small gap", () => {
    const a: LineSegment = { x1: 0, y1: 5, x2: 40, y2: 5 };
    const b: LineSegment = { x1: 45, y1: 5, x2: 90, y2: 5 };
    const merged = mergeCollinearSegments([a, b], 10);
    expect(merged.length).toBe(1);
    expect(merged[0]).toEqual({ x1: 0, y1: 5, x2: 90, y2: 5 });
  });

  it("does not merge across a gap larger than the tolerance", () => {
    const a: LineSegment = { x1: 0, y1: 5, x2: 40, y2: 5 };
    const b: LineSegment = { x1: 80, y1: 5, x2: 120, y2: 5 };
    const merged = mergeCollinearSegments([a, b], 10);
    expect(merged.length).toBe(2);
  });

  it("merges vertical segments independently of horizontal ones", () => {
    const a: LineSegment = { x1: 5, y1: 0, x2: 5, y2: 40 };
    const b: LineSegment = { x1: 5, y1: 42, x2: 5, y2: 90 };
    const merged = mergeCollinearSegments([a, b], 10);
    expect(merged.length).toBe(1);
    expect(merged[0]).toEqual({ x1: 5, y1: 0, x2: 5, y2: 90 });
  });
});

/** A 200x100 box split by a vertical wall at x=100 into two 100x100 rooms. */
function twoRoomSegments(): LineSegment[] {
  return [
    { x1: 0, y1: 0, x2: 200, y2: 0 }, // top
    { x1: 0, y1: 100, x2: 200, y2: 100 }, // bottom
    { x1: 0, y1: 0, x2: 0, y2: 100 }, // left
    { x1: 200, y1: 0, x2: 200, y2: 100 }, // right
    { x1: 100, y1: 0, x2: 100, y2: 100 }, // divider
  ];
}

describe("buildPlanarGraph + traceFaces", () => {
  it("traces a single rectangular room as one face with the correct area, excluding the outer face", () => {
    const segments: LineSegment[] = [
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { x1: 0, y1: 50, x2: 100, y2: 50 },
      { x1: 0, y1: 0, x2: 0, y2: 50 },
      { x1: 100, y1: 0, x2: 100, y2: 50 },
    ];
    const graph = buildPlanarGraph(segments);
    const faces = traceFaces(graph);
    expect(faces.length).toBe(1);
    expect(polygonArea(faces[0]!)).toBeCloseTo(100 * 50, 3);
  });

  it("traces a two-room floor plan as exactly two faces, each the right size", () => {
    const graph = buildPlanarGraph(twoRoomSegments());
    const faces = traceFaces(graph);
    expect(faces.length).toBe(2);
    const areas = faces.map(polygonArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(100 * 100, 3);
    expect(areas[1]).toBeCloseTo(100 * 100, 3);
  });

  it("splits a wall at a T-junction from a perpendicular wall", () => {
    const graph = buildPlanarGraph(twoRoomSegments());
    // The top wall (0,0)-(200,0) must be split at x=100 by the divider meeting it there,
    // producing two edges rather than one spanning the whole top.
    const topEdges = Object.values(graph.edges).filter((e) => {
      const a = graph.nodes[e.a]!;
      const b = graph.nodes[e.b]!;
      return a.y === 0 && b.y === 0;
    });
    expect(topEdges.length).toBe(2);
  });
});

describe("decomposeIntoRectangles", () => {
  it("decomposes a plain rectangle into exactly one rect matching its bounds", () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const rects = decomposeIntoRectangles(polygon);
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 100, d: 50 });
  });

  it("decomposes an L-shape into rectangles whose total area matches the polygon", () => {
    // A 100x100 square missing its top-right 50x50 quadrant.
    const polygon = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 100 },
    ];
    const rects = decomposeIntoRectangles(polygon);
    const totalArea = rects.reduce((sum, r) => sum + r.w * r.d, 0);
    expect(totalArea).toBeCloseTo(100 * 100 - 50 * 50, 3);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.d).toBeGreaterThan(0);
    }
  });
});

describe("calibrateScale", () => {
  it("computes mm-per-pixel from a known real-world distance", () => {
    expect(calibrateScale(100, 3048)).toBeCloseTo(30.48, 5); // 100px = 10ft
  });

  it("rejects a non-positive pixel distance", () => {
    expect(() => calibrateScale(0, 1000)).toThrow();
  });
});

describe("detectFloorPlan end to end", () => {
  it("detects two rooms from a two-room floor plan's line segments", () => {
    const { draft } = detectFloorPlan(twoRoomSegments());
    expect(draft.rooms.length).toBe(2);
    for (const room of draft.rooms) {
      const area = room.cellsPx.reduce((sum, r) => sum + r.w * r.d, 0);
      expect(area).toBeCloseTo(100 * 100, 3);
    }
    expect(draft.walls.length).toBeGreaterThan(0);
  });

  it("re-detects as one merged room after the reviewer rejects the dividing wall", () => {
    const { graph, draft } = detectFloorPlan(twoRoomSegments());
    // Find the wall(s) forming the vertical divider at x=100 and reject them.
    const dividerIds = new Set(
      Object.values(graph.edges)
        .filter((e) => graph.nodes[e.a]!.x === 100 && graph.nodes[e.b]!.x === 100)
        .map((e) => e.id),
    );
    expect(dividerIds.size).toBeGreaterThan(0);
    expect(draft.rooms.length).toBe(2);

    const rebuilt = rebuildAfterWallReview(graph, dividerIds);
    expect(rebuilt.rooms.length).toBe(1);
    const area = rebuilt.rooms[0]!.cellsPx.reduce((sum, r) => sum + r.w * r.d, 0);
    expect(area).toBeCloseTo(200 * 100, 3);
  });

  it("tolerates a slightly skewed, gapped, noisy scan of the same floor plan", () => {
    const noisy: LineSegment[] = [
      { x1: 0, y1: 1, x2: 60, y2: 0 },
      { x1: 63, y1: 0, x2: 200, y2: 2 },
      { x1: 0, y1: 100, x2: 200, y2: 99 },
      { x1: 1, y1: 0, x2: 0, y2: 55 },
      { x1: 0, y1: 58, x2: 1, y2: 100 },
      { x1: 200, y1: 0, x2: 199, y2: 100 },
      { x1: 100, y1: 0, x2: 101, y2: 100 },
    ];
    const { draft } = detectFloorPlan(noisy, { axisToleranceDeg: 8, gapTolerancePx: 12, nodeEpsilonPx: 6 });
    expect(draft.rooms.length).toBe(2);
  });
});
