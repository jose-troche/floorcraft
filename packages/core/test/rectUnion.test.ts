// Rect-union geometry (Phase 3, FR-11 / DM-2). buildWallGraph's parity with the old
// one-cell-per-room behavior is covered by the existing wallGraph.test.ts and the DXF
// golden fixture; this file covers what's new — multi-cell rooms (L-shapes), and the
// cases that must be rejected rather than silently misrendered.

import { describe, expect, it } from "vitest";
import { buildWallGraph, polygonFromBoundary } from "../src/wallGraph.js";
import type { RoomCell } from "../src/types.js";

function polygonArea(pts: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    area += p0.x * p1.y - p1.x * p0.y;
  }
  return Math.abs(area) / 2;
}

const boundary = { widthMm: 10000, depthMm: 10000 };
const roomMeta = {
  a: { name: "A", program: "living" as const },
  b: { name: "B", program: "kitchen" as const },
};

describe("buildWallGraph — rect unions", () => {
  it("builds a single closed polygon for an L-shape whose area is the sum of its cells", () => {
    // A 4000x4000 square with a 2000x2000 bite taken out of the top-right corner.
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 4000, d: 2000 },
      { roomId: "a", x: 0, y: 2000, w: 2000, d: 2000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const room = result.graph.rooms.a!;
    const pts = polygonFromBoundary(result.graph, room.boundary);
    // 6 true corners, plus one extra collinear point where the two cells' shared corner
    // splits the left wall into two graph edges (edges aren't merged across a cell
    // breakpoint at this level — wallRuns() does that for rendering) — 7 in the raw list.
    expect(pts.length).toBe(7);
    expect(polygonArea(pts)).toBeCloseTo(4000 * 2000 + 2000 * 2000, 5);
  });

  it("dissolves the shared seam between two cells of the same room — no wall drawn there", () => {
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 2000, d: 2000 },
      { roomId: "a", x: 2000, y: 0, w: 2000, d: 2000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The internal seam (x=2000) is fully dissolved — but the top and bottom walls each
    // still split into two graph edges at that same x, since they come from two distinct
    // cells (collinear-edge merging is wallRuns()'s job, not the graph's). 2 (top) + 2
    // (bottom) + 1 (left) + 1 (right) = 6, not the naively-expected 4.
    expect(Object.keys(result.graph.edges).length).toBe(6);
    const area = polygonArea(polygonFromBoundary(result.graph, result.graph.rooms.a!.boundary));
    expect(area).toBeCloseTo(4000 * 2000, 5);
  });

  it("gives two side-by-side rooms a single shared party wall, referenced by both", () => {
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 3000, d: 3000 },
      { roomId: "b", x: 3000, y: 0, w: 3000, d: 3000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const aEdges = new Set(result.graph.rooms.a!.boundary);
    const bEdges = new Set(result.graph.rooms.b!.boundary);
    const shared = [...aEdges].filter((e) => bEdges.has(e));
    expect(shared.length).toBe(1);
  });

  it("rejects two cells of the same room touching only at a corner (pinch point)", () => {
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 2000, d: 2000 },
      { roomId: "a", x: 2000, y: 2000, w: 2000, d: 2000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.reason).toBe("disconnected-room");
  });

  it("rejects a room whose cells enclose a hole", () => {
    // A 3x3 grid of 2000mm cells with the centre cell missing — a ring, same room.
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 2000, d: 2000 },
      { roomId: "a", x: 2000, y: 0, w: 2000, d: 2000 },
      { roomId: "a", x: 4000, y: 0, w: 2000, d: 2000 },
      { roomId: "a", x: 0, y: 2000, w: 2000, d: 2000 },
      // centre (2000,2000) intentionally omitted
      { roomId: "a", x: 4000, y: 2000, w: 2000, d: 2000 },
      { roomId: "a", x: 0, y: 4000, w: 2000, d: 2000 },
      { roomId: "a", x: 2000, y: 4000, w: 2000, d: 2000 },
      { roomId: "a", x: 4000, y: 4000, w: 2000, d: 2000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.reason).toBe("disconnected-room");
  });

  it("rejects two rooms with overlapping cells", () => {
    const cells: RoomCell[] = [
      { roomId: "a", x: 0, y: 0, w: 3000, d: 3000 },
      { roomId: "b", x: 2000, y: 0, w: 3000, d: 3000 },
    ];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.reason).toBe("overlapping-rooms");
  });

  it("rejects a cell that falls outside the level boundary", () => {
    const cells: RoomCell[] = [{ roomId: "a", x: 9000, y: 9000, w: 3000, d: 3000 }];
    const result = buildWallGraph(cells, boundary, roomMeta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.reason).toBe("out-of-bounds");
  });

  it("property: for N disjoint rect unions, polygon area always equals the sum of their cells' area", () => {
    // A 3x3 grid split between two rooms in an L/T arrangement — deliberately irregular.
    const grid = [
      ["a", "a", "b"],
      ["a", "b", "b"],
      ["a", "a", "b"],
    ];
    const size = 1000;
    const cells: RoomCell[] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        cells.push({ roomId: grid[row]![col]!, x: col * size, y: row * size, w: size, d: size });
      }
    }
    const result = buildWallGraph(cells, { widthMm: 3000, depthMm: 3000 }, roomMeta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const roomId of ["a", "b"] as const) {
      const cellArea = cells.filter((c) => c.roomId === roomId).reduce((sum, c) => sum + c.w * c.d, 0);
      const pts = polygonFromBoundary(result.graph, result.graph.rooms[roomId]!.boundary);
      expect(polygonArea(pts)).toBeCloseTo(cellArea, 5);
    }
  });
});
