import { describe, expect, it } from "vitest";
import { exportPdf } from "../src/pdfExport.js";
import { goldenPlan } from "./fixtures/plan.js";

function asText(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

describe("exportPdf", () => {
  const bytes = exportPdf(goldenPlan());
  const text = asText(bytes);

  it("produces a structurally valid PDF", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("/BaseFont /Helvetica");
  });

  it("writes a cross-reference table whose offsets land on their objects", () => {
    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const xrefBody = text.slice(startxref);
    const entries = [...xrefBody.matchAll(/^(\d{10}) (\d{5}) n $/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(5);
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + 8)).toContain(`${i + 1} 0 obj`);
    });
  });

  it("declares a stream length that matches the bytes it contains", () => {
    const declared = Number(/<< \/Length (\d+) >>/.exec(text)![1]);
    const start = text.indexOf("stream\n") + "stream\n".length;
    const end = text.indexOf("\nendstream");
    expect(end - start).toBe(declared);
  });

  it("carries the title block, scale bar and unit system (FR-18)", () => {
    expect(text).toContain("(Golden Fixture)");
    expect(text).toContain("units: imperial");
    expect(text).toContain("Floorcraft");
    expect(text).toMatch(/\(1 : \d+\)/); // scale ratio
  });

  it("draws each room's name and area", () => {
    for (const name of ["Living Room", "Kitchen", "Bedroom", "Bath"]) {
      expect(text).toContain(`(${name})`);
    }
    expect(text).toContain("sq ft");
  });

  it("honours paper size and orientation", () => {
    const a4Landscape = asText(exportPdf(goldenPlan(), { paperSize: "A4", orientation: "landscape" }));
    const a3Portrait = asText(exportPdf(goldenPlan(), { paperSize: "A3", orientation: "portrait" }));
    expect(a4Landscape).toContain("/MediaBox [0 0 841.89 595.28]");
    expect(a3Portrait).toContain("/MediaBox [0 0 841.89 1190.55]");
  });

  it("keeps every drawn coordinate on the page", () => {
    const content = text.slice(text.indexOf("stream\n"), text.indexOf("\nendstream"));
    const numbers = [...content.matchAll(/(-?\d+\.\d+) (-?\d+\.\d+) (?:m|l)$/gm)];
    expect(numbers.length).toBeGreaterThan(0);
    for (const match of numbers) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(-1);
      expect(Number(match[1])).toBeLessThanOrEqual(842);
      expect(Number(match[2])).toBeGreaterThanOrEqual(-1);
      expect(Number(match[2])).toBeLessThanOrEqual(596);
    }
  });

  it("escapes text that would otherwise break a PDF string", () => {
    const doc = goldenPlan();
    const tricky = { ...doc, title: "Plan (draft) \\ v2" };
    const out = asText(exportPdf(tricky));
    expect(out).toContain("(Plan \\(draft\\) \\\\ v2)");
  });
});
