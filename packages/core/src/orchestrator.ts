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
    let raw: unknown;
    try {
      // Providers are only typed to return a Patch; we never trust that contractually — validate regardless.
      raw = (await provider.propose({ summary, utterance: effectiveUtterance, history })) as unknown;
    } catch (e) {
      // A provider that throws never reached the model (network, quota, an unavailable
      // model). Distinguished from a validation failure because re-prompting a model
      // that was never asked cannot fix it — see the retry policy below.
      return { ok: false as const, failure: "transport" as const, error: (e as Error).message };
    }
    const allowed = provider.tier === 0 ? CORE_PATCH_OPS : FULL_PATCH_OPS;
    const parsed = validatePatchResponse(raw, allowed);
    if (!parsed.ok) return { ok: false as const, failure: "validation" as const, error: parsed.error };
    const applied = applyPatch(doc, parsed.patch);
    if (!applied.ok) return { ok: false as const, failure: "validation" as const, error: describeApplyFailure(applied) };
    return { ok: true as const, patch: parsed.patch, doc: applied.doc, changes: applied.changes };
  };

  let result = await attempt();
  // INF-4's automatic repair retry applies to an *invalid patch* — a model that answered
  // badly. A transport failure gets no correction note (there is nothing to correct) and
  // no second call, so a hard outage fails fast instead of hanging for two round trips.
  if (!result.ok && result.failure === "validation") {
    result = await attempt(
      `Your previous response was invalid: ${result.error}. Reply again with corrected JSON only, following the schema exactly.`,
    );
  }
  if (!result.ok) {
    const message =
      result.failure === "transport"
        ? `The assistant is unavailable right now (${result.error}). Your plan is unchanged — you can keep editing manually, or switch tiers in the header.`
        : `The assistant could not produce a valid plan change (${result.error}). The plan is unchanged.`;
    return { kind: "error", message };
  }

  return { kind: "provider", doc: result.doc, changes: result.changes, narration: result.patch.narration, providerId: provider.id };
}
