import { describe, expect, it } from "vitest";
import { Tier3Provider } from "../src/providers/tier3.js";
import type { PlanSummary } from "../src/types.js";

function summary(): PlanSummary {
  return {
    title: "T",
    units: "imperial",
    boundary: { widthMm: 9144, depthMm: 12192 },
    rooms: [],
    adjacencies: [],
    mode: "slicing",
    generatorTree: null,
  };
}

describe("Tier3Provider — Anthropic", () => {
  it("sends x-api-key and the browser-CORS header, and parses the text content block", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"ops":[]}' }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new Tier3Provider({ vendor: "anthropic", getApiKey: () => "sk-ant-secret", fetchImpl });
    const patch = await provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] });

    expect(patch).toEqual({ ops: [] });
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-secret");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["anthropic-version"]).toBeTruthy();
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBeTruthy();
    expect(body.system).toContain("addRoom");
  });

  it("throws when no key is configured", async () => {
    const provider = new Tier3Provider({ vendor: "anthropic", getApiKey: () => null });
    await expect(provider.propose({ summary: summary(), utterance: "x", history: [] })).rejects.toThrow();
  });
});

describe("Tier3Provider — OpenAI", () => {
  it("sends a Bearer header to the chat completions endpoint", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ops":[]}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new Tier3Provider({ vendor: "openai", getApiKey: () => "sk-secret", fetchImpl });
    const patch = await provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] });

    expect(patch).toEqual({ ops: [] });
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
  });
});

describe("Tier3Provider — Google", () => {
  it("passes the key as a query param and requests JSON output", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ops":[]}' }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new Tier3Provider({ vendor: "google", getApiKey: () => "google-secret", fetchImpl });
    const patch = await provider.propose({ summary: summary(), utterance: "add a kitchen", history: [] });

    expect(patch).toEqual({ ops: [] });
    expect(capturedUrl).toContain("key=google-secret");
    expect(capturedUrl).toContain("generateContent");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("Tier3Provider availability", () => {
  it("reflects whether a key is currently on file", async () => {
    let key: string | null = null;
    const provider = new Tier3Provider({ vendor: "openai", getApiKey: () => key });
    expect(await provider.availability()).toBe("unavailable");
    key = "sk-secret";
    expect(await provider.availability()).toBe("available");
  });
});
