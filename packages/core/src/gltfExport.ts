// glTF (.glb) export — specs.md §6.4 Phase-3 row: "Extruded walls for 3D preview."
// Pure function producing a binary-glTF (.glb) Uint8Array: JSON chunk + BIN chunk, no
// dependencies (ARC-2), so it runs the same in the browser and (per §10) inside a Worker.
//
// No CSG: openings are real geometric holes built by omitting boxes at their span, the
// same technique wallGraph.ts's wallRunSolids already uses for the 2D exporters — a door
// is a full-height gap; a window is a gap with separate below-sill and above-head boxes
// put back. Floors triangulate straight from the rect decomposition (2 triangles per
// room cell) rather than the room polygon, which would need an ear-clipper for anything
// concave (an L-shaped room's polygon is exactly that).
//
// Axis convention: plan x -> glTF x, plan y -> glTF -z (right-handed, glTF's +Z faces the
// viewer by convention — mapping plan "down" to "away" keeps a top-down plan looking
// right side up from above), height -> +y. All positions are metres (the glTF unit);
// internal plan lengths are millimetres (DM-4) and divided by 1000 on the way out.

import { activeLevel } from "./patch.js";
import { openingSpansOnRun, roomCells, wallRunSolids, wallRuns } from "./wallGraph.js";
import { solveSlicingTree } from "./slicingSolver.js";
import { PROGRAM_COLORS } from "./svgRenderer.js";
import { generatorTree } from "./types.js";
import type { Level, PlanDocument, Rect, RoomCell, RoomProgram } from "./types.js";

export type GltfExportOptions = {
  /** Export every level (default) or just the active one. */
  allLevels?: boolean;
};

const WALL_COLOR: [number, number, number, number] = [0.8, 0.8, 0.8, 1];

function hexToRgb(hex: string): [number, number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, 1];
}

type Vec3 = [number, number, number];

/** One glTF primitive's worth of geometry — one per material. */
class MeshBuilder {
  positions: number[] = [];
  indices: number[] = [];
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];

  private vertex(x: number, y: number, z: number): number {
    const i = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.min = [Math.min(this.min[0], x), Math.min(this.min[1], y), Math.min(this.min[2], z)];
    this.max = [Math.max(this.max[0], x), Math.max(this.max[1], y), Math.max(this.max[2], z)];
    return i;
  }

  triangle(a: Vec3, b: Vec3, c: Vec3): void {
    const ia = this.vertex(...a);
    const ib = this.vertex(...b);
    const ic = this.vertex(...c);
    this.indices.push(ia, ib, ic);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }
}

/** plan mm (x, y-plan, z-height) -> glTF metres, y-up. */
function toGltf(xMm: number, yPlanMm: number, zHeightMm: number): Vec3 {
  return [xMm / 1000, zHeightMm / 1000, -yPlanMm / 1000];
}

/** Emits an axis-aligned box (in plan mm footprint x height) as 6 quads. Faces don't need
 * to be watertight against neighbouring boxes for a preview mesh, so adjoining boxes
 * (e.g. two wall segments meeting at a corner) simply overlap rather than being merged. */
function emitBox(mesh: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const p = (x: number, y: number, z: number) => toGltf(x, y, z);
  // Bottom (z0, facing down) and top (z1, facing up).
  mesh.quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), p(x0, y0, z0));
  mesh.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1));
  // Four sides.
  mesh.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1));
  mesh.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1));
  mesh.quad(p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1));
  mesh.quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1));
}

/** A single flat, upward-facing quad at floor height — 2 triangles, not emitBox's 12
 * (4 of which would be degenerate zero-height side faces for a floor). */
function emitFloorQuad(mesh: MeshBuilder, x0: number, x1: number, y0: number, y1: number): void {
  const p = (x: number, y: number) => toGltf(x, y, 0);
  mesh.quad(p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1));
}

