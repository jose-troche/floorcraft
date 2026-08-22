// DXF R12 ASCII export — specs.md §6.4 (FR-16 client-side, FR-17 must import cleanly
// into LibreCAD, QCAD, AutoCAD and SketchUp, FR-18 embedded scale and units, FR-19 no
// .dwg). Pure function, no platform dependencies (ARC-2).
//
// R12 is deliberate: it is the most widely accepted DXF dialect and needs only LINE,
// ARC, TEXT and POLYLINE — no LWPOLYLINE, no object dictionary, no handles. Everything
// harder to parse is something a target application might reject.
//
// Two conventions matter throughout:
//   * DXF's Y axis points up, the plan's points down, so every Y is mirrored about the
//     level's depth on the way out.
//   * Lengths are written in millimetres, the document's canonical unit (DM-4), and the
//     unit system is stated in the drawing itself as well as in the header.

import { activeLevel } from "./patch.js";
import { formatArea, formatLength } from "./svgRenderer.js";
import { openingSpansOnRun, polygonFromBoundary, wallRunSolids, wallRuns } from "./wallGraph.js";
import type { Opening, PlanDocument, WallGraph } from "./types.js";

export const DXF_LAYERS = ["WALLS", "DOORS", "WINDOWS", "ROOMS", "TEXT", "DIMS"] as const;
export type DxfLayer = (typeof DXF_LAYERS)[number];

/** AutoCAD Color Index per layer — greys and primaries that read on both paper and screen. */
const LAYER_COLORS: Record<DxfLayer, number> = {
  WALLS: 7,
  DOORS: 3,
  WINDOWS: 5,
  ROOMS: 8,
  TEXT: 7,
  DIMS: 6,
};

type Point = { x: number; y: number };

class DxfBuilder {
  private out: string[] = [];

  pair(code: number, value: string | number): void {
    this.out.push(String(code));
    if (typeof value !== "number") {
      this.out.push(value);
      return;
    }
    // Group codes are typed by range, and a reader that expects an integer flag will
    // reject "4.0000" outright. Codes 60-79 and 170-179 are 16-bit ints, 90-99 are
    // 32-bit; everything else we emit is a double.
    const isInteger = (code >= 60 && code <= 79) || (code >= 90 && code <= 99) || (code >= 170 && code <= 179);
    this.out.push(isInteger ? String(Math.round(value)) : fmt(value));
  }

  line(layer: DxfLayer, a: Point, b: Point): void {
    this.pair(0, "LINE");
    this.pair(8, layer);
    this.pair(10, a.x);
    this.pair(20, a.y);
    this.pair(30, 0);
    this.pair(11, b.x);
    this.pair(21, b.y);
    this.pair(31, 0);
  }

  /** Angles in degrees, counter-clockwise from +X, in DXF space. */
  arc(layer: DxfLayer, centre: Point, radius: number, startDeg: number, endDeg: number): void {
    this.pair(0, "ARC");
    this.pair(8, layer);
    this.pair(10, centre.x);
    this.pair(20, centre.y);
    this.pair(30, 0);
    this.pair(40, radius);
    this.pair(50, startDeg);
    this.pair(51, endDeg);
  }

  text(layer: DxfLayer, at: Point, height: number, value: string, centred = false): void {
    this.pair(0, "TEXT");
    this.pair(8, layer);
    this.pair(10, at.x);
    this.pair(20, at.y);
    this.pair(30, 0);
    this.pair(40, height);
    this.pair(1, sanitizeText(value));
    if (centred) {
      this.pair(72, 1); // horizontally centred
      // R12 requires the second alignment point whenever justification is not left.
      this.pair(11, at.x);
      this.pair(21, at.y);
      this.pair(31, 0);
    }
  }

  polyline(layer: DxfLayer, points: Point[], closed: boolean): void {
    if (points.length < 2) return;
    this.pair(0, "POLYLINE");
    this.pair(8, layer);
    this.pair(66, 1); // vertices follow
    this.pair(10, 0);
    this.pair(20, 0);
    this.pair(30, 0);
    this.pair(70, closed ? 1 : 0);
    for (const p of points) {
      this.pair(0, "VERTEX");
      this.pair(8, layer);
      this.pair(10, p.x);
      this.pair(20, p.y);
      this.pair(30, 0);
    }
    this.pair(0, "SEQEND");
    this.pair(8, layer);
  }

  toString(): string {
    // DXF is a line-oriented format; CRLF is what every target application expects.
    return this.out.join("\r\n") + "\r\n";
  }
}

/** Fixed 4-decimal notation: DXF has no tolerance for exponent notation like 1e-7. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  const fixed = n.toFixed(4);
  return fixed === "-0.0000" ? "0.0000" : fixed;
}

/** DXF group value 1 is a single line; control characters would break the record. */
function sanitizeText(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\^/g, "");
}

