// Where an MCP tool's plan state comes from and goes back to — specs.md MCP-6 (stateless:
// state travels inline or by planId + token) and MCP-7 (anonymous inline, or bearer token
// scoped to one plan).
//
// This is the one place in the Worker that deliberately parses a plan document, and so
// the one documented exception to ARC-1. MCP-3 accepts that cost — the whole module is
// "parse + solve + serialize inside the Worker" — and pays for it with the caps below.

import {
  applyPatch,
  exportJson,
  importJson,
  type Level,
  type PlanDocument,
} from "@floorcraft/core";
import type { Env } from "../env";
import { openPlan, writePlanDoc } from "../plans";

/** MCP-3: hard cap on plan size, the first of the three CPU-budget mitigations. */
export const MAX_ROOMS_PER_LEVEL = 40;

/**
 * A failure the *calling agent* can act on: a bad argument, a missing token, a plan that
 * broke a cap. These come back as a tool result with `isError: true` and a sentence
 * saying what to do differently, not as a JSON-RPC error — a protocol error tells the
 * model nothing and usually ends the conversation instead of correcting it.
 */
export class ToolError extends Error {}

export type PlanHandle = {
  doc: PlanDocument;
  /** Set when the plan came from D1 and edits are written back to it. */
  stored: { id: string; token: string; canWrite: boolean } | null;
};

function levelRoomCount(level: Level): number {
  return Object.keys(level.graph.rooms).length;
}

/** MCP-3's room cap, checked on the way in and again on the way out of every write. */
export function assertWithinCaps(doc: PlanDocument): void {
  for (const level of doc.levels) {
    const count = levelRoomCount(level);
    if (count > MAX_ROOMS_PER_LEVEL) {
      throw new ToolError(
        `Level "${level.name}" has ${count} rooms; this server caps a level at ${MAX_ROOMS_PER_LEVEL} rooms so every ` +
          `call stays inside its CPU budget. Split the plan across levels, or edit it in the web app.`,
      );
    }
  }
}

/**
 * The transport form of a plan: the document with its derived geometry removed.
 *
 * Wall nodes, edges and each room's boundary cycle are all *outputs* of the solver
 * (DM-5) — they are regenerated from the generator tree and room metadata on every
 * patch, and they are also five sixths of the document's bytes. An agent carrying plan
 * state inline (MCP-6) would otherwise pay for the whole wall graph in context on every
 * turn to hand back something the server is about to recompute anyway.
 *
 * This is not a second document format (MCP-13): it is the same schema with derived
 * fields omitted, `hydrate` puts them back, and what gets persisted to D1 — the copy the
 * web app opens — is always the complete document.
 */
export function toWireDoc(doc: PlanDocument): PlanDocument {
  return {
    ...doc,
    levels: doc.levels.map((level) => ({
      ...level,
      graph: {
        nodes: {},
        edges: {},
        rooms: Object.fromEntries(
          Object.entries(level.graph.rooms).map(([roomId, room]) => [
            roomId,
            {
              name: room.name,
              program: room.program,
              boundary: [],
              ...(room.constraints ? { constraints: room.constraints } : {}),
              ...(room.labelAnchor ? { labelAnchor: room.labelAnchor } : {}),
            },
          ]),
        ),
      },
    })),
  };
}

function needsRebuild(level: Level): boolean {
  return Object.keys(level.graph.rooms).length > 0 && Object.keys(level.graph.nodes).length === 0;
}

/**
 * Re-solves any level whose geometry was stripped for transport. A document that already
 * carries its wall graph — anything read from D1, or exported by the web app — passes
 * through untouched, so the persisted path never pays for this.
 */
function hydrate(doc: PlanDocument): PlanDocument {
  const stale = doc.levels.filter(needsRebuild).map((l) => l.id);
  if (stale.length === 0) return doc;

  const wasActive = doc.activeLevelId;
  let out = doc;
  for (const levelId of stale) {
    // An empty patch is a full re-solve of the active level, which is exactly what a
    // stripped level needs; switching level is itself a re-solve of the level moved to.
    const result = applyPatch(out, {
      ops: levelId === out.activeLevelId ? [] : [{ op: "setActiveLevel", levelId }],
      source: "user",
    });
    if (!result.ok) {
      throw new ToolError(
        `The supplied plan could not be rebuilt: ${[...result.errors, ...(result.violations ?? []).map((v) => v.message)].join("; ")}`,
      );
    }
    out = result.doc;
  }
  // Every level now carries its graph, so restoring the caller's active level is a field
  // assignment rather than another solve.
  return out.activeLevelId === wasActive ? out : { ...out, activeLevelId: wasActive };
}

