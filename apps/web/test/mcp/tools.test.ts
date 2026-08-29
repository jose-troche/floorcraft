// The tool surface — specs.md §10.4, MCP-9 (structured input), MCP-11 (human summary
// beside structured data), MCP-12 (SVG as a resource), MCP-13 (one document, two front
// doors).

import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan, exportJson, importJson, type PatchOp, type PlanDocument } from "@floorcraft/core";
import { call, dataOf, fakeDb, makeEnv, resourceOf, storedPlan, textOf } from "./harness";

function seedDoc(ops: PatchOp[] = []): PlanDocument {
  const empty = createEmptyPlan({ id: "seed", title: "Seed", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
  if (ops.length === 0) return empty;
  const result = applyPatch(empty, { ops, source: "user" });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.doc;
}

const HOUSE = {
  title: "Family Home",
  units: "imperial",
  rooms: [
    { program: "kitchen", id: "kitchen" },
    { program: "living", id: "living", adjacentTo: "kitchen", direction: "right" },
    { program: "bedroom", count: 2 },
  ],
};

describe("create_plan", () => {
  it("builds a plan from a room programme and narrates it (MCP-11)", async () => {
    const result = await call("create_plan", HOUSE);
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/Created "Family Home"/);
    expect(text).toMatch(/Kitchen \[kitchen\]/);
    // A count of two is numbered by the same rule the app's own chat uses.
    expect(text).toMatch(/Bedroom \[/);
    expect(text).toMatch(/Bedroom 2 \[/);

    const data = dataOf(result);
    expect(data.summary.rooms).toHaveLength(4);
    expect(data.summary.title).toBe("Family Home");
    expect(data.doc).toBeDefined();
    expect(data.planId).toBeUndefined();
  });

  it("doesn't repeat the generator tree when `doc` already carries it", async () => {
    // doc.levels[].generator.tree is the exact same tree buildPlanSummary reads for
    // generatorTree — sending both would bill a growing conversation for the same bytes
    // on every later turn, not just this one.
    const data = dataOf(await call("create_plan", HOUSE));
    expect(data.summary).not.toHaveProperty("generatorTree");
    expect(data.doc.levels[0].generator.tree).toBeDefined();
  });

  it("leaves the drawing to render_svg (MCP-4's budget mitigation)", async () => {
    const result = await call("create_plan", HOUSE);
    expect(resourceOf(result)).toBeUndefined();
    expect(textOf(result)).toMatch(/Call render_svg to draw it/);
  });

  it("fits a footprint around the rooms when none is given", async () => {
    const small = dataOf(await call("create_plan", { rooms: [{ program: "bath" }] }));
    const large = dataOf(await call("create_plan", { rooms: Array.from({ length: 12 }, () => ({ program: "bedroom" })) }));
    // A single small room still gets a house-sized default; twelve bedrooms force a
    // boundary large enough to hold them, rather than a rejected solve.
    expect(small.summary.boundary).toEqual({ widthMm: 9144, depthMm: 12192 });
    expect(large.summary.boundary.widthMm * large.summary.boundary.depthMm).toBeGreaterThan(9144 * 12192);
    expect(large.summary.rooms).toHaveLength(12);
  });

  it("honours a stated footprint and its unit", async () => {
    const data = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }], footprint: { width: 8, depth: 10, unit: "m" } }));
    expect(data.summary.boundary).toEqual({ widthMm: 8000, depthMm: 10000 });
  });

  it("explains a footprint too small for the rooms instead of failing silently", async () => {
    const result = await call("create_plan", {
      rooms: Array.from({ length: 8 }, () => ({ program: "bedroom" })),
      footprint: { width: 3, depth: 3, unit: "m" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/need at least/);
    expect(textOf(result)).toMatch(/leave it out and one will be fitted/);
  });

  it("pins an exact room size when one is stated", async () => {
    const data = dataOf(
      await call("create_plan", {
        units: "metric",
        rooms: [
          { program: "kitchen", id: "k", width: 4 },
          { program: "living", id: "l" },
        ],
      }),
    );
    // The pin reaches the generator as an exact width, not a minimum the weights can
    // then argue with. Read off `doc` — the anonymous response drops the duplicate copy
    // that would otherwise sit in `summary.generatorTree` too (see summaryForResponse).
    expect(data.doc.levels[0].generator.tree.children[0]).toMatchObject({ roomId: "k", exactWidth: 4000 });
    const kitchen = data.summary.rooms.find((r: { roomId: string }) => r.roomId === "k");
    expect(kitchen.approxAreaMm2 / data.summary.boundary.depthMm).toBeCloseTo(4000, -2);
  });

  it("refuses a size it would have to drop, rather than dropping it", async () => {
    // Without an id there is nothing for the pin to attach to before the reducer runs;
    // accepting the number and ignoring it would leave the agent describing a room size
    // the plan never got.
    const result = await call("create_plan", { rooms: [{ program: "kitchen", width: 12 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/needs its own `id` and a count of 1/);
  });

  it("rejects a direction that is not one of the five", async () => {
    const result = await call("create_plan", {
      rooms: [{ program: "kitchen", id: "k" }, { program: "living", adjacentTo: "k", direction: "north" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is not one of left, right, above, below, inside/);
  });

  it("rejects an unknown program by name", async () => {
    const result = await call("create_plan", { rooms: [{ program: "wine-cellar" }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/list_programs/);
  });

  it("refuses a level past the 40-room cap (MCP-3)", async () => {
    const result = await call("create_plan", { rooms: [{ program: "closet", count: 41 }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/caps a level at 40 rooms/);
  });
});

describe("describe_plan", () => {
  it("round-trips the document a previous call returned", async () => {
    const created = dataOf(await call("create_plan", HOUSE));
    const described = dataOf(await call("describe_plan", { doc: created.doc }));
    expect(described.summary.rooms.map((r: { name: string }) => r.name)).toEqual(
      created.summary.rooms.map((r: { name: string }) => r.name),
    );
    expect(described.summary.boundary).toEqual(created.summary.boundary);
  });

  it("gives the exterior wall ids an exterior door needs", async () => {
    const created = dataOf(await call("create_plan", HOUSE));
    const described = dataOf(await call("describe_plan", { doc: created.doc }));
    expect(described.exteriorWalls.length).toBeGreaterThan(0);
    for (const wall of described.exteriorWalls) {
      expect(["top", "right", "bottom", "left"]).toContain(wall.side);
      expect(wall.lengthMm).toBeGreaterThan(0);
    }
    expect(described.mode).toBe("slicing");
    expect(described.allowedOps).toContain("addRoom");
  });

  it("reports a freeform level's reduced vocabulary", async () => {
    const doc = seedDoc([
      { op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1 },
      { op: "addRoom", roomId: "l", program: "living", areaWeight: 1 },
    ]);
    const detached = applyPatch(doc, { ops: [{ op: "detachGenerator" }], source: "user" });
    if (!detached.ok) throw new Error("fixture failed");
    const described = dataOf(await call("describe_plan", { doc: JSON.parse(exportJson(detached.doc)) }));
    expect(described.mode).toBe("freeform");
    expect(described.allowedOps).not.toContain("addRoom");
    expect(described.allowedOps).toContain("addOpening");
  });

  it("asks for a plan when given neither", async () => {
    const result = await call("describe_plan", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Pass `doc`/);
  });
});

describe("apply_patch", () => {
  it("applies an edit and hands back the updated document", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen", id: "k" }] }));
    const patched = dataOf(
      await call("apply_patch", {
        doc: created.doc,
        patch: { ops: [{ op: "addRoom", program: "office", name: "Study" }], narration: "Added a study." },
      }),
    );
    expect(patched.summary.rooms.map((r: { name: string }) => r.name)).toContain("Study");
    // The document passed in is untouched: state travels in arguments (MCP-6).
    expect(created.doc.levels[0].graph.rooms.k).toBeDefined();
    expect(Object.keys(created.doc.levels[0].graph.rooms)).toHaveLength(1);
    // apply_patch's response carries the same doc-vs-summary duplication rule create_plan's does.
    expect(patched.summary).not.toHaveProperty("generatorTree");
    expect(patched.doc.levels[0].generator.tree).toBeDefined();
  });

  it("reports what changed in words as well as structure (MCP-11)", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen", id: "k" }, { program: "living", id: "l" }] }));
    const result = await call("apply_patch", { doc: created.doc, patch: { ops: [{ op: "swapRooms", roomIdA: "k", roomIdB: "l" }] } });
    expect(textOf(result)).toMatch(/Swapped/i);
    expect(dataOf(result).changes.length).toBeGreaterThan(0);
  });

  it("refuses an op outside the vocabulary and says which are allowed", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen", id: "k" }] }));
    const result = await call("apply_patch", {
      doc: created.doc,
      // A geometry op the canvas produces: a model never places coordinates (§1.2).
      patch: { ops: [{ op: "setLabelAnchor", roomId: "k", x: 10, y: 10 }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not in the allowed vocabulary/);
    expect(textOf(result)).toMatch(/addRoom/);
  });

  it("is all-or-nothing: one bad op rejects the patch", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen", id: "k" }] }));
    const result = await call("apply_patch", {
      doc: created.doc,
      patch: { ops: [{ op: "addRoom", program: "office" }, { op: "removeRoom", roomId: "nonexistent" }] },
    });
    expect(result.isError).toBe(true);
    const after = dataOf(await call("describe_plan", { doc: created.doc }));
    expect(after.summary.rooms).toHaveLength(1);
  });

  it("passes solver warnings through instead of hiding an unmet pin", async () => {
    const created = dataOf(await call("create_plan", { units: "metric", rooms: [{ program: "kitchen", id: "k" }, { program: "living", id: "l" }] }));
    const result = await call("apply_patch", {
      doc: created.doc,
      patch: { ops: [{ op: "setDimension", roomId: "k", dimensionType: "depth", value: 3000 }] },
    });
    // A pin the layout cannot honour is a caveat about the result, not a reason to
    // refuse the edit — and the caveat has to reach the agent, or it will narrate a
    // 1 m kitchen that does not exist.
    expect(result.isError).toBeUndefined();
    const warnings = dataOf(result).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Kitchen came out .* not the .* asked for/);
    expect(textOf(result)).toContain(warnings[0]);
  });

  it("requires a patch", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }] }));
    const result = await call("apply_patch", { doc: created.doc });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/`patch` is required/);
  });

  it("nests a room in a corner of another, switching the level to freeform (FR-11)", async () => {
    const created = dataOf(
      await call("create_plan", { footprint: { width: 20, depth: 20, unit: "ft" }, rooms: [{ program: "living", id: "living" }] }),
    );
    const result = await call("apply_patch", {
      doc: created.doc,
      patch: { ops: [{ op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" }] },
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/Added Closet inside Living.*L-shaped.*freeform/);

    const data = dataOf(result);
    const described = dataOf(await call("describe_plan", { doc: data.doc }));
    expect(described.mode).toBe("freeform");
    // A freeform level has no tree to restructure — nestRoom is one of the few ops that
    // still applies to it.
    expect(described.allowedOps).not.toContain("addRoom");
    expect(described.allowedOps).toContain("nestRoom");
    expect(data.summary.rooms.map((r: { name: string }) => r.name).sort()).toEqual(["Closet", "Living"]);
  });

  it("sizes a nested room from constraints, in millimetres", async () => {
    const created = dataOf(
      await call("create_plan", { footprint: { width: 20, depth: 20, unit: "ft" }, rooms: [{ program: "living", id: "living" }] }),
    );
    const result = await call("apply_patch", {
      doc: created.doc,
      patch: {
        ops: [
          { op: "nestRoom", hostRoomId: "living", roomId: "bath", program: "bath", constraints: { width: { exact: 1600 }, depth: { exact: 2200 } } },
        ],
      },
    });
    const bath = dataOf(result).summary.rooms.find((r: { roomId: string }) => r.roomId === "bath");
    expect(bath.approxAreaMm2).toBe(1600 * 2200);
  });

  it("rejects nesting a room too big for its host with an actionable reason", async () => {
    // A single room always fills its whole boundary exactly, so pinning the footprint to
    // the closet's own minimum leaves nothing smaller to carve a second closet from.
    const created = dataOf(
      await call("create_plan", { footprint: { width: 610, depth: 610, unit: "mm" }, rooms: [{ program: "closet", id: "closet" }] }),
    );
    const result = await call("apply_patch", {
      doc: created.doc,
      patch: { ops: [{ op: "nestRoom", hostRoomId: "closet", program: "closet" }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/wouldn't leave any of|too little floor/);
  });
});

describe("validate_plan", () => {
  it("calls a door-less plan valid but says what is missing", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }, { program: "living" }] }));
    const result = await call("validate_plan", { doc: created.doc });
    const data = dataOf(result);
    expect(data.valid).toBe(true);
    expect(data.violations[0].reason).toBe("missing-egress");
    expect(textOf(result)).toMatch(/No doors have been placed yet/);
  });

  it("fails a plan whose rooms cannot be reached", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen", id: "k" }, { program: "living", id: "l" }] }));
    const patched = dataOf(
      await call("apply_patch", { doc: created.doc, patch: { ops: [{ op: "addOpening", betweenRooms: ["k", "l"], kind: "door" }] } }),
    );
    const data = dataOf(await call("validate_plan", { doc: patched.doc }));
    expect(data.valid).toBe(false);
    expect(data.violations.map((v: { reason: string }) => v.reason)).toContain("missing-egress");
  });
});

describe("render_svg", () => {
  it("returns the drawing as a resource with a summary line", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }] }));
    const result = await call("render_svg", { doc: created.doc, options: { showLegend: false, targetWidthPx: 640 } });
    const resource = resourceOf(result);
    expect(resource?.mimeType).toBe("image/svg+xml");
    expect(resource?.text).toMatch(/^<svg/);
    expect(resource?.text).toContain('width="640"');
    expect(textOf(result)).toMatch(/SVG attached as floorcraft:\/\//);
  });

  it("defaults to a width that fits a chat panel rather than a full canvas", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }] }));
    const resource = resourceOf(await call("render_svg", { doc: created.doc }));
    // Not the app's own canvas default (900/1100) — this host is narrower.
    expect(resource?.text).toContain('width="480"');
    expect(resource?.text).toMatch(/height="[\d.]+"/);
  });

  it("rejects a width outside the sane range rather than emitting something unusable", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }] }));
    const tooSmall = await call("render_svg", { doc: created.doc, options: { targetWidthPx: 10 } });
    const tooBig = await call("render_svg", { doc: created.doc, options: { targetWidthPx: 100_000 } });
    expect(tooSmall.isError).toBe(true);
    expect(tooBig.isError).toBe(true);
    expect(textOf(tooSmall)).toMatch(/between 120 and 2400/);
  });
});

