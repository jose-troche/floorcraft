// Spatial placement, dimensioned creation, and the refusal to guess — the three
// behaviours added on top of Phase 2's intent matcher.

import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import { matchDeterministicIntent } from "../src/intentMatcher.js";
import { resolveTurn } from "../src/orchestrator.js";
import { solveSlicingTree } from "../src/slicingSolver.js";
import type { PatchOp, PlanDocument } from "../src/types.js";

function apply(doc: PlanDocument, ops: PatchOp[]): PlanDocument {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(result.errors.join("; ") || result.violations?.map((v) => v.message).join("; "));
  return result.doc;
}

function plan(): PlanDocument {
  let doc = createEmptyPlan({ id: "p", title: "T", units: "imperial", boundary: { widthMm: 12000, depthMm: 10000 } });
  doc = apply(doc, [{ op: "addRoom", roomId: "office", program: "office", name: "Office", areaWeight: 1 }]);
  return doc;
}

/** Room rectangles keyed by name, so a placement assertion reads as geometry. */
function rects(doc: PlanDocument): Record<string, { x: number; y: number; w: number; d: number }> {
  const level = activeLevel(doc);
  const solved = solveSlicingTree(level.generator!.tree!, level.boundary, doc.gridModule);
  if (!solved.ok) throw new Error("unsolvable");
  const out: Record<string, { x: number; y: number; w: number; d: number }> = {};
  for (const leaf of solved.leaves) {
    out[level.graph.rooms[leaf.roomId]?.name ?? leaf.roomId] = { x: leaf.x, y: leaf.y, w: leaf.w, d: leaf.d };
  }
  return out;
}

function run(doc: PlanDocument, utterance: string): PlanDocument {
  const result = matchDeterministicIntent(doc, utterance);
  if (result?.kind !== "patch") throw new Error(`expected a patch for "${utterance}", got ${result?.kind ?? "null"}`);
  return apply(doc, result.patch.ops);
}

describe("spatial placement", () => {
  it("puts a room to the left of another, and means it geometrically", () => {
    const after = rects(run(plan(), "add a kitchen to the left of the office"));
    expect(after.Kitchen!.x).toBeLessThan(after.Office!.x);
    // Side by side, sharing a vertical wall rather than stacked.
    expect(after.Kitchen!.x + after.Kitchen!.w).toBe(after.Office!.x);
    expect(after.Kitchen!.d).toBe(after.Office!.d);
  });

  it("puts a room to the right of another", () => {
    const after = rects(run(plan(), "add a pantry to the right of the office"));
    expect(after.Pantry!.x).toBeGreaterThan(after.Office!.x);
    expect(after.Office!.x + after.Office!.w).toBe(after.Pantry!.x);
  });

  it("stacks a room above another", () => {
    const after = rects(run(plan(), "add a bedroom above the office"));
    expect(after.Bedroom!.y).toBeLessThan(after.Office!.y);
    expect(after.Bedroom!.y + after.Bedroom!.d).toBe(after.Office!.y);
    expect(after.Bedroom!.w).toBe(after.Office!.w);
  });

  it("stacks a room below another", () => {
    const after = rects(run(plan(), "add a bedroom below the office"));
    expect(after.Bedroom!.y).toBeGreaterThan(after.Office!.y);
    expect(after.Office!.y + after.Office!.d).toBe(after.Bedroom!.y);
  });

  it("carves a room out of its host for 'inside'", () => {
    const before = rects(plan());
    const after = rects(run(plan(), "add a closet inside the office"));
    // The office keeps its identity but gives up area to the closet, and the two
    // together still exactly fill what the office used to occupy.
    expect(after.Office!.w).toBeLessThan(before.Office!.w);
    expect(after.Closet!.w + after.Office!.w).toBe(before.Office!.w);
  });

  it("accepts 'in the <room>' as inside", () => {
    const result = matchDeterministicIntent(plan(), "add a closet in the office");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "addRoom", program: "closet", adjacentTo: "office", direction: "inside" });
  });

  it("does not read a room name containing 'in' as a placement", () => {
    // "walk in closet" is a closet, not a walk inside a closet.
    const result = matchDeterministicIntent(plan(), "add a walk in closet");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "addRoom", program: "closet" });
    expect(result.patch.ops[0]).not.toHaveProperty("adjacentTo", "office");
  });

  it("treats 'next to' as adjacency without forcing a side", () => {
    const result = matchDeterministicIntent(plan(), "add a pantry next to the office");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    const op = result.patch.ops[0] as { adjacentTo?: string; direction?: string };
    expect(op.adjacentTo).toBe("office");
    expect(op.direction).toBeUndefined();
  });

  it("moves an existing room to a named side", () => {
    let doc = run(plan(), "add a kitchen to the left of the office");
    const before = rects(doc);
    expect(before.Kitchen!.x).toBeLessThan(before.Office!.x);

    doc = run(doc, "move the kitchen to the right of the office");
    const after = rects(doc);
    expect(after.Kitchen!.x).toBeGreaterThan(after.Office!.x);
  });
});

