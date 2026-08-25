// Worked examples of what chat understands, in one place so the two things that show
// them can't drift apart: the example chips above the chat box, and the message shown
// when a turn could not be understood at all. Both exist to answer the same question —
// "what am I allowed to say?" — so they must answer it the same way.
//
// Every line here is a request the deterministic layers (dimensionParser.ts,
// intentMatcher.ts) resolve on their own, with no provider involved. That is deliberate:
// a suggestion offered right after an inference failure has to be one that works whether
// or not any inference tier is available.

export type ExampleRequest = {
  /** Verbatim text put into the chat box when the example is picked. */
  text: string;
  /** What capability it demonstrates — the chip's tooltip, not the chip's label. */
  hint: string;
};

export const EXAMPLE_REQUESTS: readonly ExampleRequest[] = [
  { text: "Add a kitchen, a living room and a family room", hint: "Several rooms in one go" },
  { text: "Add three bedrooms", hint: "A count of identical rooms" },
  { text: "Add a kitchen of 8 x 5 feet", hint: "An exact size, stated up front" },
  { text: "Add a pantry next to the kitchen", hint: "Placement relative to another room" },
  { text: "Remove the kitchen", hint: "Delete a room" },
  { text: "Increase the kitchen by 10%", hint: "Resize by proportion" },
  { text: "Reduce the length of the kitchen by 2 meters", hint: "Change one dimension by an amount" },
  { text: "Rename the office to Studio", hint: "Rename a room" },
  { text: "Swap the kitchen and the family room", hint: "Exchange two rooms' positions" },
  { text: "Switch to metric", hint: "Change the unit system" },
];

/**
 * What the user is told when nothing — dimensions, the intent matcher, or a provider —
 * could make sense of the turn. Names a few concrete things to say rather than reporting
 * the parse failure: "response is not a JSON object" is true and completely useless to
 * someone who just wants three bedrooms.
 */
export function unrecognizedRequestMessage(): string {
  const suggestions = EXAMPLE_REQUESTS.slice(0, 3)
    .map((e) => `"${e.text.toLowerCase()}"`)
    .join(", ");
  return `Sorry, I didn't understand that, so the plan is unchanged. Try something like ${suggestions} — or use the Manual editor tab.`;
}
