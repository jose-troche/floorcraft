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

  it("keeps both vocabularies warm instead of trading one for the other", async () => {
    // A generated level and a freeform one are primed with different system prompts. With
    // one cache slot, moving between them destroyed and rebuilt the session every time —
    // so a user who switched levels paid the cold start on turn after turn.
    const { create } = installFakeLanguageModel();
    const provider = new Tier0Provider();
    const generated = proposeInput();
    const freeform = { ...generated, summary: { ...generated.summary, mode: "freeform" as const } };

    await provider.propose(generated);
    await provider.propose(freeform);
    await provider.propose(generated);
    await provider.propose(freeform);

    // One create per vocabulary, not one per turn.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("falls back to an unconstrained prompt when the browser rejects the schema", async () => {
    // Chrome compiles responseConstraint into a grammar and can refuse a schema outright.
    // That is the constraint failing, not the model — asking again in plain text still
    // answers the question, and safeJsonParse is already built for unfenced output.
    installFakeLanguageModel();
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unsupported schema"), { name: "NotSupportedError" }))
      .mockResolvedValueOnce("```json\n{\"ops\":[{\"op\":\"addRoom\",\"program\":\"office\"}]}\n```");
    (globalThis as Record<string, any>).LanguageModel.create = vi.fn(async () => ({ prompt, destroy: vi.fn() }));

    const patch = await new Tier0Provider().propose(proposeInput());

    expect(patch.ops).toHaveLength(1);
    // The retry drops the constraint rather than repeating the call that just failed.
    expect(prompt.mock.calls[0]![1]).toHaveProperty("responseConstraint");
    expect(prompt.mock.calls[1]![1]).toBeUndefined();
  });

  it("does not retry a prompt the user just aborted", async () => {
    // An abort is the user's decision; asking again unconstrained only makes them wait
    // for a result they cancelled.
    installFakeLanguageModel();
    const prompt = vi.fn().mockRejectedValue(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    (globalThis as Record<string, any>).LanguageModel.create = vi.fn(async () => ({ prompt, destroy: vi.fn() }));

    await expect(new Tier0Provider().propose(proposeInput())).rejects.toThrow("cancelled");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a session the browser reclaimed instead of failing the turn", async () => {
    // A tab left in the background long enough loses its on-device session, and the
    // cached handle only says so when it is next used — which would otherwise be the
    // user's message, failing for a reason they can do nothing about.
    installFakeLanguageModel();
    const dead = { prompt: vi.fn().mockRejectedValue(Object.assign(new Error("reclaimed"), { name: "InvalidStateError" })), destroy: vi.fn() };
    const live = { prompt: vi.fn(async () => JSON.stringify({ ops: [{ op: "addRoom", program: "kitchen" }] })), destroy: vi.fn() };
    const create = vi.fn().mockResolvedValueOnce(dead).mockResolvedValue(live);
    (globalThis as Record<string, any>).LanguageModel.create = create;

    const provider = new Tier0Provider();
    provider.warmup();
    const patch = await provider.propose(proposeInput());

    expect(patch.ops).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    // And the dead one is gone from the cache, so the next turn goes straight to the new
    // session rather than paying the same discovery again.
    await provider.propose(proposeInput());
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("replaces a reclaimed session on re-warm, before the user's next message pays for it", async () => {
    // What the app does when a backgrounded tab comes back. The point of the re-warm is
    // that the rebuild happens here rather than inside the next turn.
    const dead = {
      prompt: vi.fn(),
      clone: vi.fn().mockRejectedValue(Object.assign(new Error("reclaimed"), { name: "InvalidStateError" })),
      destroy: vi.fn(),
    };
    const live = {
      prompt: vi.fn(async () => JSON.stringify({ ops: [{ op: "addRoom", program: "kitchen" }] })),
      clone: vi.fn(async () => ({ prompt: live.prompt, destroy: vi.fn() })),
      destroy: vi.fn(),
    };
    installFakeLanguageModel();
    const create = vi.fn().mockResolvedValueOnce(dead).mockResolvedValue(live);
    (globalThis as Record<string, any>).LanguageModel.create = create;

    const provider = new Tier0Provider();
    provider.warmup();
    await new Promise((r) => setTimeout(r, 0));
    provider.warmup(); // the tab came back
    await new Promise((r) => setTimeout(r, 0));

    expect(create).toHaveBeenCalledTimes(2);
    // The turn itself then costs nothing extra — no third create, and the dead session
    // is never prompted.
    await provider.propose(proposeInput());
    expect(create).toHaveBeenCalledTimes(2);
    expect(dead.prompt).not.toHaveBeenCalled();
  });

  it("leaves a live session alone on re-warm", async () => {
    const { create } = installFakeLanguageModel();
    const provider = new Tier0Provider();

    provider.warmup();
    await new Promise((r) => setTimeout(r, 0));
    provider.warmup();
    provider.warmup();
    await new Promise((r) => setTimeout(r, 0));

    // Re-warming has to be free, or the tab-visibility hook that calls it would be
    // paying a cold start every time the user glanced at another tab.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the browser has no LanguageModel at all", () => {
    delete (globalThis as Record<string, unknown>).LanguageModel;
    expect(() => new Tier0Provider().warmup()).not.toThrow();
  });
});