describe("creation with dimensions", () => {
  it("pins width and depth from 'add a room 3 x 4 ft'", () => {
    const result = matchDeterministicIntent(plan(), "add a room 3 x 4 ft");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({
      op: "addRoom",
      program: "other",
      constraints: { width: { exact: 914 }, depth: { exact: 1219 } },
    });
  });

  it("actually builds the room at the requested size, not merely records it", () => {
    // Exact dimensions used to be applied as minimums only, so a 3x4 request produced a
    // room of whatever size the area weights happened to give it.
    const after = rects(run(plan(), "add a bedroom 10 x 12 ft to the left of the office"));
    expect(after.Bedroom!.w).toBe(3048); // 10 ft
    expect(after.Bedroom!.d).toBe(10000); // full depth: only width was cut here
  });

  it("combines a dimension with a placement", () => {
    const result = matchDeterministicIntent(plan(), "add a closet 3x4 ft to the right of the office");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({
      op: "addRoom",
      program: "closet",
      adjacentTo: "office",
      direction: "right",
      constraints: { width: { exact: 914 } },
    });
  });

  it("reads metric units when the plan is metric", () => {
    let doc = createEmptyPlan({ id: "m", title: "T", units: "metric", boundary: { widthMm: 12000, depthMm: 10000 } });
    doc = apply(doc, [{ op: "addRoom", roomId: "office", program: "office", name: "Office", areaWeight: 1 }]);
    const result = matchDeterministicIntent(doc, "add a room 3 x 4");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ constraints: { width: { exact: 3000 }, depth: { exact: 4000 } } });
  });
});

