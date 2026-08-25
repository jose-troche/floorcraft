// The examples offered to the user — as chips above the chat box, and as suggestions in
// the message shown when a turn could not be understood — are a promise about what the
// app accepts. This is the test that keeps the promise honest.
//
// Every one of them must resolve with `provider: null`, i.e. through the dimension parser
// and the intent matcher alone. Two reasons that bar is set where it is: the suggestions
// are shown at the exact moment inference has just failed, so an example that needs a
// working model is worse than no example at all; and a suggestion that turns out not to
// work is a much worse first impression than never having offered it.

import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { resolveTurn } from "../src/orchestrator.js";
import { EXAMPLE_REQUESTS, unrecognizedRequestMessage } from "../src/examples.js";
import type { PlanDocument } from "../src/types.js";

/** A plan holding every room the examples name, so none of them fails on a missing target. */
function seeded(): PlanDocument {
  const doc = createEmptyPlan({ id: "p", title: "T", units: "imperial", boundary: { widthMm: 12000, depthMm: 10000 } });
  const result = applyPatch(doc, {
    ops: [
      { op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 },
      { op: "addRoom", roomId: "office", program: "office", name: "Office", areaWeight: 1 },
      { op: "addRoom", roomId: "family", program: "family", name: "Family Room", areaWeight: 1 },
    ],
    source: "user",
  });
  if (!result.ok) throw new Error("setup failed");
  return result.doc;
}

describe("advertised examples", () => {
  for (const example of EXAMPLE_REQUESTS) {
    it(`resolves "${example.text}" with no provider at all`, async () => {
      const outcome = await resolveTurn(seeded(), example.text, [], null);
      expect(outcome.kind, JSON.stringify(outcome)).toBe("deterministic");
    });
  }

  it("names real examples in the message shown when a turn fails", () => {
    const message = unrecognizedRequestMessage();
    expect(message).toContain(EXAMPLE_REQUESTS[0]!.text.toLowerCase());
  });
});
