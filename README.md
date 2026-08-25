# Floorcraft — Phases 1, 2, 3 and 4

Phase 1 ("Prove the loop") of `specs.md`: description → summary → patch →
slicing tree → wall graph → SVG, with Tier 0 (on-device) and Tier 1 (hosted
free pool) providers, a deterministic intent matcher, IndexedDB persistence,
and SVG + JSON export.

Phase 2 ("Editing and interchange") adds canvas direct manipulation, doors and
windows, deterministic dimension parsing, D1-backed persistence with share
links, and DXF + PDF export.

Phase 3 ("Fidelity and Tiers 2/3") adds detached/freeform wall-graph editing
with L-shaped rooms, multi-storey levels with stair-alignment checking, IFC4
and glTF export, and two more inference tiers — OpenRouter (Tier 2) and
bring-your-own-key (Tier 3).

Phase 4 ("Raster import") adds scanning an existing floor plan image into a
new, editable level: OpenCV.js line detection client-side, manual scale
calibration, and a reviewable per-wall accept/reject draft before anything is
committed. The source image never leaves the browser — no upload, no bucket,
no server-side config — so this needs nothing beyond the base deployment.

## Layout

```
packages/core/   Pure TypeScript domain engine (no DOM, no network) — solver,
                 wall graph builder (rect unions + L-shapes), patch reducer,
                 opening placement, drag planning, SVG renderer, DXF/PDF/
                 JSON/IFC/glTF export, deterministic intent + dimension
                 parsing, stair-alignment checking, raster-import geometry
                 (collinear merge, axis snap, planar face traversal,
                 rectangle decomposition), provider interface + Tier 0/1/2/3.
                 Reusable outside the web UI (spec §10, MCP server, Phase ≥2).
apps/web/        Vite frontend (chat + manual editor + interactive canvas) and
                 the Cloudflare Worker (static assets, /api/config, /api/infer,
                 /api/plans).
```

## Phase 2 at a glance

| Capability | Spec | Where |
|---|---|---|
| Drag wall, resize boundary, drag/rotate openings, drag label, inline rename | FR-7, SLV-5, SLV-8 | `packages/core/src/dragPlan.ts` + `apps/web/src/client/canvas.ts` |
| Pan / zoom / fit, touch-sized targets, keyboard editing | FR-9, NFR-6 | `apps/web/src/client/canvas.ts` |
| Doors and windows that survive re-solving | §3.2, INF-6 | `packages/core/src/openings.ts` |
| Dimension strings on every wall run; pinned-room markers | FR-8, DIM-7 | `packages/core/src/svgRenderer.ts` |
| Deterministic dimension parsing before any model call | DIM-1..DIM-6, FR-2 | `packages/core/src/dimensionParser.ts` |
| DXF R12 and PDF export | FR-16..FR-19 | `packages/core/src/{dxfExport,pdfExport}.ts` |
| D1 persistence, share links, patch history | FR-13..FR-15, SEC-2/3 | `apps/web/src/worker/plans.ts` + `apps/web/src/client/sync.ts` |

Every canvas gesture is turned into ordinary patch ops and applied through the
same reducer as a chat turn, so direct manipulation is undoable like anything
else (FR-3) and the language model never emits geometry (§1.2).

## Phase 3 at a glance

| Capability | Spec | Where |
|---|---|---|
| Rect-union geometry (a room as several rectangles, dissolved seams, cycle tracing) | DM-1, FR-11 | `packages/core/src/wallGraph.ts` |
| Detached/freeform level editing — partial wall drags, L-shapes | DM-2, FR-11 | `packages/core/src/{patch,dragPlan}.ts` |
| Multi-storey levels, ghost ready via `levels[]`, deterministic level commands | §3.2 | `packages/core/src/patch.ts` (`applyLevelManagementOps`) + `intentMatcher.ts` |
| Stair-core alignment check + one-click best-effort fix | open question 6 | `packages/core/src/stairs.ts` |
| IFC4 SPF export (walls, spaces, openings; project→site→building→storey) | §6.4 | `packages/core/src/ifcExport.ts` |
| glTF (.glb) export — extruded walls and floors for 3D preview | §6.4 | `packages/core/src/gltfExport.ts` |
| Tier 2 — OpenRouter, client-side PKCE connect | T2-1..T2-5 | `packages/core/src/providers/tier2.ts` + `apps/web/src/client/openrouterAuth.ts` |
| Tier 3 — bring your own key (Anthropic, OpenAI, Google) | T3-1..T3-3 | `packages/core/src/providers/tier3.ts` |
| Shared secret redaction (Worker *and* client error paths) | SEC-5, T2-3, T3-2 | `packages/core/src/redactSecrets.ts` |
| Content-Security-Policy on API responses | SEC-4 | `apps/web/src/worker/security.ts` |

