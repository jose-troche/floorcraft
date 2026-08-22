import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DXF_LAYERS, exportDxf } from "../src/dxfExport.js";
import { goldenPlan } from "./fixtures/plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(here, "golden", "plan.dxf");

/** Splits a DXF into (groupCode, value) pairs, which is the only structure the format has. */
function pairs(dxf: string): Array<[number, string]> {
  const lines = dxf.split("\r\n");
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

describe("exportDxf", () => {
  const dxf = exportDxf(goldenPlan());

  it("is well-formed R12 with balanced sections", () => {
    expect(dxf.startsWith("0\r\nSECTION")).toBe(true);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    expect(dxf).toContain("AC1009"); // R12
    const opens = (dxf.match(/\r\nSECTION\r\n/g) ?? []).length;
    const closes = (dxf.match(/\r\nENDSEC\r\n/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(3); // HEADER, TABLES, ENTITIES

    // Every line is either a group code or its value; an odd count means a truncated pair.
    const lines = dxf.split("\r\n").filter((l) => l.length > 0 || true).slice(0, -1);
    expect(lines.length % 2).toBe(0);
    for (const [code] of pairs(dxf)) expect(Number.isInteger(code)).toBe(true);
  });

  it("defines every layer the spec names, plus the linetype they reference", () => {
    for (const layer of DXF_LAYERS) {
      expect(dxf).toContain(`\r\nLAYER\r\n2\r\n${layer}\r\n`);
    }
    expect(dxf).toContain("\r\nLTYPE\r\n2\r\nCONTINUOUS\r\n");
    // Nothing may be drawn onto a layer that was never declared.
    const declared = new Set<string>(DXF_LAYERS);
    for (const [code, value] of pairs(dxf)) {
      if (code === 8) expect(declared.has(value)).toBe(true);
    }
  });

  it("emits only R12-legal entities", () => {
    const allowed = new Set(["SECTION", "ENDSEC", "TABLE", "ENDTAB", "LTYPE", "LAYER", "EOF", "LINE", "ARC", "TEXT", "POLYLINE", "VERTEX", "SEQEND"]);
    for (const [code, value] of pairs(dxf)) {
      if (code === 0) expect(allowed.has(value)).toBe(true);
    }
    expect(dxf).not.toContain("LWPOLYLINE");
  });

  it("types every group value the way its code requires", () => {
    for (const [code, value] of pairs(dxf)) {
      if (code >= 10 && code <= 59) {
        expect(value).toMatch(/^-?\d+\.\d+$/);
        expect(Number.isFinite(Number(value))).toBe(true);
      }
      // Flags and colours are 16-bit integers; a reader handed "4.0000" rejects the file.
      if (code >= 60 && code <= 79) expect(value).toMatch(/^-?\d+$/);
    }
    expect(dxf).not.toContain("NaN");
    expect(dxf).not.toContain("e+");
  });

  it("puts walls, doors, windows, rooms, text and dimensions on their own layers", () => {
    const layersUsed = new Set(pairs(dxf).filter(([code]) => code === 8).map(([, value]) => value));
    for (const layer of DXF_LAYERS) expect(layersUsed.has(layer)).toBe(true);
  });

  it("mirrors Y so the plan is not upside down in CAD", () => {
    const ys = pairs(dxf)
      .filter(([code]) => code === 20)
      .map(([, value]) => Number(value));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    // The fixture is 12192mm deep; the drawing is lifted clear of the origin for the scale bar.
    expect(Math.max(...ys)).toBeGreaterThan(12192);
  });

  it("states the unit system in the file (FR-18)", () => {
    expect(dxf).toContain("$INSUNITS");
    expect(dxf).toContain("scale bar");
    expect(dxf).toContain("imperial");
  });

  it("matches the golden fixture byte for byte (FR-17)", () => {
    // Regenerate deliberately with UPDATE_GOLDEN=1 when the exporter changes on purpose,
    // then eyeball the diff and re-run the manual import smoke test.
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, dxf, "utf8");
    }
    expect(dxf).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });
});
