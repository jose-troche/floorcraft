// Turn orchestration — specs.md §5.1 (INF-4, INF-5) and §5.4 (RTE-3/RTE-4).
// Tries the deterministic intent matcher first; only calls a provider when no
// deterministic match exists. Validates every provider patch against the schema
// and solver preconditions, with exactly one automatic repair retry (INF-4).

import { applyPatch } from "./patch.js";
import { matchDeterministicIntent } from "./intentMatcher.js";
import { buildPlanSummary } from "./planSummary.js";
import type { PlanDocument, Turn } from "./types.js";
import type { PlanProvider } from "./providers/types.js";
import { CORE_PATCH_OPS, FULL_PATCH_OPS, validatePatchResponse } from "./providers/schema.js";

export type TurnOutcome =
  | { kind: "deterministic"; doc: PlanDocument; changes: string[] }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "provider"; doc: PlanDocument; changes: string[]; narration?: string; providerId: string }
  | { kind: "error"; message: string };

function describeApplyFailure(result: { ok: false; errors: string[]; violations?: { message: string }[] }): string {
  if (result.violations && result.violations.length > 0) return result.violations.map((v) => v.message).join(" ");
  return result.errors.join("; ") || "Unknown validation failure";
}

export async function resolveTurn(
  doc: PlanDocument,
  utterance: string,
  history: Turn[],
  provider: PlanProvider | null,
): Promise<TurnOutcome> {
  const intent = matchDeterministicIntent(doc, utterance);
  if (intent) {
    if (intent.kind === "undo") return { kind: "undo" };
    if (intent.kind === "redo") return { kind: "redo" };
    const result = applyPatch(doc, intent.patch);
    if (result.ok) return { kind: "deterministic", doc: result.doc, changes: result.changes };
    return { kind: "error", message: describeApplyFailure(result) };
  }

  if (!provider) {
    return {
      kind: "error",
      message:
        "No inference is available right now. Try a direct command — rename, resize by %, swap, delete, add a room, undo/redo, or change units — or edit the plan manually.",
    };
  }

  const summary = buildPlanSummary(doc);

  const attempt = async (note?: string) => {
    const effectiveUtterance = note ? `${utterance}\n\n[${note}]` : utterance;
    // Providers are only typed to return a Patch; we never trust that contractually — validate regardless.
    const raw = (await provider.propose({ summary, utterance: effectiveUtterance, history })) as unknown;
    const allowed = provider.tier === 0 ? CORE_PATCH_OPS : FULL_PATCH_OPS;
    const parsed = validatePatchResponse(raw, allowed);
    if (!parsed.ok) return { ok: false as const, error: parsed.error };
    const applied = applyPatch(doc, parsed.patch);
    if (!applied.ok) return { ok: false as const, error: describeApplyFailure(applied) };
    return { ok: true as const, patch: parsed.patch, doc: applied.doc, changes: applied.changes };
  };

  let result = await attempt();
  if (!result.ok) {
    result = await attempt(
      `Your previous response was invalid: ${result.error}. Reply again with corrected JSON only, following the schema exactly.`,
    );
  }
  if (!result.ok) {
    return { kind: "error", message: `The assistant could not produce a valid plan change (${result.error}). The plan is unchanged.` };
  }

  return { kind: "provider", doc: result.doc, changes: result.changes, narration: result.patch.narration, providerId: provider.id };
}
