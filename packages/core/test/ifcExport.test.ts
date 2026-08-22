import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportIfc } from "../src/ifcExport.js";
import { goldenPlan } from "./fixtures/plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(here, "golden", "plan.ifc");
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function dataLines(ifc: string): string[] {
  const start = ifc.indexOf("DATA;\n") + "DATA;\n".length;
  const end = ifc.indexOf("\nENDSEC;\nEND-ISO-10303-21;");
  return ifc
    .slice(start, end)
    .split("\n")
    .filter((l) => l.length > 0);
}

/** Every #N=TYPE(...) declared, and every #M reference used anywhere in the DATA section. */
function analyze(ifc: string) {
  const lines = dataLines(ifc);
  const declared = new Set<number>();
  const typeOf = new Map<number, string>();
  const referenced = new Set<number>();
  for (const line of lines) {
    const decl = line.match(/^#(\d+)=([A-Z0-9_]+)\((.*)\);$/);
    expect(decl, `line does not look like a STEP entity: ${line}`).not.toBeNull();
    const id = Number(decl![1]);
    expect(declared.has(id), `duplicate entity id #${id}`).toBe(false);
    declared.add(id);
    typeOf.set(id, decl![2]!);
    // Only the attribute list (not the "#id=TYPE" prefix) can contain references to
    // other entities.
    for (const m of decl![3]!.matchAll(/#(\d+)/g)) referenced.add(Number(m[1]));
  }
  return { lines, declared, typeOf, referenced };
}

describe("exportIfc", () => {
  const doc = goldenPlan();
  const ifc = exportIfc(doc, { now: FIXED_NOW, author: "Test Author", organization: "Test Org" });

  it("is well-formed STEP with a closed header/data/footer", () => {
    expect(ifc.startsWith("ISO-10303-21;")).toBe(true);
    expect(ifc.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
    expect(ifc).toContain("FILE_SCHEMA(('IFC4'));");
    expect(ifc).toContain("HEADER;");
    expect(ifc).toContain("DATA;");
  });

  it("every reference resolves to a declared entity, with no duplicate ids", () => {
    const { declared, referenced } = analyze(ifc);
    expect(declared.size).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(declared.has(ref), `#${ref} is referenced but never declared`).toBe(true);
    }
  });

  it("declares exactly one IFCBUILDINGSTOREY per level", () => {
    const { typeOf } = analyze(ifc);
    const storeys = [...typeOf.values()].filter((t) => t === "IFCBUILDINGSTOREY");
    expect(storeys.length).toBe(doc.levels.length);
  });

  it("declares one IFCSPACE per room and one IFCWALLSTANDARDCASE per wall run", () => {
    const { typeOf } = analyze(ifc);
    const spaces = [...typeOf.values()].filter((t) => t === "IFCSPACE").length;
    const totalRooms = doc.levels.reduce((n, l) => n + Object.keys(l.graph.rooms).length, 0);
    expect(spaces).toBe(totalRooms);
    const walls = [...typeOf.values()].filter((t) => t === "IFCWALLSTANDARDCASE").length;
    expect(walls).toBeGreaterThan(0);
  });

  it("gives every opening a void relationship, and doors/windows a fill relationship", () => {
    const { typeOf } = analyze(ifc);
    const openings = [...typeOf.values()].filter((t) => t === "IFCOPENINGELEMENT").length;
    const voids = [...typeOf.values()].filter((t) => t === "IFCRELVOIDSELEMENT").length;
    expect(voids).toBe(openings);
    const doors = [...typeOf.values()].filter((t) => t === "IFCDOOR").length;
    const windows = [...typeOf.values()].filter((t) => t === "IFCWINDOW").length;
    const fills = [...typeOf.values()].filter((t) => t === "IFCRELFILLSELEMENT").length;
    expect(fills).toBe(doors + windows);
    expect(openings).toBeGreaterThan(0);
  });

  it("carries the project hierarchy from project down to building", () => {
    expect(ifc).toContain("IFCPROJECT(");
    expect(ifc).toContain("IFCSITE(");
    expect(ifc).toContain("IFCBUILDING(");
    const aggregates = ifc.split("\n").filter((l) => l.includes("IFCRELAGGREGATES(")).length;
    // project->site, site->building, building->storeys = 3 aggregation relationships.
    expect(aggregates).toBe(3);
  });

  it("declares length units in millimetres", () => {
    expect(ifc).toContain(".LENGTHUNIT.");
    expect(ifc).toContain(".MILLI.");
    expect(ifc).toContain(".METRE.");
  });

  it("produces no NaN or undefined in any attribute", () => {
    expect(ifc).not.toContain("NaN");
    expect(ifc).not.toContain("undefined");
  });

  it("is deterministic — the same document exports byte-identical output", () => {
    const again = exportIfc(doc, { now: FIXED_NOW, author: "Test Author", organization: "Test Org" });
    expect(again).toBe(ifc);
  });

  it("matches the golden fixture byte for byte", () => {
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, ifc, "utf8");
    }
    expect(ifc).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });
});
