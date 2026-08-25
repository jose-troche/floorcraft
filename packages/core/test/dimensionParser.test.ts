import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import { checkConstraintsPossible, parseDimensions } from "../src/dimensionParser.js";
import { resolveTurn } from "../src/orchestrator.js";
import type { PatchOp, PlanDocument, Units } from "../src/types.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(result.errors.join("; ") || result.violations?.map((v) => v.message).join("; "));
  return result.doc;
}

function plan(units: Units = "imperial"): PlanDocument {
  let doc = createEmptyPlan({ id: "p", title: "T", units, boundary: { widthMm: 12000, depthMm: 14000 } });
  doc = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1.2 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "living", program: "living", name: "Living Room", areaWeight: 1.6 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "bath", program: "bath", name: "Bathroom", areaWeight: 0.5 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "hall", program: "hallway", name: "Hallway", areaWeight: 0.4 }]);
  doc = apply(doc, [{ op: "addRoom", roomId: "suite", program: "primary-bedroom", name: "Master Suite", areaWeight: 1.6 }]);
  return doc;
}

function constraintsOf(doc: PlanDocument, roomId: string) {
  return activeLevel(doc).graph.rooms[roomId]?.constraints;
}

describe("parseDimensions — the DIM-2 patterns", () => {
  it("pins width and depth from 'kitchen is 4x5 feet'", () => {
    const result = parseDimensions(plan(), "kitchen is 4x5 feet");
    expect(result.ops).toEqual([
      { op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 1219 },
      { op: "setDimension", roomId: "kitchen", dimensionType: "depth", value: 1524 },
    ]);
    expect(result.remainder).toBe("");
  });

  it("bounds an area from 'living room at least 300 sq ft'", () => {
    const result = parseDimensions(plan(), "living room at least 300 sq ft");
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({ op: "setDimensionRange", roomId: "living", dimensionType: "area" });
    const op = result.ops[0] as { minMm?: number };
    expect(op.minMm).toBe(Math.round(300 * 92903.04));
  });

  it("resolves a relative change against the room's current size", () => {
    const doc = plan("metric");
    const before = parseDimensions(doc, "increase the bathroom depth by 2 meters");
    expect(before.ops).toHaveLength(1);
    const op = before.ops[0] as { op: string; dimensionType: string; value: number };
    expect(op.op).toBe("setDimension");
    expect(op.dimensionType).toBe("depth");
    // Absolute, not a delta: the reducer stores facts, not arithmetic to redo later.
    expect(op.value).toBeGreaterThan(2000);
  });

  it("reads a relative change with the axis fronted, the same as with it trailing", () => {
    // "reduce the length of the kitchen by 2 m" and "reduce the kitchen length by 2 m"
    // are the same request in ordinary English. Only understanding one of them meant
    // sending the other to a model to re-derive a length the user had already stated.
    const doc = plan("metric");
    const fronted = parseDimensions(doc, "reduce the length of the kitchen by 2 meters");
    const trailing = parseDimensions(doc, "reduce the kitchen length by 2 meters");
    expect(fronted.ops).toHaveLength(1);
    expect(fronted.ops).toEqual(trailing.ops);
    expect(fronted.ops[0]).toMatchObject({ op: "setDimension", roomId: "kitchen", dimensionType: "depth" });
    expect(fronted.remainder).toBe("");
  });

  it("handles several constraints in one utterance", () => {
    const result = parseDimensions(plan(), "bathroom 5x8, kitchen 8x12 feet");
    const rooms = result.ops.map((o) => (o as { roomId: string }).roomId);
    expect(new Set(rooms)).toEqual(new Set(["bath", "kitchen"]));
    expect(result.ops).toHaveLength(4);
  });

  it("reads a single axis from 'make the hallway 3 feet wide'", () => {
    const result = parseDimensions(plan(), "make the hallway 3 feet wide");
    expect(result.ops).toEqual([{ op: "setDimension", roomId: "hall", dimensionType: "width", value: 914 }]);
  });

  it("bounds both axes from 'master suite at least 16x20'", () => {
    const result = parseDimensions(plan(), "master suite at least 16x20");
    expect(result.ops).toEqual([
      { op: "setDimensionRange", roomId: "suite", dimensionType: "width", minMm: 4877 },
      { op: "setDimensionRange", roomId: "suite", dimensionType: "depth", minMm: 6096 },
    ]);
  });
});

