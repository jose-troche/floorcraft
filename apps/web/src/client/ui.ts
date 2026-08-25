// Renders the whole app from current store/provider state. No framework — the
// document is small (<=40 rooms per level, MCP-3) so a full re-render per change
// is simple and keeps the bundle under the NFR-2 budget.

import {
  EXAMPLE_REQUESTS,
  PROGRAM_COLORS,
  ROOM_PROGRAM_MIN_DIMENSIONS,
  activeLevel,
  checkStairAlignment,
  exportJson,
  formatLength,
  generatorTree,
  planOpeningRotate,
  planStairAlignmentOnActiveLevel,
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
import type { ProviderId, ProviderManager } from "./providers";
import * as openrouterAuth from "./openrouterAuth";
import { clearByokKey, getByokKey, setByokKey, type Tier3Vendor } from "./byokKeys";
import type { RasterImportPanel } from "./rasterImportUi";
import { CanvasView } from "./canvas";
import type { SyncStatus } from "./sync";

type Tab = "chat" | "manual";

/**
 * User-facing names for the inference tiers. The spec's "Tier 0/1" vocabulary is an
 * architectural label, not something to put in front of someone drawing a floor plan —
 * what they care about is where the work happens and whether it's private to them.
 */
const TIER_NAMES: Record<ProviderId, { badge: string; sentence: string; option: string }> = {
  "tier0-on-device": { badge: "On-device AI", sentence: "the AI on your device", option: "On-device AI (private, no network)" },
  "tier1-hosted": { badge: "Cloud AI", sentence: "the cloud AI", option: "Cloud AI (shared free pool)" },
  "tier2-openrouter": { badge: "OpenRouter", sentence: "your connected OpenRouter account", option: "OpenRouter (your account)" },
  "tier3-byok": { badge: "Your API key", sentence: "your own API key", option: "Your own API key" },
};

export class AppUI {
  private tab: Tab = "chat";
  private error: string | null = null;
  private chatBusy = false;
  private pendingLabel: string | null = null;
  private paperSize: PaperSize = "Letter";
  private shareLinks: { readOnly: string; edit: string } | null = null;
  /** Options from the last clarifying question, offered as one-tap answers (FR-5). */
  private clarifyOptions: string[] | null = null;
  /** Whether the inline "connect your own key" form (Tier 3) is expanded. */
  private byokFormOpen = false;
  private byokVendor: Tier3Vendor = "anthropic";
  /** RTE-3: quota exhaustion is explicit and must be acknowledged, not silently retried —
   * dismissing just hides the banner for this session, it doesn't change the tier. */
  private quotaBannerDismissed = false;
  /** Raster import (Phase 4, FR-25) — shown as a full-panel takeover, not a normal tab,
   * since it's a one-shot multi-step flow (upload, review, calibrate) rather than
   * ongoing editing. */
  private rasterImportPanel: RasterImportPanel | null = null;
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
    if (providerState.tier1Availability === "exhausted" && !this.quotaBannerDismissed) {
      this.root.appendChild(this.renderQuotaExhaustedBanner());
    }

    if (this.rasterImportPanel) {
      this.root.appendChild(this.rasterImportPanel.element);
      return;
    }

    const main = document.createElement("main");
    main.className = "layout";
    main.appendChild(this.renderLeftPanel(providerState));
    main.appendChild(this.renderRightPanel(level, doc.units));
    this.root.appendChild(main);
  }

  /** RTE-3: the hosted free pool being exhausted (per-client quota or the global daily
   * budget) is surfaced explicitly rather than just silently failing turns, with the
   * Tier 2/3 upgrade path one click away. */
  private renderQuotaExhaustedBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "quota-banner";
    const text = document.createElement("span");
    text.textContent = "The free cloud AI pool is exhausted for now — connect OpenRouter or your own API key to keep chatting, or keep editing manually.";
    banner.appendChild(text);
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.onclick = () => {
      this.quotaBannerDismissed = true;
      this.render();
    };
    banner.appendChild(dismiss);
    return banner;
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

    header.appendChild(this.renderLevelSwitcher());

    if (this.providers.getConfig().rasterImportEnabled) {
      const importBtn = document.createElement("button");
      importBtn.textContent = "Import from image…";
      importBtn.title = "Scan or photograph an existing floor plan and turn it into a new level (FR-20..FR-25)";
      importBtn.onclick = () => {
        // NFR-2: opencv.js is a multi-hundred-kilobyte-to-megabyte payload downstream of
        // this — the whole raster-import module stays out of the main bundle until
        // someone actually clicks this button.
        void import("./rasterImportUi").then(({ RasterImportPanel }) => {
          this.rasterImportPanel = new RasterImportPanel(
            this.providers.getConfig().rasterImportEnabled === true,
            (ops) => {
              this.rasterImportPanel = null;
              void this.runManual(ops);
            },
            () => {
              this.rasterImportPanel = null;
              this.render();
            },
          );
          this.render();
        });
      };
      header.appendChild(importBtn);
    }

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
    const options: Array<[string, string]> = [["auto", "Automatic"], ["tier0-on-device", TIER_NAMES["tier0-on-device"].option], ["tier1-hosted", TIER_NAMES["tier1-hosted"].option]];
    // Tier 2/3 are opt-in (RTE-1 never auto-selects them) and only worth offering once
    // actually connected — an entry for a tier with no key would just error on selection.
    if (providerState.tier2Availability === "available") options.push(["tier2-openrouter", TIER_NAMES["tier2-openrouter"].option]);
    if (providerState.tier3Availability === "available") options.push(["tier3-byok", TIER_NAMES["tier3-byok"].option]);
    options.push(["none", "Manual editing only"]);
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
      else this.providers.setActive(tierSelect.value as ProviderId);
      this.store.setProvider(this.providers.getActiveProvider());
    };
    header.appendChild(tierSelect);

    header.appendChild(this.renderTierConnections(providerState));

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

  /** Multi-storey level switcher (Phase 3) — always rendered, even for a single level, so
   * "+" for a second floor is discoverable without a separate menu. */
  private renderLevelSwitcher(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "level-switcher";
    const doc = this.store.doc;
    const levels = [...doc.levels].sort((a, b) => a.elevation - b.elevation);

    const select = document.createElement("select");
    select.setAttribute("aria-label", "Active level");
    for (const level of levels) {
      const opt = document.createElement("option");
      opt.value = level.id;
      opt.textContent = level.name;
      select.appendChild(opt);
    }
    select.value = doc.activeLevelId;
    select.onchange = () => void this.runManual([{ op: "setActiveLevel", levelId: select.value }]);
    wrap.appendChild(select);

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "✎";
    renameBtn.title = "Rename level";
    renameBtn.setAttribute("aria-label", "Rename level");
    renameBtn.onclick = () => {
      const current = activeLevel(doc);
      const name = window.prompt("Level name", current.name);
      if (name && name.trim()) void this.runManual([{ op: "renameLevel", levelId: current.id, name: name.trim() }]);
    };
    wrap.appendChild(renameBtn);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+";
    addBtn.title = "Add a level";
    addBtn.setAttribute("aria-label", "Add a level");
    addBtn.onclick = () => {
      const name = window.prompt("New level name", `Level ${levels.length + 1}`);
      if (name === null) return;
      void this.runManual([{ op: "addLevel", name: name.trim() || undefined }]);
    };
    wrap.appendChild(addBtn);

    if (levels.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Delete level";
      removeBtn.onclick = () => {
        const current = activeLevel(doc);
        if (window.confirm(`Delete "${current.name}" and everything on it?`)) {
          void this.runManual([{ op: "removeLevel", levelId: current.id }]);
        }
      };
      wrap.appendChild(removeBtn);
    }

    return wrap;
  }

  /** Connect/disconnect controls for Tier 2 (OpenRouter) and Tier 3 (BYOK) — specs.md
   * T2-1/T2-2, T3-1/T3-2. Both start disconnected; connecting either is always an
   * explicit click, never automatic (RTE-1 doesn't route to them). */
  private renderTierConnections(providerState: ReturnType<ProviderManager["getState"]>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tier-connections";

    if (providerState.tier2Availability === "available") {
      const disconnect = document.createElement("button");
      disconnect.textContent = "Disconnect OpenRouter";
      disconnect.onclick = () => {
        openrouterAuth.disconnect();
        void this.providers.refreshConnections().then(() => this.render());
      };
      wrap.appendChild(disconnect);
    } else {
      const connect = document.createElement("button");
      connect.textContent = "Connect OpenRouter…";
      connect.onclick = () => {
        // T2-2: the spend risk is stated at the point of connection, not buried in settings.
        const ok = window.confirm(
          "This connects your OpenRouter account. Floorcraft will use it to run chat requests, " +
            "which can spend your OpenRouter credits (a free-tier model is used by default). Continue?",
        );
        if (ok) void openrouterAuth.beginConnect();
      };
      wrap.appendChild(connect);
    }

    if (providerState.tier3Availability === "available" && providerState.tier3Vendor) {
      const vendor = providerState.tier3Vendor;
      const forget = document.createElement("button");
      forget.textContent = `Forget ${vendor} key`;
      forget.onclick = () => {
        clearByokKey(vendor);
        void this.providers.refreshConnections().then(() => this.render());
      };
      wrap.appendChild(forget);
    } else {
      const toggle = document.createElement("button");
      toggle.textContent = this.byokFormOpen ? "Cancel" : "Use your own API key…";
      toggle.onclick = () => {
        this.byokFormOpen = !this.byokFormOpen;
        this.render();
      };
      wrap.appendChild(toggle);

      if (this.byokFormOpen) {
        const vendorSelect = document.createElement("select");
        vendorSelect.setAttribute("aria-label", "API key provider");
        const vendors: Array<[Tier3Vendor, string]> = [
          ["anthropic", "Anthropic"],
          ["openai", "OpenAI"],
          ["google", "Google"],
        ];
        for (const [value, label] of vendors) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          vendorSelect.appendChild(opt);
        }
        vendorSelect.value = this.byokVendor;
        vendorSelect.onchange = () => {
          this.byokVendor = vendorSelect.value as Tier3Vendor;
        };
        wrap.appendChild(vendorSelect);

        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.placeholder = "API key";
        keyInput.setAttribute("aria-label", "API key");
        keyInput.autocomplete = "off";
        wrap.appendChild(keyInput);

        const save = document.createElement("button");
        save.textContent = "Connect";
        save.onclick = () => {
          const key = keyInput.value.trim();
          if (!key) return;
          setByokKey(this.byokVendor, key);
          this.byokFormOpen = false;
          void this.providers.refreshConnections().then(() => this.render());
        };
        wrap.appendChild(save);
      }
    }

    return wrap;
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

    // Declared before the transcript so a clarification chip can write into it.
    const input = document.createElement("textarea");
    input.rows = 3;

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

    if (this.clarifyOptions && this.clarifyOptions.length > 0 && !this.chatBusy) {
      const chips = document.createElement("div");
      chips.className = "clarify-options";
      for (const option of this.clarifyOptions) {
        const chip = document.createElement("button");
        chip.className = "clarify-chip";
        chip.textContent = option;
        chip.onclick = () => {
          input.value = option;
          input.focus();
        };
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
    }

    const chatDisabled = providerState.activeId === null;

    // Examples sit directly above the input, and only when there is no clarification
    // waiting — two competing rows of chips would make it unclear which one answers the
    // question just asked. They stay visible after the first message rather than only on
    // an empty transcript: most of what they teach (counts, lists, exact sizes) is what
    // someone reaches for on their third request, not their first.
    if (!this.clarifyOptions) wrap.appendChild(this.renderExampleChips(input, chatDisabled));

    if (chatDisabled) {
      const note = document.createElement("div");
      note.className = "chat-disabled-note";
      note.textContent =
        "No inference tier is available, so chat is disabled (per RTE-4). Use the Manual editor tab — every edit chat could make is also a button there.";
      wrap.appendChild(note);
    }

    const row = document.createElement("div");
    row.className = "chat-input-row";
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
      input.value = "";
      this.error = null;
      this.chatBusy = true;
      this.pendingLabel = tierLabel ? `Working on your plan with ${tierLabel}…` : "Working on your plan…";
      this.render();
      try {
        const result = await this.store.submitChatTurn(text);
        if (result.kind === "error") this.error = result.message;
        // A question stays pending until the next turn answers it; anything else clears it.
        this.clarifyOptions = result.kind === "clarify" ? (result.options ?? []) : null;
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
      // Shift+Enter (or IME composition) inserts a newline like any multiline textarea;
      // plain Enter sends, matching the single-line input's old behavior.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    };
    send.onclick = () => void submit();

    row.appendChild(input);
    row.appendChild(send);
    wrap.appendChild(row);

    return wrap;
  }

  /**
   * Examples of what chat understands, as chips that load the text into the box rather
   * than sending it. Loading rather than sending is the point: the value of "Add a kitchen
   * of 8 x 5 feet" is learning that a size can be stated at all, and the user almost never
   * wants those exact numbers — so the example arrives editable, with the cursor in it.
   *
   * The list is EXAMPLE_REQUESTS from core, shared with the message shown when a turn
   * fails; every entry there is resolved by the deterministic layers, so these keep
   * working even with no inference tier available.
   */
  private renderExampleChips(input: HTMLTextAreaElement, chatDisabled: boolean): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "chat-examples";

    const label = document.createElement("span");
    label.className = "chat-examples-label";
    label.textContent = "Try:";
    wrap.appendChild(label);

    for (const example of EXAMPLE_REQUESTS) {
      const chip = document.createElement("button");
      chip.className = "example-chip";
      chip.type = "button";
      chip.textContent = example.text;
      chip.title = example.hint;
      chip.disabled = chatDisabled || this.chatBusy;
      chip.onclick = () => {
        input.value = example.text;
        input.focus();
        // Cursor at the end, so typing continues the sentence instead of replacing it.
        input.setSelectionRange(example.text.length, example.text.length);
      };
      wrap.appendChild(chip);
    }

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
    const tree = generatorTree(level);
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
    // FR-19: DXF is the way into DWG-native tools; .dwg itself is never offered. DXF, PDF,
    // IFC and glTF are all dynamically imported (NFR-2): none of them is needed for first
    // paint, and IFC/glTF in particular are Phase 3 additions with real code weight.
    const dxf = addButton("DXF", () =>
      void import("@floorcraft/core/dxfExport").then(({ exportDxf }) =>
        downloadBlob(exportDxf(this.store.doc), `${title}.dxf`, "application/dxf"),
      ),
    );
    dxf.title = "DXF R12 — imports into LibreCAD, QCAD, AutoCAD and SketchUp (and is the route into DWG tools)";
    addButton("PDF", () =>
      void import("@floorcraft/core/pdfExport").then(({ exportPdf }) =>
        downloadBlob(exportPdf(this.store.doc, { paperSize: this.paperSize }), `${title}.pdf`, "application/pdf"),
      ),
    );
    const ifc = addButton("IFC", () =>
      void import("@floorcraft/core/ifcExport").then(({ exportIfc }) =>
        downloadBlob(exportIfc(this.store.doc), `${title}.ifc`, "application/x-step"),
      ),
    );
    ifc.title = "IFC4 SPF — verify in your BIM tool before relying on it; see the README's manual smoke-test note";
    addButton("glTF", () =>
      void import("@floorcraft/core/gltfExport").then(({ exportGltf }) =>
        downloadBlob(exportGltf(this.store.doc), `${title}.glb`, "model/gltf-binary"),
      ),
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

    // Detached/freeform editing (DM-2, FR-11): a level either follows the generated
    // layout or has been detached into a direct rectangle-union, never both.
    if (level.generator?.kind === "freeform") {
      const restore = addButton("Restore generated layout", () => void this.runManual([{ op: "reattachGenerator" }]));
      restore.title = "Discard freeform edits and go back to the generated layout";
      const freeformBadge = document.createElement("span");
      freeformBadge.className = "freeform-badge";
      freeformBadge.textContent = "Freeform";
      toolbar.appendChild(freeformBadge);
    } else if (generatorTree(level)) {
      const detach = addButton("Switch to freeform editing", () => void this.runManual([{ op: "detachGenerator" }]));
      detach.title = "Edit walls and rooms directly, including L-shapes — chat layout commands become limited";
    }

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

    // Stair alignment (D2): a mismatch is a warning, never a solve failure — the plan
    // still renders, and a one-click fix is offered right next to it.
    for (const warning of checkStairAlignment(this.store.doc)) {
      const banner = document.createElement("div");
      banner.className = "stair-warning";
      banner.textContent = `⚠ ${warning.message}`;
      if (warning.levelIds.includes(level.id)) {
        const fix = document.createElement("button");
        fix.textContent = "Align to neighbouring level";
        fix.onclick = () => {
          const plan = planStairAlignmentOnActiveLevel(this.store.doc, warning.coreName);
          if (!plan.ok) {
            this.error = plan.reason;
            this.render();
            return;
          }
          void this.runManual(plan.ops);
        };
        banner.appendChild(fix);
      }
      toolbar.appendChild(banner);
    }

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
