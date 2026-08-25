# Floorcraft — Conversational Floor Plan Builder

**Product name:** Floorcraft
**Repo name:** `floorcraft`
**Description:** Conversational floor plan builder powered by on-device AI and hosted inference. Describe your floor plan in natural language, refine through chat and direct canvas editing, and export to industry-standard formats. No signup or API key needed.

**Version:** 0.1 (draft)
**Target platform:** Cloudflare Workers free tier
**Status:** Pre-implementation

Requirement keywords (MUST, SHOULD, MAY) follow RFC 2119. Requirements are numbered for traceability; phase tags indicate the earliest milestone in which the requirement applies.

---

## 1. Overview

### 1.1 Product summary

A browser application in which a user describes a floor plan in natural language ("a floor with a kitchen, living room, and family room"), receives an immediate vector rendering, and refines it through a mixed dialogue: chat instructions ("swap the kitchen and family room", "make the living room 30% bigger") and direct manipulation on a drawing canvas. The resulting plan exports to formats importable by mainstream CAD and BIM tools.

### 1.2 Design thesis

Three decisions govern the entire architecture. Every requirement below descends from one of them.

1. **The language model never emits geometry.** It emits patches against a structured plan specification. A deterministic solver in the client turns the specification into coordinates. This makes invalid output structurally impossible, keeps model context small, and lets weak models do useful work.
2. **All heavy compute runs in the browser.** The Worker is a thin pipe: static assets, an inference proxy, and document CRUD. This is what keeps the app inside the 10 ms Worker CPU budget on the free tier.
3. **Inference is a swappable, tiered capability, and its absence is not fatal.** The canvas editor MUST remain fully functional with no inference available at all.

### 1.3 Goals

- A user with no account, no API key, and no configuration gets a usable floor plan within 60 seconds of landing.
- The application runs within Cloudflare free-tier limits at low-to-moderate traffic without functional degradation.
- The plan engine is reusable outside the web UI (see §10, MCP server).

### 1.4 Non-goals

- Structural, mechanical, electrical, or code-compliance analysis.
- Native `.dwg` output (proprietary; requires a licensed native SDK — out of scope permanently).
- Multi-user real-time collaboration (deferred indefinitely; see §12).
- Photorealistic 3D rendering.

### 1.5 Glossary

| Term | Meaning |
|---|---|
| **Plan document** | The complete, serializable state of one project. Canonical persisted artifact. |
| **Wall graph** | Planar subdivision (half-edge structure) that is the canonical geometric representation. |
| **Slicing tree** | Binary tree of H/V splits with area ratios; a *generator* that emits into the wall graph. |
| **Patch** | An ordered list of edit operations against the plan document. |
| **Provider** | An implementation of the inference interface (§5). |
| **Tier** | A provider class distinguished by cost, auth friction, and capability. |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser                                                  │
│  ┌────────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │
│  │ Chat UI    │  │ Canvas    │  │ Solver   │  │Exporter│ │
│  └─────┬──────┘  └─────┬─────┘  └────┬─────┘  └───┬────┘ │
│        │               │             │            │      │
│        └───────┬───────┴─────────────┴────────────┘      │
│                ▼                                          │
│        ┌───────────────┐   ┌──────────────────────────┐  │
│        │ Plan Store    │   │ Provider Router (§5)     │  │
│        │ (in-memory +  │   │  T0 on-device            │  │
│        │  IndexedDB)   │   │  T1 → Worker proxy       │  │
│        └───────┬───────┘   │  T2/T3 → direct or proxy │  │
│                │           └────────────┬─────────────┘  │
└────────────────┼────────────────────────┼────────────────┘
                 │ sync (debounced)       │ /api/infer
                 ▼                        ▼
┌─────────────────────────────────────────────────────────┐
│ Cloudflare Worker (thin)                                 │
│  static assets │ /api/plans │ /api/infer │ /mcp (opt.)   │
└────────┬──────────────────┬──────────────────┬──────────┘
         ▼                  ▼                  ▼
       D1 (docs)        Workers AI          R2 (P4 uploads)
