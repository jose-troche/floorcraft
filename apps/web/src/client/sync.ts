// Cloud persistence and share links — specs.md FR-13 (debounced sync to D1, plus a
// flush on visibilitychange → hidden), FR-14 (unguessable share URL, read-only by
// default with an optional edit token), FR-15 (patch history retained server-side).
//
// The client stays authoritative (ARC-3): IndexedDB is the source of truth for the
// session and D1 is a copy. Every failure here is non-fatal by construction — a plan
// that cannot reach the server is still fully editable and exportable.

import { exportJson, importJson, type Patch, type PlanDocument } from "@floorcraft/core";

/** FR-13's floor. Chosen at the floor because a plan lost to a closed tab is the failure. */
const IDLE_DEBOUNCE_MS = 5_000;

export type CloudRef = { id: string; editToken: string; shareToken: string };

export type SyncStatus =
  | { state: "off" }
  | { state: "idle" }
  | { state: "pending" }
  | { state: "saving" }
  | { state: "saved"; at: number }
  | { state: "error"; message: string };

export type SyncOptions = {
  enabled: boolean;
  getDoc: () => PlanDocument;
  getRef: () => CloudRef | null;
  saveRef: (ref: CloudRef) => Promise<void>;
  onStatus?: (status: SyncStatus) => void;
};

export class PlanSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  /** Set when a flush is requested while one is already running; drives the re-run below. */
  private flushAgain = false;
  private queuedPatches: Patch[] = [];
  private status: SyncStatus;

  constructor(private options: SyncOptions) {
    this.status = options.enabled ? { state: "idle" } : { state: "off" };
    if (!options.enabled) return;

    // A tab being hidden is the last reliable moment to save; on mobile it is often the
    // only notice before the process is discarded, so `hidden` flushes immediately.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flush({ keepalive: true });
    });
    window.addEventListener("pagehide", () => void this.flush({ keepalive: true }));
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  /** Called after every applied patch. Restarts the idle window rather than extending it. */
  schedule(patch?: Patch): void {
    if (!this.options.enabled) return;
    if (patch) {
      this.queuedPatches.push(patch);
      // Nothing downstream reads more than the retained window, and an unbounded queue
      // would grow through a long offline stretch.
      if (this.queuedPatches.length > 50) this.queuedPatches.shift();
    }
    if (this.timer) clearTimeout(this.timer);
    this.setStatus({ state: "pending" });
    this.timer = setTimeout(() => void this.flush(), IDLE_DEBOUNCE_MS);
  }

  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (!this.options.enabled) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Serialise: two overlapping PUTs of the same plan can land out of order. A request
    // that arrives mid-flight is remembered rather than dropped — the running flush read
    // the document before that edit existed, so merely joining it would lose the edit.
    if (this.inFlight) {
      this.flushAgain = true;
      return this.inFlight;
    }
    this.inFlight = this.doFlush(options).finally(() => {
      this.inFlight = null;
      if (this.flushAgain) {
        this.flushAgain = false;
        void this.flush(options);
      }
    });
    return this.inFlight;
  }

  private async doFlush(options: { keepalive?: boolean }): Promise<void> {
    const doc = this.options.getDoc();
    const body = exportJson(doc);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-fc-title": encodeURIComponent(doc.title),
      "x-fc-schema-version": String(doc.schemaVersion),
    };

    this.setStatus({ state: "saving" });
    try {
      let ref = this.options.getRef();
      if (!ref) {
        const created = await fetch("/api/plans", { method: "POST", headers, body, keepalive: options.keepalive });
        if (!created.ok) throw new SyncFailure(await describe(created));
        ref = (await created.json()) as CloudRef;
        await this.options.saveRef(ref);
      } else {
        const saved = await fetch(`/api/plans/${ref.id}`, {
          method: "PUT",
          headers: { ...headers, "x-fc-token": ref.editToken },
          body,
          keepalive: options.keepalive,
        });
        if (!saved.ok) throw new SyncFailure(await describe(saved));
      }

      const patches = this.queuedPatches;
      this.queuedPatches = [];
      for (const patch of patches) {
        // Version history is a nice-to-have on top of a saved document; a failure here
        // must not report the document itself as unsaved.
        await fetch(`/api/plans/${ref.id}/versions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-fc-token": ref.editToken },
          body: JSON.stringify(patch),
          keepalive: options.keepalive,
        }).catch(() => {});
      }

      this.setStatus({ state: "saved", at: Date.now() });
    } catch (e) {
      const message = e instanceof SyncFailure ? e.message : "the server could not be reached";
      this.setStatus({ state: "error", message });
    }
  }

  /** FR-14: a read-only link by default, and an edit link only if explicitly asked for. */
  async shareLinks(): Promise<{ readOnly: string; edit: string }> {
    await this.flush();
    const ref = this.options.getRef();
    if (!ref) {
      // The flush above already worked out why there is nothing to link to. Falling back
      // to "not saved yet" here would report a failed save as a deliberate one.
      if (this.status.state === "error") throw new Error(this.status.message);
      throw new Error("This plan has not been saved to the cloud yet.");
    }
    const base = `${location.origin}${location.pathname}`;
    return {
      readOnly: `${base}?plan=${ref.id}&t=${ref.shareToken}`,
      edit: `${base}?plan=${ref.id}&t=${ref.editToken}`,
    };
  }
}

/** Carries a message already phrased for a user; see doFlush's catch. */
class SyncFailure extends Error {}

/**
 * The Worker writes its own errors for a person to read ("Too many requests"), so those
 * pass through. Everything else is described by status class — "500 Internal Server
 * Error" tells the user nothing they can act on.
 */
async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Fall through to the phrase for this status class.
  }
  if (response.status === 429) return "too many saves in a row — wait a moment and try again";
  if (response.status === 413) return "this plan is too large to save to the cloud";
  if (response.status >= 500) return "the server could not save this plan";
  return "the server would not accept this plan";
}

export type OpenedShare = { doc: PlanDocument; access: "read" | "edit"; id: string; token: string };

/** Reads `?plan=…&t=…` off the URL, if present. */
export function readShareParams(): { id: string; token: string } | null {
  const params = new URLSearchParams(location.search);
  const id = params.get("plan");
  const token = params.get("t");
  return id && token ? { id, token } : null;
}

/**
 * Fetches a shared plan. The server reports which access the token granted, so an edit
 * link opens editable and a share link opens read-only without the client deciding.
 */
export async function fetchSharedPlan(id: string, token: string): Promise<OpenedShare> {
  const response = await fetch(`/api/plans/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(await describe(response));
  const text = await response.text();
  const parsed = importJson(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const access = response.headers.get("x-fc-access") === "edit" ? "edit" : "read";
  return { doc: parsed.doc, access, id, token };
}