### Detached/freeform editing (DM-2, FR-11)

A level starts **generated**: a slicing tree drives its layout, and every room
is a single rectangle. Clicking "Switch to freeform editing" (or dragging part
of a wall the tree can't express) **detaches** it: the currently-solved
rectangles are frozen into a `cells` array, and from then on the level edits
those rectangles directly instead of the tree. Dragging a wall that only
partly borders a room's rectangle splits that rectangle into up to three
pieces — the part that moved and the parts that didn't — which is how an
L-shaped room comes to exist. "Restore generated layout" discards the
freeform edits and switches back to the tree that was frozen at detach time.

A freeform level's vocabulary is deliberately smaller — `addRoom`,
`resizeRoom`, `swapRooms`, `moveRoom`, `setSplit`, and the `setDimension*`
family all assume a generator tree and are refused with an actionable message
(`FREEFORM_BLOCKED_MSG` in `patch.ts`) telling you to edit the canvas
directly or restore the generated layout instead. `removeRoom` is the
exception: it works in both modes, leaving a void (a legitimate freeform
shape — a courtyard) rather than an error. A provider asked about a freeform
level gets this reduced set too (`FREEFORM_PATCH_OPS` in
`providers/schema.ts`), so it isn't asked for restructuring it has no way to
express.

### Multi-storey (§3.2)

`addLevel`, `removeLevel`, `setActiveLevel`, `renameLevel`, and
`setLevelProps` are document-scoped: they run in their own pass
(`applyLevelManagementOps`) **before** the rest of a patch, so
`activeLevelId` can change mid-patch. This is what makes "add a second floor
with two bedrooms" one turn instead of two — the room-adding ops that follow
`addLevel` in the same patch land on the level it just created.
`copyFromLevelId` duplicates another level's layout and room metadata (not
its openings). Deterministic phrasing: "add a second floor", "add a floor
called Attic", "go to the ground floor" / "switch to level 2", "rename level
2 to Attic".

### Stair-core alignment (open question 6)

There's no linking step: two rooms with `program: "stair"` and the *same
name*, on adjacent levels, are automatically one vertical run. Phase 3
checks rather than solves this — `checkStairAlignment` intersects each
core's footprint between adjacent levels and warns (non-blocking, surfaced as
a banner in the canvas toolbar) when the overlap falls short of a stair's
minimum footprint. "Align to neighbouring level" copies a freeform level's
cells exactly, or on a generated level pins width and depth to match
(`planStairAlignment` in `stairs.ts`) — position on a generated level may
still need a manual nudge afterwards, which the assist's own return note says
outright rather than implying more precision than a tree can actually give.

### IFC and glTF export — verify before you trust them

Both exporters are hand-written against remembered IFC4/glTF entity shapes,
not validated against the official EXPRESS schema or a real toolchain as part
of this build. The test suites (`ifcExport.test.ts`, `gltfExport.test.ts`)
check structural well-formedness — every STEP `#id` reference resolves, every
glTF accessor's byte range stays inside its buffer, triangle counts are
sane — which catches internal corruption but does **not** prove the files are
semantically valid IFC/glTF. Before relying on either exporter, open the
output in:

