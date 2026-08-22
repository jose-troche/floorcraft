// Plan document CRUD — specs.md §8.3 (/api/plans), FR-13 (debounced sync target),
// FR-14 (share links), FR-15 (version retention), SEC-2 (1 MB cap enforced before any
// read), SEC-3 (hashed capability tokens).
//
// ARC-1 governs every handler here: the document body is opaque text. It is never
// parsed, validated or transformed server-side — a JSON.parse of a large plan would
// eat a meaningful slice of the 10 ms free-tier CPU budget for no benefit, since the
// client is authoritative for plan state anyway (ARC-3).

import type { Env } from "./env";
import { errorResponse } from "./redact";
import { hashOwner, hashToken, mintToken, timingSafeEqual } from "./tokens";

/** SEC-2. Checked against content-length before the body is touched. */
const MAX_DOC_BYTES = 1_000_000;
/** FR-15: the last 50 patches per plan are what undo-across-sessions needs. */
const VERSION_RETENTION = 50;

type PlanRow = {
  id: string;
  owner_hash: string;
  edit_token_hash: string | null;
  share_token_hash: string | null;
  title: string;
  schema_version: number;
  doc: string;
  updated_at: number;
};

export type Access = "read" | "edit";

function jsonResponse(body: unknown, status = 200, headers: Headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Rejects an oversize body before reading it. A request with no content-length (a
 * streamed body) is refused rather than read blind — SEC-2 says reject *before* any read.
 */
function bodyTooLarge(request: Request): Response | null {
  const header = request.headers.get("content-length");
  if (header === null) return errorResponse("A content-length header is required", 411);
  const length = Number(header);
  if (!Number.isFinite(length) || length < 0) return errorResponse("Invalid content-length", 400);
  if (length > MAX_DOC_BYTES) return errorResponse("Plan document too large", 413);
  return null;
}

/** Titles ride in a header so the body stays opaque; they arrive percent-encoded. */
function readTitle(request: Request): string {
  const raw = request.headers.get("x-fc-title");
  if (!raw) return "Untitled";
  try {
    return decodeURIComponent(raw).slice(0, 200) || "Untitled";
  } catch {
    return "Untitled";
  }
}

function readSchemaVersion(request: Request): number {
  const raw = Number(request.headers.get("x-fc-schema-version"));
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

async function loadPlan(env: Env, id: string): Promise<PlanRow | null> {
  return env.DB.prepare(
    "SELECT id, owner_hash, edit_token_hash, share_token_hash, title, schema_version, doc, updated_at FROM plans WHERE id = ?",
  )
    .bind(id)
    .first<PlanRow>();
}

/** The strongest access the presented token grants, or null if it grants none. */
async function authorize(row: PlanRow, token: string | null): Promise<Access | null> {
  if (!token) return null;
  const presented = await hashToken(token);
  if (row.edit_token_hash && timingSafeEqual(presented, row.edit_token_hash)) return "edit";
  if (row.share_token_hash && timingSafeEqual(presented, row.share_token_hash)) return "read";
  return null;
}

function tokenFrom(request: Request, url: URL): string | null {
  // Header for the app's own calls; query parameter so a share link is a plain URL.
  return request.headers.get("x-fc-token") ?? url.searchParams.get("t");
}

async function handleCreate(request: Request, env: Env, clientId: string): Promise<Response> {
  const tooLarge = bodyTooLarge(request);
  if (tooLarge) return tooLarge;

  const doc = await request.text();
  if (doc.length === 0) return errorResponse("Empty plan document", 400);

  const id = crypto.randomUUID();
  const editToken = mintToken();
  const shareToken = mintToken();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO plans (id, owner_hash, edit_token_hash, share_token_hash, title, schema_version, doc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      await hashOwner(env.QUOTA_SALT ?? "floorcraft-dev-salt", clientId),
      await hashToken(editToken),
      await hashToken(shareToken),
      readTitle(request),
      readSchemaVersion(request),
      doc,
      now,
      now,
    )
    .run();

  // The tokens are returned exactly once. Nothing server-side can recover them, which is
  // the point of storing only their hashes.
  return jsonResponse({ id, editToken, shareToken }, 201);
}

async function handleRead(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const row = await loadPlan(env, id);
  if (!row) return errorResponse("Plan not found", 404);
  const access = await authorize(row, tokenFrom(request, url));
  if (!access) return errorResponse("Plan not found", 404); // Not 403: don't confirm the id exists.

  return new Response(row.doc, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-fc-title": encodeURIComponent(row.title),
      "x-fc-access": access,
      "x-fc-schema-version": String(row.schema_version),
    },
  });
}