describe("relative resizing", () => {
  function twoRooms(): PlanDocument {
    let doc = plan();
    doc = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 }]);
    return doc;
  }

  it("handles 'reduce kitchen by 40%'", async () => {
    const doc = twoRooms();
    const before = rects(doc).Kitchen!;
    const outcome = await resolveTurn(doc, "reduce the kitchen by 40%", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    const after = rects(outcome.doc).Kitchen!;
    expect(after.w * after.d).toBeLessThan(before.w * before.d);
  });

  it("handles 'increase kitchen width by 3 meters'", async () => {
    const doc = twoRooms();
    const before = rects(doc).Kitchen!;
    const outcome = await resolveTurn(doc, "increase the kitchen width by 3 meters", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    // DM-4 stores whole millimetres, and the starting width came off a grid-snapped cut,
    // so the pinned result is the rounded sum rather than the raw one.
    expect(rects(outcome.doc).Kitchen!.w).toBe(Math.round(before.w + 3000));
  });

  it("handles 'increase office length by 30%'", async () => {
    // Stacked, so the office has depth headroom to grow into.
    const doc = run(plan(), "add a bedroom below the office");
    const before = rects(doc).Office!;
    const outcome = await resolveTurn(doc, "increase the office length by 30%", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    // "length" reads as the front-to-back extent, matching how "deep"/"long" already read.
    expect(rects(outcome.doc).Office!.d).toBeCloseTo(before.d * 1.3, 0);
  });

  it("refuses a relative growth that cannot fit the footprint (DIM-6)", async () => {
    // The office already spans the full depth, so 130% of it has nowhere to go.
    const outcome = await resolveTurn(twoRooms(), "increase the office length by 30%", [], null);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("Enlarge the footprint");
  });

  it("shrinks by percentage on a named axis too", async () => {
    const doc = twoRooms();
    const before = rects(doc).Kitchen!;
    const outcome = await resolveTurn(doc, "reduce the kitchen width by 25%", [], null);
    expect(outcome.kind).toBe("deterministic");
    if (outcome.kind !== "deterministic") return;
    expect(rects(outcome.doc).Kitchen!.w).toBeCloseTo(before.w * 0.75, 0);
  });
});

describe("asking instead of guessing", () => {
  function twoBedrooms(): PlanDocument {
    let doc = plan();
    doc = apply(doc, [{ op: "addRoom", roomId: "b1", program: "bedroom", name: "Bedroom 1", areaWeight: 1 }]);
    doc = apply(doc, [{ op: "addRoom", roomId: "b2", program: "bedroom", name: "Bedroom 2", areaWeight: 1 }]);
    return doc;
  }

  it("will not delete when the room reference is ambiguous", () => {
    const result = matchDeterministicIntent(twoBedrooms(), "delete the bedroom");
    expect(result?.kind).toBe("clarify");
    if (result?.kind !== "clarify") return;
    expect(result.question).toContain("more than one");
    expect(result.options).toEqual(["Bedroom 1", "Bedroom 2"]);
  });

  it("will not rename, swap or resize an ambiguous room either", () => {
    const doc = twoBedrooms();
    for (const utterance of [
      "rename the bedroom to Guest Room",
      "swap the bedroom and the office",
      "make the bedroom 20% bigger",
    ]) {
      expect(matchDeterministicIntent(doc, utterance)?.kind, utterance).toBe("clarify");
    }
  });

  it("asks rather than deleting a room that does not exist", () => {
    const result = matchDeterministicIntent(plan(), "delete the sunroom");
    expect(result?.kind).toBe("clarify");
    if (result?.kind !== "clarify") return;
    expect(result.question).toContain("can't find");
    expect(result.options).toContain("Office");
  });

  it("asks rather than creating a room of an unrecognised kind", () => {
    const result = matchDeterministicIntent(plan(), "add a zorbatorium");
    expect(result?.kind).toBe("clarify");
    if (result?.kind !== "clarify") return;
    expect(result.question).toContain("not sure what kind of room");
  });

  it("asks when the placement anchor is ambiguous, instead of placing it anywhere", () => {
    const result = matchDeterministicIntent(twoBedrooms(), "add a closet inside the bedroom");
    expect(result?.kind).toBe("clarify");
    if (result?.kind !== "clarify") return;
    expect(result.options).toEqual(["Bedroom 1", "Bedroom 2"]);
  });

  it("still acts when an exact name disambiguates the request", () => {
    const result = matchDeterministicIntent(twoBedrooms(), "delete the Bedroom 2");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops[0]).toMatchObject({ op: "removeRoom", roomId: "b2" });
  });

  it("leaves the plan untouched and never reaches a provider when asking", async () => {
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
    const doc = twoBedrooms();
    const outcome = await resolveTurn(doc, "delete the bedroom", [], provider);
    expect(outcome.kind).toBe("clarify");
    // A model asked the same question would answer it by picking one, which is the
    // guess the clarification exists to prevent.
    expect(called).toBe(false);
    expect(Object.keys(activeLevel(doc).graph.rooms)).toHaveLength(3);
  });

  it("expands multi-room creation into one op per room", () => {
    const result = matchDeterministicIntent(plan(), "add a kitchen, a living room and two bedrooms");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops.map((op) => (op as { program: string }).program)).toEqual([
      "kitchen",
      "living",
      "bedroom",
      "bedroom",
    ]);
  });

  it("expands a bare count into that many rooms", () => {
    for (const [utterance, count] of [
      ["add 2 bedrooms", 2],
      ["add three bedrooms", 3],
      ["add a couple of bathrooms", 2],
    ] as const) {
      const result = matchDeterministicIntent(plan(), utterance);
      expect(result?.kind, utterance).toBe("patch");
      if (result?.kind !== "patch") continue;
      expect(result.patch.ops, utterance).toHaveLength(count);
    }
  });

  it("keeps a multi-room request on the provider path when it cannot be read exactly", () => {
    // Getting one room out of three, or one bedroom where two were asked for, is exactly
    // the wrong-inference failure — anything this matcher cannot expand in full must
    // reach a model that can express the whole request instead.
    for (const utterance of [
      "add a kitchen and paint the walls blue", // a segment that is not a room at all
      "add a few bedrooms", // no defensible count
      "add 200 bedrooms", // past the per-turn ceiling
      "add a kitchen 8x5 ft and a bath", // one size, two rooms — no honest way to split it
    ]) {
      expect(matchDeterministicIntent(plan(), utterance), utterance).toBeNull();
    }
  });

  it("applies a stated placement to every room in a list", () => {
    const result = matchDeterministicIntent(plan(), "add a pantry and a closet next to the office");
    expect(result?.kind).toBe("patch");
    if (result?.kind !== "patch") return;
    expect(result.patch.ops).toHaveLength(2);
    for (const op of result.patch.ops) {
      expect(op).toMatchObject({ op: "addRoom", adjacentTo: "office" });
    }
  });
});
