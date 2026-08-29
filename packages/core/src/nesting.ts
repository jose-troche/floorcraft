// Corner-nook geometry for `nestRoom` (patch.ts). Pure and platform-free (ARC-2): given a
// single rectangular host and a nook size, decides which corner to carve the nook from and
// what shape the host's L-shaped remainder takes.
//
// This is deliberately narrow. A slicing tree is a guillotine partition and a rect-union
// room (FR-11) is a set of axis-aligned rectangles with no holes — neither can express one
// room's floor fully surrounded by another's on every side. What they *can* express, and
// what a person means by "a closet inside the bedroom", is a small room carved from one
// corner of a bigger one: the bigger room gives up a corner and keeps everything else,
// which reads as "inside" without requiring true containment. Picking the corner is a
// layout decision — like which side an adjacency lands on — so it belongs here, not with
// the caller: the model states the sizes, the geometry decides where they fit best.

import type { Rect } from "./types.js";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Order doubles as the tie-break when two corners score equally: top-left wins first. */
export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export type NestPlan = {
  corner: Corner;
  nook: Rect;
  /** Always two pieces — an L-shape decomposes into exactly two rectangles once a corner is fixed. */
  remainder: [Rect, Rect];
  /** The shorter side of the remainder piece's shorter side — how much of a squeeze this corner is. */
  slack: number;
};

function nookAt(host: Rect, corner: Corner, w: number, d: number): Rect {
  const x = corner === "top-left" || corner === "bottom-left" ? host.x : host.x + host.w - w;
  const y = corner === "top-left" || corner === "top-right" ? host.y : host.y + host.d - d;
  return { x, y, w, d };
}

/**
 * The host minus one corner, as two rectangles. One piece keeps the host's full original
 * width (or depth) and is unaffected in that axis; the other is diminished along both,
 * covering the strip beside the nook. Which pairing depends on the corner, but the two
 * pieces always meet edge-to-edge with no gap and no overlap — together they cover
 * exactly `host` minus `nook`.
 */
function remainderFor(host: Rect, nook: Rect, corner: Corner): [Rect, Rect] {
  const onLeft = corner === "top-left" || corner === "bottom-left";
  const onTop = corner === "top-left" || corner === "top-right";
  // The strip beside the nook, spanning the nook's own depth, taking the rest of the width.
  const besideNook: Rect = { x: onLeft ? host.x + nook.w : host.x, y: nook.y, w: host.w - nook.w, d: nook.d };
  // The strip below (or above) both the nook and its neighbour, spanning the full width.
  const fullWidth: Rect = { x: host.x, y: onTop ? host.y + nook.d : host.y, w: host.w, d: host.d - nook.d };
  return [besideNook, fullWidth];
}

function shortSide(r: Rect): number {
  return Math.min(r.w, r.d);
}

/**
 * Tries every corner and returns the one that leaves the roomiest remainder — the corner
 * minimizing the thinnest resulting strip, so a nook lands where it costs the host the
 * least usable floor. Returns null when the nook doesn't strictly fit inside the host on
 * both axes (nothing to carve from, or the whole host would be consumed).
 */
export function planNestedRoom(host: Rect, nookWidth: number, nookDepth: number): NestPlan | null {
  if (nookWidth <= 0 || nookDepth <= 0 || nookWidth >= host.w || nookDepth >= host.d) return null;

  let best: NestPlan | null = null;
  for (const corner of CORNERS) {
    const nook = nookAt(host, corner, nookWidth, nookDepth);
    const remainder = remainderFor(host, nook, corner);
    const slack = Math.min(shortSide(remainder[0]), shortSide(remainder[1]));
    if (!best || slack > best.slack) best = { corner, nook, remainder, slack };
  }
  return best;
}
