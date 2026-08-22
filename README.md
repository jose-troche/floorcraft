# Floorcraft — Phases 1 and 2

Phase 1 ("Prove the loop") of `specs.md`: description → summary → patch →
slicing tree → wall graph → SVG, with Tier 0 (on-device) and Tier 1 (hosted
free pool) providers, a deterministic intent matcher, IndexedDB persistence,
and SVG + JSON export.

Phase 2 ("Editing and interchange") adds canvas direct manipulation, doors and
windows, deterministic dimension parsing, D1-backed persistence with share
links, and DXF + PDF export. Still deployable on Cloudflare's free tier.

## Layout

```
packages/core/   Pure TypeScript domain engine (no DOM, no network) — solver,
                 wall graph builder, patch reducer, opening placement, drag
                 planning, SVG renderer, DXF/PDF/JSON export, deterministic
                 intent + dimension parsing, provider interface + Tier 0/1.
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

### DXF golden fixture (FR-17)

`packages/core/test/golden/plan.dxf` is byte-compared in CI against a fixed
fixture plan. When the exporter changes on purpose:

```bash
cd packages/core && UPDATE_GOLDEN=1 npx vitest run test/dxfExport.test.ts
```

Review the diff, then re-run the manual import smoke test into LibreCAD, QCAD,
AutoCAD and SketchUp — the byte comparison catches drift, not whether the four
target applications still accept the file.

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

6. Optional: adjust `[vars]` in `wrangler.toml` — `DAILY_QUOTA_PER_CLIENT`
   (default 12 turns/client/day, T1-3) and `GLOBAL_NEURON_BUDGET` (default
   7,000 = 70% of the 10,000/day free allocation, T1-4).

If you skip steps 2–3, the app still deploys and works fully — Tier 1 just
reports itself disabled via `/api/config`, and Tier 0 / the manual editor
take over (RTE-4).

If you skip the D1 setup entirely, `/api/config` reports `cloudSyncEnabled:
false`, the Share button disappears, and plans live in IndexedDB alone —
editing and export are unaffected.

### What's intentionally *not* here yet (Phase 3+)

- Detached wall-graph editing and L-shaped rooms (`DM-2`, `FR-11`), multi-storey
  with stair alignment, IFC4 and glTF export — Phase 3.
- Tier 2 (OpenRouter PKCE) / Tier 3 (BYOK) — Phase 3.
- Raster import — Phase 4.
- The MCP server module (spec §10) — optional, any phase ≥ 2.

Phase 2 documents add an optional `levels[].openings` array. It is additive, so
older documents load unchanged and no schema migration is needed.
