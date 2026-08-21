// Warm-up exists to hide the on-device session's cold start (a multi-second first turn).
// It only does that if the session it creates is the one propose() later reuses — a
// warm-up that builds a session propose() then throws away costs time instead of saving it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Tier0Provider } from "../src/providers/tier0.js";
import { buildPlanSummary } from "../src/planSummary.js";
import { createEmptyPlan } from "../src/patch.js";

type FakeSession = { prompt: ReturnType<typeof vi.fn>; clone: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };

function installFakeLanguageModel(opts: { createDelayMs?: number } = {}) {
  const created: string[] = [];
  const makeSession = (): FakeSession => {
    const session: FakeSession = {
      prompt: vi.fn(async () => JSON.stringify({ ops: [{ op: "addRoom", program: "kitchen" }], narration: "ok" })),
      clone: vi.fn(async () => makeSession()),
      destroy: vi.fn(),
    };
    return session;
  };
  const create = vi.fn(async (o?: { initialPrompts?: Array<{ role: string; content: string }> }) => {
    created.push(o?.initialPrompts?.[0]?.content ?? "");
    if (opts.createDelayMs) await new Promise((r) => setTimeout(r, opts.createDelayMs));
    return makeSession();
  });
  (globalThis as Record<string, unknown>).LanguageModel = {
    availability: vi.fn(async () => "available" as const),
    create,
  };
  return { create, created };
}

function proposeInput() {
  const doc = createEmptyPlan({ id: "p1", title: "T", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
  return { summary: buildPlanSummary(doc), utterance: "add a kitchen and an office", history: [] };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).LanguageModel;
});

describe("Tier 0 warm-up", () => {
  it("reuses the warmed session instead of creating a second one on the first turn", async () => {
    const { create } = installFakeLanguageModel();
    const provider = new Tier0Provider();

    provider.warmup();
    await provider.propose(proposeInput());

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("makes the first turn wait only on the warm-up already in flight, never on a fresh create", async () => {
    // propose() called while warmup()'s create is still pending must join that same
    // promise; a second create here would mean the user pays the cold start anyway.
    const { create } = installFakeLanguageModel({ createDelayMs: 20 });
    const provider = new Tier0Provider();

    provider.warmup();
    await provider.propose(proposeInput());

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("primes the session with the same system prompt propose() asks for", async () => {
    const { created } = installFakeLanguageModel();
    const provider = new Tier0Provider();

    provider.warmup();
    await provider.propose(proposeInput());

    // One create, and its system prompt is the one propose() would have built itself —
    // otherwise the cache would be serving a session primed for a different vocabulary.
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("Floorcraft");
  });

  it("does not leave the provider poisoned when the warm-up create fails", async () => {
    installFakeLanguageModel();
    const lm = (globalThis as Record<string, any>).LanguageModel;
    lm.create = vi
      .fn()
      .mockRejectedValueOnce(new Error("model busy"))
      .mockImplementation(async () => ({
        prompt: vi.fn(async () => JSON.stringify({ ops: [{ op: "addRoom", program: "kitchen" }] })),
        clone: undefined,
        destroy: vi.fn(),
      }));
    const provider = new Tier0Provider();

    provider.warmup();
    await new Promise((r) => setTimeout(r, 0));
    // A failed warm-up is a missed optimisation, not a broken provider: the next real
    // turn must still be able to build its own session.
    const patch = await provider.propose(proposeInput());

    expect(patch.ops).toHaveLength(1);
    expect(lm.create).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the browser has no LanguageModel at all", () => {
    delete (globalThis as Record<string, unknown>).LanguageModel;
    expect(() => new Tier0Provider().warmup()).not.toThrow();
  });
});