- **IFC**: IfcOpenShell/BlenderBIM, FreeCAD, and one web IFC viewer.
- **glTF**: any three.js-based `.glb` viewer (e.g. [gltf-viewer.donmccurdy.com](https://gltf-viewer.donmccurdy.com)).

IFC's opening geometry is simplified: an `IfcOpeningElement` correctly voids
each wall via `IfcRelVoidsElement`, and doors/windows are correctly related
via `IfcRelFillsElement`, but the door/window products themselves carry no
geometry of their own (`Representation = $`) — a real leaf/sash model was
judged not worth the added risk of guessing at more entity shapes from
memory. glTF walls and floors are not CSG-clipped either — window openings
are real geometric gaps (a below-sill box, an above-head box, nothing in
between), but adjoining wall/floor boxes simply overlap at their seams rather
than being merged, which is fine for a preview render and would look wrong
under boolean-difference tooling.

### Tier 2 — OpenRouter (T2-1..T2-5)

Client-side PKCE: connecting redirects to `openrouter.ai/auth` and back,
exchanges the code for a key at `POST /api/v1/auth/keys`, and stores the key
in `localStorage` — the key never reaches this app's own server. **T2-4**
prefers the server-side PKCE variant "if session infrastructure exists"; it
doesn't here (the Worker has only the anonymous quota-bucket cookie, no
login session to hold a key behind), and standing one up just for this would
be a bigger, riskier change than the client-side flow it would replace — so
that's what's implemented, and this is the record of the trade-off. The
default model (`TIER2_DEFAULT_MODEL` in `providers/tier2.ts`) is a
free-tier-eligible model hardcoded rather than fetched live from
`/models` — a live, filtered picker is a reasonable follow-up, not yet built.

### Tier 3 — bring your own key (T3-1..T3-3)

Anthropic, OpenAI, or Google, one at a time, key stored in `localStorage`
under `fc.tier3.<vendor>.key`. All three providers support browser-origin
CORS (Anthropic via the `anthropic-dangerous-direct-browser-access` header),
so **no pass-through proxy is built** — T3-2's proxy clause is conditional on
CORS requiring it, and for all three it doesn't.

### Content-Security-Policy (SEC-4) — known gap

`apps/web/src/worker/security.ts` sets a strict CSP (naming Tier 2/3's
provider origins in `connect-src`) on every response the Worker itself
handles. Cloudflare serves anything matching a file under `[assets]` — the
HTML page included — directly, bypassing the Worker by default, so today
this header reaches `/api/*` responses only, not the page. Closing that gap
needs `run_worker_first = true` in `wrangler.toml`, which would move asset
traffic onto the Workers Free tier's request quota instead of the `[assets]`
binding's unbilled/unlimited path (specs.md §8.1) — a real cost trade-off,
left as a deliberate choice rather than made silently. See the comment in
`security.ts` for the full reasoning.

## Phase 4 at a glance — raster import (§6.5, optional)

| Capability | Spec | Where |
|---|---|---|
| Deskew, adaptive threshold, morphological close, Hough line detection | FR-21 | `apps/web/src/client/rasterPipeline.ts` |
| Collinear merge, axis snap, planar wall graph, face traversal, rectangle decomposition | FR-21 | `packages/core/src/rasterImport.ts` |
| Manual scale calibration (click two points, enter the real length) | FR-22 | `apps/web/src/client/rasterImportUi.ts` |
| Per-wall accept/reject review before anything is committed | FR-25 | `apps/web/src/client/rasterImportUi.ts` |
| Detached (no generator) result | FR-24 | `importLevel` op, `packages/core/src/patch.ts` |
| Source image never uploaded — read from a local blob URL | FR-20 | `apps/web/src/client/rasterImportUi.ts` (`handleFile`) |

### Architecture: FR-24's "detached level" is Phase 3's freeform generator

FR-24 predates Phase 3's rect-union work and says import "MUST produce a
detached level (no generator)... this is the requirement that forces DM-1."
The actual point — the canonical `WallGraph` can't depend on a slicing tree,
because raster-traced geometry can't be expressed as one — is exactly what
DM-1 already guarantees and what Phase 3's freeform generator
(`{kind: "freeform", cells}`) already implements. So import produces a new
level with a freeform generator and no `savedTree` (there was never a tree to
restore to), via one new op: `importLevel {boundaryMm, rooms: [{program,
name?, rects}]}`. This reuses every piece of Phase 3's freeform machinery —
`buildWallGraph`'s cycle tracing, drag-to-reshape, opening placement — for
free, rather than inventing a second "detached" representation to maintain.

### The pipeline, and what's actually verified

FR-21's pipeline splits at the image/geometry boundary, and so does the
testing story:

- **Pure geometry** (`packages/core/src/rasterImport.ts`: collinear merge,
  axis snap, planar graph construction, face traversal, rectangle
  decomposition, scale-calibration math) is ordinary TypeScript with no
  platform dependency (ARC-2) and is fully unit-tested against synthetic line
  segments — including a deliberately noisy, gapped, slightly-skewed input —
  in `packages/core/test/rasterImport.test.ts` and, end to end through the
  `importLevel` op and the real reducer, `test/importLevel.test.ts`.
- **The OpenCV.js stages** (`apps/web/src/client/rasterPipeline.ts`: deskew,
  adaptive threshold, morphological close, `HoughLinesP` line detection) are
  written against OpenCV's long-stable, widely-documented core API, but this
  needs a browser, the ~8 MB WASM binary, and a real scanned floor plan to
  mean anything — the same reason Tier 0's on-device model and canvas
  gestures aren't in `packages/core`'s unit suite either. What *is* verified:
  the import panel opens, shows its file picker, and closes cleanly with no
  console errors, as a permanent Playwright test
  (`apps/web/e2e/canvas.spec.ts` — it needs no binding or server config, since
  import is entirely client-side). **Running the actual
  OpenCV.js pipeline against a real scanned or photographed floor plan has
  not been done in this environment** — do that before relying on detection
  quality, the same discipline as the IFC/glTF exporters above.
- OpenCV.js itself is loaded lazily from `https://docs.opencv.org/4.x/opencv.js`
  (NFR-2: it must not affect first paint, and this codebase has no npm
  dependency on it) — `security.ts`'s CSP names that origin in `script-src`
  and `connect-src` (the latter for the `.wasm` binary fetch) and adds
  `'wasm-unsafe-eval'`, the modern CSP directive for WASM compilation.
- **Not implemented**: FR-23's optional vision-model labelling/sanity-check
  pass. Imported rooms default to program `"other"`; the user re-labels them
  afterward with the same chat/manual tools as any other room. FR-23 is a
  MAY, and this is a legitimate scope cut, not an oversight — worth
  revisiting once the deterministic pipeline's real-world accuracy is known.

### Commands resolved without inference (INF-5, DIM-1..DIM-6)

These are handled by `intentMatcher.ts` and `dimensionParser.ts` before any
provider is consulted, so they cost nothing and behave identically on every
tier:

| Shape | Examples |
|---|---|
| Placement | `add a kitchen to the left of the office`, `add a bedroom above the kitchen`, `add a closet inside the office`, `add a pantry next to the kitchen`, `move the kitchen to the right of the office` |
| Creation with size | `add a room 3 x 4 ft`, `add a bedroom 12x14 feet to the left of the office` |
| Several rooms at once | `add a kitchen, a living room and a family room`, `add three bedrooms`, `add a couple of bathrooms`, `add a pantry and a closet next to the kitchen` |
| Pinning a size | `kitchen is 4x5 feet`, `make the hallway 3 feet wide`, `living room at least 300 sq ft` |
| Relative resize | `reduce the kitchen by 40%`, `increase the kitchen width by 3 meters`, `reduce the length of the kitchen by 2 meters` |
| Everything else | rename, swap, delete, undo/redo, change units |

The chips above the chat box are `EXAMPLE_REQUESTS` in
`packages/core/src/examples.ts`, and `test/examples.test.ts` asserts that every
one of them resolves through this table with `provider: null`. That is the
point of the list: the same examples are quoted back when a turn fails, so they
have to work whether or not any inference tier is available.

`left`/`right` cut vertically and `above`/`below` horizontally. `inside` is an
approximation with a reason: a slicing tree is a guillotine partition and cannot
enclose one room in another (that needs FR-11's L-shapes, Phase 3), so it
partitions the host room instead — which is what a closet in an office is.

**Ambiguity is a question, not a guess.** "delete the bedroom" in a plan with
two bedrooms returns a clarifying question and leaves the plan untouched,
rather than destroying whichever one sorted first; the same applies to renaming,
swapping, resizing, and to the anchor room in a placement. A request naming a
room that doesn't exist, or a kind of room that isn't recognised, also asks.
These questions are deliberately *not* forwarded to a provider — a model asked
"which bedroom?" answers by picking one, which is the guess being avoided.
Multi-room requests are expanded here rather than forwarded — but only when every
part reads exactly. `add a kitchen, a living room and two bedrooms` becomes four
`addRoom` ops; `add a few bedrooms` (no defensible count), `add a kitchen and
paint the walls blue` (a fragment that is not a room), `add a kitchen 8x5 ft
and a bath` (one size, two rooms), and `add three bedrooms, one with a private
bathroom` (a segment describing a relationship, not just naming a room) all go
to a provider instead. Adding two of the three rooms someone asked for is the
same wrong-inference failure as adding the wrong one.

Room words are matched on whole words, and text naming two kinds of room is
never reduced to one of them. `add a bedroom with an ensuite bathroom` states a
relationship only a provider can express, so it goes there rather than becoming
whichever room happened to match.

### DXF golden fixture (FR-17)

`packages/core/test/golden/plan.dxf` is byte-compared in CI against a fixed
fixture plan. When the exporter changes on purpose:

```bash
cd packages/core && UPDATE_GOLDEN=1 npx vitest run test/dxfExport.test.ts
```

Review the diff, then re-run the manual import smoke test into LibreCAD, QCAD,
AutoCAD and SketchUp — the byte comparison catches drift, not whether the four
target applications still accept the file.

### IFC golden fixture

Same idea, same fixture plan, `packages/core/test/golden/plan.ifc`:

```bash
cd packages/core && UPDATE_GOLDEN=1 npx vitest run test/ifcExport.test.ts
```

The suite's reference-integrity checks (every `#id` resolves, storey/space/
wall counts match the model) catch structural regressions the byte
comparison alone would miss; neither substitutes for the manual viewer
smoke-test — see "IFC and glTF export — verify before you trust them" above.

## Requirements traceability (Phase 1 exit criteria)

| Exit criterion | Where |
|---|---|
| 20 representative prompts → schema-valid patches, zero invalid geometry | `packages/core/fixtures/prompts.ts` + `test/fixtures.test.ts` |
| Worker CPU p99 < 6ms | Worker only proxies/counts (no doc parsing, no solver) — see `apps/web/src/worker/index.ts` |
| Inference disabled → template + editing still work | Manual editor tab (`apps/web/src/client/ui.ts`) uses the reducer directly, no provider involved |

## Development

```bash
npm install
npm test              # core package unit tests + 20-prompt fixture (vitest)
npm run build          # typecheck + build the core package and the client bundle
```

Local full-stack dev (frontend + Worker together):

```bash
cd apps/web
npm run build           # build the client once
npx wrangler dev        # serves the Worker + built assets at http://localhost:8787
```

Or frontend-only with hot reload (proxies `/api/*` to a `wrangler dev` running on
`:8787` — start that in a second terminal):

```bash
cd apps/web && npm run dev
```

With no Cloudflare bindings configured, `/api/config` reports Tier 1 as
disabled and the app falls back to Tier 0 (if your browser supports it) or the
manual editor — this is RTE-4's release-blocking behavior, and it's what you'll
see out of the box.

### End-to-end tests (real browser)

`packages/core`'s test suite covers the pure functions (solver, reducer,
drag-planning math); it can't exercise the DOM wiring the canvas depends on —
double-click hit-testing, focus, actual pointer drags. `apps/web/e2e/` covers
that layer with Playwright, driven against a real `wrangler dev` instance (the
Worker's `/api/config`/`/api/plans` routes are part of what's under test, so
Vite's dev server alone isn't enough):

