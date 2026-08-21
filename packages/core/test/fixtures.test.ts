// Phase 1 exit criterion: zero invalid geometry across the full prompt fixture set.
// Runs all 20 fixture prompts (fixtures/prompts.ts) as chained patches and asserts
// every step solves with well-formed, non-degenerate room polygons.

import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyPlan } from "../src/patch.js";
import { polygonFromBoundary } from "../src/wallGraph.js";
import { PROMPT_FIXTURES } from "../fixtures/prompts.js";

describe("20-prompt fixture set", () => {
  for (const scenario of PROMPT_FIXTURES) {
    it(`scenario "${scenario.name}" solves every step with valid, non-degenerate geometry`, () => {
      let doc = createEmptyPlan({ id: scenario.name, title: scenario.name, units: "imperial", boundary: scenario.boundary });

      for (const step of scenario.steps) {
        const result = applyPatch(doc, { ops: step.ops, source: "user" });
        expect(result.ok, `step "${step.utterance}" failed: ${!result.ok ? JSON.stringify(result.violations ?? result.errors) : ""}`).toBe(
          true,
        );
        if (!result.ok) continue;
        doc = result.doc;

        const level = doc.levels.find((l) => l.id === doc.activeLevelId)!;
        for (const [roomId, room] of Object.entries(level.graph.rooms)) {
          const pts = polygonFromBoundary(level.graph, room.boundary);
          expect(pts.length, `room ${roomId} after "${step.utterance}" has a degenerate boundary`).toBeGreaterThanOrEqual(3);
          let area = 0;
          for (let i = 0; i < pts.length; i++) {
            const p0 = pts[i]!;
            const p1 = pts[(i + 1) % pts.length]!;
            area += p0.x * p1.y - p1.x * p0.y;
          }
          area = Math.abs(area) / 2;
          expect(area, `room ${roomId} after "${step.utterance}" has non-positive area`).toBeGreaterThan(0);
          for (const p of pts) {
            expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
          }
        }
      }
    });
  }

  it("covers 20 prompts total", () => {
    const total = PROMPT_FIXTURES.reduce((sum, s) => sum + s.steps.length, 0);
    expect(total).toBe(20);
  });
});