```

**ARC-1** The Worker MUST NOT parse, validate, or transform plan document bodies. Documents are stored and returned as opaque text. *(Rationale: a `JSON.parse` of a large document can consume a meaningful fraction of the 10 ms free-tier CPU budget.)*

**ARC-2** The solver, renderer, and all exporters MUST be implemented as pure functions with no network or platform dependencies, so the same modules run in the browser and (for the MCP path) inside a Worker.

**ARC-3** The client MUST be authoritative for plan state during a session. The server is a persistence and relay layer only.

---

## 3. Domain model

### 3.1 Canonical representation

**DM-1** The canonical geometry MUST be a **planar wall graph**, not a slicing tree.

*Rationale: slicing trees only express guillotine layouts (all-rectangular, no L-shapes, no interior cores). Real plans, manual edits, and raster import (P4) all produce non-guillotine geometry. If the tree is canonical, P4 forces a rewrite of everything downstream.*

**DM-2** The slicing tree MUST be modeled as an optional *generator* attached to a plan level. When present it can regenerate the wall graph; once the user makes an edit the tree cannot express, the generator is marked `detached` and the wall graph stands alone.

**DM-3** Plan documents MUST carry a `schemaVersion`. The client MUST refuse to load a document with an unknown major version and MUST apply registered migrations for older minor versions.

### 3.2 Schema (normative sketch)

```ts
type PlanDocument = {
  schemaVersion: 1;
  id: string;              // uuid
  title: string;
  units: "imperial" | "metric";
  gridModule: number;      // snap increment, mm internally (default 101.6 = 4")
  levels: Level[];
  createdAt: string; updatedAt: string;
};

type Level = {
  id: string; name: string; elevation: number; floorToCeiling: number;
  generator?: SlicingTree;      // absent or {detached:true} after freeform edits
  graph: WallGraph;             // canonical
};

type WallGraph = {
  nodes: Record<NodeId, { x: number; y: number }>;      // mm, level-local
  edges: Record<EdgeId, {
    a: NodeId; b: NodeId;
    thickness: number;
    type: "exterior" | "interior" | "partition";
    openings: Opening[];
  }>;
  rooms: Record<RoomId, {
    name: string;
    program: RoomProgram;       // kitchen | bedroom | bath | ...
    boundary: EdgeId[];         // ordered cycle, CCW
    labelAnchor?: { x: number; y: number };
    constraints?: {
      width?: { exact?: number; min?: number; max?: number };     // mm
      depth?: { exact?: number; min?: number; max?: number };     // mm
      area?: { exact?: number; min?: number; max?: number };      // mm²
      aspectRatio?: { min?: number; max?: number };               // width:depth
    };
  }>;
};

type Opening = {
  id: string;
  kind: "door" | "window" | "cased" | "pass-through";
  offset: number;   // mm from edge.a along the edge
  width: number; height: number; sill?: number;
  swing?: "left-in" | "left-out" | "right-in" | "right-out";
};

type SlicingTree =
  | { kind: "leaf"; roomId: RoomId; areaWeight: number;
      minWidth?: number; minDepth?: number }
  | { kind: "split"; axis: "h" | "v"; ratio: number;   // 0..1
      children: [SlicingTree, SlicingTree] };
