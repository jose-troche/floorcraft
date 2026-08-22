// PDF export — specs.md §6.4 (FR-16 client-side Blob, FR-18 scale reference and units)
// with paper sizes, a scale bar and a title block. Pure function, no dependencies: a PDF
// writer for this drawing is a few hundred lines, and a library would cost more of the
// 250 KB bundle budget (NFR-2) than the whole rest of the app.
//
// The output is PDF 1.4 with a single uncompressed content stream and one standard
// Type 1 font, which every viewer since Acrobat 3 can open.

import { activeLevel } from "./patch.js";
import { formatArea, formatLength, PROGRAM_COLORS } from "./svgRenderer.js";
import { openingSpansOnRun, polygonFromBoundary, wallRunSolids, wallRuns, type Point } from "./wallGraph.js";
import type { PlanDocument, Units, WallGraph } from "./types.js";

export type PaperSize = "A4" | "A3" | "Letter" | "Tabloid";
export type Orientation = "portrait" | "landscape";

/** Paper dimensions in PostScript points (1/72"), portrait. */
const PAPER_POINTS: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 595.28, h: 841.89 },
  A3: { w: 841.89, h: 1190.55 },
  Letter: { w: 612, h: 792 },
  Tabloid: { w: 792, h: 1224 },
};

const MM_PER_POINT = 25.4 / 72;
const MARGIN_PT = 36; // 12.7 mm
const TITLE_BLOCK_PT = 64;

/** Helvetica advance widths (units of 1/1000 em) for printable ASCII, for centred text. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32]! : 556;
  }
  return (units / 1000) * fontSize;
}

/**
 * Typography that has no WinAnsi byte but a perfectly good ASCII stand-in. Without this
 * the em dashes separating title-block fields print as question marks.
 */
const TRANSLITERATIONS: Record<string, string> = {
  "\u2014": "-",
  "\u2013": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2026": "...",
  "\u00d7": "x",
};

/** WinAnsi covers Latin-1; anything past it is transliterated, then escaped. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = TRANSLITERATIONS[ch] ?? (ch.charCodeAt(0) <= 255 ? ch : "?");
    for (const c of mapped) out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
  }
  return out;
}

class ContentStream {
  private ops: string[] = [];

  private static num(n: number): string {
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  gray(level: number): void {
    this.ops.push(`${ContentStream.num(level)} g`);
  }
  strokeGray(level: number): void {
    this.ops.push(`${ContentStream.num(level)} G`);
  }
  fillHex(hex: string): void {
    const [r, g, b] = hexToRgb(hex);
    this.ops.push(`${ContentStream.num(r)} ${ContentStream.num(g)} ${ContentStream.num(b)} rg`);
  }
  lineWidth(w: number): void {
    this.ops.push(`${ContentStream.num(w)} w`);
  }
  moveTo(p: Point): void {
    this.ops.push(`${ContentStream.num(p.x)} ${ContentStream.num(p.y)} m`);
  }
  lineTo(p: Point): void {
    this.ops.push(`${ContentStream.num(p.x)} ${ContentStream.num(p.y)} l`);
  }
  curveTo(c1: Point, c2: Point, to: Point): void {
    this.ops.push(
      `${ContentStream.num(c1.x)} ${ContentStream.num(c1.y)} ${ContentStream.num(c2.x)} ${ContentStream.num(c2.y)} ` +
        `${ContentStream.num(to.x)} ${ContentStream.num(to.y)} c`,
    );
  }
  closePath(): void {
    this.ops.push("h");
  }
  fill(): void {
    this.ops.push("f");
  }
  stroke(): void {
    this.ops.push("S");
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(`${ContentStream.num(x)} ${ContentStream.num(y)} ${ContentStream.num(w)} ${ContentStream.num(h)} re`);
  }
  polygon(points: Point[]): void {
    if (points.length === 0) return;
    this.moveTo(points[0]!);
    for (const p of points.slice(1)) this.lineTo(p);
    this.closePath();
  }
  text(at: Point, size: number, value: string, align: "left" | "centre" = "left"): void {
    const x = align === "centre" ? at.x - textWidth(value, size) / 2 : at.x;
    this.ops.push(
      `BT /F1 ${ContentStream.num(size)} Tf ${ContentStream.num(x)} ${ContentStream.num(at.y)} Td (${pdfString(value)}) Tj ET`,
    );
  }
  save(): void {
    this.ops.push("q");
  }
  restore(): void {
    this.ops.push("Q");
  }
  toString(): string {
    return this.ops.join("\n");
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export type PdfExportOptions = {
  paperSize?: PaperSize;
  orientation?: Orientation;
  /** Draughtsman's name or project reference for the title block. */
  drawnBy?: string;
};

