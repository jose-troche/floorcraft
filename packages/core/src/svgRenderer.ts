// SVG renderer — specs.md §6.2/§6.4 (FR-6, FR-8..FR-10, FR-18, NFR-6). Pure function:
// no DOM, no network. Same renderer used by the canvas (live) and SVG export (static).

import type { PlanDocument, RoomProgram, Units, WallGraph } from "./types.js";
import { activeLevel } from "./patch.js";
import { polygonFromBoundary, type Point } from "./wallGraph.js";

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
  other: "#EEEEEE",
};

export function formatLength(mm: number, units: Units): string {
  if (units === "metric") {
    return `${(mm / 1000).toFixed(2)} m`;
  }
  const totalInches = mm / 25.4;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  return inches === 0 ? `${feet}'-0"` : `${feet}'-${inches}"`;
}

function polygonPoints(pts: Point[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type RenderOptions = {
  /** Target rendered width in CSS px; height follows the boundary aspect ratio. */
  targetWidthPx?: number;
  showDimensions?: boolean;
  showLegend?: boolean;
};

export function renderSvg(doc: PlanDocument, options: RenderOptions = {}): string {
  const { showDimensions = true, showLegend = true } = options;
  const level = activeLevel(doc);
  const graph: WallGraph = level.graph;
  const { widthMm, depthMm } = level.boundary;
  const margin = Math.max(widthMm, depthMm) * 0.08;
  const legendHeight = showLegend ? Math.max(widthMm, depthMm) * 0.12 : 0;
  const viewW = widthMm + margin * 2;
  const viewH = depthMm + margin * 2 + legendHeight;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW} ${viewH}" ` +
      `width="${options.targetWidthPx ?? 900}" preserveAspectRatio="xMidYMid meet" role="img">`,
  );
  parts.push(`<title>${escapeXml(doc.title)}</title>`);
  parts.push(
    `<desc>Floor plan, ${level.name}, ${formatLength(widthMm, doc.units)} by ${formatLength(depthMm, doc.units)}, ` +
      `${Object.keys(graph.rooms).length} rooms. Units: ${doc.units}.</desc>`,
  );
  parts.push(`<g transform="translate(${margin}, ${margin})">`);
  parts.push(`<rect x="0" y="0" width="${viewW - margin * 2}" height="${viewH - margin * 2 - legendHeight}" fill="none"/>`);

  const usedProgram = new Set<RoomProgram>();

  for (const [roomId, room] of Object.entries(graph.rooms)) {
    const pts = polygonFromBoundary(graph, room.boundary);
    if (pts.length < 3) continue;
    usedProgram.add(room.program);
    const color = PROGRAM_COLORS[room.program] ?? PROGRAM_COLORS.other;
    parts.push(
      `<polygon points="${polygonPoints(pts)}" fill="${color}" fill-opacity="0.55" ` +
        `stroke="none" data-room-id="${escapeXml(roomId)}"><title>${escapeXml(room.name)}</title></polygon>`,
    );
  }

  // Wall centerlines, stroked to their actual thickness.
  for (const edge of Object.values(graph.edges)) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    parts.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#222" ` +
        `stroke-width="${edge.thickness}" stroke-linecap="square"/>`,
    );
    for (const opening of edge.openings) {
      const len = segmentLength(a, b);
      const frac0 = opening.offset / len;
      const frac1 = (opening.offset + opening.width) / len;
      const ox0 = a.x + (b.x - a.x) * frac0;
      const oy0 = a.y + (b.y - a.y) * frac0;
      const ox1 = a.x + (b.x - a.x) * frac1;
      const oy1 = a.y + (b.y - a.y) * frac1;
      parts.push(
        `<line x1="${ox0}" y1="${oy0}" x2="${ox1}" y2="${oy1}" stroke="#fff" ` +
          `stroke-width="${edge.thickness}" stroke-linecap="butt"/>`,
      );
    }
  }

  // Room labels + areas.
  for (const room of Object.values(graph.rooms)) {
    const anchor = room.labelAnchor;
    if (!anchor) continue;
    const fontSize = Math.max(Math.min(widthMm, depthMm) * 0.02, 120);
    parts.push(
      `<text x="${anchor.x}" y="${anchor.y}" font-size="${fontSize}" text-anchor="middle" ` +
        `dominant-baseline="middle" fill="#111">${escapeXml(room.name)}</text>`,
    );
  }

  // Dimension strings on exterior wall runs (FR-8).
  if (showDimensions) {
    for (const edge of Object.values(graph.edges)) {
      if (edge.type !== "exterior") continue;
      const a = graph.nodes[edge.a];
      const b = graph.nodes[edge.b];
      if (!a || !b) continue;
      const len = segmentLength(a, b);
      if (len < 200) continue;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const isVertical = a.x === b.x;
      const fontSize = Math.max(Math.min(widthMm, depthMm) * 0.016, 90);
      const dx = isVertical ? -fontSize * 0.6 : 0;
      const dy = isVertical ? 0 : -fontSize * 0.6;
      const rotate = isVertical ? ` transform="rotate(-90 ${midX + dx} ${midY + dy})"` : "";
      parts.push(
        `<text x="${midX + dx}" y="${midY + dy}" font-size="${fontSize}" text-anchor="middle"${rotate} fill="#555">` +
          `${escapeXml(formatLength(len, doc.units))}</text>`,
      );
    }
  }

  parts.push(`</g>`);

  if (showLegend) {
    const programs = [...usedProgram];
    const swatch = Math.max(Math.min(widthMm, depthMm) * 0.02, 80);
    const gap = swatch * 4;
    parts.push(`<g transform="translate(${margin}, ${viewH - legendHeight + swatch})">`);
    programs.forEach((program, i) => {
      const x = (i % 4) * gap;
      const y = Math.floor(i / 4) * (swatch * 2);
      parts.push(`<rect x="${x}" y="${y}" width="${swatch}" height="${swatch}" fill="${PROGRAM_COLORS[program]}"/>`);
      parts.push(
        `<text x="${x + swatch * 1.3}" y="${y + swatch * 0.8}" font-size="${swatch}" fill="#333">${escapeXml(program)}</text>`,
      );
    });
    parts.push(`</g>`);
  }

  // Scale reference bar (FR-18).
  const scaleBarLenMm = doc.units === "metric" ? 1000 : 1219.2; // 1m or 4ft
  parts.push(
    `<g transform="translate(${margin}, ${viewH - Math.max(margin * 0.3, 40)})">` +
      `<line x1="0" y1="0" x2="${scaleBarLenMm}" y2="0" stroke="#000" stroke-width="${Math.max(widthMm * 0.002, 20)}"/>` +
      `<text x="0" y="${-Math.max(widthMm * 0.01, 60)}" font-size="${Math.max(widthMm * 0.016, 90)}">` +
      `${escapeXml(formatLength(scaleBarLenMm, doc.units))} — ${doc.units}</text></g>`,
  );

  parts.push(`</svg>`);
  return parts.join("");
}
