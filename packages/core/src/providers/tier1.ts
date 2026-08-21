// Tier 1 — hosted free pool (specs.md §5.3 T1-1..T1-6). Client-side half of the
// proxy: builds the prompt, calls POST /api/infer with a Turnstile token, and
// consumes the streamed response. The model API key never reaches this code.

import type { Patch, PlanSummary, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { FULL_PATCH_OPS, buildPatchJsonSchema, validatePatchResponse } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";

const TOKEN_BUDGET = 3000;

export type Tier1Options = {
  endpoint?: string;
  getTurnstileToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

export class Tier1Provider implements PlanProvider {
  readonly id = "tier1-hosted" as const;
  readonly tier = 1 as const;

  private lastAvailability: Availability = "available";

  constructor(private opts: Tier1Options) {}

  async availability(): Promise<Availability> {
    return this.lastAvailability;
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const system = buildSystemPrompt(FULL_PATCH_OPS);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(FULL_PATCH_OPS);
    const turnstileToken = await this.opts.getTurnstileToken();

    const res = await fetchFn(this.opts.endpoint ?? "/api/infer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system, user, schema, turnstileToken }),
    });

    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      this.lastAvailability = body?.reason === "global_pool_exhausted" ? "exhausted" : "unavailable";
      throw new Error(body?.reason === "global_pool_exhausted" ? "Tier 1 global pool exhausted for today" : "Tier 1 quota exceeded");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body?.error ? `Tier 1 request failed: ${body.error}` : `Tier 1 request failed: ${res.status}`);
    }
    this.lastAvailability = "available";

    const text = await streamToText(res);
    const contentType = res.headers.get("content-type") ?? "";
    const modelText = contentType.includes("text/event-stream") ? parseWorkersAiSse(text) : text;

    let raw: unknown;
    try {
      raw = JSON.parse(modelText);
    } catch (e) {
      throw new Error(`Tier 1 response was not valid JSON: ${(e as Error).message}`);
    }
    const validated = validatePatchResponse(raw, FULL_PATCH_OPS);
    if (!validated.ok) throw new Error(validated.error);
    return validated.patch;
  }
}

/**
 * Workers AI streams chat completions as SSE: a "data: {...}" line per chunk with a
 * `response` field carrying the text delta, terminated by "data: [DONE]". The Worker
 * relays this untouched (T1-6); this is the client-side counterpart that reassembles it.
 */
function parseWorkersAiSse(text: string): string {
  let out = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const chunk = JSON.parse(payload) as { response?: string };
      if (typeof chunk.response === "string") out += chunk.response;
    } catch {
      // Ignore malformed keep-alive/heartbeat lines.
    }
  }
  return out;
}

async function streamToText(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
