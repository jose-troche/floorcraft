# Floorcraft — Phase 1

Phase 1 ("Prove the loop") of `specs.md`: description → summary → patch →
slicing tree → wall graph → SVG, with Tier 0 (on-device) and Tier 1 (hosted
free pool) providers, a deterministic intent matcher, IndexedDB persistence,
and SVG + JSON export — deployable on Cloudflare's free tier.

## Layout

```
packages/core/   Pure TypeScript domain engine (no DOM, no network) — solver,
                 wall graph builder, patch reducer, SVG renderer, JSON export,
                 deterministic intent matcher, provider interface + Tier 0/1.
                 Reusable outside the web UI (spec §10, MCP server, Phase ≥2).
apps/web/        Vite frontend (chat + manual editor + canvas) and the
                 Cloudflare Worker (static assets, /api/config, /api/infer).
```

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

## Deploying to Cloudflare (free tier)

All of this fits Cloudflare's free tier (Workers, Workers AI's free neuron
allocation, D1, Workers Static Assets, Analytics Engine). You'll need a
Cloudflare account and to be logged in via `npx wrangler login` from
`apps/web/`.

1. **Create the D1 database** (quota tracking only in Phase 1):
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

### What's intentionally *not* here yet (Phase 2+)

- D1-backed plan persistence, share links (`/api/plans/*`) — Phase 1 is
  IndexedDB-only per the phasing table.
- Canvas direct manipulation (wall drag, opening drag), DXF/PDF export,
  dimension constraint parsing from chat (DIM-*, SLV-6..9) — all Phase 2.
- Tier 2 (OpenRouter) / Tier 3 (BYOK) — Phase 3.

The patch vocabulary (`INF-6`) and reducer already support openings and
dimension ops end-to-end so Phase 2 doesn't need a schema migration, but the
UI and NL parsing for them ship later.
