// SVG renderer — specs.md §6.2/§6.4 (FR-6, FR-8..FR-10, FR-18, NFR-6). Pure function:
// no DOM, no network. Same renderer used by the canvas (live) and SVG export (static);
// `interactive` is the only difference between them, adding the hit targets and handles
// the canvas controller needs for FR-7 direct manipulation.

import type { Opening, PlanDocument, RoomProgram, Units, WallGraph } from "./types.js";
import { activeLevel } from "./patch.js";
import { polygonFromBoundary, wallRuns, type Point } from "./wallGraph.js";

// Okabe-Ito colorblind-safe categorical palette (FR-10).
export const PROGRAM_COLORS: Record<RoomProgram, string> = {
  kitchen: "#E69F00",
  living: "#56B4E9",
  family: "#009E73",
  dining: "#F0E442",
  bedroom: "#0072B2",
  "primary-bedroom": "#0072B2",
  bath: "#D55E00",
  "half-bath": "#D55E00",
  laundry: "#CC79A7",
  office: "#999999",
  garage: "#8C8C00",
  hallway: "#DDDDDD",
  closet: "#BBBBBB",
  pantry: "#B4A57A",
  entry: "#A0C4E9",
  mudroom: "#C7B7A3",
  stair: "#4E4E4E",
  other: "#EEEEEE",
};

export function formatLength(mm: number, units: Units): string {
  if (units === "metric") {
    return `${(mm / 1000).toFixed(2)} m`;
  }
  const totalInches = mm / 25.4;
  let feet = Math.floor(totalInches / 12);
  let inches = Math.round(totalInches - feet * 12);
  // Anything from 11.5" up rounds to a full 12", which is a foot and has to be carried:
  // 6704mm is 21'-11.9", and printing it as the literal 21'-12" puts a dimension on the
  // drawing that no one would write and that reads as 33 feet at a glance.
  if (inches === 12) {
    feet += 1;
    inches = 0;
  }
  return inches === 0 ? `${feet}'-0"` : `${feet}'-${inches}"`;
}

export function formatArea(mm2: number, units: Units): string {
  if (units === "metric") return `${(mm2 / 1_000_000).toFixed(1)} m²`;
  return `${Math.round(mm2 / 92903.04)} sq ft`;
}

function polygonPoints(pts: Point[]): string {
  return pts.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Coordinates are mm; a hundredth of a millimetre is well past drawing precision. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type Selection = { kind: "wall" | "opening" | "label" | "boundary"; id: string } | null;

export type RenderOptions = {
  /** Target rendered width in CSS px; height follows the boundary aspect ratio. */
  targetWidthPx?: number;
  showDimensions?: boolean;
  showLegend?: boolean;
  /**
   * Adds pointer/keyboard targets: fat invisible strips over walls, opening and label
   * handles, and boundary grips. Exports leave this off so the file stays clean geometry.
   */
  interactive?: boolean;
  selection?: Selection;
};

type Frame = {
  widthMm: number;
  depthMm: number;
  /** Half the exterior wall thickness plus room to hang dimension strings outside. */
  margin: number;
  legendHeight: number;
};

export function renderSvg(doc: PlanDocument, options: RenderOptions = {}): string {
  const { showDimensions = true, showLegend = true, interactive = false, selection = null } = options;
  const level = activeLevel(doc);
  const graph: WallGraph = level.graph;
  const { widthMm, depthMm } = level.boundary;
  const span = Math.max(widthMm, depthMm);
  const margin = span * 0.1;
  const legendHeight = showLegend ? span * 0.12 : 0;
  const viewW = widthMm + margin * 2;
  const viewH = depthMm + margin * 2 + legendHeight;

  // One text scale for the whole drawing, so labels stay legible on a 4 m studio and a
  // 25 m house alike without the caller having to think about zoom.
  const unit = Math.max(span * 0.014, 80);
  const frame: Frame = { widthMm, depthMm, margin, legendHeight };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(viewW)} ${round(viewH)}" ` +
      `width="${options.targetWidthPx ?? 900}" preserveAspectRatio="xMidYMid meet" role="img">`,
  );
  parts.push(`<title>${escapeXml(doc.title)}</title>`);
  parts.push(
    `<desc>Floor plan, ${level.name}, ${formatLength(widthMm, doc.units)} by ${formatLength(depthMm, doc.units)}, ` +
      `${Object.keys(graph.rooms).length} rooms. Units: ${doc.units}.</desc>`,
  );
  // The canvas maps screen coordinates to level-local millimetres through this group's
  // CTM, which is why it needs a stable id when interactive.
  parts.push(`<g${interactive ? ' id="fc-plan"' : ""} transform="translate(${round(margin)}, ${round(margin)})">`);

  parts.push(...renderRooms(graph, doc.units, interactive, selection));
  parts.push(...renderWalls(graph, interactive, selection));
  parts.push(...renderOpenings(graph, interactive, selection));
  parts.push(...renderLabels(graph, doc.units, unit, interactive, selection));
  if (showDimensions) parts.push(...renderDimensions(graph, doc.units, unit, frame));
  if (interactive) parts.push(...renderBoundaryHandles(frame, unit, selection));

  parts.push(`</g>`);

  if (showLegend) parts.push(...renderLegend(graph, viewH, legendHeight, margin, unit));
  parts.push(...renderScaleBar(doc.units, viewH, margin, unit));

  parts.push(`</svg>`);
  return parts.join("");
}

