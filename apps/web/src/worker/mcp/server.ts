// MCP transport — specs.md MCP-5 (Streamable HTTP at POST /mcp), MCP-6 (stateless
// between calls) and MCP-8 (rate-limited per token).
//
// Streamable HTTP lets a server answer a POST either with an SSE stream or with a single
// JSON response. Every tool here is a synchronous computation with one result and no
// progress to report, so this returns JSON: no stream to keep open, no session to
// resume, and nothing for the client to reconnect to. That is MCP-6 as a transport
// property rather than a promise — there is no server-side state that could go stale,
// because plan state travels in the arguments (or lives in D1 behind a token).

import { redactSecrets } from "@floorcraft/core";
import type { Env } from "../env";
import { isRateLimited } from "../rateLimiter";
import { hashToken } from "../tokens";
import { TOOLS, callTool, type ToolContext } from "./tools";

const SERVER_INFO = { name: "floorcraft", title: "Floorcraft", version: "0.1.0" };

/** Newest first; the client's requested version is echoed when we speak it. */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * MCP-8: tool calls burn the same 100 K/day Worker request budget as everything else, so
 * they are metered per bearer token (per IP when anonymous). Higher than /api/infer's
 * ceiling because a plan is built in a burst of calls, not one at a time.
 */
const MCP_CALLS_PER_MINUTE = 60;

/**
 * The MCP path parses documents and solves geometry, so it is capped well below SEC-2's
 * 1 MB: an inline document that big would be a plan far past MCP-3's 40-room cap anyway,
 * and the point of the cap is to refuse the work before doing it.
 */
const MAX_BODY_BYTES = 512_000;

const INSTRUCTIONS = [
  "Floorcraft turns a room programme into real floor-plan geometry. It runs no model of its own:",
  "you decide what the user means, and these tools do the geometry, validation and export deterministically.",
  "",
  "Two ways to hold plan state:",
  "- Anonymous: call create_plan without a planId, then pass the `doc` it returns to every later call.",
  "  Nothing is stored, and each call returns the updated document for the next one.",
  "- Saved: send a plan's token as `Authorization: Bearer <token>` and pass `planId`. Edits are written",
  "  back to that plan, and the same plan opens in the Floorcraft web app at the URL each result carries.",
  "",
  "A good sequence: list_programs (once, if unsure) -> create_plan -> describe_plan for room ids and",
  "exterior wall ids -> apply_patch to refine -> validate_plan -> export_plan.",
].join("\n");

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function fail(id: JsonRpcId, code: number, message: string) {
  // SEC-5: every error leaving this Worker goes through the shared redaction helper.
  return { jsonrpc: "2.0" as const, id, error: { code, message: redactSecrets(message) } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/**
 * MCP clients reach this endpoint from a server, not a browser page, so these headers are
 * for the browser-based ones (the Inspector, in-page clients). Credentials are
 * deliberately not allowed: authorization here is a bearer token, never the app's cookie,
 * so a page on another origin can offer nothing it did not already have.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
};

/**
 * The plan token, from the `Authorization` header or from `?t=` on the endpoint URL.
 *
 * The query form exists because the hosts this server is for — Claude Desktop, claude.ai
 * — take a connector *URL* and have no field for a custom header. It is the same shape
 * the app's own share links use (`/?plan=…&t=…`, plans.ts `tokenFrom`) and the same
 * capability token behind it, so a saved plan is connected by pasting a URL. A token in a
 * query string is easier to leak into a log than one in a header; that trade is already
 * made by FR-14's share links, and the token still scopes to exactly one plan.
 */
function bearerFrom(request: Request, url: URL): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }
  return url.searchParams.get("t");
}

function negotiateProtocol(params: unknown): string {
  const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
  return typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]!;
}

async function dispatch(message: JsonRpcMessage, ctx: ToolContext): Promise<object | null> {
  const id = (message.id ?? null) as JsonRpcId;
  const isNotification = message.id === undefined || message.id === null;
  const method = message.method;

  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : fail(id, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
  }

  // Notifications carry no reply by definition; `notifications/initialized` is the one
  // this server actually expects, and the rest are acknowledged by saying nothing.
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocol(message.params),
        // Only tools. No prompts, no resource listing: a plan is not a document this
        // server can enumerate — it belongs to whoever holds its token (MCP-7) — so the
        // drawings and exports ride back as embedded resources on the call that made
        // them (MCP-12) rather than as a directory anyone could browse.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return fail(id, INVALID_PARAMS, "tools/call requires a string `name`.");
      const args = params.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return fail(id, INVALID_PARAMS, "tools/call `arguments` must be an object.");
      }
      try {
        return ok(id, await callTool(params.name, (args ?? {}) as Record<string, unknown>, ctx));
      } catch (e) {
        // Anything that reaches here is a bug or a D1 failure, not a bad argument — those
        // come back from callTool as an errored result the model can act on.
        return fail(id, INTERNAL_ERROR, `Tool "${params.name}" failed: ${(e as Error).message}`);
      }
    }

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `Unknown method "${method}".`);
  }
}

/**
 * MCP-8's meter. A bearer token is metered as itself (hashed, so the bucket key never
 * holds the token); anonymous callers share a bucket per IP.
 */
async function rateLimitKey(bearer: string | null, ip: string): Promise<string> {
  return bearer ? `mcp:t:${(await hashToken(bearer)).slice(0, 32)}` : `mcp:ip:${ip}`;
}

export async function handleMcp(request: Request, env: Env, ip: string): Promise<Response> {
  if (env.MCP_ENABLED === "false") {
    return jsonResponse({ error: "The MCP module is disabled on this deployment" }, 503);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") {
    // This server never opens a server-initiated stream and holds no session to delete,
    // so GET and DELETE have nothing to do here (MCP-6).
    return new Response(JSON.stringify({ error: "The Floorcraft MCP endpoint accepts POST only" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST, OPTIONS", ...CORS_HEADERS },
    });
  }

  const url = new URL(request.url);
  const bearer = bearerFrom(request, url);
  if (isRateLimited(await rateLimitKey(bearer, ip), MCP_CALLS_PER_MINUTE)) {
    return jsonResponse(fail(null, INTERNAL_ERROR, "Too many MCP calls; wait a moment and retry."), 429);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonResponse(fail(null, INVALID_REQUEST, `Request body over ${MAX_BODY_BYTES} bytes.`), 413);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return jsonResponse(fail(null, INVALID_REQUEST, `Request body over ${MAX_BODY_BYTES} bytes.`), 413);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse(fail(null, PARSE_ERROR, "Request body is not valid JSON."), 400);
  }

  const ctx: ToolContext = { env, bearer, origin: url.origin };
  // Batches were dropped in protocol 2025-06-18 but are still spoken by older clients;
  // answering both costs one array check.
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return jsonResponse(fail(null, INVALID_REQUEST, "Empty batch."), 400);

  const responses: object[] = [];
  for (const message of messages) {
    const response = await dispatch((message ?? {}) as JsonRpcMessage, ctx);
    if (response) responses.push(response);
  }

  // Every message was a notification: acknowledged with no content, per the transport.
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return jsonResponse(Array.isArray(body) ? responses : responses[0]);
}
