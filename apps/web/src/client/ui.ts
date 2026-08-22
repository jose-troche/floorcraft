// Renders the whole app from current store/provider state. No framework — the
// document is small (<=40 rooms per level, MCP-3) so a full re-render per change
// is simple and keeps the bundle under the NFR-2 budget.

import {
  PROGRAM_COLORS,
  ROOM_PROGRAM_MIN_DIMENSIONS,
  activeLevel,
  exportDxf,
  exportJson,
  exportPdf,
  formatLength,
  planOpeningRotate,
  renderSvg,
  sideOfRoom,
  type OpeningKind,
  type PaperSize,
  type PatchOp,
  type RoomProgram,
  type RoomSide,
  type Units,
} from "@floorcraft/core";
import type { PlanStore } from "./store";
import type { ProviderManager } from "./providers";
import { CanvasView } from "./canvas";
import type { SyncStatus } from "./sync";

type Tab = "chat" | "manual";

/**
 * User-facing names for the inference tiers. The spec's "Tier 0/1" vocabulary is an
 * architectural label, not something to put in front of someone drawing a floor plan —
 * what they care about is where the work happens and whether it's private to them.
 */
const TIER_NAMES: Record<"tier0-on-device" | "tier1-hosted", { badge: string; sentence: string; option: string }> = {
  "tier0-on-device": { badge: "On-device AI", sentence: "the AI on your device", option: "On-device AI (private, no network)" },
  "tier1-hosted": { badge: "Cloud AI", sentence: "the cloud AI", option: "Cloud AI (shared free pool)" },
};

export class AppUI {
  private tab: Tab = "chat";
  private error: string | null = null;
  private chatBusy = false;
  private pendingLabel: string | null = null;
  private paperSize: PaperSize = "A4";
  private shareLinks: { readOnly: string; edit: string } | null = null;
  /**
   * Built once and re-parented on every render. The canvas holds live gesture state and
   * a pan/zoom position; rebuilding it per render would drop a drag mid-flight.
   */
  private canvas: CanvasView;

  constructor(
    private root: HTMLElement,
    private store: PlanStore,
    private providers: ProviderManager,
  ) {
    this.canvas = new CanvasView(this.store, {
      onMessage: (message) => this.setCanvasMessage(message),
      isReadOnly: () => this.store.readOnly,
    });
    this.store.subscribe(() => {
      this.canvas.update();
      this.render();
    });
    this.providers.subscribe(() => this.render());
  }

  /** Canvas feedback (a refused drag) is shown in the same banner as everything else. */
  private setCanvasMessage(message: string | null): void {
    if (this.error === message) return;
    this.error = message;
    this.renderBanner();
  }

  render(): void {
    const doc = this.store.doc;
    const level = activeLevel(doc);
    const providerState = this.providers.getState();

    this.root.innerHTML = "";
    this.root.appendChild(this.renderHeader(providerState));

    const main = document.createElement("main");
    main.className = "layout";
    main.appendChild(this.renderLeftPanel(providerState));
    main.appendChild(this.renderRightPanel(level, doc.units));
    this.root.appendChild(main);
  }

