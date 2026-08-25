# How Floorcraft actually works

I wrote elsewhere about [Floorcraft](#) — type a sentence, get a real, editable, dimensioned floor plan — and about the one rule the whole thing rests on: **the AI never draws anything.**

That claim is easy to make and easy to fake. This is the longer version: what the model is actually allowed to say, what happens to it before anything reaches the screen, and where the design strains.

---

## The model doesn't see the drawing

The obvious way to build this is to hand the model the plan and ask for a new one. That fails immediately — a wall graph is hundreds of coordinates, and every one of them is an opportunity to drift by 40mm and leave a gap in a corner.

So the model never receives the wall graph. It receives a **digest**: the room list with programs and approximate areas, which rooms touch which, which rooms face the exterior, and the layout tree. That's it. The budget is about 600 tokens for a twenty-room level.

This is the decision that makes everything downstream possible. A 600-token input is small enough for a model running on your laptop's own silicon, which is why the on-device tier is viable at all rather than a demo that only works on a frontier API.

## The model can only say fourteen things

What comes back isn't a drawing and isn't prose. It's a patch — a list of operations drawn from a closed vocabulary:

`addRoom` · `removeRoom` · `renameRoom` · `resizeRoom` · `swapRooms` · `moveRoom` · `setSplit` · `addOpening` · `removeOpening` · `setBoundary` · `setUnits` · `setDimension` · `setDimensionRange` · `clearDimension` — plus a few for levels.

Anything the model wants to say conversationally travels in a separate `narration` field, so it can never contaminate the structured part.

The vocabulary being *closed* is the point. There is no operation for "put a wall here," so there is no way for the model to put a wall in a stupid place. The worst a bad response can do is ask for a room that doesn't fit — and that has a defined answer.

Adding a new capability costs exactly three edits: the schema, the reducer, and the prompt fixture. If a feature needs a fourth, the architecture is wrong and I'd rather find that out at the schema.

## The fast path skips the model entirely

Before any provider is invoked, the utterance goes through two deterministic passes.

First, a dimension parser: *"kitchen is 4×5 feet," "living room at least 300 sq ft," "make the hallway 3 feet wide."* These are extracted, unit-converted to canonical integer millimetres, and turned into patch operations directly. They're facts, not suggestions — there's no reason to pay a model to re-read a number the user already typed precisely.

Second, an intent matcher on whatever text remains: rename, delete, swap, resize by percentage, change units, add a room of a known program.

The two compose. *"Make the kitchen 5×6 feet and add a pantry"* pins the kitchen deterministically and asks the model only to place the pantry — with the already-handled fragment stripped out so it can't be double-applied. Plenty of turns never reach a model at all, which means they're instant, free, and work offline.

## Every patch is guilty until proven innocent

A returned patch is validated against the schema *and* against the solver's preconditions before it touches the document. If validation fails, the error text is appended to the prompt and the model gets another attempt — two of them, in practice. The small on-device model fails its first parse often enough that a single retry was leaving ordinary requests dead, which is the sort of thing you only learn by watching real turns.

Two failures and the plan is left completely untouched with a plain-language explanation. A patch that was never asked for cannot be repaired into a good one.

## The solver is where correctness lives

Rooms aren't stored as coordinates. A level is a **slicing tree** — recursive horizontal and vertical cuts of the outer boundary — and the solver evaluates that tree into rectangles. The structure guarantees what would otherwise need checking: no overlaps, no gaps, no zero-area rooms, for any syntactically valid tree. Not "validated after the fact" — unrepresentable.

On top of that runs a refinement pass with a strict priority order: per-program minimum dimensions and grid-snapped wall centerlines are required; circulation widths are strong; plumbing alignment — kitchens, baths and laundries preferring to share a wet wall — is medium; the requested area ratios are weak, the first thing to give.

When the required constraints genuinely can't be satisfied, the solver returns a *structured failure* naming the conflicting rooms rather than rendering something broken. The user gets "Kitchen cannot fit in 4×5 with the required appliance clearances; suggest 4×6 or 5×5," not a plan with a wall through the fridge.

The whole evaluation has a 16ms budget — one animation frame — because of what comes next.

## Dragging a wall is the same operation as saying it

That 16ms is what lets you drag. A wall drag doesn't move geometry; it edits the `ratio` of one split in the tree and re-solves the level live. The solver hands the canvas each cut line along with the range it may travel before some child room falls under its minimum, so an invalid drag is *prevented* rather than corrected afterward. Pin a room to an exact dimension and its walls stop moving — with a lock indicator on the canvas, so it's clear which constraint is refusing you.

Because manual gestures and sentences both become patches against the same document, undo works identically across both. There's no "manual mode" the AI can't see and no AI action that stomps hand-work.

The tree also knows its own limits. A drag that no arrangement of cuts can express — an L-shaped room, a courtyard, an interior core — quietly detaches the level into freeform geometry, where node coordinates move directly. The generated layout is kept, so you can go back.

## What the canonical model buys for free

Once a plan is one well-defined document, the rest stops being individual features:

- **Exports** to SVG, PDF, DXF, JSON, IFC4 and glTF are all just readers of the same structure. Nothing is locked in my app.
- **Multi-storey** plans are a list of levels, so stair-core alignment between them is a check over two graphs — with a one-click fix when they drift.
- **Raster import** — tracing a scanned or photographed plan with computer vision — produces candidate walls that go through the same validation as everything else. You calibrate scale by clicking two known points, then accept or reject every detected wall before anything is committed.

## The tiers, and the release-blocker

Inference has four tiers: an on-device model, a free hosted pool, OpenRouter via OAuth, or your own Anthropic / OpenAI / Google key. Bring-your-own keys live in `localStorage`, are redacted in a single shared error serializer rather than at each call site, and where the provider allows browser-origin requests the client calls it directly — removing my server from the trust path entirely.

Fallback between tiers is silent when a failure is transient and explicit when a quota is exhausted, because those two things mean very different things to a user mid-drawing.

And the one I treated as release-blocking rather than a nicety: **with every tier unavailable, the app must remain a fully functional editor.** Chat greys out with an explanation. Nothing else changes. If losing the model cost you your drawing, the split between model and machine was never real in the first place.

## Where it strains

Two places, honestly.

The slicing tree is a strong constraint and strong constraints have edges. Most homes are expressible as recursive cuts; the ones that aren't hit the freeform escape hatch, and past that point the guarantees I've been bragging about are weaker — freeform geometry is checked, not structurally impossible to get wrong.

And deterministic parsing is a treadmill. Every phrasing I add is one fewer model call, but natural language doesn't converge — there's always another way to say "make it bigger." The honest framing is that the fast path is an optimization with a long tail, not a replacement for inference.

Neither changes the shape of the thing. The model reads intent; the engine owns the truth. Everything above is just the accounting for that one line.