```

**DM-4** All internal lengths MUST be stored in millimetres as integers. Display units are a presentation concern only.

**DM-5** Wall geometry MUST be stored as centerlines with a thickness attribute. Face polygons are derived at render/export time, never persisted.

---

## 4. Layout solver

**SLV-1** Given a `SlicingTree` and an outer boundary rectangle, the solver MUST produce a wall graph with no overlapping rooms, no gaps, and no zero- or negative-area rooms, for any syntactically valid tree.

**SLV-2** After tree evaluation, the solver MUST run a constraint refinement pass (Cassowary / `kiwi.js` or equivalent) enforcing, in priority order:
1. (required) Minimum room dimension per `program` (configurable table).
2. (required) Wall centerlines snapped to `gridModule`.
3. (strong) Corridor and circulation minimum widths.
4. (medium) Plumbing wall alignment — wet programs (kitchen, bath, laundry) preferentially share a wall.
5. (weak) Requested `areaWeight` ratios.

**SLV-3** If the required constraints are unsatisfiable, the solver MUST return a structured failure identifying the conflicting rooms. The UI MUST surface this as a specific, actionable message and MUST NOT render a broken plan.

**SLV-4** Solver evaluation for a level of ≤ 20 rooms MUST complete in < 16 ms on a mid-range 2022 laptop (one animation frame), so that wall-drag interaction re-solves live.

**SLV-5** Dragging a wall in the canvas MUST edit the underlying split `ratio` (when a generator is attached) or the node coordinates (when detached), never produce free-floating geometry. Invalid drag states MUST be prevented, not corrected after the fact.

### 4.1 Dimension constraints

**SLV-6** The solver MUST support hard and soft dimension constraints on individual rooms and room pairs:
- **Exact dimensions:** a room width or depth pinned to an explicit value (e.g., "kitchen is exactly 4×5 feet").
- **Range constraints:** a room area or width bounded by min/max (e.g., "bedroom at least 120 sq ft").
- **Aspect ratio bounds:** preferred width-to-depth range.
- **Edge-to-edge distances:** Manhattan distance between two room edges (e.g., "bathroom door must be within 8 feet of kitchen entry").

**SLV-7** Dimension constraints entered via chat MUST be parsed into the room's metadata and expressed to the constraint solver as priorities. The solver MUST NOT reject a plan because an exact dimension conflicts with a minimum room size; instead, the violated constraint MUST be reported in a structured error, and the user invited to loosen it (e.g., "Kitchen cannot fit in 4×5 with the required appliance clearances; suggest 4×6 or 5×5").

**SLV-8** Once a room has an explicit dimension constraint, dragging its boundary in the canvas MUST NOT override that constraint. The drag MUST either be rejected with visual feedback or snap to the constraint boundary.

**SLV-9** Dimension units (imperial / metric) MUST be converted at parse time to the plan's canonical unit. If the user specifies "4x5 feet" in a metric plan, conversion MUST be lossless (stored as integral mm after rounding) and displayed back in the original unit on subsequent output.

---

## 5. Inference layer

### 5.1 Provider interface

**INF-1** All inference MUST be accessed through a single interface. No feature may call a provider directly.

```ts
interface PlanProvider {
  readonly id: ProviderId;
  readonly tier: 0 | 1 | 2 | 3;
  availability(): Promise<"available" | "unavailable" | "downloadable" | "exhausted">;
  propose(input: {
    summary: PlanSummary;      // compact digest, NOT the full document
    utterance: string;
    history: Turn[];           // last N turns, truncated to token budget
  }): Promise<Patch>;
}
```

**INF-2** `PlanSummary` MUST be a compact digest — room list with programs, approximate areas, adjacency pairs, exterior-facing rooms, and the generator tree — and MUST NOT include the wall graph. It MUST fit in ≤ 600 tokens for a 20-room level.

*Rationale: this is what makes Tier 0 viable at all, and it materially reduces Tier 1 neuron burn.*

**INF-3** Providers MUST return a `Patch`, never prose-with-JSON. Any conversational text MUST travel in a dedicated `Patch.narration` field.

**INF-4** The client MUST validate every returned patch against the schema and against solver preconditions before application. Invalid patches MUST trigger one automatic repair retry with the validation error appended to the prompt; a second failure MUST surface a plain-language error and leave the plan untouched.

**INF-5** The application MUST attempt deterministic intent matching before invoking any provider. At minimum: rename room, resize room by percentage or absolute area, swap two rooms, delete room, add room of known program, undo/redo, change units. *(Target: ≥ 35% of turns resolved with zero inference.)*

### 5.2 Patch operation set

**INF-6** The patch vocabulary MUST be closed and small. Initial set:

| Op | Payload |
|---|---|
| `addRoom` | `program`, `name?`, `areaWeight`, `adjacentTo?`, `constraints?` |
| `removeRoom` | `roomId` |
| `renameRoom` | `roomId`, `name` |
| `resizeRoom` | `roomId`, `areaWeight` \| `targetAreaMm2` |
| `swapRooms` | `roomIdA`, `roomIdB` |
| `moveRoom` | `roomId`, `relativeTo`, `direction` |
| `setSplit` | `nodePath`, `axis?`, `ratio?` |
| `addOpening` | `betweenRooms` \| `edgeId`, `kind`, `width?` |
| `removeOpening` | `openingId` |
| `setBoundary` | `widthMm`, `depthMm` |
| `setUnits` | `units` |
| `setDimension` | `roomId`, `dimensionType`, `value`, `unit?` |
| `clearDimension` | `roomId`, `dimensionType` |
| `setDimensionRange` | `roomId`, `dimensionType`, `minMm?`, `maxMm?` |

**INF-6a** Dimension operations target explicit constraints on rooms. Supported dimension types:
- `width`: exact or range (mm)
- `depth`: exact or range (mm)
- `area`: exact or range (mm²)
- `aspectRatio`: min and max ratio (width:depth)

The payload MUST include `unit` if and only if the value is specified in user units (feet, meters) rather than canonical mm. The Worker MUST never receive dimension values in user units; conversion MUST occur in the browser and MUST produce canonical mm integers.

**INF-7** Adding a new operation MUST require updating exactly three artifacts: the patch schema, the reducer, and the provider prompt/schema fixture. Any design requiring changes elsewhere is a defect.

### 5.3 Tier specifications

#### Tier 0 — On-device (Phase 1)

**T0-1** The application MUST feature-detect `'LanguageModel' in self` and call `LanguageModel.availability()` before offering Tier 0.
**T0-2** Availability MUST be treated as four-valued (`available` / `downloadable` / `downloading` / `unavailable`) and the UI MUST NOT block on a model download; a `downloadable` state SHOULD offer an explicit opt-in with a progress indicator.
**T0-3** Prompts MUST stay under ~1,500 input tokens. If the summary plus history exceeds budget, history MUST be truncated before the summary.
**T0-4** Tier 0 MUST use structured/JSON-constrained output where the API exposes it, and MUST validate regardless.
**T0-5** Known constraints to document in the UI, not fight: official Google Chrome desktop builds only; unsupported on Firefox, Safari, Edge, and mobile Chrome; distro-packaged Chromium will report unavailable.
**T0-6** *(SHOULD, Phase 3)* A WebLLM/WebGPU provider MAY be offered as an opt-in "run locally" alternative with grammar-constrained decoding. It MUST NOT be a default due to the multi-hundred-megabyte first load.

#### Tier 1 — Hosted free pool (Phase 1)

**T1-1** Tier 1 MUST proxy through `POST /api/infer` to Workers AI. The model API key MUST never reach the client.
**T1-2** Requests MUST require a valid Turnstile token. Turnstile verification MUST be performed server-side on every request.
**T1-3** Each client MUST be metered against a daily quota (default: **12 turns per client per UTC day**), enforced server-side in D1 and keyed on a salted hash of `(client_id_cookie, cf-connecting-ip)`.
**T1-4** A **global daily budget** MUST also be enforced (default: **70% of the 10,000-neuron allocation**). On exhaustion the endpoint MUST return `429` with `{reason:"global_pool_exhausted"}` and the UI MUST present the Tier 2 upgrade path.
**T1-5** Model selection MUST default to a small instruction-tuned model. Neuron cost per turn MUST be logged (Analytics Engine) so the per-client quota can be tuned against real usage.
**T1-6** Responses MUST be streamed to the client. The Worker MUST NOT buffer or inspect the response body beyond framing.

#### Tier 2 — One-click connect (Phase 3)

**T2-1** Tier 2 MUST implement the OpenRouter OAuth PKCE flow: redirect to `/auth` with `callback_url`, receive `code`, exchange at `POST /api/v1/auth/keys` for a user-controlled key.
**T2-2** The issued key can spend the user's funds. The UI MUST state this explicitly at the point of connection and MUST provide a one-click disconnect that deletes the stored key.
**T2-3** The key MUST NOT be written to D1, logged, or included in any telemetry or error report. Redaction MUST be enforced in a shared error-serialization helper, not per call site.
**T2-4** The server-side PKCE variant (key held behind a Worker session cookie, never delivered to the client) SHOULD be preferred if session infrastructure exists by then.
**T2-5** The default model for Tier 2 SHOULD be a free-tier-eligible model so that a user with zero credits still gets service.

#### Tier 3 — Bring your own key (Phase 3)

**T3-1** Tier 3 MUST accept an Anthropic, OpenAI, or Google API key entered by the user.
**T3-2** Keys MUST be stored in `localStorage` only, never transmitted to the origin server except as a pass-through `Authorization` header when CORS requires proxying.
**T3-3** Where the provider supports browser-origin CORS, the client MUST call it directly and bypass the Worker entirely (saves request quota and removes the origin from the trust path).

### 5.4 Tier routing

**RTE-1** Default selection order on load: Tier 0 if `available` → Tier 1 if quota remains → prompt for Tier 2/3.
**RTE-2** The active tier MUST be visible in the UI at all times and MUST be manually overridable by the user.
**RTE-3** Tier fallback MUST be automatic and silent on transient failure, and explicit (user-visible, requiring acknowledgement) on quota exhaustion.
**RTE-4** With **all** tiers unavailable, the application MUST remain fully functional as a manual editor. Chat input is disabled with an explanatory affordance; nothing else changes. *(This is a release-blocking acceptance criterion, not a nicety.)*

### 5.5 Dimension parsing and constraint intent matching

**DIM-1** Before invoking any provider, the client MUST attempt to extract and apply dimension constraints from the user's utterance via deterministic parsing.

**DIM-2** Supported natural-language patterns (non-exhaustive; MUST be expanded in Phase 2 based on fixture feedback):
- "kitchen [is/must be] 4x5 feet" → `setDimension(kitchen, width=1219mm, depth=1524mm)`
- "living room [at least/minimum] 300 sq ft" → `setDimensionRange(living-room, area={min: 27871mm²})`
- "increase bedroom depth by 2 meters" → `resizeRoom(bedroom, depth += 2000mm)` (relative)
- "bathroom 5×8, kitchen 8×12 feet" → multiple constraints in one utterance
- "make the hallway 3 feet wide" → `setDimension(hallway, width=914mm)`
- "master suite at least 16×20" → `setDimensionRange(master-suite, width={min:4877mm}, depth={min:6096mm})`

**DIM-3** Dimension parsing MUST be unit-aware. The parser MUST:
- Infer intended unit from context (if the plan is metric and user says "feet", apply conversion; warn if ambiguous).
- Accept mixed input within a single turn ("kitchen 4×5 feet, bedroom 3×3.5 meters").
- Return all values in canonical mm.

**DIM-4** Dimension extraction MUST produce a patch operation list. If multiple constraints are parsed, they MUST be applied in order. If a constraint is unparseable but the remainder of the utterance is, the parser MUST proceed with the parsed constraints and include the unparseable fragment in the provider input *with a flag* so the model can attempt to disambiguate.

**DIM-5** Dimension parsing MUST be separate from intent matching and MUST run before the provider is invoked, so that:
- A turn like "make the kitchen 5×6 feet and add a pantry" produces `[setDimension(kitchen, 1524×1829mm), addRoom(pantry)]` from deterministic parsing alone, and the provider is only asked to place the pantry.
- Dimension constraints are never sent to the model for re-parsing; they are facts, not suggestions.

**DIM-6** If dimension parsing produces a constraint that is geometrically impossible (e.g., a 4×50 meter room with an 8-meter minimum depth), the UI MUST surface this *before* invoking the solver, with a suggestion to relax the constraint.

**DIM-7** The canvas MUST visually indicate rooms with active dimension constraints (e.g., a small lock icon on a pinned wall) so the user knows which constraints prevent free dragging.

### 6.1 Conversation

**FR-1** The user MUST be able to create a plan from a free-text description in one turn. Examples:
- "A 30×40 foot house with kitchen, living room, 2 bedrooms, 1 bath"
- "Apartment with master suite 16×18 feet, guest bedroom 12×12, living area 20×25, kitchen 8×10"

**FR-2** The user MUST be able to specify exact dimensions for rooms inline with layout instructions. Examples:
- "Kitchen must be 4×5 feet, add a pantry next to it"
- "Make the living room at least 400 sq ft"
- "Increase the master bedroom depth by 2 meters"
- "Bathroom 5×8 feet minimum, with door to the hallway"

Dimension specifications MUST be parsed deterministically before the provider is invoked. The provider is only asked to arrange unspecified rooms and resolve conflicts.

**FR-3** Every applied patch MUST be reversible via undo, including patches produced by inference or dimension parsing.

**FR-4** The chat MUST display what changed after each turn in structured form (e.g. "Kitchen +18%, Family Room −12%, Master Bath pinned to 5×8 ft"), derived from the patch — not from model narration.

**FR-5** The system SHOULD proactively ask one clarifying question when a plan is under-specified (missing overall footprint, missing bedroom/bath counts), and MUST NOT ask more than one per turn. Dimension specification in an utterance satisfies specificity for that aspect (e.g., if the user specifies kitchen dimensions, no need to ask kitchen size).

**FR-6** Conversation history MUST persist with the plan document. Dimension constraints applied to rooms MUST be retained across sessions.

### 6.2 Canvas

**FR-6** The canvas MUST render as SVG (DOM-addressable, exportable, printable) rather than raster canvas.
**FR-7** Supported direct manipulation, Phase 2: drag wall, resize outer boundary, drag/rotate door and window openings, rename room inline, drag room label.
**FR-8** Dimension strings MUST be displayed on every wall run and MUST update live during drag.
**FR-9** The canvas MUST support pan, zoom, and fit-to-view, with pointer-events sized for touch.
**FR-10** Room fill MUST encode `program` via a legible, colorblind-safe palette; program legend MUST be available.
**FR-11** *(Phase 3)* Rooms MUST be expressible as unions of rectangles to support L-shapes.

### 6.3 Persistence

**FR-12** Plan state MUST autosave to IndexedDB on every applied patch, synchronously enough to survive a tab crash.
**FR-13** Sync to D1 MUST be debounced (≥ 5 s idle) and MUST also fire on `visibilitychange → hidden`.
**FR-14** A plan MUST be shareable via an unguessable URL. Share links MUST be read-only by default, with an optional edit token.
**FR-15** Version history MUST retain the last 50 patches per plan for undo across sessions.

### 6.4 Export

**FR-16** Export MUST run entirely client-side, producing a `Blob` — no server round-trip.

| Format | Phase | Notes |
|---|---|---|
| **DXF R12 ASCII** | 2 | Primary interchange target. Layers: `WALLS`, `DOORS`, `WINDOWS`, `ROOMS`, `TEXT`, `DIMS`. |
| **SVG** | 1 | Same renderer as canvas, print-styled. |
| **PDF** | 2 | Paper sizes, scale bar, title block. |
| **Native JSON** | 1 | Versioned, round-trippable. |
| **glTF** | 3 | Extruded walls for 3D preview. |
| **IFC4 SPF** | 3 | Subset: `IfcProject`→`IfcSite`→`IfcBuilding`→`IfcBuildingStorey`, `IfcWallStandardCase`, `IfcSpace`, `IfcDoor`, `IfcWindow`. |

**FR-17** DXF output MUST import without errors into at least: LibreCAD, QCAD, AutoCAD, and SketchUp. This MUST be verified by fixture files in CI (byte-comparison against golden output) and by manual smoke test each release.
**FR-18** Every export MUST embed a scale reference and the plan's unit system.
**FR-19** `.dwg` MUST NOT be offered. The export UI SHOULD state that DXF is the path into DWG-native tools.

### 6.5 Raster import *(Phase 4, optional)*

**FR-20** Import MUST run client-side (OpenCV.js/WASM); processing MUST NOT occur in a Worker. The source image MUST NOT be uploaded or stored server-side: detection reads it from a local blob URL, and only the vectorised result is persisted. (Amended from the original "MUST be stored in R2" — nothing read that copy back, and not taking it keeps a scan of someone's home in their browser.)
**FR-21** Pipeline: deskew → adaptive threshold → morphological close → line segment detection → collinear merge → axis snap → wall graph construction → planar face traversal for room detection.
**FR-22** Scale calibration MUST be a manual step: the user draws a line across a dimension of known length.
**FR-23** A vision-model pass MAY be used for room labelling and topology sanity-checking; it MUST be optional and MUST NOT be required for a usable import.
**FR-24** Import MUST produce a `detached` level (no generator). This is the requirement that forces DM-1.
**FR-25** The import result MUST be presented as a reviewable draft with per-wall accept/reject, never applied silently.

---

## 7. Non-functional requirements

**NFR-1** Time to first rendered plan from a cold load, Tier 1, p50: < 8 s. Tier 0: < 5 s.
**NFR-2** Initial JS bundle ≤ 250 KB gzipped excluding optional WASM. OpenCV.js and WebLLM MUST be lazily loaded and MUST NOT affect first paint.
**NFR-3** Worker CPU per request MUST stay under 6 ms p99, measured, leaving headroom against the 10 ms free-tier ceiling.
**NFR-4** The application MUST function offline for editing and export once loaded (service worker; plan state from IndexedDB).
**NFR-5** Browser support: current Chrome, Firefox, Safari, Edge on desktop; Safari iOS and Chrome Android for view + basic edit. Tier 0 gracefully absent everywhere but Chrome desktop.
**NFR-6** Keyboard operability for all canvas edits; SVG output MUST carry `<title>`/`<desc>` for screen readers; contrast ratios ≥ 4.5:1.
**NFR-7** No third-party analytics or trackers. Telemetry limited to Cloudflare Analytics Engine with no plan content and no PII.
**NFR-8** No account required to use the product. Any future authentication MUST be additive.

---

## 8. Cloudflare resource specification

### 8.1 Bindings

| Binding | Product | Purpose | Free-tier headroom |
|---|---|---|---|
| `ASSETS` | Workers Static Assets | SPA, WASM | Unlimited, unbilled |
| `DB` | D1 | plans, versions, quota | 5 M reads / 100 K writes per day, 5 GB |
| `AI` | Workers AI | Tier 1 | 10,000 neurons/day, account-wide |
| `ANALYTICS` | Analytics Engine | usage + neuron accounting | Included |

**CF-1** Workers KV MUST NOT be used for any write-path state (free tier allows ~1,000 writes/day — an autosaving editor exhausts this trivially). KV MAY be used for read-mostly configuration.
**CF-2** Durable Objects MUST NOT be introduced before a concrete multiplayer requirement exists.
**CF-3** Queues MUST NOT be assumed available (paid feature).

### 8.2 D1 schema

```sql
CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  owner_hash     TEXT NOT NULL,          -- salted hash of client token
  edit_token_hash TEXT,
  title          TEXT NOT NULL DEFAULT 'Untitled',
  schema_version INTEGER NOT NULL,
  doc            TEXT NOT NULL,          -- opaque; never parsed server-side
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_plans_owner ON plans(owner_hash, updated_at DESC);