function wallFootprint(run: { axis: "h" | "v"; coord: number }, from: number, to: number, thickness: number) {
  const half = thickness / 2;
  return run.axis === "h"
    ? { x0: from, x1: to, y0: run.coord - half, y1: run.coord + half }
    : { x0: run.coord - half, x1: run.coord + half, y0: from, y1: to };
}

function levelCells(doc: PlanDocument, level: Level): RoomCell[] {
  if (level.generator?.kind === "freeform") return level.generator.cells;
  const tree = generatorTree(level);
  if (!tree) return [];
  const solved = solveSlicingTree(tree, level.boundary, doc.gridModule);
  return solved.ok ? solved.leaves.map((l) => ({ roomId: l.roomId, x: l.x, y: l.y, w: l.w, d: l.d })) : [];
}

type Primitive = { mesh: MeshBuilder; color: [number, number, number, number] };

function buildLevelMeshes(doc: PlanDocument, level: Level): Primitive[] {
  const wallMesh = new MeshBuilder();
  const floorByProgram = new Map<RoomProgram, MeshBuilder>();

  for (const cell of levelCells(doc, level)) {
    const room = level.graph.rooms[cell.roomId];
    const program = room?.program ?? "other";
    const mesh = floorByProgram.get(program) ?? new MeshBuilder();
    floorByProgram.set(program, mesh);
    const r: Rect = cell;
    emitFloorQuad(mesh, r.x, r.x + r.w, r.y, r.y + r.d);
  }

  for (const { run, thickness, solids } of wallRunSolids(level.graph)) {
    for (const solid of solids) {
      const fp = wallFootprint(run, solid.from, solid.to, thickness);
      emitBox(wallMesh, fp.x0, fp.x1, fp.y0, fp.y1, 0, level.floorToCeiling);
    }
    // Windows put back a below-sill and above-head box across their own gap in `solids`
    // (SLV-independent: this is purely a render-geometry concern, no CSG).
    for (const { span, opening } of openingSpansOnRun(level.graph, run)) {
      if (opening.kind !== "window") continue;
      const fp = wallFootprint(run, span.from, span.to, thickness);
      const sill = opening.sill ?? 0;
      const head = sill + opening.height;
      if (sill > 0) emitBox(wallMesh, fp.x0, fp.x1, fp.y0, fp.y1, 0, sill);
      if (head < level.floorToCeiling) emitBox(wallMesh, fp.x0, fp.x1, fp.y0, fp.y1, head, level.floorToCeiling);
    }
  }

  const primitives: Primitive[] = [];
  if (!wallMesh.isEmpty) primitives.push({ mesh: wallMesh, color: WALL_COLOR });
  for (const [program, mesh] of floorByProgram) {
    if (!mesh.isEmpty) primitives.push({ mesh, color: hexToRgb(PROGRAM_COLORS[program] ?? PROGRAM_COLORS.other) });
  }
  return primitives;
}

