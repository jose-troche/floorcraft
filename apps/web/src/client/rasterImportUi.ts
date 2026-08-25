// Raster import review panel — specs.md FR-22 (manual scale calibration) and FR-25 (the
// import result is a reviewable draft with per-wall accept/reject, never applied
// silently). Detection itself is rasterPipeline.ts (OpenCV.js) feeding
// packages/core/src/rasterImport.ts's pure pipeline; this file is only the interactive
// review/calibration step between "detected something" and "committed to the plan".

import {
  calibrateScale,
  detectFloorPlan,
  draftToRoomCells,
  rebuildAfterWallReview,
  type ImportDraft,
  type PatchOp,
  type PlanarGraph,
} from "@floorcraft/core";
import { extractLineSegments } from "./rasterPipeline";

type Stage = "pick" | "processing" | "review" | "error";

export class RasterImportPanel {
  readonly element: HTMLElement;

  private stage: Stage = "pick";
  private errorMessage = "";
  private image: HTMLImageElement | null = null;
  private graph: PlanarGraph | null = null;
  private draft: ImportDraft | null = null;
  private rejectedWallIds = new Set<string>();
  private calibrationClicks: { x: number; y: number }[] = [];
  private calibrationMode = false;
  private mmPerPixel: number | null = null;
  private levelName = "Imported Level";

  constructor(
    private onImport: (ops: PatchOp[]) => void,
    private onClose: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "raster-import-panel";
    this.render();
  }

  private setStage(stage: Stage, error = ""): void {
    this.stage = stage;
    this.errorMessage = error;
    this.render();
  }

  private async handleFile(file: File): Promise<void> {
    this.setStage("processing");
    try {
      // FR-20: the source image is never uploaded anywhere. Detection is client-side, so
      // the file is read straight off the local blob URL and only the vectorised result
      // is ever persisted — the scan itself doesn't leave the browser.
      const url = URL.createObjectURL(file);
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not read that image file."));
        image.src = url;
      });
      this.image = image;

