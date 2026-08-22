// The drawing canvas — specs.md §6.2: FR-6 (SVG, not raster), FR-7 (drag wall, resize
// boundary, drag/rotate openings, rename a room inline, drag a room label), FR-8
// (dimension strings update live during a drag), FR-9 (pan, zoom, fit-to-view, touch
// targets) and NFR-6 (every edit reachable from the keyboard).
//
// Two rules shape this file:
//
//  * Gestures never touch geometry. Each one asks core's dragPlan for the patch ops it
//    would produce, previews them by applying to a copy, and commits the same ops
//    through the store on release — so a drag lands in undo exactly like a chat turn.
//  * A drag plans against the document as it stood when the gesture began, using the
//    cumulative pointer delta. Planning against the live preview would compound rounding
//    and let the wall drift away from the pointer.

import {
  activeLevel,
  applyPatch,
  planBoundaryResize,
  planDetachedWallDrag,
  planLabelDrag,
  planOpeningDrag,
  planOpeningRotate,
  planWallDrag,
  renderSvg,
  type BoundaryHandle,
  type PatchOp,
  type PlanDocument,
  type Selection,
} from "@floorcraft/core";
import type { PlanStore } from "./store";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.25;
/** Pointer travel, in CSS pixels, below which a gesture is a click rather than a drag. */
const CLICK_SLOP_PX = 3;

type DragKind = "wall" | "boundary" | "opening" | "label" | "pan";

type DragState = {
  kind: DragKind;
  /** The document as it was when the gesture started; every plan is computed from this. */
  baseDoc: PlanDocument;
  startClient: { x: number; y: number };
  startMm: { x: number; y: number };
  /**
   * Millimetres per CSS pixel as of the gesture's first frame. Pointer movement is
   * converted through this rather than re-read from the live SVG: a boundary resize
   * changes the drawing's scale as it goes, and measuring the second half of a drag
   * against a rescaled picture makes the geometry chase the pointer.
   */
  mmPerPx: number;
  moved: boolean;
  edgeId?: string;
  handle?: BoundaryHandle;
  openingId?: string;
  roomId?: string;
  /** Set for wall drags: which axis the pointer's movement is projected onto. */
  axis?: "x" | "y";
  panStart?: { x: number; y: number };
};

export class CanvasView {
  readonly element: HTMLElement;
  private surface: HTMLElement;
  private drag: DragState | null = null;
  private preview: PlanDocument | null = null;
  private selection: Selection = null;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private baseViewBox: { x: number; y: number; w: number; h: number } | null = null;
  private frameRequested = false;
  private renaming = false;
  /** Whether focus was inside the canvas when the current render started. */
  private hadFocus = false;

  constructor(
    private store: PlanStore,
    private options: { onMessage: (message: string | null) => void; isReadOnly: () => boolean },
  ) {
    this.element = document.createElement("div");
    this.element.className = "canvas-shell";
    this.element.appendChild(this.buildToolbar());

    this.surface = document.createElement("div");
    this.surface.className = "canvas-container";
    this.surface.tabIndex = 0;
    this.surface.setAttribute("role", "application");
    this.surface.setAttribute("aria-label", "Floor plan canvas. Tab to a wall, opening or label, then use the arrow keys.");
    this.element.appendChild(this.surface);

    this.surface.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.surface.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.surface.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.surface.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.surface.addEventListener("focusin", (e) => this.onFocusIn(e));

    this.render();
  }

  /** Called when the store changes. A live drag owns the picture until it is released. */
  update(): void {
    if (this.drag) return;
    this.preview = null;
    this.render();
  }

  // ------------------------------------------------------------- rendering

  private get doc(): PlanDocument {
    return this.preview ?? this.store.doc;
  }