```bash
cd apps/web
npm run build && npx wrangler dev --local --port 8788   # terminal 1
npx playwright install chromium                          # once
npm run test:e2e                                          # terminal 2
```

## Deploying to Cloudflare (free tier)

All of this fits Cloudflare's free tier (Workers, Workers AI's free neuron
allocation, D1, Workers Static Assets, Analytics Engine). You'll need a
Cloudflare account and to be logged in via `npx wrangler login` from
`apps/web/`.

1. **Create the D1 database** (Tier 1 quota, plan documents, and patch history):
   ```bash
   cd apps/web
   npx wrangler d1 create floorcraft
   ```
   Copy the returned `database_id` into `wrangler.toml`'s `[[d1_databases]]`
   block, then apply the schema:
   ```bash
   npm run db:migrate:remote
   ```

2. **Create a Turnstile widget** (Cloudflare dashboard → Turnstile → Add
   site). Use the **invisible/managed** widget type. Put the site key in
   `wrangler.toml` under `[vars] TURNSTILE_SITE_KEY`, and set the secret key
   (never commit it):
   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

3. **Set the quota salt** (any random string, used to salt the per-client
   quota hash — T1-3):
   ```bash
   npx wrangler secret put QUOTA_SALT
   ```

4. **Enable Workers AI and Analytics Engine** for the account if not already
   (both are on by default for most accounts; Analytics Engine logging is
   best-effort — the Worker skips it silently if the binding is absent).