// ------------------------------------------------------------------- GLB packing

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function exportGltf(doc: PlanDocument, options: GltfExportOptions = {}): Uint8Array {
  const levels = options.allLevels === false ? [activeLevel(doc)] : doc.levels;

  const bufferSegments: Uint8Array[] = [];
  let bufferOffset = 0;
  const pushAligned = (bytes: Uint8Array): number => {
    const pad = align4(bufferOffset) - bufferOffset;
    if (pad > 0) {
      bufferSegments.push(new Uint8Array(pad));
      bufferOffset += pad;
    }
    const at = bufferOffset;
    bufferSegments.push(bytes);
    bufferOffset += bytes.byteLength;
    return at;
  };

  const gltfAccessors: Record<string, unknown>[] = [];
  const gltfBufferViews: Record<string, unknown>[] = [];
  const gltfMeshes: Record<string, unknown>[] = [];
  const gltfMaterials: Record<string, unknown>[] = [];
  const materialIndexByColor = new Map<string, number>();
  const gltfNodes: Record<string, unknown>[] = [];
  const sceneNodeIndices: number[] = [];

  const materialFor = (color: [number, number, number, number]): number => {
    const key = color.join(",");
    const existing = materialIndexByColor.get(key);
    if (existing !== undefined) return existing;
    const index = gltfMaterials.length;
    gltfMaterials.push({ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.9 } });
    materialIndexByColor.set(key, index);
    return index;
  };

  for (const level of levels) {
    const primitives = buildLevelMeshes(doc, level);
    if (primitives.length === 0) continue;

    const meshPrimitives = primitives.map(({ mesh, color }) => {
      const posBytes = new Uint8Array(new Float32Array(mesh.positions).buffer);
      const posOffset = pushAligned(posBytes);
      const posBufferView = gltfBufferViews.length;
      gltfBufferViews.push({ buffer: 0, byteOffset: posOffset, byteLength: posBytes.byteLength, target: 34962 });
      const posAccessor = gltfAccessors.length;
      gltfAccessors.push({
        bufferView: posBufferView,
        componentType: 5126, // FLOAT
        count: mesh.positions.length / 3,
        type: "VEC3",
        min: mesh.min,
        max: mesh.max,
      });

      const idxBytes = new Uint8Array(new Uint32Array(mesh.indices).buffer);
      const idxOffset = pushAligned(idxBytes);
      const idxBufferView = gltfBufferViews.length;
      gltfBufferViews.push({ buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength, target: 34963 });
      const idxAccessor = gltfAccessors.length;
      gltfAccessors.push({ bufferView: idxBufferView, componentType: 5125, count: mesh.indices.length, type: "SCALAR" }); // UNSIGNED_INT

      return { attributes: { POSITION: posAccessor }, indices: idxAccessor, material: materialFor(color) };
    });

    const meshIndex = gltfMeshes.length;
    gltfMeshes.push({ primitives: meshPrimitives });

    const nodeIndex = gltfNodes.length;
    gltfNodes.push({ mesh: meshIndex, name: level.name, translation: [0, level.elevation / 1000, 0] });
    sceneNodeIndices.push(nodeIndex);
  }

  const buffer = new Uint8Array(align4(bufferOffset));
  {
    let pos = 0;
    for (const seg of bufferSegments) {
      buffer.set(seg, pos);
      pos += seg.byteLength;
    }
  }

  const gltf = {
    asset: { version: "2.0", generator: "Floorcraft" },
    scene: 0,
    scenes: [{ nodes: sceneNodeIndices }],
    nodes: gltfNodes,
    meshes: gltfMeshes,
    materials: gltfMaterials,
    accessors: gltfAccessors,
    bufferViews: gltfBufferViews,
    buffers: [{ byteLength: buffer.byteLength }],
  };

  return packGlb(gltf, buffer);
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function packGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const jsonText = JSON.stringify(json);
  const jsonBytesRaw = new TextEncoder().encode(jsonText);
  const jsonPadded = align4(jsonBytesRaw.byteLength);
  const jsonBytes = new Uint8Array(jsonPadded);
  jsonBytes.set(jsonBytesRaw);
  jsonBytes.fill(0x20, jsonBytesRaw.byteLength); // glTF pads the JSON chunk with spaces

  const binPadded = align4(bin.byteLength);
  const binBytes = new Uint8Array(binPadded);
  binBytes.set(bin);

  const totalLength = 12 + (8 + jsonBytes.byteLength) + (8 + binBytes.byteLength);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;

  view.setUint32(offset, GLB_MAGIC, true);
  offset += 4;
  view.setUint32(offset, 2, true); // version
  offset += 4;
  view.setUint32(offset, totalLength, true);
  offset += 4;

  view.setUint32(offset, jsonBytes.byteLength, true);
  offset += 4;
  view.setUint32(offset, CHUNK_JSON, true);
  offset += 4;
  out.set(jsonBytes, offset);
  offset += jsonBytes.byteLength;

  view.setUint32(offset, binBytes.byteLength, true);
  offset += 4;
  view.setUint32(offset, CHUNK_BIN, true);
  offset += 4;
  out.set(binBytes, offset);
  offset += binBytes.byteLength;

  return out;
}