      this.setStage("processing");
      const segments = await extractLineSegments(image);
      const { graph, draft } = detectFloorPlan(segments);
      if (draft.rooms.length === 0) {
        this.setStage("error", "No enclosed rooms were detected in this image. Try a clearer, more evenly-lit scan.");
        return;
      }
      this.graph = graph;
      this.draft = draft;
      this.rejectedWallIds = new Set();
      this.calibrationClicks = [];
      this.mmPerPixel = null;
      this.setStage("review");
    } catch (e) {
      this.setStage("error", (e as Error).message || "Import failed.");
    }
  }

  private recomputeAfterReview(): void {
    if (!this.graph) return;
    this.draft = rebuildAfterWallReview(this.graph, this.rejectedWallIds);
    this.render();
  }

  private handleCalibrationClick(x: number, y: number): void {
    this.calibrationClicks.push({ x, y });
    if (this.calibrationClicks.length > 2) this.calibrationClicks = [{ x, y }];
    this.render();
  }

  private commitImport(): void {
    if (!this.draft || !this.mmPerPixel) return;
    const cells = draftToRoomCells(this.draft, this.mmPerPixel);
    const xs = cells.map((c) => c.x + c.w);
    const ys = cells.map((c) => c.y + c.d);
    const boundaryMm = { widthMm: Math.max(1000, ...xs), depthMm: Math.max(1000, ...ys) };
    const rooms = this.draft.rooms.map((r, i) => ({
      roomId: r.roomId,
      program: "other" as const,
      name: `Imported Room ${i + 1}`,
      rects: cells.filter((c) => c.roomId === r.roomId).map(({ x, y, w, d }) => ({ x, y, w, d })),
    }));
    this.onImport([{ op: "importLevel", name: this.levelName, boundaryMm, rooms }]);
  }

  private render(): void {
    this.element.innerHTML = "";
    const header = document.createElement("div");
    header.className = "raster-import-header";
    const title = document.createElement("h2");
    title.textContent = "Import from a floor plan image";
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => this.onClose();
    header.appendChild(closeBtn);
    this.element.appendChild(header);

    if (this.stage === "pick" || this.stage === "error") {
      if (this.stage === "error") {
        const err = document.createElement("div");
        err.className = "error-banner";
        err.textContent = this.errorMessage;
        this.element.appendChild(err);
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void this.handleFile(file);
      };
      this.element.appendChild(input);
      const note = document.createElement("p");
      note.className = "raster-import-note";
      note.textContent =
        "Works best with a top-down scan or photo of a simple, mostly-orthogonal floor plan.";
      this.element.appendChild(note);
      this.element.appendChild(renderPrivacyNote());
      return;
    }

    if (this.stage === "processing") {
      const status = document.createElement("p");
      status.textContent = "Detecting walls and rooms…";
      this.element.appendChild(status);
      // Repeated here because this stage is the slow one (the detection engine is a
      // multi-megabyte download on first use) — it's exactly when someone waiting on a
      // spinner wonders where their floor plan just went.
      this.element.appendChild(renderPrivacyNote());
      return;
    }

    // stage === "review"
    if (!this.image || !this.draft) return;
    this.element.appendChild(this.renderReview(this.image, this.draft));
  }

  private renderReview(image: HTMLImageElement, draft: ImportDraft): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "raster-review";

    const stage = document.createElement("div");
    stage.className = "raster-review-stage";
    stage.style.position = "relative";
    const img = document.createElement("img");
    img.src = image.src;
    img.className = "raster-review-image";
    stage.appendChild(img);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    svg.classList.add("raster-review-overlay");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";

    if (this.graph) {
      for (const edge of Object.values(this.graph.edges)) {
        const a = this.graph.nodes[edge.a]!;
        const b = this.graph.nodes[edge.b]!;
        const rejected = this.rejectedWallIds.has(edge.id);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(a.x));
        line.setAttribute("y1", String(a.y));
        line.setAttribute("x2", String(b.x));
        line.setAttribute("y2", String(b.y));
        line.setAttribute("stroke", rejected ? "#D55E00" : "#0072B2");
        line.setAttribute("stroke-width", "4");
        line.setAttribute("stroke-dasharray", rejected ? "6 4" : "none");
        line.style.cursor = "pointer";
        line.setAttribute("aria-label", rejected ? "Rejected wall — click to accept" : "Detected wall — click to reject");
        line.onclick = () => {
          if (this.rejectedWallIds.has(edge.id)) this.rejectedWallIds.delete(edge.id);
          else this.rejectedWallIds.add(edge.id);
          this.recomputeAfterReview();
        };
        svg.appendChild(line);
      }
    }

    for (const [i, pt] of this.calibrationClicks.entries()) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(pt.x));
      dot.setAttribute("cy", String(pt.y));
      dot.setAttribute("r", "6");
      dot.setAttribute("fill", "#E69F00");
      svg.appendChild(dot);
      if (i === 1) {
        const first = this.calibrationClicks[0]!;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(first.x));
        line.setAttribute("y1", String(first.y));
        line.setAttribute("x2", String(pt.x));
        line.setAttribute("y2", String(pt.y));
        line.setAttribute("stroke", "#E69F00");
        line.setAttribute("stroke-width", "3");
        svg.appendChild(line);
      }
    }

    svg.onclick = (event) => {
      if (!this.calibrationMode) return;
      const rect = svg.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * image.naturalWidth;
      const y = ((event.clientY - rect.top) / rect.height) * image.naturalHeight;
      this.handleCalibrationClick(x, y);
    };

    stage.appendChild(svg);
    wrap.appendChild(stage);

    const controls = document.createElement("div");
    controls.className = "raster-review-controls";

    const wallCount = document.createElement("p");
    const acceptedCount = this.graph ? Object.keys(this.graph.edges).length - this.rejectedWallIds.size : 0;
    wallCount.textContent = `${acceptedCount} wall(s) accepted, ${draft.rooms.length} room(s) detected. Click a wall above to accept or reject it.`;
    controls.appendChild(wallCount);

    const calibrateBtn = document.createElement("button");
    calibrateBtn.textContent = this.calibrationMode ? "Click two points on the image…" : "Calibrate scale…";
    calibrateBtn.onclick = () => {
      this.calibrationMode = true;
      this.calibrationClicks = [];
      this.render();
    };
    controls.appendChild(calibrateBtn);

    if (this.calibrationClicks.length === 2) {
      const pxDist = Math.hypot(
        this.calibrationClicks[1]!.x - this.calibrationClicks[0]!.x,
        this.calibrationClicks[1]!.y - this.calibrationClicks[0]!.y,
      );
      const lengthInput = document.createElement("input");
      lengthInput.type = "number";
      lengthInput.min = "0.01";
      lengthInput.step = "0.01";
      lengthInput.placeholder = "Real-world length";
      const unitSelect = document.createElement("select");
      const unitOptions: Array<[string, string]> = [
        ["ft", "feet"],
        ["m", "meters"],
      ];
      for (const [value, label] of unitOptions) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        unitSelect.appendChild(opt);
      }
      const setBtn = document.createElement("button");
      setBtn.textContent = "Set scale";
      setBtn.onclick = () => {
        const value = Number(lengthInput.value);
        if (!Number.isFinite(value) || value <= 0) return;
        const mm = unitSelect.value === "ft" ? value * 304.8 : value * 1000;
        this.mmPerPixel = calibrateScale(pxDist, mm);
        this.calibrationMode = false;
        this.render();
      };
      controls.appendChild(lengthInput);
      controls.appendChild(unitSelect);
      controls.appendChild(setBtn);
    }

    if (this.mmPerPixel) {
      const scaleNote = document.createElement("p");
      scaleNote.textContent = `Scale set: 1px = ${this.mmPerPixel.toFixed(3)}mm.`;
      controls.appendChild(scaleNote);
    }

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = this.levelName;
    nameInput.setAttribute("aria-label", "New level name");
    nameInput.oninput = () => {
      this.levelName = nameInput.value;
    };
    controls.appendChild(nameInput);

    const importBtn = document.createElement("button");
    importBtn.className = "primary";
    importBtn.textContent = "Import as new level";
    importBtn.disabled = !this.mmPerPixel;
    importBtn.title = this.mmPerPixel ? "" : "Set the scale first";
    importBtn.onclick = () => this.commitImport();
    controls.appendChild(importBtn);

    wrap.appendChild(controls);
    return wrap;
  }
}

/**
 * FR-20: detection is client-side and the source image is never uploaded. That is a real
 * privacy property of this feature — someone scanning their own home should be told it
 * plainly, at the moment they're choosing a file and again while they wait, rather than
 * having to take it on trust.
 */
function renderPrivacyNote(): HTMLElement {
  const note = document.createElement("p");
  note.className = "raster-import-privacy";

  const icon = document.createElement("span");
  icon.className = "raster-import-privacy-icon";
  icon.textContent = "\u{1F512}";
  icon.setAttribute("aria-hidden", "true");
  note.appendChild(icon);

  const lead = document.createElement("strong");
  lead.textContent = "Your floor plan image stays on this device.";
  note.appendChild(lead);

  // Deliberately says "become part of your plan, like any other edit" rather than implying
  // the *result* is local too: with cloud sync on, the accepted walls sync to D1 exactly as
  // a chat turn or a canvas drag would. The image is what never leaves — don't overclaim.
  note.appendChild(
    document.createTextNode(
      " It is read straight from your computer and processed here in the browser — never " +
        "uploaded, never stored on a server, and never sent to a language model. Only the " +
        "walls and rooms you accept become part of your plan, like any other edit.",
    ),
  );
  return note;
}