export function exportPdf(doc: PlanDocument, options: PdfExportOptions = {}): Uint8Array {
  const paper = PAPER_POINTS[options.paperSize ?? "A4"];
  const orientation = options.orientation ?? "landscape";
  const pageW = orientation === "landscape" ? paper.h : paper.w;
  const pageH = orientation === "landscape" ? paper.w : paper.h;

  const level = activeLevel(doc);
  const graph = level.graph;
  const { widthMm, depthMm } = level.boundary;

  // Fit the plan into what is left after margins and the title block, keeping a little
  // room at the edges for the dimension strings that hang outside the footprint.
  const drawW = pageW - MARGIN_PT * 2;
  const drawH = pageH - MARGIN_PT * 2 - TITLE_BLOCK_PT;
  // The 1.16 leaves a sixteenth of the plan's size at each edge for the dimension
  // strings, which hang outside the footprint.
  const planWpt = widthMm / MM_PER_POINT;
  const planHpt = depthMm / MM_PER_POINT;
  /** Points per millimetre. */
  const s = Math.min(drawW / (planWpt * 1.16), drawH / (planHpt * 1.16)) / MM_PER_POINT;

  const originX = MARGIN_PT + (drawW - widthMm * s) / 2;
  // PDF's Y axis points up; the plan's points down, so the level is flipped about its depth.
  const originY = MARGIN_PT + TITLE_BLOCK_PT + (drawH - depthMm * s) / 2 + depthMm * s;
  const toPdf = (p: Point): Point => ({ x: originX + p.x * s, y: originY - p.y * s });
  const fontSize = Math.max(Math.min(widthMm, depthMm) * 0.018 * s, 6);

  const cs = new ContentStream();
  drawRoomFills(cs, graph, toPdf);
  drawWalls(cs, graph, toPdf);
  drawOpenings(cs, graph, toPdf, s);
  drawRoomText(cs, doc, graph, toPdf, fontSize);
  drawDimensions(cs, doc, graph, toPdf, fontSize, s);
  drawTitleBlock(cs, doc, { pageW, pageH }, s, options.drawnBy);

  return assemblePdf(cs.toString(), pageW, pageH);
}

function drawRoomFills(cs: ContentStream, graph: WallGraph, toPdf: (p: Point) => Point): void {
  for (const room of Object.values(graph.rooms)) {
    const pts = polygonFromBoundary(graph, room.boundary);
    if (pts.length < 3) continue;
    cs.save();
    cs.fillHex(PROGRAM_COLORS[room.program] ?? PROGRAM_COLORS.other);
    cs.polygon(pts.map(toPdf));
    cs.fill();
    cs.restore();
  }
}

function drawWalls(cs: ContentStream, graph: WallGraph, toPdf: (p: Point) => Point): void {
  cs.save();
  cs.gray(0.1);
  for (const { run, thickness, solids } of wallRunSolids(graph)) {
    const half = thickness / 2;
    for (const piece of solids) {
      const a = run.axis === "v" ? { x: run.coord - half, y: piece.from } : { x: piece.from, y: run.coord - half };
      const b = run.axis === "v" ? { x: run.coord + half, y: piece.to } : { x: piece.to, y: run.coord + half };
      const p0 = toPdf(a);
      const p1 = toPdf(b);
      cs.rect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
      cs.fill();
    }
  }
  cs.restore();
}

function drawOpenings(cs: ContentStream, graph: WallGraph, toPdf: (p: Point) => Point, s: number): void {
  cs.save();
  cs.strokeGray(0.25);
  cs.lineWidth(Math.max(0.4, 20 * s));
  for (const run of wallRuns(graph)) {
    const thickness = graph.edges[run.edgeIds[0]!]?.thickness ?? 100;
    const vertical = run.axis === "v";
    const dir: Point = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const normal: Point = { x: -dir.y, y: dir.x };

    for (const { span, opening } of openingSpansOnRun(graph, run)) {
      const p0: Point = vertical ? { x: run.coord, y: span.from } : { x: span.from, y: run.coord };
      const p1: Point = vertical ? { x: run.coord, y: span.to } : { x: span.to, y: run.coord };

      if (opening.kind === "window") {
        const inset = thickness * 0.22;
        for (const sign of [1, -1]) {
          cs.moveTo(toPdf({ x: p0.x + normal.x * inset * sign, y: p0.y + normal.y * inset * sign }));
          cs.lineTo(toPdf({ x: p1.x + normal.x * inset * sign, y: p1.y + normal.y * inset * sign }));
        }
        cs.stroke();
        continue;
      }
      if (opening.kind !== "door") continue;

      const swing = opening.swing ?? "left-in";
      const hingeAtStart = swing.startsWith("left");
      const hinge = hingeAtStart ? p0 : p1;
      const along = hingeAtStart ? dir : { x: -dir.x, y: -dir.y };
      const outward = swing.endsWith("in") ? normal : { x: -normal.x, y: -normal.y };
      const r = opening.width;
      const leafEnd = { x: hinge.x + outward.x * r, y: hinge.y + outward.y * r };
      const closed = { x: hinge.x + along.x * r, y: hinge.y + along.y * r };

      cs.moveTo(toPdf(hinge));
      cs.lineTo(toPdf(leafEnd));
      cs.stroke();

      // A quarter circle as one cubic Bézier: the classic 0.5523 control-point ratio is
      // accurate to well under a printer dot at this scale.
      const k = 0.5522847498;
      const c1 = { x: closed.x + outward.x * r * k, y: closed.y + outward.y * r * k };
      const c2 = { x: leafEnd.x + along.x * r * k, y: leafEnd.y + along.y * r * k };
      cs.moveTo(toPdf(closed));
      cs.curveTo(toPdf(c1), toPdf(c2), toPdf(leafEnd));
      cs.stroke();
    }
  }
  cs.restore();
}