CREATE TABLE plan_versions (
  plan_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  patch      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, seq)
);

CREATE TABLE quota (
  bucket_key TEXT NOT NULL,              -- hash(client_id, ip) or 'GLOBAL'
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD' UTC
  turns      INTEGER NOT NULL DEFAULT 0,
  neurons    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, day)
);
```

**CF-4** Quota increments MUST use a single `INSERT ... ON CONFLICT DO UPDATE` (one row written per turn).
**CF-5** A cron trigger (free) SHOULD prune `quota` rows older than 7 days and `plan_versions` beyond the retention window.

### 8.3 HTTP API

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/*` | — | Static assets (unbilled) |
| `GET` | `/api/config` | — | Feature flags, tier availability, Turnstile site key |
| `POST` | `/api/infer` | Turnstile + client token | Tier 1 only; streams; quota-enforced |
| `POST` | `/api/plans` | client token | Create; returns id + edit token |
| `GET` | `/api/plans/:id` | share or edit token | Returns opaque doc |
| `PUT` | `/api/plans/:id` | edit token | Full replace; body ≤ 1 MB |
| `POST` | `/api/plans/:id/versions` | edit token | Append patch |
| `ALL` | `/mcp` | bearer (optional module) | §10 |

### 8.4 Abuse controls

**SEC-1** `/api/infer` MUST require Turnstile and MUST be IP rate-limited independent of the daily quota (suggested: 10 req/min).
**SEC-2** Plan document bodies MUST be size-capped at 1 MB server-side; oversize requests rejected with `413` before any read.
**SEC-3** Share and edit tokens MUST be ≥ 128 bits of entropy and MUST be stored hashed.
**SEC-4** The Worker MUST set a strict CSP. Tier 3 direct-to-provider calls MUST be reflected in `connect-src`.
**SEC-5** All error responses MUST pass through a shared redaction helper that strips anything matching known API key patterns.

