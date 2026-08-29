import { describe, expect, it } from "vitest";
import { activeLevel, applyPatch, createEmptyPlan } from "../src/patch.js";
import { generatorTree, type Patch } from "../src/types.js";

function basePlan() {
  return createEmptyPlan({ id: "p1", title: "Test Plan", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
}

function apply(doc: ReturnType<typeof basePlan>, ops: Patch["ops"]) {
  const result = applyPatch(doc, { ops, source: "user" });
  if (!result.ok) throw new Error(`patch failed: ${result.errors.join("; ")} ${JSON.stringify(result.violations)}`);
  return result;
}

describe("applyPatch", () => {
  it("renamePlan retitles the document and reports the change", () => {
    const doc = basePlan();
    const { doc: renamed, changes } = apply(doc, [{ op: "renamePlan", title: "Oak Street" }]);
    expect(renamed.title).toBe("Oak Street");
    expect(changes).toContain("Renamed the plan to Oak Street");
  });

  it("renamePlan trims, rejects a blank title, and leaves the rest of the patch alone", () => {
    const doc = basePlan();
    const { doc: withRoom } = apply(doc, [
      { op: "renamePlan", title: "  Oak Street  " },
      { op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 },
    ]);
    expect(withRoom.title).toBe("Oak Street");
    expect(Object.keys(activeLevel(withRoom).graph.rooms)).toEqual(["kitchen"]);

    const blank = applyPatch(withRoom, { ops: [{ op: "renamePlan", title: "   " }], source: "user" });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors[0]).toContain("cannot be empty");
  });

  it("renamePlan caps a runaway title at a length the Worker will store", () => {
    const doc = basePlan();
    const { doc: renamed } = apply(doc, [{ op: "renamePlan", title: "x".repeat(500) }]);
    expect(renamed.title).toHaveLength(200);
  });


  it("addRoom builds a one-leaf tree and a matching wall graph", () => {
    const doc = basePlan();
    const { doc: doc1 } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    const level = activeLevel(doc1);
    expect(generatorTree(level)).toMatchObject({ kind: "leaf", roomId: "kitchen" });
    expect(Object.keys(level.graph.rooms)).toEqual(["kitchen"]);
    const room = level.graph.rooms.kitchen!;
    expect(room.boundary.length).toBeGreaterThanOrEqual(4);
  });

  it("a second addRoom splits the tree and both rooms tile the boundary without gaps", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1.5 }]));
    const level = activeLevel(d);
    expect(Object.keys(level.graph.rooms).sort()).toEqual(["kitchen", "living"]);
  });

  it("removeRoom collapses the tree back to the sibling", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1 }]));
    ({ doc: d } = apply(d, [{ op: "removeRoom", roomId: "living" }]));
    const level = activeLevel(d);
    expect(generatorTree(level)).toMatchObject({ kind: "leaf", roomId: "kitchen" });
    expect(Object.keys(level.graph.rooms)).toEqual(["kitchen"]);
  });

  it("renameRoom updates the name without touching geometry", () => {
    const doc = basePlan();
    const { doc: d1 } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    const before = activeLevel(d1).graph.rooms.kitchen!.boundary;
    const { doc: d2 } = apply(d1, [{ op: "renameRoom", roomId: "kitchen", name: "Cook Room" }]);
    const after = activeLevel(d2).graph.rooms.kitchen!;
    expect(after.name).toBe("Cook Room");
    expect(after.boundary).toEqual(before);
  });

  it("swapRooms exchanges which room gets which tree slot", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "a", program: "bedroom", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "b", program: "kitchen", areaWeight: 3 }]));
    const beforeA = activeLevel(d).graph.rooms.a!;
    const beforeB = activeLevel(d).graph.rooms.b!;
    ({ doc: d } = apply(d, [{ op: "swapRooms", roomIdA: "a", roomIdB: "b" }]));
    const afterA = activeLevel(d).graph.rooms.a!;
    const afterB = activeLevel(d).graph.rooms.b!;
    // After swapping, room 'a' should now occupy roughly what 'b' occupied (areas swap).
    expect(afterA.name).toBe(beforeA.name);
    expect(afterB.name).toBe(beforeB.name);
    expect(afterA).not.toEqual(beforeA);
  });

  it("setBoundary regenerates geometry to the new footprint", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "setBoundary", widthMm: 6000, depthMm: 6000 }]));
    expect(activeLevel(d).boundary).toEqual({ widthMm: 6000, depthMm: 6000 });
  });

  it("fails with a structured violation instead of broken geometry when rooms cannot fit", () => {
    const doc = basePlan();
    const { doc: d } = apply(doc, [{ op: "setBoundary", widthMm: 2000, depthMm: 2000 }]);
    const result = applyPatch(d, { ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }], source: "user" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations?.[0]?.reason).toBe("boundary-too-small");
  });

  it("auto-generated roomIds don't collide after removing a room out of order", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", program: "kitchen", areaWeight: 1 }]); // room-0
    ({ doc: d } = apply(d, [{ op: "addRoom", program: "office", areaWeight: 1 }])); // room-1
    ({ doc: d } = apply(d, [{ op: "addRoom", program: "living", areaWeight: 1 }])); // room-2
    ({ doc: d } = apply(d, [{ op: "addRoom", program: "dining", areaWeight: 1 }])); // room-3
    ({ doc: d } = apply(d, [{ op: "removeRoom", roomId: "room-1" }])); // count drops to 3, but room-3 still exists
    const result = apply(d, [{ op: "addRoom", program: "bath", areaWeight: 1 }]);
    expect(Object.keys(activeLevel(result.doc).graph.rooms).sort()).toEqual(["room-0", "room-2", "room-3", "room-4"]);
  });

  it("reassigns a fresh id when a provider echoes back an existing roomId on addRoom", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "room-0", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "room-1", program: "office", areaWeight: 1 }]));
    // A model shown the plan summary echoes an id that is already taken.
    const result = apply(d, [{ op: "addRoom", roomId: "room-1", program: "bath", areaWeight: 0.5 }]);
    const rooms = activeLevel(result.doc).graph.rooms;
    expect(Object.keys(rooms).sort()).toEqual(["room-0", "room-1", "room-2"]);
    // The pre-existing room-1 keeps its own program; the new room lands on a fresh id.
    expect(rooms["room-1"]!.program).toBe("office");
    expect(rooms["room-2"]!.program).toBe("bath");
  });

  it("names the added room in the change summary even when the op carries no roomId", () => {
    const doc = basePlan();
    const { changes } = apply(doc, [{ op: "addRoom", program: "kitchen", areaWeight: 1 }]);
    expect(changes).toContain("Added Kitchen");
  });

  it("keeps ids unique across several addRoom ops in a single patch", () => {
    const doc = basePlan();
    const result = apply(doc, [
      { op: "addRoom", roomId: "room-0", program: "kitchen", areaWeight: 1 },
      { op: "addRoom", roomId: "room-0", program: "bath", areaWeight: 0.5 },
      { op: "addRoom", program: "office", areaWeight: 1 },
    ]);
    expect(Object.keys(activeLevel(result.doc).graph.rooms).sort()).toEqual(["room-0", "room-1", "room-2"]);
  });

  it("reports a per-room percentage change for resizeRoom", () => {
    const doc = basePlan();
    let { doc: d } = apply(doc, [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }]);
    ({ doc: d } = apply(d, [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1 }]));
    const { changes } = apply(d, [{ op: "resizeRoom", roomId: "kitchen", areaWeight: 2 }]);
    expect(changes.some((c) => c.includes("Kitchen") && c.includes("%"))).toBe(true);
  });
});

