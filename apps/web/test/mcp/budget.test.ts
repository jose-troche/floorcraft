// The CPU budget — specs.md MCP-3: "benchmark `parse + solve + serialize` in CI and fail
// the build if p99 exceeds 7 ms".
//
// This measures the whole handler, not the solver alone: reading the JSON-RPC body,
// rebuilding the plan, solving it, rendering, and serializing the response are all work
// the Worker does inside one 10 ms free-tier slice, so the benchmark that decides whether
// the module ships has to cover all of it.
//
// What the ceiling is about is CPU time — that is what Cloudflare meters — but
// `process.cpuUsage()` is accounted in kernel ticks, and at 2 ms per call the
// quantization *is* the tail, so it cannot be sampled per call. Wall clock has the
// resolution and none of the meaning: a sibling test file competing for the same core
// lands in the tail and fails the build over scheduling, not over the Worker.
//
// So: sample wall clock, then scale the whole distribution by the batch's measured
// CPU-to-wall ratio. On an idle runner the ratio is ~1 and this is plain wall time; under
// contention it removes the time the process spent descheduled and not the work it did.
// A real regression raises CPU too, so it cannot be normalised away.
//
// If this test fails, MCP-4 says what to do: cut scope — a smaller room cap, or moving
// `render_svg` to a client-only path — or move the Worker to a paid plan and say so.
// It does not say to raise the threshold.

import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan, exportJson, type PatchOp, type PlanDocument, type RoomProgram } from "@floorcraft/core";
import { MAX_ROOMS_PER_LEVEL, toWireDoc } from "../../src/worker/mcp/planIO";
import { handleMcp } from "../../src/worker/mcp/server";
import { makeEnv } from "./harness";

const BUDGET_P99_MS = 7;
// Enough samples that p99 is a percentile rather than "the slowest of a handful": at 50
// samples the 99th is the maximum, and one garbage-collection pause decides whether the
// build passes.
const ITERATIONS = 200;
// Generous, and deliberately so: the first scenario measured otherwise pays for JIT
// compilation and the heap growth every later one inherits warm, which showed up as a
// tail that moved with position rather than with the tool.
const WARMUP = 60;

/** Programs small enough that 40 of them still fit a plausible footprint. */
const PROGRAMS: RoomProgram[] = ["bedroom", "bath", "office", "closet", "hallway", "pantry", "laundry", "entry"];

function fullPlan(): PlanDocument {
  const empty = createEmptyPlan({
    id: "budget",
    title: "Budget Fixture",
    units: "imperial",
    boundary: { widthMm: 28_000, depthMm: 42_000 },
  });
  const ops: PatchOp[] = [];
  for (let i = 0; i < MAX_ROOMS_PER_LEVEL; i++) {
    ops.push({ op: "addRoom", roomId: `r${i}`, program: PROGRAMS[i % PROGRAMS.length]!, name: `Room ${i}`, areaWeight: 1 });
  }
  const result = applyPatch(empty, { ops, source: "user" });
  if (!result.ok) throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  return result.doc;
}

const env = makeEnv();

async function measure(name: string, body: unknown): Promise<{ name: string; p99: number; mean: number; cpuMean: number; ratio: number }> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: body });
  // Built outside the timed region: constructing a Request and reading the reply back are
  // the platform's and the caller's work, not the Worker's. What is timed is exactly what
  // MCP-3 names — reading the body, solving, and serializing the response.
  const newRequest = () =>
    new Request("https://floorcraft.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  const check = async (response: Response) => {
    if (response.status !== 200) throw new Error(`${name} returned ${response.status}`);
    const parsed = (await response.json()) as { result?: { isError?: boolean; content: Array<{ text?: string }> } };
    if (parsed.result?.isError) throw new Error(`${name} failed: ${parsed.result.content[0]?.text}`);
  };

  for (let i = 0; i < WARMUP; i++) await check(await handleMcp(newRequest(), env, `10.1.${i}.1`));

  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  for (let i = 0; i < ITERATIONS; i++) {
    // A distinct IP per sample so MCP-8's meter never becomes what is being measured.
    const request = newRequest();
    const ip = `10.2.${Math.floor(i / 250)}.${i % 250}`;
    const started = performance.now();
    const response = await handleMcp(request, env, ip);
    samples.push(performance.now() - started);
    if (i === 0) await check(response);
  }
  const cpu = process.cpuUsage(cpuBefore);
  samples.sort((a, b) => a - b);

  const wallTotal = samples.reduce((a, b) => a + b, 0);
  const cpuTotal = (cpu.user + cpu.system) / 1000;
  // Never scale *up*: CPU can exceed wall time when the runtime does work on another
  // thread, and that is not this call's serial cost.
  const ratio = Math.min(1, cpuTotal / wallTotal);
  return {
    name,
    p99: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)]! * ratio,
    mean: (wallTotal / samples.length) * ratio,
    cpuMean: cpuTotal / ITERATIONS,
    ratio,
  };
}