---

## 9. Phasing and acceptance

### Phase 1 — Prove the loop *(Tiers 0 + 1)*
Scope: description → summary → patch → slicing tree → wall graph → SVG. Tier 0 and Tier 1 providers. Deterministic intent matcher. IndexedDB persistence. SVG + JSON export.

**Exit criteria**
- 20 representative prompts produce schema-valid patches ≥ 90% of the time on the Tier 1 default model, ≥ 75% on Tier 0.
- Zero invalid geometry across the full prompt fixture set.
- Worker CPU p99 < 6 ms under synthetic load.
- With inference disabled by flag, plan creation from a template and all editing still work.

### Phase 2 — Editing and interchange
Canvas direct manipulation, undo/redo, openings, dimensions, D1 persistence, share links, DXF + PDF export.

**Exit criteria:** DXF fixture imports clean into all four target applications; wall drag re-solves within one frame at 20 rooms.

### Phase 3 — Fidelity and Tiers 2/3
Detached wall-graph editing, L-shaped rooms, multi-storey with stair alignment, IFC subset export, OpenRouter PKCE, BYOK.

### Phase 4 — Raster import
Per §6.5.

### Optional module (any phase ≥ 2) — MCP server
Per §10.

---

## 10. Optional module — MCP server

### 10.1 Purpose

