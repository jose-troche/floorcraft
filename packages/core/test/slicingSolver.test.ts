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

describe("solveSlicingTree — pinned dimensions (SLV-6, SLV-7)", () => {
  const leaf = (roomId: string, extra: Partial<Extract<SlicingTree, { kind: "leaf" }>> = {}): SlicingTree => ({
    kind: "leaf",
    roomId,
    areaWeight: 1,
    minWidth: 500,
    minDepth: 500,
    ...extra,
  });

  it("honours a pin on the axis its parent split cuts", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [leaf("a", { exactWidth: 1500 }), leaf("b")],
    };
    const result = solveSlicingTree(tree, { widthMm: 6000, depthMm: 4000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leaves.find((l) => l.roomId === "a")!.w).toBe(1500);
    expect(result.unmet).toEqual([]);
  });

  /**
   * The regression behind "add a kitchen of 8x5 feet": giving a pinned room a neighbour
   * pushed it one level down the tree, and the outer cut — which used to see the leaf —
   * saw a split instead and fell back to area weights, dropping the pin entirely.
   */
  it("keeps a pin visible to an outer cut after the room gains a neighbour", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [
        leaf("other"),
        { kind: "split", axis: "h", ratio: 0.5, children: [leaf("pinned", { exactWidth: 1500, exactDepth: 900 }), leaf("below")] },
      ],
    };
    const result = solveSlicingTree(tree, { widthMm: 6000, depthMm: 4000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pinned = result.leaves.find((l) => l.roomId === "pinned")!;
    expect(pinned.w).toBe(1500);
    expect(pinned.d).toBe(900);
    expect(result.unmet).toEqual([]);
  });

  /**
   * SLV-7: a pin the partition cannot deliver is reported, not silently dropped and not
   * escalated to a failed solve. The lone room of a level has to fill that level — which
   * is exactly how a 8x5 ft kitchen came to be drawn, and labelled, at 30x40 ft.
   */
  it("reports a pin the lone room of a level cannot hold", () => {
    const result = solveSlicingTree(leaf("only", { exactWidth: 2438, exactDepth: 1524 }), { widthMm: 9144, depthMm: 12192 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leaves[0]!.w).toBe(9144);
    expect(result.unmet).toEqual([
      { roomId: "only", axis: "width", requestedMm: 2438, actualMm: 9144 },
      { roomId: "only", axis: "depth", requestedMm: 1524, actualMm: 12192 },
    ]);
  });

  it("reports a pin the room's own minimum overrides, without failing the solve", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [leaf("tight", { minWidth: 2440, exactWidth: 1524 }), leaf("b")],
    };
    const result = solveSlicingTree(tree, { widthMm: 6000, depthMm: 4000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leaves.find((l) => l.roomId === "tight")!.w).toBe(2440);
    expect(result.unmet).toEqual([{ roomId: "tight", axis: "width", requestedMm: 1524, actualMm: 2440 }]);
  });

  /** Unit conversion lands on whole mm (8 ft is 2438.4), so a pin may miss a round minimum by a hair. */
  it("does not report a miss too small to see", () => {
    const tree: SlicingTree = {
      kind: "split",
      axis: "v",
      ratio: 0.5,
      children: [leaf("a", { minWidth: 2440, exactWidth: 2438 }), leaf("b")],
    };
    const result = solveSlicingTree(tree, { widthMm: 6000, depthMm: 4000 }, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unmet).toEqual([]);
  });
});
