// Tier 0 — on-device (specs.md §5.3 T0-1..T0-5). Chrome's built-in `LanguageModel`
// (Prompt API), feature-detected; never assumed present, never blocks on download.

import type { Patch, PlanSummary, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { CORE_PATCH_OPS, buildPatchJsonSchema, validatePatchResponse } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";

const TOKEN_BUDGET = 1500; // T0-3

type LanguageModelSession = {
  prompt(input: string, opts?: { responseConstraint?: unknown }): Promise<string>;
  clone?: () => Promise<LanguageModelSession>;
  destroy?: () => void;
};

type BrowserLanguageModel = {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts?: { initialPrompts?: Array<{ role: string; content: string }> }): Promise<LanguageModelSession>;
};

function getLanguageModel(): BrowserLanguageModel | null {
  const g = globalThis as unknown as { LanguageModel?: BrowserLanguageModel };
  return "LanguageModel" in globalThis && g.LanguageModel ? g.LanguageModel : null;
}

export class Tier0Provider implements PlanProvider {
  readonly id = "tier0-on-device" as const;
  readonly tier = 0 as const;

  // Reused across turns so the model's weights/context aren't reinitialized on every
  // message — creating a session is the expensive part, not prompting an existing one.
  private baseSessionPromise: Promise<LanguageModelSession> | null = null;

  async availability(): Promise<Availability> {
    const lm = getLanguageModel();
    if (!lm) return "unavailable";
    try {
      const status = await lm.availability();
      if (status === "available") return "available";
      if (status === "downloadable" || status === "downloading") return "downloadable";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private getBaseSession(lm: BrowserLanguageModel, system: string): Promise<LanguageModelSession> {
    if (!this.baseSessionPromise) {
      this.baseSessionPromise = lm.create({ initialPrompts: [{ role: "system", content: system }] }).catch((err) => {
        this.baseSessionPromise = null;
        throw err;
      });
    }
    return this.baseSessionPromise;
  }

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const lm = getLanguageModel();
    if (!lm) throw new Error("Tier 0 model unavailable");

    const system = buildSystemPrompt(CORE_PATCH_OPS);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(CORE_PATCH_OPS);

    const base = await this.getBaseSession(lm, system);
    // Clone per turn (cheap — no model reinit) so each call is stateless: our own prompt
    // already carries summary+history (T0-3), so the session itself must not accumulate
    // its own turn-by-turn memory on top of that or context would double up and grow
    // unbounded. Browsers without clone() fall back to prompting the shared session directly.
    const session = base.clone ? await base.clone() : base;
    try {
      const text = await session.prompt(user, { responseConstraint: schema });
      const raw = JSON.parse(text);
      const validated = validatePatchResponse(raw, CORE_PATCH_OPS);
      if (!validated.ok) throw new Error(validated.error);
      return validated.patch;
    } finally {
      if (session !== base) session.destroy?.();
    }
  }
}