Expose the plan engine as tools an external agent (Claude, ChatGPT, or any MCP client) can call. The agent supplies the reasoning; the server supplies deterministic geometry, validation, and export. This inverts the tier model: the user's existing assistant subscription funds inference, and the operator pays nothing for tokens.

**MCP-1** The MCP server MUST NOT perform any inference. It is a pure deterministic tool surface. *(This is what makes it free to run and what makes it correct — the calling agent already is the model.)*

**MCP-2** The MCP server MUST share the solver, validator, and exporter modules with the web client (per ARC-2), with no forked implementations.

### 10.2 CPU budget — the one real risk

**MCP-3** Unlike the web path, the MCP path runs the solver **inside** the Worker, against the 10 ms free-tier ceiling. The implementation MUST:
- cap plan size at 40 rooms per level and reject beyond it;
- benchmark `parse + solve + serialize` in CI and fail the build if p99 exceeds 7 ms;
- prefer patch-application over full regeneration where possible.

**MCP-4** If the budget cannot be met, the mitigation MUST be to reduce scope (smaller caps, `render_svg` moved to a client-only path) rather than silently degrade. Escalating to Workers Paid is a legitimate outcome to document, not a failure to hide.

### 10.3 Transport and auth

**MCP-5** Transport MUST be Streamable HTTP at `POST /mcp` on the same Worker.
**MCP-6** The server MUST be stateless between calls. Plan state travels either inline in tool arguments (small plans) or by `planId` + token (persisted plans). No server-side session.
**MCP-7** Auth MUST support two modes: anonymous with inline plan state (no persistence), and bearer token scoped to one plan for persisted work.
**MCP-8** Tool call volume counts against the 100 K/day Worker request budget and MUST be rate-limited per token.