function headerSection(b: DxfBuilder, extMax: Point): void {
  b.pair(0, "SECTION");
  b.pair(2, "HEADER");
  b.pair(9, "$ACADVER");
  b.pair(1, "AC1009");
  b.pair(9, "$INSBASE");
  b.pair(10, 0);
  b.pair(20, 0);
  b.pair(30, 0);
  b.pair(9, "$EXTMIN");
  b.pair(10, 0);
  b.pair(20, 0);
  b.pair(30, 0);
  b.pair(9, "$EXTMAX");
  b.pair(10, extMax.x);
  b.pair(20, extMax.y);
  b.pair(30, 0);
  // FR-18: the unit system travels in the file, not only in the drawing.
  b.pair(9, "$INSUNITS");
  b.pair(70, 4); // millimetres
  b.pair(9, "$MEASUREMENT");
  b.pair(70, 1); // metric drawing units
  b.pair(0, "ENDSEC");
}

function tablesSection(b: DxfBuilder): void {
  b.pair(0, "SECTION");
  b.pair(2, "TABLES");

  // Every layer names CONTINUOUS, so the linetype has to exist for a strict reader.
  b.pair(0, "TABLE");
  b.pair(2, "LTYPE");
  b.pair(70, 1);
  b.pair(0, "LTYPE");
  b.pair(2, "CONTINUOUS");
  b.pair(70, 64);
  b.pair(3, "Solid line");
  b.pair(72, 65);
  b.pair(73, 0);
  b.pair(40, 0);
  b.pair(0, "ENDTAB");

  b.pair(0, "TABLE");
  b.pair(2, "LAYER");
  b.pair(70, DXF_LAYERS.length);
  for (const layer of DXF_LAYERS) {
    b.pair(0, "LAYER");
    b.pair(2, layer);
    b.pair(70, 0);
    b.pair(62, LAYER_COLORS[layer]);
    b.pair(6, "CONTINUOUS");
  }
  b.pair(0, "ENDTAB");

  b.pair(0, "ENDSEC");
}

function drawWalls(b: DxfBuilder, graph: WallGraph, toDxf: (p: Point) => Point): void {
  // Walls are drawn as two faces rather than a centerline: a CAD user expects walls with
  // thickness, and a centerline is not a drawable object over there.
  for (const { run, thickness, solids } of wallRunSolids(graph)) {
    const half = thickness / 2;
    const along = (at: number, offset: number): Point =>
      run.axis === "v" ? { x: run.coord + offset, y: at } : { x: at, y: run.coord + offset };

    for (const piece of solids) {
      for (const sign of [1, -1]) {
        b.line("WALLS", toDxf(along(piece.from, half * sign)), toDxf(along(piece.to, half * sign)));
      }
      // Close the wall across its thickness at both ends of each solid stretch, which
      // covers the run's ends and both jambs of every opening in one pass.
      b.line("WALLS", toDxf(along(piece.from, -half)), toDxf(along(piece.from, half)));
      b.line("WALLS", toDxf(along(piece.to, -half)), toDxf(along(piece.to, half)));
    }
  }
}