  private render(): void {
    // A render mid-rename would tear out the <input> the user is typing into. The
    // rename session itself calls render() directly once it ends (see startRename's
    // `finish`), by which point this.renaming is already false, so nothing is missed —
    // this only ever skips a render that would have clobbered live text entry.
    if (this.renaming) return;
    this.hadFocus = this.surface.contains(document.activeElement);
    const interactive = !this.options.isReadOnly();
    const svg = renderSvg(this.doc, { targetWidthPx: 1100, interactive, selection: this.selection });
    this.surface.innerHTML = svg;
    const root = this.surface.querySelector("svg");
    if (!root) return;
    root.setAttribute("width", "100%");

    const viewBox = root.getAttribute("viewBox")!.split(" ").map(Number);
    this.baseViewBox = { x: viewBox[0]!, y: viewBox[1]!, w: viewBox[2]!, h: viewBox[3]! };
    this.applyViewBox(root);
    this.restoreFocus();
  }

  /**
   * Called by the app after re-parenting the canvas into a freshly built page. Moving a
   * focused element blurs it, which would end a keyboard editing session after one key.
   */
  afterReparent(): void {
    this.restoreFocus();
  }

  private restoreFocus(): void {
    if (!this.hadFocus || this.renaming) return;
    const target = this.selectionElement() ?? this.surface;
    target.focus({ preventScroll: true });
  }

  private selectionElement(): HTMLElement | null {
    const selection = this.selection;
    if (!selection) return null;
    const attribute =
      selection.kind === "wall"
        ? "data-edge-id"
        : selection.kind === "opening"
          ? "data-opening-id"
          : selection.kind === "label"
            ? "data-room-id"
            : "data-handle";
    return this.surface.querySelector(`[data-drag][${attribute}="${CSS.escape(selection.id)}"]`);
  }

  private renderSoon(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  private applyViewBox(root: SVGSVGElement): void {
    const base = this.baseViewBox;
    if (!base) return;
    const w = base.w / this.zoom;
    const h = base.h / this.zoom;
    const x = base.x + this.pan.x + (base.w - w) / 2;
    const y = base.y + this.pan.y + (base.h - h) / 2;
    root.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  // ------------------------------------------------------------- toolbar

  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "canvas-view-controls";
    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onclick = onClick;
      bar.appendChild(b);
    };
    button("−", "Zoom out", () => this.setZoom(this.zoom / ZOOM_STEP));
    button("+", "Zoom in", () => this.setZoom(this.zoom * ZOOM_STEP));
    button("Fit", "Fit plan to view", () => this.fitToView());
    return bar;
  }

  fitToView(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.render();
  }