### 10.4 Tool surface

| Tool | Input | Output |
|---|---|---|
| `create_plan` | `description` *(structured, not prose)*: room programs, counts, footprint, units | `planId`, `summary`, `svg` |
| `describe_plan` | `planId` \| `doc` | `PlanSummary` — the same digest defined in INF-2 |
| `apply_patch` | `planId` \| `doc`, `patch` | updated `summary`, `svg`, `warnings[]` |
| `validate_plan` | `planId` \| `doc` | `{ valid, violations[] }` — min dimensions, unreachable rooms, missing egress |
| `render_svg` | `planId` \| `doc`, `options` | SVG string (returned as an MCP image/resource) |
| `export_plan` | `planId` \| `doc`, `format` | download URL (R2, TTL-signed) or inline text for DXF/IFC |
| `list_programs` | — | Supported room programs and their dimension constraints |

**MCP-9** `create_plan` MUST take structured input, not a natural-language string. The calling agent is responsible for turning the user's sentence into structure — that is the division of labour that makes this module free of inference.

**MCP-10** Tool descriptions MUST document the patch vocabulary (INF-6) inline and completely, since the agent has no other schema source.

**MCP-11** Every tool response MUST include a human-readable summary alongside structured data, so the agent can narrate without a second call.

**MCP-12** `render_svg` output SHOULD be returned as an MCP resource so hosts that support inline widgets can display the plan directly.

