// Tier1Provider's own resilience: a Turnstile siteverify failure (403 from /api/infer)
// is often transient — a stale/duplicate token, or Safari's ITP starving Turnstile's
// scoring of cross-site signal — so one retry with a fresh token happens inside the
// provider before it gives up, transparent to the orchestrator (providerResilience.test.ts
// covers that the orchestrator itself never retries a throwing provider).

import { describe, expect, it } from "vitest";
import { Tier1Provider } from "../src/providers/tier1.js";
import type { PlanSummary } from "../src/types.js";

function summary(): PlanSummary {
  return {
    title: "T",
    units: "imperial",
    boundary: { widthMm: 9144, depthMm: 12192 },
    rooms: [],
    adjacencies: [],
    generatorTree: null,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Tier1Provider Turnstile retry", () => {
  it("retries once with a fresh token after a 403 and succeeds", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const getTurnstileToken = async () => {
      tokenCalls++;
      return `token-${tokenCalls}`;
    };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      fetchCalls++;
      const body = JSON.parse(String(init?.body)) as { turnstileToken: string };
      if (fetchCalls === 1) {
        expect(body.turnstileToken).toBe("token-1");
        return jsonResponse(403, { error: "Turnstile verification failed" });
      }
      expect(body.turnstileToken).toBe("token-2");
      return new Response(JSON.stringify({ ops: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const provider = new Tier1Provider({ getTurnstileToken, fetchImpl });
    const patch = await provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] });

    expect(patch).toEqual({ ops: [] });
    expect(tokenCalls).toBe(2);
    expect(fetchCalls).toBe(2);
  });

  it("throws after a second consecutive 403 rather than retrying forever", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return jsonResponse(403, { error: "Turnstile verification failed" });
    }) as typeof fetch;

    const provider = new Tier1Provider({ getTurnstileToken: async () => "token", fetchImpl });

    await expect(provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] })).rejects.toThrow(
      "Tier 1 request failed: Turnstile verification failed",
    );
    expect(fetchCalls).toBe(2);
  });
});