  private setZoom(next: number): void {
    this.zoom = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX);
    this.render();
  }

  private onWheel(event: WheelEvent): void {
    // Trackpad pinch arrives as ctrl+wheel; a plain wheel scrolls the page as usual.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  }

  // ------------------------------------------------------- coordinate math

  /** Screen point to level-local millimetres, via the plan group's own transform. */
  private toPlanMm(clientX: number, clientY: number): { x: number; y: number } | null {
    const ctm = this.planCtm();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }

  private planCtm(): DOMMatrix | null {
    const group = this.surface.querySelector("#fc-plan") as SVGGraphicsElement | null;
    return group?.getScreenCTM() ?? null;
  }

  /** Millimetres per CSS pixel at the current zoom, for converting pointer travel. */
  private currentMmPerPx(): number {
    const ctm = this.planCtm();
    return ctm && ctm.a !== 0 ? 1 / ctm.a : 1;
  }

  // ----------------------------------------------------------- pointer

  private onPointerDown(event: PointerEvent): void {
    if (this.renaming) return;
    const target = event.target as Element;
    const handle = target.closest("[data-drag]") as HTMLElement | null;
    const startMm = this.toPlanMm(event.clientX, event.clientY);
    if (!startMm) return;

    const readOnly = this.options.isReadOnly();
    const kind = (handle?.dataset.drag as DragKind | undefined) ?? "pan";
    if (readOnly && kind !== "pan") return;

    this.options.onMessage(null);
    const baseDoc = this.store.doc;
    const state: DragState = {
      kind: readOnly ? "pan" : kind,
      baseDoc,
      startClient: { x: event.clientX, y: event.clientY },
      startMm,
      mmPerPx: this.currentMmPerPx(),
      moved: false,
    };

    if (state.kind === "wall") {
      state.edgeId = handle!.dataset.edgeId;
      const edge = activeLevel(baseDoc).graph.edges[state.edgeId!];
      const a = edge && activeLevel(baseDoc).graph.nodes[edge.a];
      const b = edge && activeLevel(baseDoc).graph.nodes[edge.b];
      if (!a || !b) return;
      // A wall only moves along its normal, so the pointer's other axis is ignored.
      state.axis = a.x === b.x ? "x" : "y";
      this.selection = { kind: "wall", id: state.edgeId! };
    } else if (state.kind === "boundary") {
      state.handle = handle!.dataset.handle as BoundaryHandle;
      this.selection = { kind: "boundary", id: state.handle };
    } else if (state.kind === "opening") {
      state.openingId = handle!.dataset.openingId;
      this.selection = { kind: "opening", id: state.openingId! };
    } else if (state.kind === "label") {
      state.roomId = handle!.dataset.roomId;
      this.selection = { kind: "label", id: state.roomId! };
    } else {
      state.panStart = { ...this.pan };
    }

    this.drag = state;
    // Listeners go on the window, not the target: previewing a drag replaces the SVG
    // under the pointer, so the element the gesture started on stops existing.
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.onPointerUp(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // No render here: nothing user-visible has changed yet. A real drag repaints via
    // onPointerMove's renderSoon() once movement starts; a plain click repaints on
    // pointerup below. Rendering eagerly on pointerdown would replace the very DOM node
    // the browser is tracking for a double-click, and — as the second click of every
    // dblclick lands on a freshly rebuilt element — silently breaks native dblclick
    // detection, which is exactly how the inline-rename gesture went dead.
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dxPx = event.clientX - drag.startClient.x;
    const dyPx = event.clientY - drag.startClient.y;
    if (!drag.moved && Math.hypot(dxPx, dyPx) < CLICK_SLOP_PX) return;
    drag.moved = true;

    if (drag.kind === "pan") {
      const base = this.baseViewBox;
      if (!base || !drag.panStart) return;
      const scale = base.w / this.zoom / this.surface.clientWidth;
      this.pan = { x: drag.panStart.x - dxPx * scale, y: drag.panStart.y - dyPx * scale };
      const root = this.surface.querySelector("svg");
      if (root) this.applyViewBox(root);
      return;
    }

    const plan = this.planFor(drag, event);
    if (!plan) return;
    if (!plan.ok) {
      this.options.onMessage(plan.reason);
      return;
    }
    this.options.onMessage(null);
    const applied = applyPatch(drag.baseDoc, { ops: plan.ops, source: "user" });
    if (applied.ok) {
      this.preview = applied.doc;
      this.renderSoon();
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;

    if (drag.kind === "pan" || !drag.moved) {
      // A click that never became a drag just selects. Deferred via renderSoon rather
      // than an immediate render: a plain click and the second click of a double-click
      // are indistinguishable at this point, and rebuilding the DOM synchronously here
      // is what breaks the browser's native dblclick detection (see the comment on
      // onPointerDown). Deferring by a frame lets dblclick fire first.
      this.preview = null;
      this.renderSoon();
      return;
    }

    const plan = this.planFor(drag, event);
    this.preview = null;
    if (!plan || !plan.ok) {
      if (plan && !plan.ok) this.options.onMessage(plan.reason);
      this.render();
      return;
    }
    if (plan.ops.length === 0) {
      this.render();
      return;
    }
    void this.commit(plan.ops);
  }

  private planFor(drag: DragState, event: PointerEvent) {
    const dx = (event.clientX - drag.startClient.x) * drag.mmPerPx;
    const dy = (event.clientY - drag.startClient.y) * drag.mmPerPx;
    const nowMm = { x: drag.startMm.x + dx, y: drag.startMm.y + dy };
    switch (drag.kind) {
      case "wall": {
        // A wall only travels along its own normal; movement on the other axis is noise.
        const deltaMm = drag.axis === "x" ? dx : dy;
        // A freeform level's walls can border cells that only partly span them (an
        // L-shape's inner step), which planWallDrag's single-split-ratio model can't
        // express — planDetachedWallDrag handles that generally instead.
        return activeLevel(drag.baseDoc).generator?.kind === "freeform"
          ? planDetachedWallDrag(drag.baseDoc, drag.edgeId!, deltaMm)
          : planWallDrag(drag.baseDoc, drag.edgeId!, deltaMm);
      }
      case "boundary":
        return planBoundaryResize(drag.baseDoc, drag.handle!, dx, dy);
      case "opening":
        return planOpeningDrag(drag.baseDoc, drag.openingId!, nowMm);
      case "label":
        return planLabelDrag(drag.baseDoc, drag.roomId!, nowMm);
      default:
        return null;
    }
  }

  private async commit(ops: PatchOp[]): Promise<void> {
    // A gesture can legitimately plan to nothing — an arrow key on the axis a boundary
    // handle doesn't own, a drag that ended where it started. Committing that would put
    // an identical document on the undo stack and make undo look broken.
    if (ops.length === 0) return;
    const result = await this.store.applyManual(ops);
    // A successful edit re-renders through the store's own subscribers; only a rejected
    // one has to redraw here, to drop the preview it was showing.
    if (result.kind === "error") {
      this.options.onMessage(result.message);
      this.render();
    }
  }

  // ---------------------------------------------------------- keyboard

  /** Tabbing onto a handle selects it, so the highlight and the arrow keys agree. */
  private onFocusIn(event: FocusEvent): void {
    const handle = (event.target as Element | null)?.closest("[data-drag]") as HTMLElement | null;
    if (!handle) return;
    const kind = handle.dataset.drag;
    let next: Selection = null;
    if (kind === "wall" && handle.dataset.edgeId) next = { kind: "wall", id: handle.dataset.edgeId };
    else if (kind === "opening" && handle.dataset.openingId) next = { kind: "opening", id: handle.dataset.openingId };
    else if (kind === "label" && handle.dataset.roomId) next = { kind: "label", id: handle.dataset.roomId };
    else if (kind === "boundary" && handle.dataset.handle) next = { kind: "boundary", id: handle.dataset.handle };
    if (!next) return;
    // Redrawing restores focus to the equivalent handle, which fires focusin again —
    // so only an actual change of selection is allowed to trigger a redraw.
    if (this.selection && this.selection.kind === next.kind && this.selection.id === next.id) return;
    this.selection = next;
    if (!this.drag) this.render();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.renaming || this.options.isReadOnly()) return;
    const selection = this.selection;
    if (!selection) return;

    const step = (event.shiftKey ? 10 : 1) * Math.max(Math.round(this.store.doc.gridModule), 1);
    const arrows: Record<string, { dx: number; dy: number }> = {
      ArrowLeft: { dx: -step, dy: 0 },
      ArrowRight: { dx: step, dy: 0 },
      ArrowUp: { dx: 0, dy: -step },
      ArrowDown: { dx: 0, dy: step },
    };
    const nudge = arrows[event.key];

    if (nudge) {
      event.preventDefault();
      void this.nudge(selection, nudge);
      return;
    }
    if ((event.key === "r" || event.key === "R") && selection.kind === "opening") {
      event.preventDefault();
      const plan = planOpeningRotate(this.store.doc, selection.id);
      if (!plan.ok) this.options.onMessage(plan.reason);
      else void this.commit(plan.ops);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selection.kind === "opening") {
      event.preventDefault();
      void this.commit([{ op: "removeOpening", openingId: selection.id }]);
      return;
    }
    if ((event.key === "F2" || event.key === "Enter") && selection.kind === "label") {
      event.preventDefault();
      this.startRename(selection.id);
    }
  }

  private async nudge(selection: NonNullable<Selection>, delta: { dx: number; dy: number }): Promise<void> {
    const doc = this.store.doc;
    switch (selection.kind) {
      case "wall": {
        const edge = activeLevel(doc).graph.edges[selection.id];
        if (!edge) return;
        const a = activeLevel(doc).graph.nodes[edge.a]!;
        const b = activeLevel(doc).graph.nodes[edge.b]!;
        const along = a.x === b.x ? delta.dx : delta.dy;
        if (along === 0) return;
        const plan = planWallDrag(doc, selection.id, along);
        if (!plan.ok) this.options.onMessage(plan.reason);
        else await this.commit(plan.ops);
        return;
      }
      case "boundary": {
        const plan = planBoundaryResize(doc, selection.id as BoundaryHandle, delta.dx, delta.dy);
        if (plan.ok) await this.commit(plan.ops);
        return;
      }
      case "opening": {
        const level = activeLevel(doc);
        const persisted = (level.openings ?? []).find((o) => o.id === selection.id);
        if (!persisted) return;
        // Keyboard nudges move the opening by a fixed fraction of its slidable range,
        // which is the only thing the persisted form knows about — mm along a wall whose
        // length changes with the layout would not survive the next edit.
        const stepRatio = 0.05 * (delta.dx + delta.dy > 0 ? 1 : -1);
        await this.commit([
          { op: "moveOpening", openingId: selection.id, offsetRatio: Math.min(Math.max(persisted.offsetRatio + stepRatio, 0), 1) },
        ]);
        return;
      }
      case "label": {
        const anchor = activeLevel(doc).graph.rooms[selection.id]?.labelAnchor;
        if (!anchor) return;
        const plan = planLabelDrag(doc, selection.id, { x: anchor.x + delta.dx, y: anchor.y + delta.dy });
        if (plan.ok) await this.commit(plan.ops);
      }
    }
  }

  // ------------------------------------------------------ inline rename

  private onDoubleClick(event: MouseEvent): void {
    if (this.options.isReadOnly()) return;
    const target = event.target as Element;
    const label = target.closest("[data-label-room-id], [data-room-id]") as HTMLElement | null;
    const roomId = label?.dataset.labelRoomId ?? label?.dataset.roomId;
    if (!roomId) return;
    event.preventDefault();
    this.startRename(roomId);
  }

  /** FR-7's "rename room inline": an input placed over the label itself, not a dialog. */
  private startRename(roomId: string): void {
    const room = activeLevel(this.store.doc).graph.rooms[roomId];
    if (!room || this.renaming) return;
    const labelGroup = this.surface.querySelector(`[data-label-room-id="${CSS.escape(roomId)}"] text`);
    const box = (labelGroup ?? this.surface).getBoundingClientRect();
    const shellBox = this.surface.getBoundingClientRect();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-rename";
    input.value = room.name;
    input.setAttribute("aria-label", `Rename ${room.name}`);
    input.style.left = `${box.left - shellBox.left + this.surface.scrollLeft - 60}px`;
    input.style.top = `${box.top - shellBox.top + this.surface.scrollTop - 6}px`;

    this.renaming = true;
    const finish = (commit: boolean) => {
      if (!this.renaming) return;
      this.renaming = false;
      const name = input.value.trim();
      input.remove();
      if (commit && name && name !== room.name) void this.commit([{ op: "renameRoom", roomId, name }]);
      else this.render();
      this.surface.focus();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
      e.stopPropagation();
    };
    input.onblur = () => finish(true);

    this.surface.appendChild(input);
    input.focus();
    input.select();
  }
}
