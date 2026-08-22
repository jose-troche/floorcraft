// Tier 3 — bring your own key (specs.md §5.3 T3-1..T3-3). Three sub-providers behind
// one PlanProvider, chosen at connect time. Every one of them supports browser-origin
// CORS, so T3-3's proxy clause ("MUST call it directly and bypass the Worker") is simply
// what always happens here — no pass-through proxy exists in this codebase, and none is
// needed. Keys are supplied by the caller (apps/web stores them in localStorage per
// T3-2) and never touch this module's own storage.
//
// Anthropic is called with raw fetch rather than the SDK: every other provider in this
// file already does (ARC-2 — packages/core has zero runtime dependencies by design), and
// the Anthropic Messages API's browser-CORS support is exactly one header, so pulling in
// the SDK for one of three sub-providers would trade a small amount of boilerplate for a
// new dependency and an inconsistent pattern.

import type { Patch, PlanSummary, ProviderId, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { FREEFORM_PATCH_OPS, FULL_PATCH_OPS, buildPatchJsonSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { safeJsonParse } from "./safeJsonParse.js";
import { HttpJsonProvider } from "./httpJsonProvider.js";

export type Tier3Vendor = "anthropic" | "openai" | "google";

export type Tier3Options = {
  vendor: Tier3Vendor;
  getApiKey: () => string | null;
  model?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MODELS: Record<Tier3Vendor, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  google: "gemini-2.5-flash",
};

const TOKEN_BUDGET = 4000;
const MAX_TOKENS = 4096;

class AnthropicProvider implements PlanProvider {
  readonly id = "tier3-byok" as const;
  readonly tier = 3 as const;

  constructor(private opts: Tier3Options) {}

  async availability(): Promise<Availability> {
    return this.opts.getApiKey() ? "available" : "unavailable";
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const apiKey = this.opts.getApiKey();
    if (!apiKey) throw new Error("tier3-byok (Anthropic) is not connected — no API key on file");

    const ops = input.summary.mode === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
    const system = buildSystemPrompt(ops);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for a browser to call this endpoint directly (T3-1's whole premise);
        // without it the API refuses cross-origin requests outright.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.opts.model ?? DEFAULT_MODELS.anthropic,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`tier3-byok (Anthropic) request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = body.content?.find((b) => b.type === "text");
    if (!textBlock?.text) throw new Error("tier3-byok (Anthropic) returned no text content");
    return safeJsonParse(textBlock.text) as Patch;
  }
}

class GoogleProvider implements PlanProvider {
  readonly id = "tier3-byok" as const;
  readonly tier = 3 as const;

  constructor(private opts: Tier3Options) {}

  async availability(): Promise<Availability> {
    return this.opts.getApiKey() ? "available" : "unavailable";
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const apiKey = this.opts.getApiKey();
    if (!apiKey) throw new Error("tier3-byok (Google) is not connected — no API key on file");

    const ops = input.summary.mode === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
    const system = buildSystemPrompt(ops);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(ops);

    const model = this.opts.model ?? DEFAULT_MODELS.google;
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(schema) },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`tier3-byok (Google) request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("tier3-byok (Google) returned no text content");
    return safeJsonParse(text) as Patch;
  }
}

/** Gemini's responseSchema is JSON-Schema-like but rejects a few keywords (anyOf at the
 * root, $schema, additionalProperties in some versions) — stripped defensively rather
 * than asserted correct, since a malformed schema would fail the whole request instead
 * of just falling back to unconstrained decoding. */
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

export class Tier3Provider implements PlanProvider {
  readonly id: ProviderId = "tier3-byok";
  readonly tier = 3 as const;

  private inner: PlanProvider;

  constructor(opts: Tier3Options) {
    if (opts.vendor === "anthropic") {
      this.inner = new AnthropicProvider(opts);
    } else if (opts.vendor === "google") {
      this.inner = new GoogleProvider(opts);
    } else {
      this.inner = new HttpJsonProvider({
        id: "tier3-byok",
        tier: 3,
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: opts.model ?? DEFAULT_MODELS.openai,
        getApiKey: opts.getApiKey,
        buildHeaders: (key) => ({ authorization: `Bearer ${key}` }),
        fetchImpl: opts.fetchImpl,
      });
    }
  }

  async availability(): Promise<Availability> {
    return this.inner.availability();
  }

  propose: PlanProvider["propose"] = (input) => this.inner.propose(input);
}
