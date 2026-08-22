// A weak or unavailable provider must never kill a turn: bad answers get INF-4's repair
// retry, and transport failures surface as a plain-language error — never an exception
// escaping into the UI, where it would strand the "working…" indicator forever.

import { describe, expect, it } from "vitest";
import { createEmptyPlan } from "../src/patch.js";
import { resolveTurn } from "../src/orchestrator.js";
import { validatePatchResponse } from "../src/providers/schema.js";
import { safeJsonParse } from "../src/providers/safeJsonParse.js";
import { CORE_PATCH_OPS } from "../src/providers/schema.js";
import type { Patch, PlanDocument } from "../src/types.js";
import type { PlanProvider } from "../src/providers/types.js";

function plan(): PlanDocument {
  return createEmptyPlan({ id: "p1", title: "T", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
}

function providerReturning(responses: unknown[]): PlanProvider & { calls: number } {
  return {
    id: "tier0-on-device",
    tier: 0,
    calls: 0,
    async availability() {
      return "available";
    },
    async propose() {
      const next = responses[this.calls] ?? responses[responses.length - 1];
      this.calls++;
      return next as Patch;
    },
  } as PlanProvider & { calls: number };
}

function providerThrowing(message: string): PlanProvider & { calls: number } {
  return {
    id: "tier1-hosted",
    tier: 1,
    calls: 0,
    async availability() {
      return "available";
    },
    async propose(): Promise<Patch> {
      this.calls++;
      throw new Error(message);
    },
  } as PlanProvider & { calls: number };
}

describe("provider resilience", () => {
  it("defaults a missing areaWeight instead of rejecting the addRoom", () => {
    const result = validatePatchResponse({ ops: [{ op: "addRoom", program: "entry" }] }, CORE_PATCH_OPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.patch.ops[0] as { areaWeight: number };
    expect(op.areaWeight).toBeGreaterThan(0);
  });

  it("applies a turn whose addRoom omitted areaWeight (the 'Add foyer' case)", async () => {
    const provider = providerReturning([{ ops: [{ op: "addRoom", program: "entry", name: "Foyer" }] }]);
    // Deliberately phrased so the deterministic matcher (INF-5) can't handle it and
    // the turn actually reaches the provider — as "Add folyer" did, via the typo.
    const outcome = await resolveTurn(plan(), "I would like a welcoming entrance area", [], provider);
    expect(outcome.kind).toBe("provider");
    if (outcome.kind !== "provider") return;
    expect(Object.values(outcome.doc.levels[0]!.graph.rooms)[0]!.name).toBe("Foyer");
  });

  it("retries once on an invalid patch, then succeeds (INF-4)", async () => {
    const provider = providerReturning([
      { ops: [{ op: "addRoom", program: "not-a-real-program" }] },
      { ops: [{ op: "addRoom", program: "kitchen" }] },
    ]);
    const outcome = await resolveTurn(plan(), "make this feel more open", [], provider);
    expect(outcome.kind).toBe("provider");
    expect(provider.calls).toBe(2);
  });

  it("reports a transport failure as an error outcome without throwing, and without retrying", async () => {
    const provider = providerThrowing("Inference failed: model was deprecated");
    const outcome = await resolveTurn(plan(), "make this feel more open", [], provider);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("unavailable");
    // Re-prompting a model that was never reached cannot help, so no second call.
    expect(provider.calls).toBe(1);
  });

  it("surfaces an unusable response as an error rather than an exception", async () => {
    const provider = providerReturning(["I'm sorry, I can't help with that."]);
    const outcome = await resolveTurn(plan(), "make this feel more open", [], provider);
    expect(outcome.kind).toBe("error");
  });

  it("recovers JSON from a fenced code block", () => {
    expect(safeJsonParse('```json\n{"ops":[]}\n```')).toEqual({ ops: [] });
    expect(safeJsonParse("not json at all")).toBe("not json at all");
  });

  it("recovers JSON wrapped in a stray lead-in sentence", () => {
    expect(safeJsonParse('Here\'s the updated plan: {"ops":[{"op":"removeRoom","roomId":"r1"}]}')).toEqual({
      ops: [{ op: "removeRoom", roomId: "r1" }],
    });
    // A brace that only appears inside a string literal must not confuse the scan.
    expect(safeJsonParse('Sure! {"ops":[],"narration":"looks like a } to me"}')).toEqual({
      ops: [],
      narration: "looks like a } to me",
    });
  });

  it("gives up cleanly on truncated JSON rather than throwing", () => {
    const truncated = '{"ops":[{"op":"addRoom","program":"kitchen"';
    expect(safeJsonParse(truncated)).toBe(truncated);
  });
});
