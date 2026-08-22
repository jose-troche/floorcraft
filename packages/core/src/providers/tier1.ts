// Tier 1 — hosted free pool (specs.md §5.3 T1-1..T1-6). Client-side half of the
// proxy: builds the prompt, calls POST /api/infer with a Turnstile token, and
// consumes the streamed response. The model API key never reaches this code.

import type { Patch, PlanSummary, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { FREEFORM_PATCH_OPS, FULL_PATCH_OPS, buildPatchJsonSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { safeJsonParse } from "./safeJsonParse.js";

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
    // A freeform level has no generator tree to restructure — see FREEFORM_PATCH_OPS.
    const ops = input.summary.mode === "freeform" ? FREEFORM_PATCH_OPS : FULL_PATCH_OPS;
    const system = buildSystemPrompt(ops);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(ops);

    const send = async () => {
      const turnstileToken = await this.opts.getTurnstileToken();
      return fetchFn(this.opts.endpoint ?? "/api/infer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, user, schema, turnstileToken }),
      });
    };

    let res = await send();
    // /api/infer's only 403 is a failed Turnstile siteverify. Tokens are single-use and
    // Turnstile's own scoring is probabilistic (worse under Safari's ITP, which starves
    // it of cross-site signal) — one retry with a fresh token clears most of these
    // without surfacing a spurious "assistant unavailable" for what's really a retry.
    if (res.status === 403) {
      res = await send();
    }

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

    // Returned unvalidated on purpose — see the note in tier0.ts. Only transport-level
    // failures (above) throw from here; a bad answer is the orchestrator's to retry.
    return safeJsonParse(modelText) as Patch;
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