  /** Updates just the error banner, so a rejected drag doesn't rebuild the whole page. */
  private renderBanner(): void {
    const existing = this.root.querySelector(".error-banner");
    const panel = this.root.querySelector(".tab-panel");
    if (!panel) return;
    if (!this.error) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.textContent = this.error;
      return;
    }
    const banner = document.createElement("div");
    banner.className = "error-banner";
    banner.textContent = this.error;
    panel.insertBefore(banner, panel.firstChild);
  }

  // ---------------------------------------------------------------- header

  private renderHeader(providerState: ReturnType<ProviderManager["getState"]>): HTMLElement {
    const header = document.createElement("header");
    header.className = "app-header";

    const h1 = document.createElement("h1");
    h1.textContent = "Floorcraft";
    header.appendChild(h1);

    const badge = document.createElement("span");
    badge.className = "tier-badge";
    const tierText = providerState.activeId ? TIER_NAMES[providerState.activeId].badge : "Manual editing only";
    if (this.chatBusy) {
      badge.classList.add("busy");
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      badge.appendChild(spinner);
      badge.appendChild(document.createTextNode(`${tierText} — working…`));
    } else {
      badge.textContent = tierText;
    }
    header.appendChild(badge);

    const tierSelect = document.createElement("select");
    tierSelect.setAttribute("aria-label", "Inference tier");
    const options: Array<[string, string]> = [
      ["auto", "Automatic"],
      ["tier0-on-device", TIER_NAMES["tier0-on-device"].option],
      ["tier1-hosted", TIER_NAMES["tier1-hosted"].option],
      ["none", "Manual editing only"],
    ];
    for (const [value, label] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      tierSelect.appendChild(opt);
    }
    tierSelect.value = providerState.activeId ?? "none";
    tierSelect.onchange = () => {
      if (tierSelect.value === "auto") this.providers.autoSelect();
      else if (tierSelect.value === "none") this.providers.setActive(null);
      else this.providers.setActive(tierSelect.value as "tier0-on-device" | "tier1-hosted");
      this.store.setProvider(this.providers.getActiveProvider());
    };
    header.appendChild(tierSelect);

    header.appendChild(this.spacer());

    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo";
    undoBtn.disabled = !this.store.canUndo;
    undoBtn.onclick = () => this.store.undoManual();
    header.appendChild(undoBtn);

    const redoBtn = document.createElement("button");
    redoBtn.textContent = "Redo";
    redoBtn.disabled = !this.store.canRedo;
    redoBtn.onclick = () => this.store.redoManual();
    header.appendChild(redoBtn);

    return header;
  }

  private spacer(): HTMLElement {
    const s = document.createElement("div");
    s.className = "spacer";
    return s;
  }

  // ------------------------------------------------------------ left panel

  private renderLeftPanel(providerState: ReturnType<ProviderManager["getState"]>): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "left-panel";

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    for (const [id, label] of [
      ["chat", "Chat"],
      ["manual", "Manual editor"],
    ] as const) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.setAttribute("aria-selected", String(this.tab === id));
      btn.onclick = () => {
        this.tab = id;
        this.render();
      };
      tabs.appendChild(btn);
    }
    panel.appendChild(tabs);

    const tabPanel = document.createElement("div");
    tabPanel.className = "tab-panel";
    if (this.error) {
      const banner = document.createElement("div");
      banner.className = "error-banner";
      banner.textContent = this.error;
      tabPanel.appendChild(banner);
    }
    tabPanel.appendChild(this.tab === "chat" ? this.renderChatTab(providerState) : this.renderManualTab());
    panel.appendChild(tabPanel);

    return panel;
  }

  private renderChatTab(providerState: ReturnType<ProviderManager["getState"]>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.flex = "1";
    wrap.style.minHeight = "0";

    const messages = document.createElement("div");
    messages.className = "chat-messages";
    for (const turn of this.store.chatHistory) {
      const msg = document.createElement("div");
      msg.className = `chat-msg ${turn.role}`;
      msg.textContent = turn.text;
      messages.appendChild(msg);
    }
    if (this.chatBusy) {
      const pending = document.createElement("div");
      pending.className = "chat-msg assistant pending";
      const dots = document.createElement("span");
      dots.className = "typing-dots";
      dots.innerHTML = "<span></span><span></span><span></span>";
      pending.appendChild(dots);
      const label = document.createElement("span");
      label.textContent = this.pendingLabel ?? "Working…";
      pending.appendChild(label);
      messages.appendChild(pending);
    }
    wrap.appendChild(messages);
    queueMicrotask(() => {
      messages.scrollTop = messages.scrollHeight;
    });

    const chatDisabled = providerState.activeId === null;

    if (chatDisabled) {
      const note = document.createElement("div");
      note.className = "chat-disabled-note";
      note.textContent =
        "No inference tier is available, so chat is disabled (per RTE-4). Use the Manual editor tab — every edit chat could make is also a button there.";
      wrap.appendChild(note);
    }

    const row = document.createElement("div");
    row.className = "chat-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = chatDisabled ? "Chat disabled — use the manual editor" : "Describe your plan, or say things like \"swap the kitchen and bath\"";
    input.disabled = chatDisabled || this.chatBusy;
    const send = document.createElement("button");
    send.className = "primary";
    send.textContent = this.chatBusy ? "…" : "Send";
    send.disabled = chatDisabled || this.chatBusy;

    const tierLabel = providerState.activeId ? TIER_NAMES[providerState.activeId].sentence : null;

    const submit = async () => {
      const text = input.value.trim();
      if (!text || this.chatBusy) return;
      this.error = null;
      this.chatBusy = true;
      this.pendingLabel = tierLabel ? `Working on your plan with ${tierLabel}…` : "Working on your plan…";
      this.render();
      try {
        const result = await this.store.submitChatTurn(text);
        if (result.kind === "error") this.error = result.message;
      } catch (e) {
        // The busy state must never outlive the turn: a stuck spinner tells the user
        // work is still happening when it has already failed.
        this.error = `Something went wrong: ${(e as Error).message}. Your plan is unchanged.`;
      } finally {
        this.chatBusy = false;
        this.pendingLabel = null;
        this.render();
      }
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
    send.onclick = () => void submit();

    row.appendChild(input);
    row.appendChild(send);
    wrap.appendChild(row);

    return wrap;
  }

  // --------------------------------------------------------- manual editor

  private renderManualTab(): HTMLElement {
    const wrap = document.createElement("div");
    const doc = this.store.doc;
    const level = activeLevel(doc);

    wrap.appendChild(this.renderBoundaryForm(doc.units, level.boundary));
    wrap.appendChild(this.renderUnitsToggle(doc.units));
    wrap.appendChild(this.renderAddRoomForm());
    wrap.appendChild(this.renderRoomList());
    wrap.appendChild(this.renderOpeningsForm());

    return wrap;
  }

  /**
   * Doors and windows from buttons rather than the canvas. RTE-4 makes this a release
   * blocker, not a convenience: with no inference available every edit must still be
   * reachable, and openings are a Phase 2 edit like any other.
   */
  private renderOpeningsForm(): HTMLElement {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Doors and windows";
    fs.appendChild(legend);

    const level = activeLevel(this.store.doc);
    const rooms = Object.entries(level.graph.rooms);
    if (rooms.length === 0) {
      const p = document.createElement("p");
      p.textContent = "Add rooms first — an opening needs a wall to sit in.";
      fs.appendChild(p);
      return fs;
    }

    const roomSelect = (label: string) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const select = document.createElement("select");
      for (const [roomId, room] of rooms) {
        const opt = document.createElement("option");
        opt.value = roomId;
        opt.textContent = room.name;
        select.appendChild(opt);
      }
      wrapper.appendChild(select);
      fs.appendChild(wrapper);
      return select;
    };

    const kindLabel = document.createElement("label");
    kindLabel.textContent = "Kind";
    const kindSelect = document.createElement("select");
    for (const kind of ["door", "window", "cased", "pass-through"] as OpeningKind[]) {
      const opt = document.createElement("option");
      opt.value = kind;
      opt.textContent = kind;
      kindSelect.appendChild(opt);
    }
    kindLabel.appendChild(kindSelect);
    fs.appendChild(kindLabel);

    const placementLabel = document.createElement("label");
    placementLabel.textContent = "Place in";
    const placement = document.createElement("select");
    for (const [value, text] of [
      ["between", "the wall between two rooms"],
      ["exterior", "an outside wall of one room"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      placement.appendChild(opt);
    }
    placementLabel.appendChild(placement);
    fs.appendChild(placementLabel);

    const roomA = roomSelect("Room");
    const roomB = roomSelect("Adjoining room");
    const sideLabel = document.createElement("label");
    sideLabel.textContent = "Outside wall";
    const sideSelect = document.createElement("select");
    for (const side of ["top", "right", "bottom", "left"] as RoomSide[]) {
      const opt = document.createElement("option");
      opt.value = side;
      opt.textContent = side;
      sideSelect.appendChild(opt);
    }
    sideLabel.appendChild(sideSelect);
    fs.appendChild(sideLabel);

    const syncPlacement = () => {
      const between = placement.value === "between";
      roomB.parentElement!.style.display = between ? "" : "none";
      sideLabel.style.display = between ? "none" : "";
    };
    placement.onchange = syncPlacement;
    syncPlacement();

    const add = document.createElement("button");
    add.className = "primary";
    add.textContent = "Add opening";
    add.onclick = () => {
      const kind = kindSelect.value as OpeningKind;
      if (placement.value === "between") {
        if (roomA.value === roomB.value) {
          this.error = "Pick two different rooms — an opening needs a wall between them.";
          this.render();
          return;
        }
        void this.runManual([{ op: "addOpening", betweenRooms: [roomA.value, roomB.value], kind }]);
        return;
      }
      const side = sideSelect.value as RoomSide;
      const room = level.graph.rooms[roomA.value];
      const edgeId = room?.boundary.find(
        (id) => level.graph.edges[id]?.type === "exterior" && sideOfRoom(level.graph, roomA.value, id) === side,
      );
      if (!edgeId) {
        this.error = `${room?.name ?? "That room"} has no outside wall on the ${side}.`;
        this.render();
        return;
      }
      void this.runManual([{ op: "addOpening", edgeId, kind }]);
    };
    fs.appendChild(add);

    for (const opening of level.openings ?? []) {
      const row = document.createElement("div");
      row.className = "room-row";
      const name = document.createElement("span");
      name.className = "name";
      const where =
        opening.anchor.kind === "between"
          ? `${level.graph.rooms[opening.anchor.rooms[0]]?.name ?? "?"} / ${level.graph.rooms[opening.anchor.rooms[1]]?.name ?? "?"}`
          : `${level.graph.rooms[opening.anchor.roomId]?.name ?? "?"} (${opening.anchor.side})`;
      name.textContent = `${opening.kind}: ${where}`;
      row.appendChild(name);

      if (opening.kind !== "window") {
        const rotate = document.createElement("button");
        rotate.textContent = "Rotate";
        rotate.title = "Cycle which way the door hinges and swings";
        rotate.onclick = () => {
          const plan = planOpeningRotate(this.store.doc, opening.id);
          if (!plan.ok) {
            this.error = plan.reason;
            this.render();
          } else {
            void this.runManual(plan.ops);
          }
        };
        row.appendChild(rotate);
      }

      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.onclick = () => void this.runManual([{ op: "removeOpening", openingId: opening.id }]);
      row.appendChild(remove);

      fs.appendChild(row);
    }

    return fs;
  }

  private async runManual(ops: PatchOp[]): Promise<void> {
    this.error = null;
    const result = await this.store.applyManual(ops);
    if (result.kind === "error") this.error = result.message;
    this.render();
  }

  private renderBoundaryForm(units: Units, boundary: { widthMm: number; depthMm: number }): HTMLElement {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Boundary";
    fs.appendChild(legend);

    const widthLabel = document.createElement("label");
    widthLabel.textContent = `Width (${formatLength(boundary.widthMm, units)})`;
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.value = String(boundary.widthMm);
    widthLabel.appendChild(widthInput);
    fs.appendChild(widthLabel);

    const depthLabel = document.createElement("label");
    depthLabel.textContent = `Depth (${formatLength(boundary.depthMm, units)})`;
    const depthInput = document.createElement("input");
    depthInput.type = "number";
    depthInput.value = String(boundary.depthMm);
    depthLabel.appendChild(depthInput);
    fs.appendChild(depthLabel);

    const btn = document.createElement("button");
    btn.textContent = "Apply boundary";
    btn.onclick = () =>
      void this.runManual([{ op: "setBoundary", widthMm: Number(widthInput.value), depthMm: Number(depthInput.value) }]);
    fs.appendChild(btn);

    return fs;
  }

  private renderUnitsToggle(units: Units): HTMLElement {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Units";
    fs.appendChild(legend);
    const btn = document.createElement("button");
    btn.textContent = units === "imperial" ? "Switch to metric" : "Switch to imperial";
    btn.onclick = () => void this.runManual([{ op: "setUnits", units: units === "imperial" ? "metric" : "imperial" }]);
    fs.appendChild(btn);
    return fs;
  }

  private renderAddRoomForm(): HTMLElement {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Add room";
    fs.appendChild(legend);

    const programLabel = document.createElement("label");
    programLabel.textContent = "Program";
    const programSelect = document.createElement("select");
    for (const program of Object.keys(ROOM_PROGRAM_MIN_DIMENSIONS) as RoomProgram[]) {
      const opt = document.createElement("option");
      opt.value = program;
      opt.textContent = program;
      programSelect.appendChild(opt);
    }
    programLabel.appendChild(programSelect);
    fs.appendChild(programLabel);

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Name (optional)";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameLabel.appendChild(nameInput);
    fs.appendChild(nameLabel);

    const rooms = Object.entries(activeLevel(this.store.doc).graph.rooms);
    const adjacentLabel = document.createElement("label");
    adjacentLabel.textContent = "Adjacent to (optional)";
    const adjacentSelect = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "(none)";
    adjacentSelect.appendChild(noneOpt);
    for (const [roomId, room] of rooms) {
      const opt = document.createElement("option");
      opt.value = roomId;
      opt.textContent = room.name;
      adjacentSelect.appendChild(opt);
    }
    adjacentLabel.appendChild(adjacentSelect);
    fs.appendChild(adjacentLabel);

    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "Add room";
    btn.onclick = () =>
      void this.runManual([
        {
          op: "addRoom",
          program: programSelect.value as RoomProgram,
          name: nameInput.value.trim() || undefined,
          areaWeight: 1,
          adjacentTo: adjacentSelect.value || undefined,
        },
      ]);
    fs.appendChild(btn);

    return fs;
  }

  private renderRoomList(): HTMLElement {
    const fs = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Rooms";
    fs.appendChild(legend);

    const level = activeLevel(this.store.doc);
    const rooms = Object.entries(level.graph.rooms);

    if (rooms.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No rooms yet — add one above.";
      fs.appendChild(p);
      return fs;
    }

    for (const [roomId, room] of rooms) {
      const row = document.createElement("div");
      row.className = "room-row";

      const swatch = document.createElement("span");
      swatch.className = "program-swatch";
      swatch.style.background = PROGRAM_COLORS[room.program] ?? "#ccc";
      row.appendChild(swatch);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = room.name;
      row.appendChild(name);

      const renameBtn = document.createElement("button");
      renameBtn.textContent = "Rename";
      renameBtn.onclick = () => {
        const newName = window.prompt("New name", room.name);
        if (newName && newName.trim()) void this.runManual([{ op: "renameRoom", roomId, name: newName.trim() }]);
      };
      row.appendChild(renameBtn);

      const smaller = document.createElement("button");
      smaller.textContent = "−";
      smaller.title = "20% smaller";
      smaller.onclick = () => void this.resizeByPercent(roomId, -0.2);
      row.appendChild(smaller);

      const bigger = document.createElement("button");
      bigger.textContent = "+";
      bigger.title = "20% bigger";
      bigger.onclick = () => void this.resizeByPercent(roomId, 0.2);
      row.appendChild(bigger);

      const otherRooms = rooms.filter(([id]) => id !== roomId);
      if (otherRooms.length > 0) {
        const swapSelect = document.createElement("select");
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Swap with…";
        swapSelect.appendChild(placeholder);
        for (const [otherId, other] of otherRooms) {
          const opt = document.createElement("option");
          opt.value = otherId;
          opt.textContent = other.name;
          swapSelect.appendChild(opt);
        }
        swapSelect.onchange = () => {
          if (swapSelect.value) void this.runManual([{ op: "swapRooms", roomIdA: roomId, roomIdB: swapSelect.value }]);
        };
        row.appendChild(swapSelect);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = () => void this.runManual([{ op: "removeRoom", roomId }]);
      row.appendChild(deleteBtn);

      fs.appendChild(row);
    }

    return fs;
  }

  private async resizeByPercent(roomId: string, delta: number): Promise<void> {
    const level = activeLevel(this.store.doc);
    const tree = level.generator?.tree;
    const currentWeight = tree ? findWeight(tree, roomId) : null;
    if (currentWeight === null) return;
    await this.runManual([{ op: "resizeRoom", roomId, areaWeight: Math.max(currentWeight * (1 + delta), 0.01) }]);
  }

  // ----------------------------------------------------------- right panel

  private renderRightPanel(level: ReturnType<typeof activeLevel>, units: Units): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "right-panel";

    panel.appendChild(this.renderCanvasToolbar(level, units));
    if (this.shareLinks) panel.appendChild(this.renderSharePanel(this.shareLinks));
    if (this.store.readOnlyMessage) {
      const banner = document.createElement("div");
      banner.className = "readonly-banner";
      banner.textContent = this.store.readOnlyMessage;
      panel.appendChild(banner);
    }
    panel.appendChild(this.canvas.element);
    this.canvas.afterReparent();

    return panel;
  }

  private renderCanvasToolbar(level: ReturnType<typeof activeLevel>, units: Units): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "canvas-toolbar";
    const title = this.store.doc.title || "plan";

    const addButton = (label: string, onClick: () => void, className?: string) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (className) btn.className = className;
      btn.onclick = onClick;
      toolbar.appendChild(btn);
      return btn;
    };

    addButton("SVG", () => downloadBlob(renderSvg(this.store.doc), `${title}.svg`, "image/svg+xml"));
    // FR-19: DXF is the way into DWG-native tools; .dwg itself is never offered.
    const dxf = addButton("DXF", () => downloadBlob(exportDxf(this.store.doc), `${title}.dxf`, "application/dxf"));
    dxf.title = "DXF R12 — imports into LibreCAD, QCAD, AutoCAD and SketchUp (and is the route into DWG tools)";
    addButton("PDF", () =>
      downloadBlob(exportPdf(this.store.doc, { paperSize: this.paperSize }), `${title}.pdf`, "application/pdf"),
    );

    const paper = document.createElement("select");
    paper.setAttribute("aria-label", "PDF paper size");
    for (const size of ["A4", "A3", "Letter", "Tabloid"] as PaperSize[]) {
      const opt = document.createElement("option");
      opt.value = size;
      opt.textContent = size;
      paper.appendChild(opt);
    }
    paper.value = this.paperSize;
    paper.onchange = () => {
      this.paperSize = paper.value as PaperSize;
    };
    toolbar.appendChild(paper);

    addButton("JSON", () => downloadBlob(exportJson(this.store.doc), `${title}.json`, "application/json"));

    const sync = this.store.getSync();
    if (sync?.enabled) {
      const share = addButton("Share…", () => void this.createShareLinks());
      share.title = "Save to the cloud and create a link";
    }

    const status = document.createElement("span");
    status.className = "canvas-status";
    const syncText = sync?.enabled ? describeSync(sync.getStatus()) : "Saved on this device";
    status.textContent =
      `${Object.keys(level.graph.rooms).length} room(s) · ` +
      `${formatLength(level.boundary.widthMm, units)} × ${formatLength(level.boundary.depthMm, units)} · ${syncText}`;
    toolbar.appendChild(status);

    return toolbar;
  }

  private async createShareLinks(): Promise<void> {
    const sync = this.store.getSync();
    if (!sync) return;
    try {
      this.shareLinks = await sync.shareLinks();
      this.error = null;
    } catch (e) {
      this.error = `Could not create a share link: ${(e as Error).message}`;
    }
    this.render();
  }

  /** FR-14: the read-only link is the one on offer; the edit link is a deliberate second step. */
  private renderSharePanel(links: { readOnly: string; edit: string }): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "share-panel";

    const row = (label: string, url: string, note: string) => {
      const wrap = document.createElement("div");
      wrap.className = "share-row";
      const heading = document.createElement("strong");
      heading.textContent = label;
      wrap.appendChild(heading);
      const input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.value = url;
      input.onfocus = () => input.select();
      wrap.appendChild(input);
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = () => {
        void navigator.clipboard?.writeText(url);
        copy.textContent = "Copied";
      };
      wrap.appendChild(copy);
      const hint = document.createElement("small");
      hint.textContent = note;
      wrap.appendChild(hint);
      panel.appendChild(wrap);
    };

    row("View-only link", links.readOnly, "Anyone with this link can view and export, but not edit.");
    row("Edit link", links.edit, "Anyone with this link can change the plan. Share it deliberately.");

    const close = document.createElement("button");
    close.textContent = "Done";
    close.onclick = () => {
      this.shareLinks = null;
      this.render();
    };
    panel.appendChild(close);

    return panel;
  }
}

function describeSync(status: SyncStatus): string {
  switch (status.state) {
    case "off":
      return "Saved on this device";
    case "pending":
      return "Saving soon…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved to the cloud";
    case "error":
      return `Cloud save failed (${status.message}) — your plan is safe on this device`;
    default:
      return "Saved on this device";
  }
}

function findWeight(tree: import("@floorcraft/core").SlicingTree, roomId: string): number | null {
  if (tree.kind === "leaf") return tree.roomId === roomId ? tree.areaWeight : null;
  return findWeight(tree.children[0], roomId) ?? findWeight(tree.children[1], roomId);
}

/** FR-16: every export is a client-side Blob — no server round-trip, works offline. */
function downloadBlob(content: string | Uint8Array, filename: string, type: string): void {
  const blob = new Blob([content as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
