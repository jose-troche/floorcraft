// How an applied turn is worded in the chat transcript. Lives here rather than in the
// client so the wording is covered by the core test suite — the transcript is the only
// place a user finds out what actually happened to their plan.

/**
 * Composes the assistant's transcript line for a turn that applied.
 *
 * Narration (the provider's own sentence) and the applied-change list describe the very
 * same ops, so emitting both prints everything twice — the reported
 * "Added 'kitchen', 'living room', and 'office' rooms to the plan. Added Kitchen, Added
 * Living, Added Office". Narration is the better sentence when we have one; the change
 * list is the voice for deterministic turns, which never carry narration.
 *
 * An empty change list is the exception, always worth stating: the patch applied but
 * moved nothing the user can see, and a narration claiming otherwise would be the only
 * thing they'd read.
 */
export function formatAppliedTurn(input: { changes: readonly string[]; narration?: string }): string {
  const narration = input.narration?.trim();
  const changeSummary = input.changes.join(", ");
  if (!changeSummary) return narration ? `${narration} (No visible changes.)` : "No visible changes.";
  return narration || changeSummary;
}
