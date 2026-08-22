import { describe, expect, it } from "vitest";
import { solveSlicingTree } from "../src/slicingSolver.js";
import { buildWallGraph, polygonFromBoundary } from "../src/wallGraph.js";
import type { SlicingTree } from "../src/types.js";

function shoelaceArea(pts: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    area += p0.x * p1.y - p1.x * p0.y;
  }
  return Math.abs(area) / 2;
}

describe("buildWallGraph", () => {
  const tree: SlicingTree = {
    kind: "split",
    axis: "h",
    ratio: 0.4,
    children: [
      { kind: "leaf", roomId: "top", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
      {
        kind: "split",
        axis: "v",
        ratio: 0.6,
        children: [
          { kind: "leaf", roomId: "bl", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
          { kind: "leaf", roomId: "br", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
        ],
      },
    ],
  };
  const boundary = { widthMm: 6000, depthMm: 5000 };
  const solved = solveSlicingTree(tree, boundary, 100);
  if (!solved.ok) throw new Error("fixture tree should solve");

  const roomMeta = {
    top: { name: "Top", program: "living" as const },
    bl: { name: "Bottom Left", program: "kitchen" as const },
    br: { name: "Bottom Right", program: "bath" as const },
  };
  const built = buildWallGraph(solved.leaves, boundary, roomMeta);
  if (!built.ok) throw new Error("fixture graph should build");
  const graph = built.graph;

  it("gives every room a closed polygon whose area matches its solved rectangle", () => {
    for (const leaf of solved.leaves) {
      const room = graph.rooms[leaf.roomId]!;
      const pts = polygonFromBoundary(graph, room.boundary);
      expect(pts.length).toBeGreaterThanOrEqual(4);
      const area = shoelaceArea(pts);
      expect(area).toBeCloseTo(leaf.w * leaf.d, 0);
    }
  });

  it("marks only edges on the outer rectangle as exterior", () => {
    for (const edge of Object.values(graph.edges)) {
      const a = graph.nodes[edge.a]!;
      const b = graph.nodes[edge.b]!;
      const onBoundary =
        (a.x === 0 && b.x === 0) ||
        (a.x === boundary.widthMm && b.x === boundary.widthMm) ||
        (a.y === 0 && b.y === 0) ||
        (a.y === boundary.depthMm && b.y === boundary.depthMm);
      expect(edge.type === "exterior").toBe(onBoundary);
    }
  });

  it("shares one wall between bl and br, referenced by both rooms", () => {
    const bl = new Set(graph.rooms.bl!.boundary);
    const br = new Set(graph.rooms.br!.boundary);
    const shared = [...bl].filter((e) => br.has(e));
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });
});