5. **Build and deploy**:
   ```bash
   npm run deploy
   ```
   This runs `vite build` (client → `dist/client/`) then `wrangler deploy`,
   which bundles the Worker (including the `@floorcraft/core` workspace
   package) and uploads the built assets via the `[assets]` binding.

   `wrangler.toml` pins `account_id` for this reason: without it, `wrangler
   deploy` resolves the account by calling the legacy `/memberships` API,
   which 400s (code 9106) for scoped API tokens that lack the old
   membership-read grant — even though the same token deploys fine once the
   account is already known. If you fork this and deploy under a different
   account, update `account_id` to your own (`npx wrangler whoami` prints
   it).

6. Optional: adjust `[vars]` in `wrangler.toml` — `DAILY_QUOTA_PER_CLIENT`
   (default 12 turns/client/day, T1-3) and `GLOBAL_NEURON_BUDGET` (default
   7,000 = 70% of the 10,000/day free allocation, T1-4).

If you skip steps 2–3, the app still deploys and works fully — Tier 1 just
reports itself disabled via `/api/config`, and Tier 0 / the manual editor
take over (RTE-4).

If you skip the D1 setup entirely, `/api/config` reports `cloudSyncEnabled:
false`, the Share button disappears, and plans live in IndexedDB alone —
editing and export are unaffected.

