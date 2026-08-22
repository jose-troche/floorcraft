// Shared OpenAI-compatible chat-completion provider — specs.md ARC-2 (no forked
// implementations): Tier 2 (OpenRouter) and Tier 3's OpenAI leg both go through this one
// class, differing only in endpoint, model, and how the API key gets into the request.
//
// Every call happens directly from the browser to the provider (T3-3's logic extended to
// Tier 2 as well): no Worker in the path, no request quota spent, and the key never
// touches Floorcraft's own server.

import type { Patch, PlanSummary, ProviderId, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { FREEFORM_PATCH_OPS, FULL_PATCH_OPS, buildPatchJsonSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { safeJsonParse } from "./safeJsonParse.js";

const TOKEN_BUDGET = 4000;

export type HttpJsonProviderConfig = {
  id: ProviderId;
  tier: 0 | 1 | 2 | 3;
  endpoint: string;
  model: string;
  /** Returns the stored key, or null if the tier isn't connected/configured yet. */
  getApiKey: () => string | null;
  /** Turns a present key into request headers — providers disagree on the header name. */
  buildHeaders: (apiKey: string) => Record<string, string>;
  /** Extra body fields a specific API needs beyond the OpenAI-compatible core (e.g. OpenRouter's routing hints). */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
};

/**
 * An OpenAI-compatible `/chat/completions` caller: structured JSON output via
 * `response_format`, single request/response, no streaming (T1-6's streaming requirement
 * is Tier 1-specific — the Worker relays because it's proxying; these tiers talk directly
 * to the provider from the browser, so there's no proxy buffering concern to design around).
 */
export class HttpJsonProvider implements PlanProvider {
  readonly id: ProviderId;
  readonly tier: 0 | 1 | 2 | 3;

  constructor(private config: HttpJsonProviderConfig) {
    this.id = config.id;
    this.tier = config.tier;
  }

  async availability(): Promise<Availability> {
    return this.config.getApiKey() ? "available" : "unavailable";
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const apiKey = this.config.getApiKey();
    if (!apiKey) throw new Error(`${this.id} is not connected — no API key on file`);

    const ops = input.summary.mode === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
    const system = buildSystemPrompt(ops);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(ops);

    const fetchFn = this.config.fetchImpl ?? fetch;
    const res = await fetchFn(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.config.buildHeaders(apiKey) },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name: "floorcraft_patch", strict: false, schema } },
        ...this.config.extraBody,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.id} request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`${this.id} returned no content`);

    // Returned unvalidated on purpose, same as every other provider — the orchestrator
    // validates every response regardless (INF-4) and owns the repair retry.
    return safeJsonParse(content) as Patch;
  }
}
