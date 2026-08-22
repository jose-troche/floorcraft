// Tier 2 — OpenRouter, one-click connect (specs.md §5.3 T2-1..T2-5). The OAuth PKCE
// exchange itself is client-only glue (apps/web/src/client/openrouterAuth.ts) since it
// needs a browser redirect; this file is just the inference call once a key exists.

import type { Availability, PlanProvider } from "./types.js";
import { HttpJsonProvider } from "./httpJsonProvider.js";

// T2-5: default to a model free even with zero OpenRouter credits, so connecting costs
// nothing until the user opts into a paid model. Picking from OpenRouter's live /models
// list (filtered to pricing.prompt === "0") would track deprecations automatically; this
// hardcoded default doesn't, and is a known follow-up rather than a design decision.
export const TIER2_DEFAULT_MODEL = "meta-llama/llama-3.2-3b-instruct:free";

export type Tier2Options = {
  getApiKey: () => string | null;
  model?: string;
  fetchImpl?: typeof fetch;
};

export class Tier2Provider implements PlanProvider {
  readonly id = "tier2-openrouter" as const;
  readonly tier = 2 as const;

  private inner: HttpJsonProvider;

  constructor(private opts: Tier2Options) {
    this.inner = new HttpJsonProvider({
      id: this.id,
      tier: this.tier,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: opts.model ?? TIER2_DEFAULT_MODEL,
      getApiKey: opts.getApiKey,
      // OpenRouter attributes usage to the referring app via these two headers; neither
      // is sensitive, and OpenRouter's own docs recommend sending them.
      buildHeaders: (key) => ({
        authorization: `Bearer ${key}`,
        "http-referer": typeof location !== "undefined" ? location.origin : "https://floorcraft.app",
        "x-title": "Floorcraft",
      }),
      fetchImpl: opts.fetchImpl,
    });
  }

  async availability(): Promise<Availability> {
    return this.inner.availability();
  }

  propose: HttpJsonProvider["propose"] = (input) => this.inner.propose(input);
}
