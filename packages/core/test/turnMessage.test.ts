// The transcript is where a user learns what happened to their plan, so it has to say
// each thing exactly once — the reported bug was the first turn printing the provider's
// sentence and the mechanical change list back to back.

import { describe, expect, it } from "vitest";
import { formatAppliedTurn } from "../src/turnMessage.js";

describe("applied-turn wording", () => {
  it("does not repeat the change list after the narration that already described it", () => {
    const text = formatAppliedTurn({
      narration: "Added 'kitchen', 'living room', and 'office' rooms to the plan.",
      changes: ["Added Kitchen", "Added Living", "Added Office"],
    });
    expect(text).toBe("Added 'kitchen', 'living room', and 'office' rooms to the plan.");
    expect(text).not.toContain("Added Kitchen");
  });

  it("falls back to the change list on a deterministic turn, which has no narration", () => {
    expect(formatAppliedTurn({ changes: ["Renamed room to Den"] })).toBe("Renamed room to Den");
  });

  it("treats a blank narration as no narration rather than printing an empty line", () => {
    expect(formatAppliedTurn({ narration: "   ", changes: ["Added Kitchen"] })).toBe("Added Kitchen");
  });

  it("still says so when a narrated patch applied but changed nothing visible", () => {
    // Otherwise the model's claim is the only thing the user sees, and it is wrong.
    const text = formatAppliedTurn({ narration: "Widened the hallway.", changes: [] });
    expect(text).toContain("Widened the hallway.");
    expect(text).toContain("No visible changes.");
  });

  it("reports an empty, unnarrated turn plainly", () => {
    expect(formatAppliedTurn({ changes: [] })).toBe("No visible changes.");
  });
});