async function handleReplace(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const tooLarge = bodyTooLarge(request);
  if (tooLarge) return tooLarge;

  const row = await loadPlan(env, id);
  if (!row) return errorResponse("Plan not found", 404);
  const access = await authorize(row, tokenFrom(request, url));
  if (access !== "edit") return errorResponse("An edit token is required", 403);

  const doc = await request.text();
  if (doc.length === 0) return errorResponse("Empty plan document", 400);

  await env.DB.prepare("UPDATE plans SET doc = ?, title = ?, schema_version = ?, updated_at = ? WHERE id = ?")
    .bind(doc, readTitle(request), readSchemaVersion(request), Date.now(), id)
    .run();
  return jsonResponse({ ok: true, id });
}

async function handleAppendVersion(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const tooLarge = bodyTooLarge(request);
  if (tooLarge) return tooLarge;

  const row = await loadPlan(env, id);
  if (!row) return errorResponse("Plan not found", 404);
  const access = await authorize(row, tokenFrom(request, url));
  if (access !== "edit") return errorResponse("An edit token is required", 403);

  const patch = await request.text();
  if (patch.length === 0) return errorResponse("Empty patch", 400);

  // One statement to allocate the sequence number and insert, so two concurrent tabs
  // can't collide on the (plan_id, seq) primary key.
  await env.DB.prepare(
    `INSERT INTO plan_versions (plan_id, seq, patch, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM plan_versions WHERE plan_id = ?), ?, ?)`,
  )
    .bind(id, id, patch, Date.now())
    .run();

  // FR-15 retention: keep the newest 50 and drop the rest.
  await env.DB.prepare(
    `DELETE FROM plan_versions WHERE plan_id = ? AND seq <= (
       SELECT MAX(seq) - ? FROM plan_versions WHERE plan_id = ?
     )`,
  )
    .bind(id, VERSION_RETENTION, id)
    .run();

  return jsonResponse({ ok: true });
}

async function handleListVersions(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const row = await loadPlan(env, id);
  if (!row) return errorResponse("Plan not found", 404);
  const access = await authorize(row, tokenFrom(request, url));
  if (!access) return errorResponse("Plan not found", 404);

  const result = await env.DB.prepare(
    "SELECT seq, patch, created_at FROM plan_versions WHERE plan_id = ? ORDER BY seq DESC LIMIT ?",
  )
    .bind(id, VERSION_RETENTION)
    .all<{ seq: number; patch: string; created_at: number }>();
  return jsonResponse({ versions: result.results ?? [] });
}

/** Routes /api/plans and /api/plans/:id[/versions]; returns null when the path isn't ours. */
export async function handlePlans(request: Request, env: Env, url: URL, clientId: string): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/plans") {
    if (request.method === "POST") return handleCreate(request, env, clientId);
    return errorResponse("Method not allowed", 405);
  }

  const match = /^\/api\/plans\/([A-Za-z0-9-]{1,64})(\/versions)?$/.exec(path);
  if (!match) return null;
  const id = match[1]!;
  const isVersions = Boolean(match[2]);

  if (isVersions) {
    if (request.method === "POST") return handleAppendVersion(request, env, url, id);
    if (request.method === "GET") return handleListVersions(request, env, url, id);
    return errorResponse("Method not allowed", 405);
  }

  if (request.method === "GET") return handleRead(request, env, url, id);
  if (request.method === "PUT") return handleReplace(request, env, url, id);
  return errorResponse("Method not allowed", 405);
}

export const PLAN_LIMITS = { MAX_DOC_BYTES, VERSION_RETENTION };
