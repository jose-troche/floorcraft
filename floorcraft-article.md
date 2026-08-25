# How Floorcraft actually works

I wrote elsewhere about Floorcraft — type a sentence, get a real, editable, dimensioned floor plan — and about the one rule the whole thing rests on: **the AI never draws anything.**

That claim is easy to make and easy to fake, so here's the tell. Ask for a kitchen that can't work and you get *"Kitchen cannot fit in 4×5 with the required appliance clearances; suggest 4×6 or 5×5"* — not a plan with a wall through the fridge. No model wrote that. A solver did, because the model was never holding the geometry.

What follows is the accounting — including where the design strains.

---

## The model doesn't see the drawing

The obvious build hands the model the plan and asks for a new one. That fails immediately — a wall graph is hundreds of coordinates, and every one can drift 40mm and leave a gap in a corner.

So the model never receives the wall graph. It gets a **digest**: the room list with programs and approximate areas, which rooms touch which, which face the exterior, and the layout tree. That's it — about 600 tokens for a twenty-room level.

That number is the whole architecture. A 600-token input fits a model running on your laptop's own silicon — which is why the on-device tier is real, not a demo that needs a frontier API.

## The model can only say fourteen things

What comes back isn't a drawing and isn't prose. It's a patch — operations from a closed vocabulary: `addRoom`, `resizeRoom`, `swapRooms`, `setSplit`, `setDimension`, and nine more. Fourteen, plus a few for levels. Anything conversational travels in a separate `narration` field, where it can't contaminate the structured part.

The vocabulary being *closed* is the point: there is no operation for "put a wall here," so there is no way to put a wall in a silly place. The worst a bad response can do is ask for a room that doesn't fit — which has a defined answer.

Every patch is then validated against the schema *and* the solver's preconditions before it touches the document. On failure the error text goes back into the prompt and the model retries — twice, because one retry left ordinary requests dying on the on-device model's first bad parse. You only learn that from real turns. After two failures the plan is left untouched, with a plain-language explanation. A patch that was never asked for cannot be repaired into a good one.

Adding a capability costs exactly three edits: schema, reducer, prompt fixture. If a feature needs a fourth, the architecture is wrong — and I'd rather find that out at the schema.

## The fast path skips the model entirely

Before any provider is invoked, the utterance goes through two deterministic passes.

First, a dimension parser: *"kitchen is 4×5 feet," "living room at least 300 sq ft."* Extracted, converted to canonical integer millimetres, turned into operations directly. They're facts, not suggestions — no reason to pay a model to re-read a number the user already typed.

Second, an intent matcher on whatever remains: rename, delete, swap, resize by percentage, change units, add a room of a known program.

The two compose. *"Make the kitchen 5×6 feet and add a pantry"* pins the kitchen deterministically and asks the model only to place the pantry, with the handled fragment stripped so it can't be double-applied. Plenty of turns never reach a model at all: instant, free, offline.

## The solver is where correctness lives

Rooms aren't stored as coordinates. A level is a **slicing tree** — recursive horizontal and vertical cuts of the outer boundary — which the solver evaluates into rectangles. The structure guarantees what would otherwise need checking: no overlaps, no gaps, no zero-area rooms, for any valid tree. Not validated after the fact — unrepresentable.

On top runs a refinement pass with a strict priority order. Per-program minimums and grid-snapped wall centerlines are required; circulation widths are strong; plumbing alignment — kitchens, baths and laundries preferring a shared wet wall — is medium; requested area ratios are weak, the first thing to give. When the required constraints can't be satisfied, the solver returns a *structured failure* naming the conflicting rooms — the fridge answer above.

The whole evaluation has a 16ms budget, one animation frame, because of what comes next.

## Dragging a wall is the same operation as saying it

That 16ms is what lets you drag. A wall drag doesn't move geometry; it edits the `ratio` of one split and re-solves the level live. The canvas gets each cut line with the range it may travel before a child room falls under its minimum, so an invalid drag is *prevented*, not corrected. Pin a room to an exact dimension and its walls stop moving, with a lock indicator showing which constraint is refusing you.

The tree also knows its own limits. A drag no arrangement of cuts can express — an L-shaped room, a courtyard, an interior core — detaches the level into freeform geometry, where node coordinates move directly. The generated layout is kept, so you can go back.

Because gestures and sentences both become patches against the same document, undo works identically across both. No "manual mode" the AI can't see; no AI action that stomps hand-work.

And once a plan is one well-defined document, features stop being features. Exports to SVG, PDF, DXF, JSON, IFC4 and glTF are readers of the same structure — nothing locked in my app. Multi-storey is a list of levels, so stair-core alignment is a check over two graphs, with a one-click fix when they drift. Raster import — tracing a scanned plan with computer vision — proposes candidate walls that face the same validation as everything else, after you calibrate scale from two known points.

## The tiers, and the release-blocker

Inference has four tiers: an on-device model, a free hosted pool, OpenRouter via OAuth, or your own Anthropic / OpenAI / Google key. Your own keys live in `localStorage`, are redacted in one shared error serializer rather than at each call site, and where the provider allows browser-origin requests the client calls it directly, removing my server from the trust path. Fallback is silent when a failure is transient and explicit when a quota is exhausted — those mean very different things mid-drawing.

And the one I treated as release-blocking rather than a nicety: **with every tier unavailable, the app must remain a fully functional editor.** Chat greys out with an explanation. Nothing else changes. If losing the model cost you your drawing, the split between model and machine was never real.

## Where it strains

Two places, honestly.

The slicing tree is a strong constraint, and strong constraints have edges. Most homes are expressible as recursive cuts; the ones that aren't hit the freeform escape hatch, where the guarantees I've been bragging about get weaker — freeform geometry is checked, not structurally impossible to get wrong.

And deterministic parsing is a treadmill. Every phrasing I add is one fewer model call, but natural language doesn't converge — there's always another way to say "make it bigger." The fast path is an optimization with a long tail, not a replacement for inference.

Neither changes the shape of the thing. The model reads intent; the engine owns the truth.
