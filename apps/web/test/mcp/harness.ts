// Test doubles for the MCP suite: a Worker Env with just enough D1 to exercise the
// saved-plan path (specs.md MCP-7), and a helper that speaks JSON-RPC to POST /mcp.

import { handleMcp } from "../../src/worker/mcp/server";
import type { Env } from "../../src/worker/env";

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

/**
 * A stand-in for D1 covering the two statements the MCP module reaches it through
 * (openPlan's SELECT and writePlanDoc's UPDATE). Anything else throws rather than
 * silently returning nothing, so a new query can't pass its tests by accident.
 */
export function fakeDb(rows: Record<string, PlanRow>) {
  return {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (!sql.startsWith("SELECT id, owner_hash")) throw new Error(`unexpected query: ${sql}`);
          return (rows[String(statement.args[0])] ?? null) as T | null;
        },
        async run() {
          if (!sql.startsWith("UPDATE plans SET doc")) throw new Error(`unexpected statement: ${sql}`);
          const [doc, title, schemaVersion, updatedAt, id] = statement.args as [string, string, number, number, string];
          const row = rows[id];
          if (row) Object.assign(row, { doc, title, schema_version: schemaVersion, updated_at: updatedAt });
          return { success: true };
        },
        async all() {
          throw new Error(`unexpected query: ${sql}`);
        },
      };
      return statement;
    },
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    AI: { run: async () => { throw new Error("MCP-1: the MCP module must never call a model"); } },
    DB: undefined as unknown as Env["DB"],
    ...overrides,
  } as Env;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stored plan whose edit and share tokens are the two strings given. */
export async function storedPlan(id: string, doc: string, editToken: string, shareToken: string): Promise<PlanRow> {
  return {
    id,
    owner_hash: "owner",
    edit_token_hash: await sha256Hex(editToken),
    share_token_hash: await sha256Hex(shareToken),
    title: "Stored",
    schema_version: 1,
    doc,
    updated_at: 0,
  };
}

export type RpcOptions = {
  bearer?: string;
  /** Token on the endpoint URL instead of the header, as a pasted connector URL carries it. */
  urlToken?: string;
  ip?: string;
  env?: Env;
  method?: string;
  headers?: Record<string, string>;
};

let requestCounter = 0;

/** POSTs one JSON-RPC message and returns the parsed response plus the raw Response. */
export async function rpc(
  method: string,
  params: unknown,
  options: RpcOptions = {},
): Promise<{ status: number; body: any; response: Response }> {
  const id = ++requestCounter;
  return rawRpc({ jsonrpc: "2.0", id, method, params }, options);
}

export async function rawRpc(payload: unknown, options: RpcOptions = {}): Promise<{ status: number; body: any; response: Response }> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", ...options.headers });
  if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
  const endpoint = options.urlToken ? `https://floorcraft.example/mcp?t=${encodeURIComponent(options.urlToken)}` : "https://floorcraft.example/mcp";
  const request = new Request(endpoint, { method: options.method ?? "POST", headers, body: options.method === "GET" ? undefined : body });
  // A fresh IP per call by default: the rate limiter (MCP-8) is process-wide and would
  // otherwise let one test's volume fail the next one's.
  const ip = options.ip ?? `10.0.0.${++requestCounter % 250}`;
  const response = await handleMcp(request, options.env ?? makeEnv(), ip);
  const text = await response.clone().text();
  return { status: response.status, body: text ? JSON.parse(text) : null, response };
}

/** Calls a tool and returns its result, failing loudly on a protocol-level error. */
export async function call(name: string, args: unknown, options: RpcOptions = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args }, options);
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  return body.result as { content: Array<any>; isError?: boolean };
}

export function textOf(result: { content: Array<any> }): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/** The structured half of a tool result — the last text block (MCP-11). */
export function dataOf(result: { content: Array<any> }): any {
  const blocks = result.content.filter((c) => c.type === "text");
  return JSON.parse(blocks[blocks.length - 1]!.text);
}

export function resourceOf(result: { content: Array<any> }): { uri: string; mimeType: string; text: string } | undefined {
  return result.content.find((c) => c.type === "resource")?.resource;
}