// ------------------------------------------------------------------ rooms

function renderRooms(graph: WallGraph, units: Units, interactive: boolean, selection: Selection): string[] {
  const parts: string[] = [];
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    const pts = polygonFromBoundary(graph, room.boundary);
    if (pts.length < 3) continue;
    const color = PROGRAM_COLORS[room.program] ?? PROGRAM_COLORS.other;
    const selected = selection?.kind === "label" && selection.id === roomId;
    parts.push(
      `<polygon points="${polygonPoints(pts)}" fill="${color}" fill-opacity="${selected ? 0.75 : 0.55}" ` +
        `stroke="none" data-room-id="${escapeXml(roomId)}"${interactive ? ' class="fc-room"' : ""}>` +
        `<title>${escapeXml(room.name)} — ${formatArea(polygonArea(pts), units)}</title></polygon>`,
    );
  }
  return parts;
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

// ------------------------------------------------------------------ walls

function renderWalls(graph: WallGraph, interactive: boolean, selection: Selection): string[] {
  const parts: string[] = [];
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const selected = selection?.kind === "wall" && selection.id === edgeId;
    parts.push(
      `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}" ` +
        `stroke="${selected ? "#0072B2" : "#222"}" stroke-width="${edge.thickness}" stroke-linecap="square" ` +
        `data-edge-id="${escapeXml(edgeId)}"/>`,
    );
  }
  if (!interactive) return parts;

  // A fat transparent strip over each interior wall: walls are ~114 mm of a drawing
  // several metres wide, far under a comfortable touch target (FR-9).
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (edge.type === "exterior") continue;
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const grab = Math.max(edge.thickness * 4, 260);
    parts.push(
      `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}" ` +
        `stroke="transparent" stroke-width="${grab}" stroke-linecap="butt" class="fc-wall-grab" ` +
        `data-drag="wall" data-edge-id="${escapeXml(edgeId)}" tabindex="0" role="button" ` +
        `aria-label="Wall, drag or use arrow keys to move"/>`,
    );
  }
  return parts;
}

// --------------------------------------------------------------- openings

type OpeningFrame = {
  /** Start and end of the opening along the wall centerline. */
  p0: Point;
  p1: Point;
  /** Unit vector along the wall, and its left-hand normal. */
  dir: Point;
  normal: Point;
  thickness: number;
};

function openingFrame(graph: WallGraph, edgeId: string, opening: Opening): OpeningFrame | null {
  const edge = graph.edges[edgeId];
  if (!edge) return null;
  const a = graph.nodes[edge.a];
  const b = graph.nodes[edge.b];
  if (!a || !b) return null;
  const len = segmentLength(a, b);
  if (len === 0) return null;
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const normal = { x: -dir.y, y: dir.x };
  const p0 = { x: a.x + dir.x * opening.offset, y: a.y + dir.y * opening.offset };
  const p1 = { x: p0.x + dir.x * opening.width, y: p0.y + dir.y * opening.width };
  return { p0, p1, dir, normal, thickness: edge.thickness };
}

