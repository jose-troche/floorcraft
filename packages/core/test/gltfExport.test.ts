import { describe, expect, it } from "vitest";
import { exportGltf } from "../src/gltfExport.js";
import { goldenPlan } from "./fixtures/plan.js";

/** Splits a .glb buffer back into its JSON and BIN chunks — the inverse of packGlb. */
function parseGlb(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);
  const jsonBytes = glb.slice(20, 20 + jsonChunkLength);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));

  const binHeaderOffset = 20 + jsonChunkLength;
  const binChunkLength = view.getUint32(binHeaderOffset, true);
  const binChunkType = view.getUint32(binHeaderOffset + 4, true);
  const bin = glb.slice(binHeaderOffset + 8, binHeaderOffset + 8 + binChunkLength);

  return { magic, version, totalLength, jsonChunkLength, jsonChunkType, json, binChunkLength, binChunkType, bin };
}

describe("exportGltf", () => {
  const glb = exportGltf(goldenPlan());
  const parsed = parseGlb(glb);

  it("starts with the glTF magic number and version 2", () => {
    expect(parsed.magic).toBe(0x46546c67);
    expect(parsed.version).toBe(2);
  });

  it("reports a total length matching the actual buffer size", () => {
    expect(parsed.totalLength).toBe(glb.byteLength);
  });

  it("chunk lengths are 4-byte aligned and match their declared type tags", () => {
    expect(parsed.jsonChunkLength % 4).toBe(0);
    expect(parsed.binChunkLength % 4).toBe(0);
    expect(parsed.jsonChunkType).toBe(0x4e4f534a); // "JSON"
    expect(parsed.binChunkType).toBe(0x004e4942); // "BIN\0"
  });

  it("round-trips a valid glTF 2.0 JSON chunk", () => {
    expect(parsed.json.asset.version).toBe("2.0");
    expect(Array.isArray(parsed.json.meshes)).toBe(true);
    expect(parsed.json.meshes.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.json.nodes)).toBe(true);
    expect(parsed.json.nodes.length).toBe(parsed.json.meshes.length);
  });

  it("every accessor's byte range falls inside its buffer view, and every buffer view inside the buffer", () => {
    const bufferByteLength = parsed.json.buffers[0].byteLength;
    for (const view of parsed.json.bufferViews) {
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(bufferByteLength);
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(parsed.bin.byteLength);
    }
    const componentSize: Record<number, number> = { 5126: 4, 5125: 4 }; // FLOAT, UNSIGNED_INT
    const typeCount: Record<string, number> = { VEC3: 3, SCALAR: 1 };
    for (const accessor of parsed.json.accessors) {
      const view = parsed.json.bufferViews[accessor.bufferView];
      const bytesPerElement = componentSize[accessor.componentType]! * typeCount[accessor.type]!;
      expect(accessor.count * bytesPerElement).toBeLessThanOrEqual(view.byteLength);
    }
  });

  it("every POSITION accessor's min/max bounds its actual vertex data", () => {
    for (const mesh of parsed.json.meshes) {
      for (const prim of mesh.primitives) {
        const accessor = parsed.json.accessors[prim.attributes.POSITION];
        const view = parsed.json.bufferViews[accessor.bufferView];
        const floats = new Float32Array(parsed.bin.buffer, parsed.bin.byteOffset + view.byteOffset, accessor.count * 3);
        for (let i = 0; i < accessor.count; i++) {
          for (let axis = 0; axis < 3; axis++) {
            const v = floats[i * 3 + axis]!;
            expect(v).toBeGreaterThanOrEqual(accessor.min[axis] - 1e-4);
            expect(v).toBeLessThanOrEqual(accessor.max[axis] + 1e-4);
          }
        }
      }
    }
  });

  it("every index accessor stays within its own position accessor's vertex count, and forms whole triangles", () => {
    for (const mesh of parsed.json.meshes) {
      for (const prim of mesh.primitives) {
        const posAccessor = parsed.json.accessors[prim.attributes.POSITION];
        const idxAccessor = parsed.json.accessors[prim.indices];
        expect(idxAccessor.count % 3).toBe(0);
        const view = parsed.json.bufferViews[idxAccessor.bufferView];
        const indices = new Uint32Array(parsed.bin.buffer, parsed.bin.byteOffset + view.byteOffset, idxAccessor.count);
        for (const i of indices) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(posAccessor.count);
        }
      }
    }
  });

  it("gives every primitive a material with a valid RGBA base color", () => {
    for (const mesh of parsed.json.meshes) {
      for (const prim of mesh.primitives) {
        const material = parsed.json.materials[prim.material];
        expect(material).toBeDefined();
        const color = material.pbrMetallicRoughness.baseColorFactor;
        expect(color.length).toBe(4);
        for (const c of color) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("one node per level, translated by that level's elevation in metres", () => {
    const doc = goldenPlan();
    expect(parsed.json.nodes.length).toBe(doc.levels.length);
    for (let i = 0; i < doc.levels.length; i++) {
      expect(parsed.json.nodes[i].translation[1]).toBeCloseTo(doc.levels[i]!.elevation / 1000, 6);
    }
  });
});
