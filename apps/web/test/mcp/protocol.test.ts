// Transport conformance — specs.md MCP-5 (Streamable HTTP at POST /mcp), MCP-6
// (stateless), MCP-8 (rate limited per token).

import { describe, expect, it } from "vitest";
import { makeEnv, rawRpc, rpc } from "./harness";

describe("POST /mcp", () => {
  it("negotiates a protocol version and advertises only tools", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("floorcraft");
    expect(Object.keys(body.result.capabilities)).toEqual(["tools"]);
    expect(body.result.instructions).toMatch(/runs no model of its own/);
  });

  it("falls back to its newest version when asked for one it does not speak", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("issues no session id — there is no server-side state to resume (MCP-6)", async () => {
    const { response } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists every tool in the §10.4 surface with an input schema", async () => {
    const { body } = await rpc("tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(
      ["apply_patch", "create_plan", "describe_plan", "export_plan", "list_programs", "render_svg", "validate_plan"],
    );
    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("documents the patch vocabulary inline and completely (MCP-10)", async () => {
    const { body } = await rpc("tools/list", {});
    const applyPatch = body.result.tools.find((t: { name: string }) => t.name === "apply_patch");
    // Every op a patch may carry has to be described where the agent can see it, since
    // the tool description is its only schema source.
    for (const op of [
      "addRoom", "removeRoom", "renameRoom", "resizeRoom", "swapRooms", "moveRoom", "setSplit",
      "addOpening", "removeOpening", "setBoundary", "setUnits", "setDimension", "clearDimension",
      "setDimensionRange", "addLevel", "setActiveLevel", "renameLevel",
    ]) {
      expect(applyPatch.description).toContain(op);
    }
  });

  it("answers ping", async () => {
    const { body } = await rpc("ping", {});
    expect(body.result).toEqual({});
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const { status, body } = await rawRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it("answers a batch with one response per request", async () => {
    const { body } = await rawRpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(body.map((m: { id: number }) => m.id)).toEqual([1, 2]);
  });

  it("reports unknown methods and malformed requests as JSON-RPC errors", async () => {
    expect((await rpc("resources/list", {})).body.error.code).toBe(-32601);
    expect((await rawRpc({ id: 1, method: "ping" })).body.error.code).toBe(-32600);
    expect((await rawRpc("{not json")).body.error.code).toBe(-32700);
    expect((await rpc("tools/call", { name: 42 })).body.error.code).toBe(-32602);
  });

  it("names an unknown tool without failing the protocol", async () => {
    const { body } = await rpc("tools/call", { name: "demolish_house", arguments: {} });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/No tool named/);
  });

  it("refuses GET: this endpoint opens no server-initiated stream", async () => {
    const { status, response } = await rawRpc({}, { method: "GET" });
    expect(status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("answers a CORS preflight without allowing credentials", async () => {
    const { response, status } = await rawRpc({}, { method: "OPTIONS" });
    expect(status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("can be switched off per deployment", async () => {
    const { status, body } = await rpc("ping", {}, { env: makeEnv({ MCP_ENABLED: "false" }) });
    expect(status).toBe(503);
    expect(body.error).toMatch(/disabled/);
  });

  it("rate-limits a single caller (MCP-8)", async () => {
    const ip = "203.0.113.9";
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const { status } = await rpc("ping", {}, { ip });
      if (status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("meters two bearer tokens separately", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 70; i++) await rpc("ping", {}, { ip, bearer: "token-a" });
    // The shared IP is irrelevant once a token identifies the caller.
    const { status } = await rpc("ping", {}, { ip, bearer: "token-b" });
    expect(status).toBe(200);
  });

  it("rejects a body past the parse cap before parsing it", async () => {
    const { status, body } = await rawRpc({}, { headers: { "content-length": String(600_000) } });
    expect(status).toBe(413);
    expect(body.error.message).toMatch(/body over/);
  });
});