describe(`MCP CPU budget at ${MAX_ROOMS_PER_LEVEL} rooms`, () => {
  it("stays inside the free-tier ceiling on every tool that solves geometry", async () => {
    const doc = fullPlan();
    // What an agent actually sends back between turns: the compact transport document,
    // which the Worker has to rebuild before it can do anything with it.
    const wire = JSON.parse(exportJson(toWireDoc(doc)));
    const rooms = Array.from({ length: MAX_ROOMS_PER_LEVEL }, (_, i) => ({
      program: PROGRAMS[i % PROGRAMS.length]!,
      name: `Room ${i}`,
    }));

    const results = [
      await measure("create_plan (40 rooms, fitted footprint)", { name: "create_plan", arguments: { title: "Budget", rooms } }),
      await measure("apply_patch (rebuild + solve + serialize)", {
        name: "apply_patch",
        arguments: { doc: wire, patch: { ops: [{ op: "renameRoom", roomId: "r1", name: "Renamed" }] } },
      }),
      await measure("apply_patch (opening on a named edge: needs the prior graph)", {
        name: "apply_patch",
        arguments: {
          doc: wire,
          patch: { ops: [{ op: "addOpening", kind: "door", edgeId: Object.keys(doc.levels[0]!.graph.edges)[0] }] },
        },
      }),
      await measure("describe_plan", { name: "describe_plan", arguments: { doc: wire } }),
      await measure("render_svg", { name: "render_svg", arguments: { doc: wire } }),
      await measure("export_plan (ifc)", { name: "export_plan", arguments: { doc: wire, format: "ifc" } }),
    ];

    // Printed unconditionally: MCP-4's decision — reduce scope, or pay for Workers Paid —
    // needs the numbers, not just a pass or a fail.
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.name}: mean ${r.mean.toFixed(2)} ms, p99 ${r.p99.toFixed(2)} ms (CPU-normalised), mean CPU ${r.cpuMean.toFixed(2)} ms`);
    }

    // Mean CPU is the contention-proof number, so it is asserted too: it cannot be
    // inflated by a busy runner, which makes a failure here unambiguously the code.
    const cpuOver = results.filter((r) => r.cpuMean > BUDGET_P99_MS);
    expect(cpuOver.map((r) => `${r.name} mean CPU ${r.cpuMean.toFixed(2)} ms`), "over budget on CPU alone").toEqual([]);

    // A runner that spent much of the batch descheduled put that time in the tail. Say so
    // in the failure, so a red build is read as "re-run" or "fix the code" without anyone
    // having to reconstruct why.
    const busy = results.some((r) => r.ratio < 0.85);
    const over = results.filter((r) => r.p99 > BUDGET_P99_MS);
    expect(
      over.map((r) => `${r.name} p99 ${r.p99.toFixed(2)} ms`),
      `over the ${BUDGET_P99_MS} ms p99 budget (MCP-3)` +
        (busy ? " — this runner was contended (CPU/wall below 0.85), so the tail may be scheduling rather than the Worker; mean CPU is the column to trust" : ""),
    ).toEqual([]);
  }, 120_000);

  it("refuses a document past the room cap rather than solving it", async () => {
    const doc = fullPlan();
    const over = applyPatch(doc, { ops: [{ op: "addRoom", program: "closet", areaWeight: 1 }], source: "user" });
    if (!over.ok) throw new Error("fixture failed");
    const request = new Request("https://floorcraft.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "describe_plan", arguments: { doc: JSON.parse(exportJson(over.doc)) } },
      }),
    });
    const body = (await (await handleMcp(request, env, "10.9.9.9")).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/caps a level at 40 rooms/);
  });
});
