import { describe, expect, it } from "vitest";
import { solveSlicingTree } from "../src/slicingSolver.js";
import type { SlicingTree } from "../src/types.js";

describe("solveSlicingTree", () => {
  it("splits a simple two-room tree with no overlap or gap", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [
        { kind: "leaf", roomId: "a", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
        { kind: "leaf", roomId: "b", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
      ],
    };
    const result = solveSlicingTree(tree, { widthMm: 4000, depthMm: 3000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leaves).toHaveLength(2);
    const [a, b] = result.leaves.sort((x, y) => x.x - y.x);
    // No gap: b starts exactly where a ends.
    expect(a!.x + a!.w).toBe(b!.x);
    // No overlap: rectangles don't intersect.
    expect(a!.x + a!.w <= b!.x).toBe(true);
    // Full coverage of the boundary width.
    expect(a!.w + b!.w).toBe(4000);
    expect(a!.d).toBe(3000);
    expect(b!.d).toBe(3000);
  });

  it("enforces minimum dimensions over the requested ratio", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.05, // would give leaf 'a' almost nothing
      children: [
        { kind: "leaf", roomId: "a", areaWeight: 1, minWidth: 2000, minDepth: 1000 },
        { kind: "leaf", roomId: "b", areaWeight: 1, minWidth: 1000, minDepth: 1000 },
      ],
    };
    const result = solveSlicingTree(tree, { widthMm: 4000, depthMm: 3000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.leaves.find((l) => l.roomId === "a")!;
    expect(a.w).toBeGreaterThanOrEqual(2000);
  });

  it("fails structured when the boundary is too small for the minimums", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [
        { kind: "leaf", roomId: "a", areaWeight: 1, minWidth: 3000, minDepth: 3000 },
        { kind: "leaf", roomId: "b", areaWeight: 1, minWidth: 3000, minDepth: 3000 },
      ],
    };
    const result = solveSlicingTree(tree, { widthMm: 4000, depthMm: 3000 }, 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.reason).toBe("boundary-too-small");
    expect(result.violations[0]!.roomIds.sort()).toEqual(["a", "b"]);
  });

  it("produces no zero- or negative-area rooms for a deeper tree", () => {
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
    const result = solveSlicingTree(tree, { widthMm: 6000, depthMm: 5000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const leaf of result.leaves) {
      expect(leaf.w).toBeGreaterThan(0);
      expect(leaf.d).toBeGreaterThan(0);
    }
    const totalArea = result.leaves.reduce((sum, l) => sum + l.w * l.d, 0);
    expect(totalArea).toBe(6000 * 5000);
  });
});