function renderOpenings(graph: WallGraph, interactive: boolean, selection: Selection): string[] {
  const parts: string[] = [];
  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    for (const opening of edge.openings) {
      const frame = openingFrame(graph, edgeId, opening);
      if (!frame) continue;
      const selected = selection?.kind === "opening" && selection.id === opening.id;
      const group: string[] = [];

      // Knock the wall out first — every opening kind is a hole before it is a symbol.
      group.push(
        `<line x1="${round(frame.p0.x)}" y1="${round(frame.p0.y)}" x2="${round(frame.p1.x)}" y2="${round(frame.p1.y)}" ` +
          `stroke="#fff" stroke-width="${frame.thickness + 2}" stroke-linecap="butt"/>`,
      );
      group.push(...jambTicks(frame));

      if (opening.kind === "door") group.push(...doorSymbol(frame, opening));
      else if (opening.kind === "window") group.push(...windowSymbol(frame));

      if (interactive) {
        const mid = { x: (frame.p0.x + frame.p1.x) / 2, y: (frame.p0.y + frame.p1.y) / 2 };
        const grab = Math.max(frame.thickness * 3, 300);
        group.push(
          `<line x1="${round(frame.p0.x)}" y1="${round(frame.p0.y)}" x2="${round(frame.p1.x)}" y2="${round(frame.p1.y)}" ` +
            `stroke="transparent" stroke-width="${grab}" stroke-linecap="round" class="fc-opening-grab" ` +
            `data-drag="opening" data-opening-id="${escapeXml(opening.id)}" tabindex="0" role="button" ` +
            `aria-label="${escapeXml(opening.kind)}, drag to slide, press R to rotate"/>`,
        );
        if (selected) {
          group.push(
            `<circle cx="${round(mid.x)}" cy="${round(mid.y)}" r="${round(frame.thickness * 1.2)}" ` +
              `fill="none" stroke="#0072B2" stroke-width="${round(frame.thickness * 0.35)}"/>`,
          );
        }
      }

      parts.push(
        `<g data-opening-id="${escapeXml(opening.id)}" data-opening-kind="${opening.kind}">${group.join("")}</g>`,
      );
    }
  }
  return parts;
}

/** The short strokes that close the wall's faces at either end of an opening. */
function jambTicks(frame: OpeningFrame): string[] {
  const half = frame.thickness / 2;
  const strokes: string[] = [];
  for (const p of [frame.p0, frame.p1]) {
    strokes.push(
      `<line x1="${round(p.x + frame.normal.x * half)}" y1="${round(p.y + frame.normal.y * half)}" ` +
        `x2="${round(p.x - frame.normal.x * half)}" y2="${round(p.y - frame.normal.y * half)}" ` +
        `stroke="#222" stroke-width="${round(frame.thickness * 0.3)}"/>`,
    );
  }
  return strokes;
}

/** Leaf plus swing arc — the conventional plan symbol, hinged per the opening's swing. */
function doorSymbol(frame: OpeningFrame, opening: Opening): string[] {
  const swing = opening.swing ?? "left-in";
  const hingeAtStart = swing.startsWith("left");
  const hinge = hingeAtStart ? frame.p0 : frame.p1;
  const along = hingeAtStart ? frame.dir : { x: -frame.dir.x, y: -frame.dir.y };
  const outward = swing.endsWith("in") ? frame.normal : { x: -frame.normal.x, y: -frame.normal.y };
  const r = opening.width;

  const closed = { x: hinge.x + along.x * r, y: hinge.y + along.y * r };
  const open = { x: hinge.x + outward.x * r, y: hinge.y + outward.y * r };
  // SVG's sweep flag follows the screen's clockwise sense, which the cross product of the
  // two radii settles without any per-orientation special-casing.
  const cross = along.x * outward.y - along.y * outward.x;
  const sweep = cross > 0 ? 1 : 0;
  const stroke = Math.max(frame.thickness * 0.35, 20);

  return [
    `<line x1="${round(hinge.x)}" y1="${round(hinge.y)}" x2="${round(open.x)}" y2="${round(open.y)}" ` +
      `stroke="#222" stroke-width="${round(stroke)}"/>`,
    `<path d="M ${round(closed.x)} ${round(closed.y)} A ${round(r)} ${round(r)} 0 0 ${sweep} ${round(open.x)} ${round(open.y)}" ` +
      `fill="none" stroke="#666" stroke-width="${round(stroke * 0.6)}" stroke-dasharray="${round(r * 0.06)} ${round(r * 0.04)}"/>`,
  ];
}