describe("export_plan", () => {
  it("exports JSON that reimports as the same plan (MCP-13)", async () => {
    const created = dataOf(await call("create_plan", HOUSE));
    const result = await call("export_plan", { doc: created.doc, format: "json" });
    const exported = resourceOf(result)!;
    expect(exported.mimeType).toBe("application/json");
    const reimported = importJson(exported.text);
    expect(reimported.ok).toBe(true);
    if (reimported.ok) expect(Object.keys(reimported.doc.levels[0]!.graph.rooms)).toHaveLength(4);
  });

  it("exports DXF and IFC as inline text", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }, { program: "living" }] }));
    const dxf = resourceOf(await call("export_plan", { doc: created.doc, format: "dxf" }))!;
    expect(dxf.text).toContain("SECTION");
    expect(dxf.uri).toMatch(/\.dxf$/);
    const ifc = resourceOf(await call("export_plan", { doc: created.doc, format: "ifc" }))!;
    expect(ifc.text).toMatch(/^ISO-10303-21;/);
  });

  it("names the formats it has, and where the binary ones live", async () => {
    const created = dataOf(await call("create_plan", { rooms: [{ program: "kitchen" }] }));
    const result = await call("export_plan", { doc: created.doc, format: "pdf" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/PDF and glTF are binary and stay in the web app/);
  });
});

