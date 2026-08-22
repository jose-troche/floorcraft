import { describe, expect, it } from "vitest";
import { Tier2Provider } from "../src/providers/tier2.js";
import type { PlanSummary } from "../src/types.js";

function summary(mode: "slicing" | "freeform" = "slicing"): PlanSummary {
  return {
    title: "T",
    units: "imperial",
    boundary: { widthMm: 9144, depthMm: 12192 },
    rooms: [],
    adjacencies: [],
    mode,
    generatorTree: null,
  };
}

describe("Tier2Provider", () => {
  it("reports unavailable with no key, available once one is set", async () => {
    let key: string | null = null;
    const provider = new Tier2Provider({ getApiKey: () => key });
    expect(await provider.availability()).toBe("unavailable");
    key = "sk-or-v1-test";
    expect(await provider.availability()).toBe("available");
  });

  it("throws (not a silent failure) when propose is called with no key", async () => {
    const provider = new Tier2Provider({ getApiKey: () => null });
    await expect(provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] })).rejects.toThrow();
  });

  it("sends the key as a Bearer header and parses the chat-completion response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedInit = init;
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ops":[{"op":"addRoom","program":"kitchen","areaWeight":1}]}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const provider = new Tier2Provider({ getApiKey: () => "sk-or-v1-secret", fetchImpl });
    const patch = await provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] });

    expect(patch).toMatchObject({ ops: [{ op: "addRoom", program: "kitchen" }] });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or-v1-secret");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBeTruthy();
    expect(body.messages).toHaveLength(2);
  });

  it("asks for the freeform vocabulary when the level is freeform", async () => {
    let sentSystem = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sentSystem = body.messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ops":[]}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new Tier2Provider({ getApiKey: () => "sk-or-v1-secret", fetchImpl });
    await provider.propose({ summary: summary("freeform"), utterance: "rename the kitchen", history: [] });

    expect(sentSystem).not.toContain("resizeRoom");
    expect(sentSystem).toContain("renameRoom");
  });

  it("surfaces a non-2xx response as a thrown error rather than a malformed patch", async () => {
    const fetchImpl = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    const provider = new Tier2Provider({ getApiKey: () => "sk-or-v1-secret", fetchImpl });
    await expect(provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] })).rejects.toThrow(/429/);
  });
});
