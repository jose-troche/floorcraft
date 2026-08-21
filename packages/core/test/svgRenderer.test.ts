import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { formatLength, renderSvg } from "../src/svgRenderer.js";

function samplePlan() {
  const doc = createEmptyPlan({ id: "p1", title: "My House", units: "imperial", boundary: { widthMm: 9144, depthMm: 12192 } });
  const r1 = applyPatch(doc, { ops: [{ op: "addRoom", roomId: "kitchen", program: "kitchen", name: "Kitchen", areaWeight: 1 }], source: "user" });
  if (!r1.ok) throw new Error("setup");
  const r2 = applyPatch(r1.doc, {
    ops: [{ op: "addRoom", roomId: "living", program: "living", name: "Living Room", areaWeight: 1.5 }],
    source: "user",
  });
  if (!r2.ok) throw new Error("setup");
  return r2.doc;
}

describe("renderSvg", () => {
  it("produces well-formed SVG with title, room labels, and no unresolved coordinates", () => {
    const svg = renderSvg(samplePlan());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<title>My House</title>");
    expect(svg).toContain("Kitchen");
    expect(svg).toContain("Living Room");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });

  it("includes a legend swatch per program in use", () => {
    const svg = renderSvg(samplePlan(), { showLegend: true });
    expect(svg).toContain("kitchen");
    expect(svg).toContain("living");
  });
});

describe("formatLength", () => {
  it("formats imperial as feet-inches", () => {
    expect(formatLength(3657.6, "imperial")).toBe("12'-0\"");
  });
  it("formats metric as meters", () => {
    expect(formatLength(3660, "metric")).toBe("3.66 m");
  });
});