function drawOpenings(b: DxfBuilder, graph: WallGraph, toDxf: (p: Point) => Point): void {
  for (const run of wallRuns(graph)) {
    const thickness = graph.edges[run.edgeIds[0]!]?.thickness ?? 100;
    for (const { span, opening } of openingSpansOnRun(graph, run)) {
      const vertical = run.axis === "v";
      const p0: Point = vertical ? { x: run.coord, y: span.from } : { x: span.from, y: run.coord };
      const p1: Point = vertical ? { x: run.coord, y: span.to } : { x: span.to, y: run.coord };

      if (opening.kind === "window") {
        const inset = thickness * 0.22;
        for (const sign of [1, -1]) {
          const dx = vertical ? inset * sign : 0;
          const dy = vertical ? 0 : inset * sign;
          b.line("WINDOWS", toDxf({ x: p0.x + dx, y: p0.y + dy }), toDxf({ x: p1.x + dx, y: p1.y + dy }));
        }
        continue;
      }
      if (opening.kind !== "door") continue;

      // Same frame as the SVG symbol, so a door hinges the same way on screen and in
      // CAD: `dir` runs low-to-high along the wall, `normal` is its left-hand side.
      const dir: Point = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const normal: Point = { x: -dir.y, y: dir.x };
      const swing = opening.swing ?? "left-in";
      const hingeAtStart = swing.startsWith("left");
      const hinge = hingeAtStart ? p0 : p1;
      const along = hingeAtStart ? dir : { x: -dir.x, y: -dir.y };
      const outward = swing.endsWith("in") ? normal : { x: -normal.x, y: -normal.y };

      const leafEnd: Point = { x: hinge.x + outward.x * opening.width, y: hinge.y + outward.y * opening.width };
      const closed: Point = { x: hinge.x + along.x * opening.width, y: hinge.y + along.y * opening.width };

      b.line("DOORS", toDxf(hinge), toDxf(leafEnd));

      const centre = toDxf(hinge);
      const closedDxf = toDxf(closed);
      const openDxf = toDxf(leafEnd);
      const angleOf = (p: Point) => (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;
      // DXF arcs always run counter-clockwise from start to end, so the two radii are
      // ordered by which sweep is the quarter turn rather than the three-quarter one.
      let a0 = angleOf(closedDxf);
      let a1 = angleOf(openDxf);
      if (norm(a1 - a0) > 180) [a0, a1] = [a1, a0];
      b.arc("DOORS", centre, opening.width, norm(a0), norm(a1));
    }
  }
}

function norm(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function drawRoomsAndText(b: DxfBuilder, doc: PlanDocument, graph: WallGraph, toDxf: (p: Point) => Point, textHeight: number): void {
  for (const room of Object.values(graph.rooms)) {
    const pts = polygonFromBoundary(graph, room.boundary);
    if (pts.length >= 3) b.polyline("ROOMS", pts.map(toDxf), true);
    const anchor = room.labelAnchor;
    if (!anchor) continue;
    const at = toDxf(anchor);
    b.text("TEXT", { x: at.x, y: at.y }, textHeight, room.name, true);
    if (pts.length >= 3) {
      const area = polygonArea(pts);
      b.text("TEXT", { x: at.x, y: at.y - textHeight * 1.6 }, textHeight * 0.75, formatArea(area, doc.units), true);
    }
  }
}

function polygonArea(pts: Point[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    area += p0.x * p1.y - p1.x * p0.y;
  }
  return Math.abs(area) / 2;
}

function drawDimensions(
  b: DxfBuilder,
  doc: PlanDocument,
  graph: WallGraph,
  toDxf: (p: Point) => Point,
  textHeight: number,
  boundary: { widthMm: number; depthMm: number },
): void {
  for (const run of wallRuns(graph)) {
    const length = run.to - run.from;
    if (length < textHeight * 3) continue;
    const mid = (run.from + run.to) / 2;
    const outward = run.type === "exterior" ? (run.coord <= 0 ? -1 : 1) : -1;
    const gap = run.type === "exterior" ? textHeight * 2 : textHeight * 0.9;
    const at: Point = run.axis === "v" ? { x: run.coord + gap * outward, y: mid } : { x: mid, y: run.coord + gap * outward };
    b.text("DIMS", toDxf(at), textHeight * 0.8, formatLength(length, doc.units), true);
  }

  // FR-18: a scale reference and the unit system, drawn below the plan.
  const barMm = doc.units === "metric" ? 1000 : 1219.2;
  const baseY = boundary.depthMm + textHeight * 4;
  const p0 = toDxf({ x: 0, y: baseY });
  const p1 = toDxf({ x: barMm, y: baseY });
  b.line("DIMS", p0, p1);
  b.line("DIMS", toDxf({ x: 0, y: baseY - textHeight * 0.4 }), toDxf({ x: 0, y: baseY + textHeight * 0.4 }));
  b.line("DIMS", toDxf({ x: barMm, y: baseY - textHeight * 0.4 }), toDxf({ x: barMm, y: baseY + textHeight * 0.4 }));
  b.text(
    "DIMS",
    toDxf({ x: 0, y: baseY + textHeight * 2 }),
    textHeight * 0.8,
    `${doc.title} — scale bar ${formatLength(barMm, doc.units)} — drawing units: millimetres (${doc.units} display)`,
  );
}

export type DxfExportOptions = {
  /** Text height in mm; defaults to a size legible when the plan is printed to fit. */
  textHeightMm?: number;
};

export function exportDxf(doc: PlanDocument, options: DxfExportOptions = {}): string {
  const level = activeLevel(doc);
  const graph = level.graph;
  const { widthMm, depthMm } = level.boundary;
  const textHeight = options.textHeightMm ?? Math.max(Math.max(widthMm, depthMm) * 0.014, 80);

  // Mirror Y so the plan reads the right way up in a CAD viewer, and lift the drawing
  // clear of the origin so the scale bar below it stays in positive space.
  const toDxf = (p: Point): Point => ({ x: p.x, y: depthMm - p.y + textHeight * 6 });

  const b = new DxfBuilder();
  headerSection(b, { x: widthMm, y: depthMm + textHeight * 12 });
  tablesSection(b);

  b.pair(0, "SECTION");
  b.pair(2, "ENTITIES");
  drawWalls(b, graph, toDxf);
  drawOpenings(b, graph, toDxf);
  drawRoomsAndText(b, doc, graph, toDxf, textHeight);
  drawDimensions(b, doc, graph, toDxf, textHeight, level.boundary);
  b.pair(0, "ENDSEC");

  b.pair(0, "EOF");
  return b.toString();
}
