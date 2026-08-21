// Structural edits to a SlicingTree generator. The patch reducer builds and mutates
// the tree here; solveSlicingTree (slicingSolver.ts) only ever reads it.

import type { NodePath, RoomId, SlicingLeaf, SlicingTree } from "./types.js";

export function getNodeAt(tree: SlicingTree, path: NodePath): SlicingTree {
  let node = tree;
  for (const idx of path) {
    if (node.kind !== "split") throw new Error("path descends past a leaf");
    node = node.children[idx as 0 | 1];
  }
  return node;
}

export function replaceNodeAt(tree: SlicingTree, path: NodePath, replacement: SlicingTree): SlicingTree {
  if (path.length === 0) return replacement;
  if (tree.kind !== "split") throw new Error("path descends past a leaf");
  const [head, ...rest] = path as [number, ...number[]];
  const children: [SlicingTree, SlicingTree] = [...tree.children];
  children[head as 0 | 1] = replaceNodeAt(tree.children[head as 0 | 1], rest, replacement);
  return { ...tree, children };
}

export function findLeafPath(tree: SlicingTree, roomId: RoomId): NodePath | null {
  function walk(node: SlicingTree, path: NodePath): NodePath | null {
    if (node.kind === "leaf") return node.roomId === roomId ? path : null;
    return walk(node.children[0], [...path, 0]) ?? walk(node.children[1], [...path, 1]);
  }
  return walk(tree, []);
}

export function totalAreaWeight(tree: SlicingTree): number {
  if (tree.kind === "leaf") return tree.areaWeight;
  return totalAreaWeight(tree.children[0]) + totalAreaWeight(tree.children[1]);
}

/** Picks a split target when adjacency isn't specified: the leaf with the largest area weight. */
function largestLeafPath(tree: SlicingTree): NodePath {
  function walk(node: SlicingTree, path: NodePath): { path: NodePath; weight: number } {
    if (node.kind === "leaf") return { path, weight: node.areaWeight };
    const a = walk(node.children[0], [...path, 0]);
    const b = walk(node.children[1], [...path, 1]);
    return a.weight >= b.weight ? a : b;
  }
  return walk(tree, []).path;
}

export type InsertOptions = {
  adjacentTo?: RoomId;
  /** Alternates split axis by tree depth when no adjacency hint is given, for a balanced layout. */
  depthHint?: number;
};

export function insertLeaf(
  tree: SlicingTree | undefined,
  newLeaf: SlicingLeaf,
  opts: InsertOptions = {},
): SlicingTree {
  if (!tree) return newLeaf;

  const targetPath = opts.adjacentTo ? findLeafPath(tree, opts.adjacentTo) ?? largestLeafPath(tree) : largestLeafPath(tree);
  const target = getNodeAt(tree, targetPath) as SlicingLeaf;
  const axis: "h" | "v" = targetPath.length % 2 === 0 ? "v" : "h";
  const totalWeight = target.areaWeight + newLeaf.areaWeight;
  const ratio = totalWeight > 0 ? target.areaWeight / totalWeight : 0.5;
  const split: SlicingTree = { kind: "split", axis, ratio, children: [target, newLeaf] };
  return replaceNodeAt(tree, targetPath, split);
}

/** Removes a leaf, collapsing its parent split into the surviving sibling. Returns null if the tree becomes empty. */
export function removeLeaf(tree: SlicingTree, roomId: RoomId): SlicingTree | null {
  const path = findLeafPath(tree, roomId);
  if (!path) return tree;
  if (path.length === 0) return null; // removing the sole room empties the level

  const parentPath = path.slice(0, -1);
  const childIndex = path[path.length - 1] as 0 | 1;
  const parent = getNodeAt(tree, parentPath);
  if (parent.kind !== "split") throw new Error("invariant violated: parent of a leaf path must be a split");
  const sibling = parent.children[childIndex === 0 ? 1 : 0];
  return replaceNodeAt(tree, parentPath, sibling);
}

export function swapLeaves(tree: SlicingTree, roomIdA: RoomId, roomIdB: RoomId): SlicingTree {
  const pathA = findLeafPath(tree, roomIdA);
  const pathB = findLeafPath(tree, roomIdB);
  if (!pathA || !pathB) return tree;
  const leafA = getNodeAt(tree, pathA) as SlicingLeaf;
  const leafB = getNodeAt(tree, pathB) as SlicingLeaf;
  // Geometry is governed by tree position (each split's ratio), not by which roomId a leaf carries —
  // so swapping requires relocating the two leaves wholesale to each other's slot, each keeping its
  // own areaWeight/min sizes intact, rather than exchanging fields while roomId stays put.
  let result = replaceNodeAt(tree, pathA, leafB);
  result = replaceNodeAt(result, pathB, leafA);
  return result;
}

export function updateLeaf(
  tree: SlicingTree,
  roomId: RoomId,
  update: (leaf: SlicingLeaf) => SlicingLeaf,
): SlicingTree {
  const path = findLeafPath(tree, roomId);
  if (!path) return tree;
  const leaf = getNodeAt(tree, path) as SlicingLeaf;
  return replaceNodeAt(tree, path, update(leaf));
}

export function setSplitAt(
  tree: SlicingTree,
  path: NodePath,
  update: { axis?: "h" | "v"; ratio?: number },
): SlicingTree {
  const node = getNodeAt(tree, path);
  if (node.kind !== "split") throw new Error("setSplit path does not point to a split node");
  const next = { ...node, ...(update.axis ? { axis: update.axis } : {}), ...(update.ratio !== undefined ? { ratio: update.ratio } : {}) };
  return replaceNodeAt(tree, path, next);
}