**MCP-13** Plans created via MCP MUST be openable in the web app via share URL, and vice versa. One document format, two front doors.

---

## 11. Open questions

1. **Tier 0 patch quality.** Whether an on-device model reliably emits the full patch vocabulary is unproven. Mitigation: define a reduced "core vocabulary" (add/remove/rename/resize/swap) that Tier 0 is held to, and route unsupported ops to Tier 1 with a visible notice. *This should be resolved in the first week of Phase 1 — it determines whether Tier 0 is a headline feature or a bonus.*

2. **Dimension parsing coverage.** The regex/pattern-match rules in DIM-2 will require tuning based on real usage. Create a fixture of ~50 dimension-specification utterances (varying phrasing, units, compound constraints) and measure coverage weekly in Phase 1. Target ≥ 80% deterministic parse rate.

3. **Constraint conflict heuristics.** When dimension constraints conflict (e.g., "kitchen 4×5 feet" but minimum appliance clearance requires 4×6), the error message (SLV-7) must be actionable. Maintain a conflict resolution guide with suggested looseness trade-offs, populated by Phase 1 data.

4. **Neuron cost per turn.** Tier 1 per-client quota (T1-3) is a guess until measured. Instrument first, tune after. Expect that turns with dimension parsing burn fewer neurons (smaller context) than turns without.

5. **Outer boundary derivation.** Whether the user specifies footprint dimensions, total square footage, or neither (and the system infers from program). Affects the first-turn clarifying question. Dimension specification should satisfy this (e.g., specifying a 30×40 boundary implies footprint knowledge).

6. **Multi-storey stair alignment.** Vertical circulation constrains all levels simultaneously; the slicing tree has no vocabulary for it. Likely needs a separate constraint layer in Phase 3.

7. **MCP host compatibility.** Widget/resource rendering behaviour differs across hosts and is moving quickly. Verify against current host behaviour before committing to MCP-12.

---

## 12. Explicitly deferred

- Real-time collaboration (would require Durable Objects; no requirement exists yet).
- Furniture and fixture libraries.
- Cost estimation, material takeoffs.
- Building code validation.
- Native mobile applications.
- Server-side rendering of any kind.