function drawRoomText(
  cs: ContentStream,
  doc: PlanDocument,
  graph: WallGraph,
  toPdf: (p: Point) => Point,
  fontSize: number,
): void {
  cs.save();
  cs.gray(0.05);
  for (const room of Object.values(graph.rooms)) {
    const anchor = room.labelAnchor;
    if (!anchor) continue;
    const at = toPdf(anchor);
    cs.text({ x: at.x, y: at.y }, fontSize, room.name, "centre");
    const pts = polygonFromBoundary(graph, room.boundary);
    if (pts.length >= 3) {
      cs.text({ x: at.x, y: at.y - fontSize * 1.2 }, fontSize * 0.8, formatArea(polygonArea(pts), doc.units), "centre");
    }
  }
  cs.restore();
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
  cs: ContentStream,
  doc: PlanDocument,
  graph: WallGraph,
  toPdf: (p: Point) => Point,
  fontSize: number,
  s: number,
): void {
  cs.save();
  cs.gray(0.3);
  for (const run of wallRuns(graph)) {
    const length = run.to - run.from;
    if (length * s < fontSize * 3.5) continue; // Would collide with its neighbours on paper.
    if (run.type !== "exterior") continue; // Interior runs are covered by each room's own area text.
    const mid = (run.from + run.to) / 2;
    const outward = run.coord <= 0 ? -1 : 1;
    const gap = (fontSize * 1.6) / s;
    const at: Point = run.axis === "v" ? { x: run.coord + gap * outward, y: mid } : { x: mid, y: run.coord + gap * outward };
    const p = toPdf(at);
    // Vertical runs are lettered horizontally rather than rotated: at paper scale the
    // string is short enough to read beside the wall, and it keeps the text extractable.
    cs.text({ x: p.x, y: p.y }, fontSize * 0.8, formatLength(length, doc.units), "centre");
  }
  cs.restore();
}

/** FR-18: scale bar, unit system, and what this drawing is, along the bottom of the sheet. */
function drawTitleBlock(
  cs: ContentStream,
  doc: PlanDocument,
  page: { pageW: number; pageH: number },
  s: number,
  drawnBy?: string,
): void {
  const level = activeLevel(doc);
  const top = MARGIN_PT + TITLE_BLOCK_PT;
  cs.save();
  cs.strokeGray(0.4);
  cs.lineWidth(0.7);
  cs.rect(MARGIN_PT, MARGIN_PT, page.pageW - MARGIN_PT * 2, TITLE_BLOCK_PT);
  cs.stroke();

  cs.gray(0.05);
  cs.text({ x: MARGIN_PT + 10, y: top - 20 }, 13, doc.title || "Untitled Plan");
  cs.gray(0.3);
  const roomCount = Object.keys(level.graph.rooms).length;
  cs.text(
    { x: MARGIN_PT + 10, y: top - 36 },
    8,
    `${level.name} — ${roomCount} room${roomCount === 1 ? "" : "s"} — ` +
      `${formatLength(level.boundary.widthMm, doc.units)} x ${formatLength(level.boundary.depthMm, doc.units)} — units: ${doc.units}`,
  );
  cs.text({ x: MARGIN_PT + 10, y: top - 48 }, 8, `Updated ${doc.updatedAt.slice(0, 10)}${drawnBy ? ` — ${drawnBy}` : ""} — Floorcraft`);

  // Scale bar: a real measured length on the sheet, so a printed copy can be scaled off.
  const barMm = doc.units === "metric" ? 1000 : 1219.2;
  const barPt = barMm * s;
  const barX = page.pageW - MARGIN_PT - 10 - barPt;
  const barY = MARGIN_PT + 24;
  cs.strokeGray(0.1);
  cs.lineWidth(1.2);
  cs.moveTo({ x: barX, y: barY });
  cs.lineTo({ x: barX + barPt, y: barY });
  cs.moveTo({ x: barX, y: barY - 3 });
  cs.lineTo({ x: barX, y: barY + 3 });
  cs.moveTo({ x: barX + barPt, y: barY - 3 });
  cs.lineTo({ x: barX + barPt, y: barY + 3 });
  cs.stroke();
  cs.gray(0.1);
  cs.text({ x: barX + barPt / 2, y: barY + 8 }, 8, formatLength(barMm, doc.units), "centre");
  cs.text({ x: barX + barPt / 2, y: barY - 12 }, 7, `1 : ${Math.round(1 / (s * MM_PER_POINT))}`, "centre");
  cs.restore();
}

// --------------------------------------------------------- file assembly

function latin1Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

function assemblePdf(content: string, pageW: number, pageH: number): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${latin1Bytes(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(latin1Bytes(body).length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = latin1Bytes(body).length;

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Uint8Array.from(latin1Bytes(body + xref + trailer));
}