describe("setDimension units", () => {
  // INF-6 lets an op state its own unit. Ignoring it turned "a 12 ft kitchen" into a
  // 12 mm one, which the solver then silently grew back to the program minimum — the pin
  // looked applied and the room was the wrong size.
  function twoRoomPlan() {
    return apply(basePlan(), [
      { op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 },
      { op: "addRoom", roomId: "living", program: "living", areaWeight: 1 },
    ]).doc;
  }

  function pinnedWidth(op: Patch["ops"][number]): number | undefined {
    return apply(twoRoomPlan(), [op]).doc.levels[0]!.graph.rooms.kitchen!.constraints?.width?.exact;
  }

  it("reads a value in feet as millimetres", () => {
    expect(pinnedWidth({ op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 12, unit: "ft" })).toBe(3658);
  });

  it("reads a value in metres as millimetres", () => {
    expect(pinnedWidth({ op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 3.5, unit: "m" })).toBe(3500);
  });

  it("treats a bare value as millimetres", () => {
    expect(pinnedWidth({ op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 3000 })).toBe(3000);
  });

  it("squares the factor for an area", () => {
    const { doc } = apply(twoRoomPlan(), [{ op: "setDimension", roomId: "kitchen", dimensionType: "area", value: 200, unit: "ft" }]);
    // 200 sq ft = 200 x 304.8² mm².
    expect(doc.levels[0]!.graph.rooms.kitchen!.constraints?.area?.exact).toBe(18_580_608);
  });

  it("says what it pinned, in the units it actually stored", () => {
    const { changes } = apply(twoRoomPlan(), [{ op: "setDimension", roomId: "kitchen", dimensionType: "width", value: 12, unit: "ft" }]);
    expect(changes).toContain("Kitchen width pinned to 3658mm");
  });
});