describe("parseDimensions — units (DIM-3, SLV-9)", () => {
  it("converts an explicit unit even when the plan uses the other system", () => {
    const metric = parseDimensions(plan("metric"), "kitchen 4x5 feet");
    expect((metric.ops[0] as { value: number }).value).toBe(1219);
    expect(metric.warnings).toHaveLength(0);
  });

  it("assumes the plan's unit when none is given, and says so", () => {
    const result = parseDimensions(plan("imperial"), "kitchen 10x12");
    expect((result.ops[0] as { value: number }).value).toBe(Math.round(10 * 304.8));
    expect(result.warnings[0]?.message).toContain("feet");
  });

  it("accepts mixed units within one turn", () => {
    const result = parseDimensions(plan(), "kitchen 4x5 feet, bathroom 3x3.5 meters");
    const kitchenWidth = result.ops.find((o) => (o as { roomId: string }).roomId === "kitchen") as { value: number };
    const bathWidth = result.ops.find((o) => (o as { roomId: string }).roomId === "bath") as { value: number };
    expect(kitchenWidth.value).toBe(1219);
    expect(bathWidth.value).toBe(3000);
  });

  it("always returns integer millimetres", () => {
    const result = parseDimensions(plan(), "kitchen 4.5x5.25 feet");
    for (const op of result.ops) {
      const value = (op as { value: number }).value;
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("parseDimensions — leftovers and impossibilities", () => {
  it("keeps the unparseable part for the provider (DIM-4)", () => {
    const result = parseDimensions(plan(), "make the kitchen 5x6 feet and add a pantry");
    expect(result.ops).toHaveLength(2);
    expect(result.remainder).toBe("add a pantry");
  });

  it("leaves an utterance with no dimensions entirely alone", () => {
    const result = parseDimensions(plan(), "swap the kitchen and the living room");
    expect(result.ops).toHaveLength(0);
    expect(result.remainder).toContain("swap");
  });

  it("does not invent a room that is not in the plan", () => {
    const result = parseDimensions(plan(), "conservatory 4x5 feet");
    expect(result.ops).toHaveLength(0);
  });

  it("catches a geometrically impossible constraint before the solver runs (DIM-6)", () => {
    const doc = plan();
    const parsed = parseDimensions(doc, "kitchen 40x50 meters");
    const impossible = checkConstraintsPossible(doc, parsed.ops);
    expect(impossible).not.toBeNull();
    expect(impossible!.message).toContain("Kitchen");
    expect(impossible!.message).toContain("Enlarge the footprint");
  });
});

describe("resolveTurn — dimensions run before anything else (DIM-5)", () => {
  it("applies dimensions with no provider available at all", async () => {
    const outcome = await resolveTurn(plan(), "kitchen is 8x10 feet", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    expect(constraintsOf(outcome.doc, "kitchen")?.width?.exact).toBe(2438);
  });

  it("resolves DIM-5's worked example with no inference at all", async () => {
    // "make the kitchen 5x6 feet and add a pantry": the dimension parser pins the
    // kitchen, and the intent matcher (INF-5) already knows how to add a pantry — so the
    // whole turn lands deterministically and no provider is consulted.
    let called = false;
    const provider = {
      id: "tier1-hosted" as const,
      tier: 1 as const,
      availability: async () => "available" as const,
      propose: async () => {
        called = true;
        return { ops: [], source: "provider" as const };
      },
    };
    const outcome = await resolveTurn(plan(), "make the kitchen 5x6 feet and add a pantry", [], provider);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    expect(constraintsOf(outcome.doc, "kitchen")?.width?.exact).toBe(1524);
    expect(Object.values(activeLevel(outcome.doc).graph.rooms).some((r) => r.program === "pantry")).toBe(true);
    expect(called).toBe(false);
  });

  it("asks the provider about the remainder only, never the dimension", async () => {
    const asked: string[] = [];
    const provider = {
      id: "tier1-hosted" as const,
      tier: 1 as const,
      availability: async () => "available" as const,
      propose: async (input: { utterance: string }) => {
        asked.push(input.utterance);
        return { ops: [{ op: "swapRooms" as const, roomIdA: "kitchen", roomIdB: "living" }], source: "provider" as const };
      },
    };
    const outcome = await resolveTurn(plan(), "kitchen 5x6 feet, rearrange things to face the garden", [], provider);
    expect(outcome.kind).toBe("provider");
    if (outcome.kind !== "provider") return;
    expect(constraintsOf(outcome.doc, "kitchen")?.width?.exact).toBe(1524);
    expect(asked).toHaveLength(1);
    // The model never sees the dimension clause: it is a fact, not a suggestion.
    expect(asked[0]).toContain("rearrange things");
    expect(asked[0]).not.toContain("5x6");
  });

  it("keeps the parsed dimensions when the rest of the turn needs an unavailable provider", async () => {
    const outcome = await resolveTurn(plan(), "kitchen 8x10 feet and do something inscrutable", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    expect(constraintsOf(outcome.doc, "kitchen")?.width?.exact).toBe(2438);
    expect(outcome.changes.join(" ")).toContain("inscrutable");
  });

  it("still routes undo and redo, which are commands rather than edits", async () => {
    expect((await resolveTurn(plan(), "undo", [], null)).kind).toBe("undo");
    expect((await resolveTurn(plan(), "redo", [], null)).kind).toBe("redo");
  });

  it("refuses an impossible constraint without touching the plan (DIM-6)", async () => {
    const doc = plan();
    const outcome = await resolveTurn(doc, "kitchen 40x50 meters", [], null);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("Enlarge the footprint");
  });
});

/**
 * DIM-2 asks for the pattern set to be measured against a fixture and expanded from it;
 * the open risk in §11 sets the bar at >= 80% deterministic parse rate.
 */
describe("dimension utterance fixture coverage", () => {
  const UTTERANCES = [
    "kitchen is 4x5 feet",
    "kitchen 4x5 ft",
    "kitchen must be 4 x 5 feet",
    "the kitchen is exactly 4x5 feet",
    "kitchen 4 by 5 feet",
    "bathroom 5x8",
    "bathroom 5×8 feet",
    "living room at least 300 sq ft",
    "living room at least 300 square feet",
    "living room minimum 300 sqft",
    "living room no more than 400 sq ft",
    "living room at most 400 square feet",
    "bathroom at least 6 m2",
    "make the hallway 3 feet wide",
    "hallway 3 ft wide",
    "hallway is 900 mm wide",
    "kitchen 12 feet deep",
    "kitchen at least 10 feet wide",
    "master suite at least 16x20",
    "master suite at least 16x20 feet",
    "increase the bathroom depth by 2 meters",
    "decrease the kitchen width by 1 m",
    "bathroom 5x8, kitchen 8x12 feet",
    "kitchen 4x5 feet, bathroom 3x3.5 meters",
    "make the kitchen 5x6 feet and add a pantry",
  ];

  it("parses at least 80% of the fixture deterministically", () => {
    const doc = plan();
    const parsed = UTTERANCES.filter((u) => parseDimensions(doc, u).ops.length > 0);
    const rate = parsed.length / UTTERANCES.length;
    const missed = UTTERANCES.filter((u) => parseDimensions(doc, u).ops.length === 0);
    expect(rate, `missed: ${missed.join(" | ")}`).toBeGreaterThanOrEqual(0.8);
  });

  it("never produces a constraint the reducer rejects", () => {
    for (const utterance of UTTERANCES) {
      const doc = plan();
      const { ops } = parseDimensions(doc, utterance);
      if (ops.length === 0) continue;
      const result = applyPatch(doc, { ops, source: "deterministic" });
      expect(result.ok || Boolean(result.violations), `"${utterance}" produced a malformed patch`).toBe(true);
    }
  });
});