describe("list_programs", () => {
  it("lists every program with the clearances the solver enforces", async () => {
    const result = await call("list_programs", {});
    const data = dataOf(result);
    const kitchen = data.programs.find((p: { program: string }) => p.program === "kitchen");
    expect(kitchen).toEqual({ program: "kitchen", minWidthMm: 2440, minDepthMm: 2440, defaultAreaWeight: 1.2 });
    expect(data.openingKinds).toContain("door");
    expect(textOf(result)).toMatch(/min 2440 x 2440/);
  });
});

describe("saved plans (MCP-7)", () => {
  const EDIT = "edit-token-abcdefghijklmnop";
  const SHARE = "share-token-abcdefghijklmnop";

  async function envWithPlan(doc: PlanDocument = seedDoc([{ op: "addRoom", roomId: "k", program: "kitchen", areaWeight: 1 }])) {
    const rows = { "plan-1": await storedPlan("plan-1", exportJson(doc), EDIT, SHARE) };
    return { env: makeEnv({ DB: fakeDb(rows) as never }), rows };
  }

  it("refuses a planId with no bearer token", async () => {
    const { env } = await envWithPlan();
    const result = await call("describe_plan", { planId: "plan-1" }, { env });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Authorization: Bearer/);
  });

  it("does not confirm a plan id to a caller with the wrong token", async () => {
    const { env } = await envWithPlan();
    const wrong = await call("describe_plan", { planId: "plan-1" }, { env, bearer: "not-the-token" });
    const missing = await call("describe_plan", { planId: "no-such-plan" }, { env, bearer: EDIT });
    expect(wrong.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(textOf(wrong).replace("plan-1", "X")).toBe(textOf(missing).replace("no-such-plan", "X"));
  });

  it("reads with a share token but will not write with one", async () => {
    const { env } = await envWithPlan();
    const read = await call("describe_plan", { planId: "plan-1" }, { env, bearer: SHARE });
    expect(read.isError).toBeUndefined();
    const write = await call("apply_patch", { planId: "plan-1", patch: { ops: [{ op: "renameRoom", roomId: "k", name: "Galley" }] } }, { env, bearer: SHARE });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/read-only/);
  });

  it("writes an edit back to the stored plan and links to the web app (MCP-13)", async () => {
    const { env, rows } = await envWithPlan();
    const result = await call(
      "apply_patch",
      { planId: "plan-1", patch: { ops: [{ op: "renameRoom", roomId: "k", name: "Galley" }] } },
      { env, bearer: EDIT },
    );
    const data = dataOf(result);
    expect(data.planId).toBe("plan-1");
    expect(data.webUrl).toBe(`https://floorcraft.example/?plan=plan-1&t=${EDIT}`);
    expect(data.doc).toBeUndefined();
    // The stored document is a complete one the web app can open, not the compact
    // transport form.
    const stored = importJson(rows["plan-1"]!.doc);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.doc.levels[0]!.graph.rooms.k!.name).toBe("Galley");
      expect(Object.keys(stored.doc.levels[0]!.graph.nodes).length).toBeGreaterThan(0);
    }
  });

  it("replaces a saved plan's contents when create_plan names it", async () => {
    const { env, rows } = await envWithPlan();
    const result = await call("create_plan", { planId: "plan-1", title: "Rebuilt", rooms: [{ program: "garage" }] }, { env, bearer: EDIT });
    expect(dataOf(result).planId).toBe("plan-1");
    const stored = importJson(rows["plan-1"]!.doc);
    if (!stored.ok) throw new Error(stored.error);
    expect(stored.doc.title).toBe("Rebuilt");
    expect(Object.values(stored.doc.levels[0]!.graph.rooms).map((r) => r.program)).toEqual(["garage"]);
  });

  it("keeps the generator tree in the summary for a saved plan, which never gets `doc` back", async () => {
    const { env } = await envWithPlan();
    const data = dataOf(await call("create_plan", { planId: "plan-1", rooms: [{ program: "garage" }] }, { env, bearer: EDIT }));
    expect(data.doc).toBeUndefined();
    expect(data.summary.generatorTree).toBeDefined();
  });

  it("takes the token from the connector URL when a host cannot send a header", async () => {
    const { env, rows } = await envWithPlan();
    // Claude Desktop and claude.ai take a URL, not a custom header, so `?t=` has to be
    // as good as `Authorization: Bearer` — including for writes.
    const result = await call(
      "apply_patch",
      { planId: "plan-1", patch: { ops: [{ op: "renameRoom", roomId: "k", name: "Galley" }] } },
      { env, urlToken: EDIT },
    );
    expect(result.isError).toBeUndefined();
    expect(dataOf(result).webUrl).toContain("plan-1");
    expect(rows["plan-1"]!.doc).toContain("Galley");
  });

  it("prefers the Authorization header when both are present", async () => {
    const { env } = await envWithPlan();
    const result = await call("describe_plan", { planId: "plan-1" }, { env, bearer: SHARE, urlToken: "junk" });
    expect(result.isError).toBeUndefined();
  });

  it("rejects a plan and a document supplied together", async () =>{
    const { env } = await envWithPlan();
    const result = await call("describe_plan", { planId: "plan-1", doc: seedDoc() }, { env, bearer: EDIT });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not both/);
  });
});
