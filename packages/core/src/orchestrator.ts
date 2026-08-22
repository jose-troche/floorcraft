// Turn orchestration — specs.md §5.5 (DIM-1/DIM-4/DIM-5), §5.1 (INF-4, INF-5) and
// §5.4 (RTE-3/RTE-4).
//
// The order of the three layers is normative, not incidental:
//   1. Dimension parsing (DIM-5). Stated dimensions are facts; they are applied before
//      anything else and never sent to a model to be re-derived.
//   2. The deterministic intent matcher (INF-5) on whatever text is left.
//   3. A provider, asked only about the remainder (DIM-4).
// So "make the kitchen 5x6 feet and add a pantry" pins the kitchen deterministically and
// asks the model only to place the pantry.

import { applyPatch } from "./patch.js";
import { matchDeterministicIntent } from "./intentMatcher.js";
import { buildPlanSummary } from "./planSummary.js";
import { checkConstraintsPossible, parseDimensions, type DimensionWarning } from "./dimensionParser.js";
import type { PlanDocument, Turn } from "./types.js";
import type { PlanProvider } from "./providers/types.js";
import { CORE_PATCH_OPS, FREEFORM_PATCH_OPS, FULL_PATCH_OPS, validatePatchResponse } from "./providers/schema.js";

export type TurnOutcome =
  | { kind: "deterministic"; doc: PlanDocument; changes: string[]; warnings?: DimensionWarning[] }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "provider"; doc: PlanDocument; changes: string[]; narration?: string; providerId: string; warnings?: DimensionWarning[] }
  /**
   * The request was understood in shape but not in target — which room, or what kind of
   * room. The plan is untouched and the user is asked exactly one question (FR-5).
   */
  | { kind: "clarify"; question: string; options?: string[]; doc?: PlanDocument; changes?: string[] }
  | { kind: "error"; message: string };

function describeApplyFailure(result: { ok: false; errors: string[]; violations?: { message: string }[] }): string {
  if (result.violations && result.violations.length > 0) return result.violations.map((v) => v.message).join(" ");
  return result.errors.join("; ") || "Unknown validation failure";
}

export async function resolveTurn(
  doc: PlanDocument,
  utteranceRaw: string,
  history: Turn[],
  provider: PlanProvider | null,
): Promise<TurnOutcome> {
  // Undo and redo are checked first: they are commands about the session, not edits, and
  // must not be pulled apart by the dimension parser.
  const command = matchDeterministicIntent(doc, utteranceRaw);
  if (command?.kind === "undo") return { kind: "undo" };
  if (command?.kind === "redo") return { kind: "redo" };

  const dimensions = parseDimensions(doc, utteranceRaw);
  const dimensionChanges: string[] = [];
  const warnings = dimensions.warnings;
  let workingDoc = doc;

  if (dimensions.ops.length > 0) {
    const impossible = checkConstraintsPossible(doc, dimensions.ops);
    if (impossible) return { kind: "error", message: impossible.message };
    const applied = applyPatch(doc, { ops: dimensions.ops, source: "deterministic" });
    if (!applied.ok) return { kind: "error", message: describeApplyFailure(applied) };
    workingDoc = applied.doc;
    dimensionChanges.push(...applied.changes);
  }

  const utterance = dimensions.ops.length > 0 ? dimensions.remainder : utteranceRaw;

  // Nothing left to do beyond the dimensions themselves.
  if (dimensions.ops.length > 0 && utterance.length === 0) {
    return { kind: "deterministic", doc: workingDoc, changes: dimensionChanges, warnings };
  }

  const intent = matchDeterministicIntent(workingDoc, utterance);
  if (intent) {
    if (intent.kind === "undo") return { kind: "undo" };
    if (intent.kind === "redo") return { kind: "redo" };
    if (intent.kind === "clarify") {
      // Deliberately not handed to the provider: the deterministic layer already
      // understood the request well enough to know it is ambiguous, and a model asked
      // the same question would answer it by picking one — the guess we are avoiding.
      // Dimensions parsed earlier in the turn still stand and are returned with it.
      return {
        kind: "clarify",
        question: intent.question,
        options: intent.options,
        ...(dimensions.ops.length > 0 ? { doc: workingDoc, changes: dimensionChanges } : {}),
      };
    }
    const result = applyPatch(workingDoc, intent.patch);
    if (result.ok) return { kind: "deterministic", doc: result.doc, changes: [...dimensionChanges, ...result.changes], warnings };
    return { kind: "error", message: describeApplyFailure(result) };
  }

  if (!provider) {
    // Dimensions that were already applied stand on their own — the turn is only a
    // failure for the part no deterministic layer could handle.
    if (dimensions.ops.length > 0) {
      return {
        kind: "deterministic",
        doc: workingDoc,
        changes: [...dimensionChanges, `Could not act on "${utterance}" without an AI tier — the dimensions above were applied.`],
        warnings,
      };
    }
    return {
      kind: "error",
      message:
        "No inference is available right now. Try a direct command — rename, resize by %, swap, delete, add a room, undo/redo, or change units — or edit the plan manually.",
    };
  }

  const doc_ = workingDoc;
  const summary = buildPlanSummary(doc_);

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
    // A freeform level (DM-2) has no generator tree to restructure, so it gets the same
    // reduced vocabulary regardless of tier — mirrors whatever set the provider itself
    // built its prompt from (see tier0.ts/tier1.ts), so a response is never rejected for
    // using an op its own prompt just told it was available.
    const allowed = summary.mode === "freeform" ? FREEFORM_PATCH_OPS : provider.tier === 0 ? CORE_PATCH_OPS : FULL_PATCH_OPS;
    const parsed = validatePatchResponse(raw, allowed);
    if (!parsed.ok) return { ok: false as const, failure: "validation" as const, error: parsed.error };
    const applied = applyPatch(doc_, parsed.patch);
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

  return {
    kind: "provider",
    doc: result.doc,
    changes: [...dimensionChanges, ...result.changes],
    narration: result.patch.narration,
    providerId: provider.id,
    warnings,
  };
}
