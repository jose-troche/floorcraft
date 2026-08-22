// Raster import — specs.md §6.5 (Phase 4, optional). This module is the deterministic,
// unit-testable half of FR-21's pipeline: collinear merge → axis snap → wall graph
// construction → planar face traversal for room detection, plus FR-22's scale
// calibration math and the rectangle decomposition that turns a detected room's outline
// into cells the existing freeform machinery (patch.ts's setRoomRects, wallGraph.ts's
// buildWallGraph) already knows how to render and edit.
//
// The other half of FR-21 (deskew, adaptive threshold, morphological close, line segment
// detection) needs OpenCV.js/WASM running against real pixels (FR-20) and lives in
// apps/web/src/client/rasterPipeline.ts, which is *not* unit-testable the way this file
// is — it needs a browser, the WASM binary, and a real scanned image to mean anything.
// This module picks up exactly where that one hands off: a flat list of line segments in
// image-pixel coordinates.
//
// ARC-2: pure functions, no DOM, no network — same discipline as the solver and
// exporters, and for the same reason (§10, MCP server, reusable outside the web UI).

import type { Rect, RoomCell, RoomId } from "./types.js";

export type LineSegment = { x1: number; y1: number; x2: number; y2: number };

function length(s: LineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function angleDeg(s: LineSegment): number {
  // Normalized to [0, 180) — a line has no direction, so 179° and 1° are "the same line
  // tilted slightly the other way," not opposite ends of the range.
  const a = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
  const norm = ((a % 180) + 180) % 180;
  return norm;
}

// ---------------------------------------------------------------------------
// Axis snap
// ---------------------------------------------------------------------------

/**
 * Forces every segment within `toleranceDeg` of horizontal or vertical to be *exactly*
 * horizontal or vertical (DM-1's axis-aligned assumption holds everywhere else in this
 * codebase — wallGraph.ts's wallRuns() says as much — so a raster-detected wall a couple
 * of degrees off from a scan skew is snapped, not preserved at an angle nothing downstream
 * can represent). A segment too far from either axis is dropped: it's more likely a
 * misdetection (furniture, text, a diagonal dimension line) than a genuine angled wall,
 * which this system has no representation for regardless.
 */
export function snapToAxes(segments: LineSegment[], toleranceDeg = 8): LineSegment[] {
  const out: LineSegment[] = [];
  for (const s of segments) {
    const a = angleDeg(s);
    const nearHorizontal = a <= toleranceDeg || a >= 180 - toleranceDeg;
    const nearVertical = Math.abs(a - 90) <= toleranceDeg;
    if (nearHorizontal) {
      const y = (s.y1 + s.y2) / 2;
      const x1 = Math.min(s.x1, s.x2);
      const x2 = Math.max(s.x1, s.x2);
      if (x2 > x1) out.push({ x1, y1: y, x2, y2: y });
    } else if (nearVertical) {
      const x = (s.x1 + s.x2) / 2;
      const y1 = Math.min(s.y1, s.y2);
      const y2 = Math.max(s.y1, s.y2);
      if (y2 > y1) out.push({ x1: x, y1, x2: x, y2 });
    }
    // else: dropped — not axis-aligned enough to trust.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collinear merge
// ---------------------------------------------------------------------------

/**
 * Line detection on a real scan fragments what should be one wall into several short,
 * gapped segments (a door swing arc crossing it, a dimension tick, JPEG noise). Segments
 * must already be axis-snapped — merging groups by exact axis + coordinate, which only
 * axis-snapped input can match cleanly.
 */
export function mergeCollinearSegments(segments: LineSegment[], gapTolerancePx = 12): LineSegment[] {
  const horizontal = new Map<number, LineSegment[]>();
  const vertical = new Map<number, LineSegment[]>();
  for (const s of segments) {
    if (s.y1 === s.y2) {
      const arr = horizontal.get(s.y1) ?? [];
      arr.push(s);
      horizontal.set(s.y1, arr);
    } else if (s.x1 === s.x2) {
      const arr = vertical.get(s.x1) ?? [];
      arr.push(s);
      vertical.set(s.x1, arr);
    }
  }

  const out: LineSegment[] = [];
  for (const [y, group] of horizontal) {
    group.sort((a, b) => a.x1 - b.x1);
    let cur = { ...group[0]! };
    for (let i = 1; i < group.length; i++) {
      const s = group[i]!;
      if (s.x1 - cur.x2 <= gapTolerancePx) {
        cur.x2 = Math.max(cur.x2, s.x2);
      } else {
        out.push(cur);
        cur = { ...s };
      }
    }
    out.push(cur);
    void y;
  }
  for (const [x, group] of vertical) {
    group.sort((a, b) => a.y1 - b.y1);
    let cur = { ...group[0]! };
    for (let i = 1; i < group.length; i++) {
      const s = group[i]!;
      if (s.y1 - cur.y2 <= gapTolerancePx) {
        cur.y2 = Math.max(cur.y2, s.y2);
      } else {
        out.push(cur);
        cur = { ...s };
      }
    }
    out.push(cur);
    void x;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planar graph construction
// ---------------------------------------------------------------------------

export type PixelPoint = { x: number; y: number };
export type GraphNodeId = string;
export type GraphEdge = { id: string; a: GraphNodeId; b: GraphNodeId };
export type PlanarGraph = { nodes: Record<GraphNodeId, PixelPoint>; edges: Record<string, GraphEdge> };

class EpsilonNodeAllocator {
  private points: Array<{ id: GraphNodeId; x: number; y: number }> = [];
  private n = 0;
  constructor(private epsilon: number) {}

  get(x: number, y: number): GraphNodeId {
    for (const p of this.points) {
      if (Math.abs(p.x - x) <= this.epsilon && Math.abs(p.y - y) <= this.epsilon) return p.id;
    }
    const id = `p${this.n++}`;
    this.points.push({ id, x, y });
    return id;
  }

  get all(): Record<GraphNodeId, PixelPoint> {
    const out: Record<GraphNodeId, PixelPoint> = {};
    for (const p of this.points) out[p.id] = { x: p.x, y: p.y };
    return out;
  }
}

/**
 * Builds a planar graph from merged, axis-snapped segments: splits every segment at every
 * point where a perpendicular segment crosses it (a T-junction or crossing — the raster
 * equivalent of the breakpoints wallGraph.ts computes from solved rectangles) and at every
 * other same-axis segment's collinear endpoint landing in its interior, then snaps nearby
 * endpoints into shared nodes within `epsilonPx`.
 */
export function buildPlanarGraph(segments: LineSegment[], epsilonPx = 6): PlanarGraph {
  const horizontals = segments.filter((s) => s.y1 === s.y2);
  const verticals = segments.filter((s) => s.x1 === s.x2);

  const breakpointsFor = (s: LineSegment): number[] => {
    const isH = s.y1 === s.y2;
    const set = new Set<number>();
    set.add(isH ? s.x1 : s.y1);
    set.add(isH ? s.x2 : s.y2);
    if (isH) {
      for (const v of verticals) {
        if (v.y1 <= s.y1 + epsilonPx && v.y2 >= s.y1 - epsilonPx && v.x1 >= s.x1 - epsilonPx && v.x1 <= s.x2 + epsilonPx) {
          set.add(Math.min(Math.max(v.x1, s.x1), s.x2));
        }
      }
    } else {
      for (const h of horizontals) {
        if (h.x1 <= s.x1 + epsilonPx && h.x2 >= s.x1 - epsilonPx && h.y1 >= s.y1 - epsilonPx && h.y1 <= s.y2 + epsilonPx) {
          set.add(Math.min(Math.max(h.y1, s.y1), s.y2));
        }
      }
    }
    return [...set].sort((a, b) => a - b);
  };

  const nodes = new EpsilonNodeAllocator(epsilonPx);
  const edges: Record<string, GraphEdge> = {};
  let seq = 0;

  const addSegmentEdges = (s: LineSegment) => {
    const isH = s.y1 === s.y2;
    const pts = breakpointsFor(s);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      if (p1 - p0 < epsilonPx) continue; // degenerate sliver from two breakpoints landing together
      const a = isH ? nodes.get(p0, s.y1) : nodes.get(s.x1, p0);
      const b = isH ? nodes.get(p1, s.y1) : nodes.get(s.x1, p1);
      if (a === b) continue;
      const id = `ge${seq++}`;
      edges[id] = { id, a, b };
    }
  };

  for (const s of horizontals) addSegmentEdges(s);
  for (const s of verticals) addSegmentEdges(s);

  return { nodes: nodes.all, edges };
}

// ---------------------------------------------------------------------------
// Face traversal (room detection)
// ---------------------------------------------------------------------------

export type Face = PixelPoint[];

/**
 * Traces every bounded face of a planar graph — the standard doubly-connected-edge-list
 * walk: from each directed half-edge (u, v), turn onto the most-clockwise half-edge
 * leaving v (the one immediately clockwise from the reverse direction back to u), and
 * repeat until the walk closes. Every half-edge belongs to exactly one face this way; the
 * one face with the largest absolute area is the unbounded exterior and is dropped — every
 * other closed loop found is a candidate room (FR-21's "planar face traversal").
 */
export function traceFaces(graph: PlanarGraph): Face[] {
  const adjacency = new Map<GraphNodeId, GraphNodeId[]>();
  const addAdj = (from: GraphNodeId, to: GraphNodeId) => {
    const arr = adjacency.get(from) ?? [];
    arr.push(to);
    adjacency.set(from, arr);
  };
  for (const e of Object.values(graph.edges)) {
    addAdj(e.a, e.b);
    addAdj(e.b, e.a);
  }
  // Sort each node's neighbours by angle so "the next edge clockwise from a given
  // direction" is a simple index lookup during the walk below.
  const angleOf = (from: GraphNodeId, to: GraphNodeId): number => {
    const a = graph.nodes[from]!;
    const b = graph.nodes[to]!;
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const sortedAdjacency = new Map<GraphNodeId, GraphNodeId[]>();
  for (const [node, neighbours] of adjacency) {
    sortedAdjacency.set(
      node,
      [...neighbours].sort((a, b) => angleOf(node, a) - angleOf(node, b)),
    );
  }

  const nextClockwise = (from: GraphNodeId, arrivedFrom: GraphNodeId, to: GraphNodeId): GraphNodeId => {
    const neighbours = sortedAdjacency.get(to)!;
    const reverseAngle = angleOf(to, from);
    // Find the neighbour whose angle is the next one clockwise (smaller, wrapping) from
    // the reverse direction — that's the tightest right turn, which traces the face on
    // this half-edge's right-hand side.
    let best = neighbours[0]!;
    let bestDelta = Infinity;
    for (const n of neighbours) {
      if (n === from && neighbours.length > 1) continue; // don't immediately backtrack unless it's a dead end
      let delta = reverseAngle - angleOf(to, n);
      delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = n;
      }
    }
    void arrivedFrom;
    return best;
  };

  const visited = new Set<string>();
  const faces: Face[] = [];

  for (const e of Object.values(graph.edges)) {
    for (const [start, end] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as [GraphNodeId, GraphNodeId][]) {
      const key = `${start}>${end}`;
      if (visited.has(key)) continue;

      const loop: GraphNodeId[] = [start];
      let from = start;
      let to = end;
      let guard = 0;
      while (guard++ < Object.keys(graph.edges).length * 2 + 4) {
        visited.add(`${from}>${to}`);
        loop.push(to);
        if (to === start && loop.length > 2) break;
        const next = nextClockwise(from, from, to);
        from = to;
        to = next;
      }
      if (loop[loop.length - 1] === start && loop.length >= 4) {
        faces.push(loop.slice(0, -1).map((id) => graph.nodes[id]!));
      }
    }
  }

  if (faces.length <= 1) return [];
  const areaOf = (f: Face): number => {
    let a = 0;
    for (let i = 0; i < f.length; i++) {
      const p0 = f[i]!;
      const p1 = f[(i + 1) % f.length]!;
      a += p0.x * p1.y - p1.x * p0.y;
    }
    return Math.abs(a) / 2;
  };
  let outerIndex = 0;
  let outerArea = -1;
  faces.forEach((f, i) => {
    const a = areaOf(f);
    if (a > outerArea) {
      outerArea = a;
      outerIndex = i;
    }
  });
  return faces.filter((_, i) => i !== outerIndex);
}

// ---------------------------------------------------------------------------
// Rectangle decomposition
// ---------------------------------------------------------------------------

/**
 * Decomposes a simple rectilinear polygon (guaranteed by axis-snap upstream) into
 * axis-aligned rectangles whose union equals the polygon — a vertical-strip scanline: cut
 * at every distinct X, and within each strip find the inside Y-intervals by casting a ray
 * at the strip's midpoint and pairing crossings with the even-odd rule. The result isn't
 * minimal (adjacent strips with identical Y-ranges aren't merged back into one rect), but
 * that's a cosmetic cell-count concern, not a correctness one — buildWallGraph's same-room
 * seam dissolve already renders any such union as a single clean outline.
 */
export function decomposeIntoRectangles(polygon: PixelPoint[]): Rect[] {
  if (polygon.length < 3) return [];
  const xs = [...new Set(polygon.map((p) => p.x))].sort((a, b) => a - b);
  const rects: Rect[] = [];

  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    const midX = (x0 + x1) / 2;
    const crossings: number[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const p0 = polygon[j]!;
      const p1 = polygon[(j + 1) % polygon.length]!;
      if (p0.x === p1.x) continue; // vertical edges don't cross a vertical ray test at midX
      const loX = Math.min(p0.x, p1.x);
      const hiX = Math.max(p0.x, p1.x);
      if (midX > loX && midX < hiX) crossings.push(p0.y); // horizontal edge: p0.y === p1.y
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const y0 = crossings[k]!;
      const y1 = crossings[k + 1]!;
      if (y1 > y0) rects.push({ x: x0, y: y0, w: x1 - x0, d: y1 - y0 });
    }
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Scale calibration (FR-22)
// ---------------------------------------------------------------------------

/** FR-22: the user draws a line across a dimension of known real-world length. */
export function calibrateScale(pixelDistance: number, realWorldMm: number): number {
  if (pixelDistance <= 0) throw new Error("calibrateScale: pixelDistance must be positive");
  return realWorldMm / pixelDistance;
}

export function scaleFace(face: Face, mmPerPixel: number): Face {
  return face.map((p) => ({ x: Math.round(p.x * mmPerPixel), y: Math.round(p.y * mmPerPixel) }));
}

export function scaleRect(rect: Rect, mmPerPixel: number): Rect {
  return {
    x: Math.round(rect.x * mmPerPixel),
    y: Math.round(rect.y * mmPerPixel),
    w: Math.round(rect.w * mmPerPixel),
    d: Math.round(rect.d * mmPerPixel),
  };
}

// ---------------------------------------------------------------------------
// End-to-end pipeline (segments in -> draft rooms out)
// ---------------------------------------------------------------------------

export type DetectedWall = { id: string; a: PixelPoint; b: PixelPoint };
export type ImportDraft = { walls: DetectedWall[]; rooms: Array<{ roomId: RoomId; cellsPx: Rect[] }> };

/**
 * Runs collinear-merge through face-traversal-to-rectangles as one call, in pixel space.
 * FR-25's per-wall review sits between this and `applyImportDraft` below: the caller
 * shows `walls`, the user drops the rejected ones, and `rebuildAfterWallReview` re-runs
 * face detection on whatever survives — never silently applied (FR-25).
 */
export function detectFloorPlan(rawSegments: LineSegment[], options?: { axisToleranceDeg?: number; gapTolerancePx?: number; nodeEpsilonPx?: number }): {
  graph: PlanarGraph;
  draft: ImportDraft;
} {
  const snapped = snapToAxes(rawSegments, options?.axisToleranceDeg);
  const merged = mergeCollinearSegments(snapped, options?.gapTolerancePx);
  const graph = buildPlanarGraph(merged, options?.nodeEpsilonPx);
  return { graph, draft: draftFromGraph(graph) };
}

function draftFromGraph(graph: PlanarGraph): ImportDraft {
  const walls: DetectedWall[] = Object.values(graph.edges).map((e) => ({ id: e.id, a: graph.nodes[e.a]!, b: graph.nodes[e.b]! }));
  const faces = traceFaces(graph);
  const rooms = faces.map((face, i) => ({ roomId: `imported-${i}`, cellsPx: decomposeIntoRectangles(face) }));
  return { walls, rooms };
}

/** FR-25: re-run face detection after the user has accepted/rejected individual walls. */
export function rebuildAfterWallReview(graph: PlanarGraph, rejectedWallIds: ReadonlySet<string>): ImportDraft {
  const survivingEdges = Object.fromEntries(Object.entries(graph.edges).filter(([id]) => !rejectedWallIds.has(id)));
  return draftFromGraph({ nodes: graph.nodes, edges: survivingEdges });
}

/** Converts a reviewed, calibrated draft into the RoomCell[] the freeform generator
 * machinery (patch.ts's importLevel op, wallGraph.ts's buildWallGraph) already knows how
 * to render and edit — this is what makes FR-24's "detached level" concrete. */
export function draftToRoomCells(draft: ImportDraft, mmPerPixel: number): RoomCell[] {
  const cells: RoomCell[] = [];
  for (const room of draft.rooms) {
    for (const rectPx of room.cellsPx) {
      cells.push({ ...scaleRect(rectPx, mmPerPixel), roomId: room.roomId });
    }
  }
  return cells;
}