/** Glazing shown as a pair of lines inset from the wall faces. */
function windowSymbol(frame: OpeningFrame): string[] {
  const inset = frame.thickness * 0.22;
  const stroke = Math.max(frame.thickness * 0.16, 12);
  const lines: string[] = [];
  for (const sign of [1, -1]) {
    const ox = frame.normal.x * inset * sign;
    const oy = frame.normal.y * inset * sign;
    lines.push(
      `<line x1="${round(frame.p0.x + ox)}" y1="${round(frame.p0.y + oy)}" ` +
        `x2="${round(frame.p1.x + ox)}" y2="${round(frame.p1.y + oy)}" stroke="#222" stroke-width="${round(stroke)}"/>`,
    );
  }
  return lines;
}

// --------------------------------------------------------------- labels

function renderLabels(
  graph: WallGraph,
  units: Units,
  unit: number,
  interactive: boolean,
  selection: Selection,
): string[] {
  const parts: string[] = [];
  for (const [roomId, room] of Object.entries(graph.rooms)) {
    const anchor = room.labelAnchor;
    if (!anchor) continue;
    const pts = polygonFromBoundary(graph, room.boundary);
    const area = pts.length >= 3 ? polygonArea(pts) : 0;
    const selected = selection?.kind === "label" && selection.id === roomId;
    const pinned = hasConstraint(room.constraints);

    const group: string[] = [];
    group.push(
      `<text x="${round(anchor.x)}" y="${round(anchor.y)}" font-size="${round(unit)}" text-anchor="middle" ` +
        `dominant-baseline="middle" fill="#111" font-weight="600">${escapeXml(room.name)}</text>`,
    );
    if (area > 0) {
      group.push(
        `<text x="${round(anchor.x)}" y="${round(anchor.y + unit * 1.15)}" font-size="${round(unit * 0.78)}" ` +
          `text-anchor="middle" dominant-baseline="middle" fill="#444">${escapeXml(formatArea(area, units))}</text>`,
      );
    }
    // DIM-7: a pinned room must announce itself, or a rejected wall drag looks like a bug.
    if (pinned) group.push(lockGlyph(anchor.x, anchor.y - unit * 1.15, unit * 0.62));

    if (interactive) {
      group.push(
        `<rect x="${round(anchor.x - unit * 3)}" y="${round(anchor.y - unit * 1.9)}" ` +
          `width="${round(unit * 6)}" height="${round(unit * 3.4)}" fill="transparent" class="fc-label-grab" ` +
          `data-drag="label" data-room-id="${escapeXml(roomId)}" tabindex="0" role="button" ` +
          `aria-label="${escapeXml(room.name)} label, drag to move, press F2 to rename"/>`,
      );
      if (selected) {
        group.push(
          `<rect x="${round(anchor.x - unit * 3)}" y="${round(anchor.y - unit * 1.9)}" ` +
            `width="${round(unit * 6)}" height="${round(unit * 3.4)}" fill="none" stroke="#0072B2" ` +
            `stroke-width="${round(unit * 0.08)}" stroke-dasharray="${round(unit * 0.2)} ${round(unit * 0.15)}"/>`,
        );
      }
    }

    parts.push(`<g data-label-room-id="${escapeXml(roomId)}">${group.join("")}</g>`);
  }
  return parts;
}

function hasConstraint(constraints: import("./types.js").RoomConstraints | undefined): boolean {
  if (!constraints) return false;
  return Boolean(constraints.width || constraints.depth || constraints.area || constraints.aspectRatio);
}

/** A padlock drawn as geometry, so it survives export to formats with no emoji. */
function lockGlyph(cx: number, cy: number, size: number): string {
  const w = size;
  const h = size * 0.72;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const shackleR = w * 0.3;
  return (
    `<g fill="none" stroke="#7a1f1f" stroke-width="${round(size * 0.13)}">` +
    `<path d="M ${round(cx - shackleR)} ${round(y)} v ${round(-shackleR * 0.6)} a ${round(shackleR)} ${round(shackleR)} 0 0 1 ${round(shackleR * 2)} 0 v ${round(shackleR * 0.6)}"/>` +
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(size * 0.12)}" fill="#fdf0f0"/>` +
    `</g>`
  );
}

// ----------------------------------------------------------- dimensions

