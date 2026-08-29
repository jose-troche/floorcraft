import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { formatLength, renderSvg } from "../src/svgRenderer.js";
import { goldenPlan } from "./fixtures/plan.js";

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
  it("gives the root element an explicit height matching the viewBox aspect ratio, not just width", () => {
    const svg = renderSvg(samplePlan(), { targetWidthPx: 600 });
    const [vbW, vbH] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!.slice(1, 3).map(Number);
    const width = Number(svg.match(/width="([\d.]+)"/)![1]);
    const height = Number(svg.match(/height="([\d.]+)"/)![1]);
    // A host previewing this as a plain <img> needs both dimensions up front to lay out
    // around, not just a width with an ambiguous height.
    expect(width).toBe(600);
    expect(height).toBeCloseTo((600 * vbH!) / vbW!, 0);
  });

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

describe("renderSvg — Phase 2 canvas and symbols", () => {
  function planWithOpenings() {
    const doc = goldenPlan();
    return doc;
  }

  it("draws a door as a leaf plus swing arc and a window as glazing lines", () => {
    const svg = renderSvg(planWithOpenings());
    expect(svg).toContain('data-opening-kind="door"');
    expect(svg).toContain('data-opening-kind="window"');
    expect(svg).toMatch(/<path d="M [\d.-]+ [\d.-]+ A /); // swing arc
  });

  it("labels every wall run, not just the outer boundary (FR-8)", () => {
    const svg = renderSvg(planWithOpenings());
    const dims = [...svg.matchAll(/class="fc-dim">([^<]+)</g)].map((m) => m[1]);
    expect(dims.length).toBeGreaterThan(4);
    // Interior partitions get a string too, so a wall drag has a number to update.
    expect(new Set(dims).size).toBeGreaterThan(1);
  });

  it("marks rooms whose dimensions are pinned (DIM-7)", () => {
    const withPin = renderSvg(planWithOpenings());
    expect(withPin).toContain("#fdf0f0"); // the lock glyph's body fill

    const noPins = applyPatch(planWithOpenings(), {
      ops: [{ op: "clearDimension", roomId: "bath", dimensionType: "width" }],
      source: "user",
    });
    if (!noPins.ok) throw new Error("setup");
    expect(renderSvg(noPins.doc)).not.toContain("#fdf0f0");
  });

  it("emits drag targets only when interactive, keeping exports clean", () => {
    const canvas = renderSvg(planWithOpenings(), { interactive: true });
    expect(canvas).toContain('data-drag="wall"');
    expect(canvas).toContain('data-drag="opening"');
    expect(canvas).toContain('data-drag="label"');
    expect(canvas).toContain('data-drag="boundary"');
    expect(canvas).toContain('tabindex="0"'); // keyboard operable (NFR-6)

    const exported = renderSvg(planWithOpenings());
    expect(exported).not.toContain("data-drag");
    expect(exported).not.toContain("tabindex");
  });

  it("does not offer a drag handle on an exterior wall", () => {
    const canvas = renderSvg(planWithOpenings(), { interactive: true });
    const doc = planWithOpenings();
    const level = doc.levels[0]!;
    for (const [edgeId, edge] of Object.entries(level.graph.edges)) {
      if (edge.type !== "exterior") continue;
      expect(canvas).not.toContain(`data-drag="wall" data-edge-id="${edgeId}"`);
    }
  });

  it("shows the current selection", () => {
    const doc = planWithOpenings();
    const edgeId = Object.entries(doc.levels[0]!.graph.edges).find(([, e]) => e.type === "interior")![0];
    const svg = renderSvg(doc, { interactive: true, selection: { kind: "wall", id: edgeId } });
    expect(svg).toContain(`stroke="#0072B2" stroke-width=`);
  });
});

describe("formatLength", () => {
  it("formats imperial as feet-inches", () => {
    expect(formatLength(3657.6, "imperial")).toBe("12'-0\"");
  });
  it("formats metric as meters", () => {
    expect(formatLength(3660, "metric")).toBe("3.66 m");
  });
  it("carries a rounded-up 12 inches into the feet", () => {
    // 6704mm is 21'-11.94" — it must not print as 21'-12".
    expect(formatLength(6704, "imperial")).toBe("22'-0\"");
  });
});
