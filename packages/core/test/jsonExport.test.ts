import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { exportJson, importJson } from "../src/jsonExport.js";

describe("jsonExport / importJson", () => {
  it("round-trips a plan document", () => {
    const doc = createEmptyPlan({ id: "p1", title: "T", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
    const result = applyPatch(doc, { ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", areaWeight: 1 }], source: "user" });
    if (!result.ok) throw new Error("setup");

    const text = exportJson(result.doc);
    const imported = importJson(text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.doc).toEqual(result.doc);
  });

  it("rejects invalid JSON", () => {
    const result = importJson("{not json");
    expect(result.ok).toBe(false);
  });

  it("rejects a document with a newer major schema version", () => {
    const result = importJson(JSON.stringify({ schemaVersion: 99, id: "x", activeLevelId: "l", levels: [] }));
    expect(result.ok).toBe(false);
  });
});