/** FR-8: one dimension string per wall run, live because the whole SVG re-renders per frame. */
function renderDimensions(graph: WallGraph, units: Units, unit: number, frame: Frame): string[] {
  const parts: string[] = [];
  const fontSize = unit * 0.72;
  for (const run of wallRuns(graph)) {
    const length = run.to - run.from;
    if (length < unit * 3) continue; // Too short to letter without colliding with its neighbours.
    const exterior = run.type === "exterior";
    // Exterior strings sit at the middle of their wall; interior ones are shifted off
    // centre, because a room label sits at the centre of the room and the two collide.
    const along = run.from + length * (exterior ? 0.5 : 0.28);
    // Exterior strings hang outside the footprint; interior ones ride just off the wall.
    const outwardSign = exterior
      ? run.axis === "v"
        ? run.coord <= 0
          ? -1
          : 1
        : run.coord <= 0
          ? -1
          : 1
      : -1;
    const offset = (exterior ? frame.margin * 0.45 : fontSize * 0.7) * outwardSign;

    const x = run.axis === "v" ? run.coord + offset : along;
    const y = run.axis === "v" ? along : run.coord + offset;
    const rotate = run.axis === "v" ? ` transform="rotate(-90 ${round(x)} ${round(y)})"` : "";
    parts.push(
      `<text x="${round(x)}" y="${round(y)}" font-size="${round(fontSize)}" text-anchor="middle" ` +
        `dominant-baseline="middle"${rotate} fill="${exterior ? "#333" : "#666"}" class="fc-dim">` +
        `${escapeXml(formatLength(length, units))}</text>`,
    );
  }
  return parts;
}

// ------------------------------------------------------- boundary handles

function renderBoundaryHandles(frame: Frame, unit: number, selection: Selection): string[] {
  const size = unit * 0.9;
  const handles: Array<{ id: "east" | "south" | "southeast"; x: number; y: number; label: string }> = [
    { id: "east", x: frame.widthMm, y: frame.depthMm / 2, label: "Resize width" },
    { id: "south", x: frame.widthMm / 2, y: frame.depthMm, label: "Resize depth" },
    { id: "southeast", x: frame.widthMm, y: frame.depthMm, label: "Resize width and depth" },
  ];
  return handles.map(
    (h) =>
      `<rect x="${round(h.x - size / 2)}" y="${round(h.y - size / 2)}" width="${round(size)}" height="${round(size)}" ` +
      `fill="${selection?.kind === "boundary" && selection.id === h.id ? "#0072B2" : "#fff"}" stroke="#0072B2" ` +
      `stroke-width="${round(size * 0.12)}" class="fc-boundary-handle" data-drag="boundary" data-handle="${h.id}" ` +
      `tabindex="0" role="button" aria-label="${h.label}"/>`,
  );
}

// ------------------------------------------------------------ decoration

function renderLegend(graph: WallGraph, viewH: number, legendHeight: number, margin: number, unit: number): string[] {
  const programs = [...new Set(Object.values(graph.rooms).map((r) => r.program))];
  if (programs.length === 0) return [];
  const swatch = unit;
  const gap = swatch * 5;
  const parts = [`<g transform="translate(${round(margin)}, ${round(viewH - legendHeight + swatch)})">`];
  programs.forEach((program, i) => {
    const x = (i % 4) * gap;
    const y = Math.floor(i / 4) * (swatch * 2);
    parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(swatch)}" height="${round(swatch)}" fill="${PROGRAM_COLORS[program]}"/>`);
    parts.push(
      `<text x="${round(x + swatch * 1.3)}" y="${round(y + swatch * 0.8)}" font-size="${round(swatch)}" fill="#333">${escapeXml(program)}</text>`,
    );
  });
  parts.push(`</g>`);
  return parts;
}

/** FR-18: every rendering carries a scale reference and names its unit system. */
function renderScaleBar(units: Units, viewH: number, margin: number, unit: number): string[] {
  const lengthMm = units === "metric" ? 1000 : 1219.2; // 1 m or 4 ft
  const y = viewH - margin * 0.3;
  return [
    `<g transform="translate(${round(margin)}, ${round(y)})">` +
      `<line x1="0" y1="0" x2="${round(lengthMm)}" y2="0" stroke="#000" stroke-width="${round(unit * 0.18)}"/>` +
      `<line x1="0" y1="${round(-unit * 0.3)}" x2="0" y2="${round(unit * 0.3)}" stroke="#000" stroke-width="${round(unit * 0.12)}"/>` +
      `<line x1="${round(lengthMm)}" y1="${round(-unit * 0.3)}" x2="${round(lengthMm)}" y2="${round(unit * 0.3)}" stroke="#000" stroke-width="${round(unit * 0.12)}"/>` +
      `<text x="0" y="${round(-unit * 0.6)}" font-size="${round(unit * 0.8)}" fill="#333">` +
      `${escapeXml(formatLength(lengthMm, units))} — ${units}</text></g>`,
  ];
}