**Tiers 2 and 3 need no deployment configuration at all.** OpenRouter's PKCE
exchange and every BYOK provider are called directly from the browser
(T2-1, T3-3) — there's no server-side secret to provision, no binding to add.
They're available the moment the app is deployed, gated only by the user
choosing to connect one.

### What's intentionally *not* here yet

- **WebLLM/WebGPU as an opt-in local provider (T0-6, a SHOULD)** — deferred
  out of Phase 3. It's a multi-hundred-megabyte dependency competing with
  Tier 2/3 for the same "Tier 0 unavailable" slot, at meaningfully higher
  build/test cost than either. Revisit if Tier 0 adoption data justifies it.
- **A true cross-level stair constraint layer** — Phase 3 checks and assists
  (see above); a solver that keeps stairs aligned automatically across every
  edit is open question 6's harder version, deliberately not attempted here.
- **A live, filtered OpenRouter model picker** — Tier 2 uses a hardcoded
  free-tier-eligible default instead of fetching and filtering `/models`.
- **FR-23's optional vision-model pass** for raster-import room labelling —
  imported rooms default to program `"other"`; see "Phase 4 at a glance"
  above.
- **Real-world raster-import accuracy** — the deterministic geometry
  pipeline is fully unit-tested; the OpenCV.js stages have not been run
  against a real scanned or photographed floor plan in this environment.
- The MCP server module (spec §10) — optional, any phase ≥ 2.

Phase 2 documents add an optional `levels[].openings` array; Phase 3 changes
`Level.generator` from `{tree, detached?}` to a `{kind: "slicing"|"freeform",
...}` tagged union. Both are handled by `normalizeDocument()`
(`packages/core/src/migrate.ts`), called on every document load path — IndexedDB,
share links, and JSON import — so an older document loads unchanged.