/**
 * `rebuild: false` hands back a document whose stripped levels are still stripped. Only
 * `apply_patch` asks for that, and only when its patch is about to re-solve the level
 * anyway: the reducer reads room names, programs and constraints — all of which survive
 * transport — off the level and rebuilds the graph itself, so re-solving first would be
 * one full solve spent on geometry the next line throws away (MCP-3).
 */
export type OpenOptions = { rebuild?: boolean };

export function parseDoc(raw: unknown, options: OpenOptions = {}): PlanDocument {
  if (typeof raw !== "object" || raw === null) throw new ToolError("`doc` must be a plan document object.");
  const parsed = importJson(JSON.stringify(raw));
  if (!parsed.ok) throw new ToolError(`\`doc\` is not a valid plan document: ${parsed.error}`);
  const doc = options.rebuild === false ? parsed.doc : hydrate(parsed.doc);
  assertWithinCaps(doc);
  return doc;
}

export type PlanArgs = { planId?: unknown; doc?: unknown };

/**
 * Resolves the `planId | doc` pair every tool takes.
 *
 * MCP-7's two modes meet here: a `doc` argument is anonymous, stateless and never
 * persisted; a `planId` is only readable with the bearer token that plan was issued (the
 * `t=` value in the web app's share or edit link), and only writable with its edit token.
 */
export async function openPlanArg(env: Env, args: PlanArgs, bearer: string | null, options: OpenOptions = {}): Promise<PlanHandle> {
  const hasId = typeof args.planId === "string" && args.planId.length > 0;
  const hasDoc = args.doc !== undefined && args.doc !== null;

  if (hasId && hasDoc) throw new ToolError("Pass either `planId` or `doc`, not both.");
  if (!hasId && !hasDoc) {
    throw new ToolError(
      "Pass `doc` (the plan document from a previous call) to work anonymously, or `planId` with a bearer token to work on a saved plan.",
    );
  }
  if (hasDoc) return { doc: parseDoc(args.doc, options), stored: null };

  const planId = args.planId as string;
  if (!bearer) {
    throw new ToolError(
      "`planId` needs a bearer token: send the plan's token as `Authorization: Bearer <token>`. " +
        "It is the `t=` value in the share or edit link the web app produces for that plan.",
    );
  }
  if (!env.DB) throw new ToolError("Saved plans are not available on this deployment; pass `doc` inline instead.");

  const opened = await openPlan(env, planId, bearer);
  // Deliberately the same message for "no such plan" and "wrong token", so a caller
  // cannot probe for plan ids (mirrors handleRead's 404-not-403 in plans.ts).
  if (!opened) throw new ToolError(`No plan ${planId} is readable with that token.`);

  const parsed = importJson(opened.doc);
  if (!parsed.ok) throw new ToolError(`Stored plan ${planId} could not be read: ${parsed.error}`);
  const doc = hydrate(parsed.doc);
  assertWithinCaps(doc);
  return { doc, stored: { id: planId, token: bearer, canWrite: opened.access === "edit" } };
}

/**
 * Writes an edited plan back where it came from. Inline plans have nowhere to go — the
 * agent carries the returned document instead — which is what "no persistence" in MCP-7
 * means in practice.
 */
export async function persist(env: Env, handle: Pick<PlanHandle, "stored">, doc: PlanDocument): Promise<void> {
  if (!handle.stored) return;
  if (!handle.stored.canWrite) {
    throw new ToolError("That token opens the plan read-only. Editing needs the plan's edit token.");
  }
  assertWithinCaps(doc);
  await writePlanDoc(env, handle.stored.id, exportJson(doc), doc.title, doc.schemaVersion);
}

/**
 * MCP-13: the share URL that opens this plan in the web app. The token is the one the
 * caller already presented, so echoing it here discloses nothing it does not hold.
 */
export function webUrl(origin: string, id: string, token: string): string {
  return `${origin}/?plan=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}
