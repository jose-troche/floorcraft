// Tier 0 — on-device (specs.md §5.3 T0-1..T0-5). Chrome's built-in `LanguageModel`
// (Prompt API), feature-detected; never assumed present, never blocks on download.

import type { Patch, PlanSummary, Turn } from "../types.js";
import type { Availability, PlanProvider } from "./types.js";
import { CORE_PATCH_OPS, buildPatchJsonSchema, validatePatchResponse } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";

const TOKEN_BUDGET = 1500; // T0-3

type BrowserLanguageModel = {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts?: { initialPrompts?: Array<{ role: string; content: string }> }): Promise<{
    prompt(input: string, opts?: { responseConstraint?: unknown }): Promise<string>;
    destroy?: () => void;
  }>;
};

function getLanguageModel(): BrowserLanguageModel | null {
  const g = globalThis as unknown as { LanguageModel?: BrowserLanguageModel };
  return "LanguageModel" in globalThis && g.LanguageModel ? g.LanguageModel : null;
}

export class Tier0Provider implements PlanProvider {
  readonly id = "tier0-on-device" as const;
  readonly tier = 0 as const;

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

  async propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch> {
    const lm = getLanguageModel();
    if (!lm) throw new Error("Tier 0 model unavailable");

    const system = buildSystemPrompt(CORE_PATCH_OPS);
    const user = buildUserPrompt({ ...input, tokenBudget: TOKEN_BUDGET });
    const schema = buildPatchJsonSchema(CORE_PATCH_OPS);

    const session = await lm.create({ initialPrompts: [{ role: "system", content: system }] });
    try {
      const text = await session.prompt(user, { responseConstraint: schema });
      const raw = JSON.parse(text);
      const validated = validatePatchResponse(raw, CORE_PATCH_OPS);
      if (!validated.ok) throw new Error(validated.error);
      return validated.patch;
    } finally {
      session.destroy?.();
    }
  }
}