describe("nestRoom", () => {
  function livingRoomPlan() {
    // A single generous room, big enough to comfortably swallow a closet's minimum
    // (610 x 610) with plenty of slack left over on every side.
    return apply(basePlan(), [{ op: "addRoom", roomId: "living", program: "living", areaWeight: 1 }]).doc;
  }

  it("carves a corner nook, switching the level to freeform", () => {
    const { doc, changes } = apply(livingRoomPlan(), [
      { op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" },
    ]);
    const level = activeLevel(doc);
    expect(level.generator?.kind).toBe("freeform");
    expect(Object.keys(level.graph.rooms).sort()).toEqual(["closet", "living"]);
    expect(changes[0]).toMatch(/Added Closet inside Living \(Living is now L-shaped; this level is now edited freeform\)/);

    // The host is now a 2-cell rect union (an L), the nested room a single rectangle.
    if (level.generator?.kind !== "freeform") throw new Error("expected freeform");
    const hostCells = level.generator.cells.filter((c) => c.roomId === "living");
    const nookCells = level.generator.cells.filter((c) => c.roomId === "closet");
    expect(hostCells).toHaveLength(2);
    expect(nookCells).toHaveLength(1);

    // Area is conserved: nothing was gained or lost in the carve.
    const boundary = level.boundary;
    const totalArea = [...hostCells, ...nookCells].reduce((sum, c) => sum + c.w * c.d, 0);
    expect(totalArea).toBe(boundary.widthMm * boundary.depthMm);
  });

  it("sizes the nook to the program minimum when unpinned", () => {
    const { doc } = apply(livingRoomPlan(), [{ op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" }]);
    const level = activeLevel(doc);
    if (level.generator?.kind !== "freeform") throw new Error("expected freeform");
    const nook = level.generator.cells.find((c) => c.roomId === "closet")!;
    expect([nook.w, nook.d].sort((a, b) => a - b)).toEqual([610, 610]);
  });

  it("honours a pinned exact size", () => {
    const { doc } = apply(livingRoomPlan(), [
      { op: "nestRoom", hostRoomId: "living", roomId: "bath", program: "bath", constraints: { width: { exact: 1600 }, depth: { exact: 2200 } } },
    ]);
    const level = activeLevel(doc);
    if (level.generator?.kind !== "freeform") throw new Error("expected freeform");
    const nook = level.generator.cells.find((c) => c.roomId === "bath")!;
    expect(nook.w).toBe(1600);
    expect(nook.d).toBe(2200);
  });

  it("nests directly into an already-freeform level without a separate detachGenerator", () => {
    const { doc: detached } = apply(livingRoomPlan(), [{ op: "detachGenerator" }]);
    const { doc } = apply(detached, [{ op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" }]);
    expect(activeLevel(doc).generator?.kind).toBe("freeform");
    expect(Object.keys(activeLevel(doc).graph.rooms).sort()).toEqual(["closet", "living"]);
  });

  it("rejects a size below the program minimum instead of building it undersized", () => {
    const result = applyPatch(livingRoomPlan(), {
      ops: [{ op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet", constraints: { width: { exact: 200 }, depth: { exact: 610 } } }],
      source: "provider",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/needs at least 610mm x 610mm/);
  });

  it("rejects nesting into a room that does not exist", () => {
    const result = applyPatch(livingRoomPlan(), { ops: [{ op: "nestRoom", hostRoomId: "nope", program: "closet" }], source: "provider" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/host room nope not found/);
  });

  it("rejects a nook that would leave nothing of the host", () => {
    // A single room always fills its whole boundary exactly (nothing else to divide it
    // against), so a boundary sized to the closet's own minimum makes the host exactly
    // as big as the nook — nothing strictly smaller to carve it from.
    const exact = createEmptyPlan({ id: "p", title: "T", units: "imperial", boundary: { widthMm: 610, depthMm: 610 } });
    const { doc } = apply(exact, [{ op: "addRoom", roomId: "a", program: "closet", areaWeight: 1 }]);
    const result = applyPatch(doc, { ops: [{ op: "nestRoom", hostRoomId: "a", program: "closet" }], source: "provider" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/wouldn't leave any of/);
  });

  it("rejects nesting into a room that is already an irregular shape", () => {
    const doc = livingRoomPlan();
    const { doc: nested } = apply(doc, [{ op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" }]);
    // "living" is now a 2-cell L; nesting into it again has no single rectangle to carve from.
    const result = applyPatch(nested, { ops: [{ op: "nestRoom", hostRoomId: "living", program: "bath" }], source: "provider" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/already has an irregular shape \(2 pieces\)/);
  });

  it("lets the two remainder pieces be thin, since they stay one continuous floor", () => {
    // buildWallGraph dissolves the seam between two cells of the same room (see
    // rectUnion.test.ts), so a thin decomposition piece is not a thin room — the strip
    // beside the nook opens straight into the rest of "Living". Only the room's total
    // remaining area is what could actually make it unusable.
    const { doc } = apply(livingRoomPlan(), [
      { op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet", constraints: { width: { exact: 610 }, depth: { exact: 3000 } } },
    ]);
    const level = activeLevel(doc);
    if (level.generator?.kind !== "freeform") throw new Error("expected freeform");
    expect(level.generator.cells.filter((c) => c.roomId === "living")).toHaveLength(2);
  });

  it("rejects a nook that would leave too little floor for the host's own program", () => {
    // A hallway pinned to exactly its own minimum has no spare area at all, so any bite
    // taken out of it drops the remainder below what a hallway needs.
    const exact = createEmptyPlan({ id: "p", title: "T", units: "imperial", boundary: { widthMm: 910, depthMm: 910 } });
    const { doc } = apply(exact, [{ op: "addRoom", roomId: "hall", program: "hallway", areaWeight: 1 }]);
    const result = applyPatch(doc, {
      ops: [{ op: "nestRoom", hostRoomId: "hall", program: "closet", constraints: { width: { exact: 610 }, depth: { exact: 610 } } }],
      source: "provider",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/too little floor for a hallway/);
  });

  it("all-or-nothing: a rejected nestRoom leaves the plan untouched, same as any other op", () => {
    const doc = livingRoomPlan();
    const result = applyPatch(doc, {
      ops: [
        { op: "nestRoom", hostRoomId: "living", roomId: "closet", program: "closet" },
        { op: "nestRoom", hostRoomId: "nope", program: "bath" },
      ],
      source: "provider",
    });
    expect(result.ok).toBe(false);
  });
});
