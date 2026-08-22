// Plan store — specs.md ARC-3 (client authoritative for session state), FR-12
// (autosave to IndexedDB on every applied patch), FR-13 (debounced sync to D1), FR-14
// (share links), FR-15 (last 50 patches for undo).

import {
  applyPatch,
  createEmptyPlan,
  formatAppliedTurn,
  resolveTurn,
  type Patch,
  type PatchOp,
  type PlanDocument,
  type PlanProvider,
  type Turn,
} from "@floorcraft/core";
import { PlanSync, type CloudRef, type SyncStatus } from "./sync";

const DB_NAME = "floorcraft";
const DB_VERSION = 1;
const PLAN_STORE = "plans";
const META_STORE = "meta";
const HISTORY_LIMIT = 50;

type StoredRecord = {
  id: string;
  doc: PlanDocument;
  chatHistory: Turn[];
  undoStack: PlanDocument[];
  redoStack: PlanDocument[];
  /** Set once the plan has been saved to D1; absent for a purely local plan. */
  cloudRef?: CloudRef;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PLAN_STORE)) db.createObjectStore(PLAN_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type TurnResult =
  | { kind: "applied"; changes: string[]; narration?: string }
  | { kind: "noop" }
  | { kind: "error"; message: string };

export class PlanStore {
  private db: IDBDatabase | null = null;
  private record: StoredRecord;
  private provider: PlanProvider | null = null;
  private listeners: Array<() => void> = [];
  private sync: PlanSync | null = null;
  private readOnlyReason: string | null = null;

  private constructor(record: StoredRecord) {
    this.record = record;
  }

  static async load(): Promise<PlanStore> {
    const db = await openDb();
    const meta = await idbGet<{ key: string; lastPlanId: string }>(db, META_STORE, "app");
    let record: StoredRecord | undefined;
    if (meta?.lastPlanId) {
      record = await idbGet<StoredRecord>(db, PLAN_STORE, meta.lastPlanId);
    }
    if (!record) {
      const id = crypto.randomUUID();
      const doc = createEmptyPlan({
        id,
        title: "Untitled Plan",
        units: "imperial",
        boundary: { widthMm: 9144, depthMm: 12192 }, // 30x40 ft, a reasonable single-family default
      });
      record = { id, doc, chatHistory: [], undoStack: [], redoStack: [] };
    }
    const store = new PlanStore(record);
    store.db = db;
    await store.persist();
    return store;
  }

  /**
   * Adopts a plan opened from a share link (FR-14). A read-only link is kept out of the
   * local plan list entirely: it belongs to whoever sent it, and quietly taking ownership
   * of someone else's plan on open would be the wrong default.
   */
  async adoptShared(input: { doc: PlanDocument; access: "read" | "edit"; id: string; token: string }): Promise<void> {
    this.record = {
      id: input.doc.id,
      doc: input.doc,
      chatHistory: [],
      undoStack: [],
      redoStack: [],
      cloudRef: input.access === "edit" ? { id: input.id, editToken: input.token, shareToken: "" } : undefined,
    };
    this.readOnlyReason = input.access === "read" ? "You are viewing a shared plan. Export a copy to edit it." : null;
    if (input.access === "edit") await this.persist();
    this.emit();
  }

  attachSync(sync: PlanSync): void {
    this.sync = sync;
  }

  getSync(): PlanSync | null {
    return this.sync;
  }

  get readOnly(): boolean {
    return this.readOnlyReason !== null;
  }

  get readOnlyMessage(): string | null {
    return this.readOnlyReason;
  }

  get cloudRef(): CloudRef | null {
    return this.record.cloudRef ?? null;
  }

  async setCloudRef(ref: CloudRef): Promise<void> {
    this.record.cloudRef = ref;
    await this.persist();
  }

  setProvider(provider: PlanProvider | null): void {
    this.provider = provider;
  }

  get doc(): PlanDocument {
    return this.record.doc;
  }
  get chatHistory(): readonly Turn[] {
    return this.record.chatHistory;
  }
  get canUndo(): boolean {
    return this.record.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.record.redoStack.length > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private async persist(): Promise<void> {
    if (!this.db) return;
    await idbPut(this.db, PLAN_STORE, this.record);
    await idbPut(this.db, META_STORE, { key: "app", lastPlanId: this.record.id });
  }

  private pushUndo(prevDoc: PlanDocument): void {
    this.record.undoStack.push(prevDoc);
    if (this.record.undoStack.length > HISTORY_LIMIT) this.record.undoStack.shift();
    this.record.redoStack = [];
  }

  /** Direct manual edit (toolbar), bypassing chat/provider entirely — RTE-4's manual-editor path. */
  async applyManual(ops: PatchOp[]): Promise<TurnResult> {
    if (this.readOnly) return { kind: "error", message: this.readOnlyReason! };
    const prevDoc = this.record.doc;
    const result = applyPatch(prevDoc, { ops, source: "user" });
    if (!result.ok) {
      const message = result.violations?.map((v) => v.message).join(" ") ?? result.errors.join("; ");
      return { kind: "error", message };
    }
    this.pushUndo(prevDoc);
    this.record.doc = result.doc;
    await this.persist();
    this.sync?.schedule({ ops, source: "user" });
    this.emit();
    return { kind: "applied", changes: result.changes };
  }

  async submitChatTurn(utterance: string): Promise<TurnResult> {
    if (this.readOnly) return { kind: "error", message: this.readOnlyReason! };
    const historyBefore = [...this.record.chatHistory];
    this.record.chatHistory.push({ role: "user", text: utterance });

    let outcome: Awaited<ReturnType<typeof resolveTurn>>;
    try {
      outcome = await resolveTurn(this.record.doc, utterance, historyBefore, this.provider);
    } catch (e) {
      // resolveTurn is meant to report failures as an "error" outcome rather than throw;
      // if one ever escapes, it still has to land in the transcript and be persisted, or
      // the user's own message is left dangling with no reply.
      outcome = { kind: "error", message: `Something went wrong: ${(e as Error).message}. Your plan is unchanged.` };
    }

    if (outcome.kind === "undo") {
      const undone = this.undo();
      await this.persist();
      if (undone) this.sync?.schedule();
      this.emit();
      return undone ? { kind: "applied", changes: ["Undone"] } : { kind: "noop" };
    }
    if (outcome.kind === "redo") {
      const redone = this.redo();
      await this.persist();
      if (redone) this.sync?.schedule();
      this.emit();
      return redone ? { kind: "applied", changes: ["Redone"] } : { kind: "noop" };
    }
    if (outcome.kind === "error") {
      this.record.chatHistory.push({ role: "assistant", text: outcome.message });
      await this.persist();
      this.emit();
      return { kind: "error", message: outcome.message };
    }

    this.pushUndo(this.record.doc);
    this.record.doc = outcome.doc;
    const narration = outcome.kind === "provider" ? outcome.narration : undefined;
    const text = formatAppliedTurn({ changes: outcome.changes, narration, warnings: outcome.warnings });
    this.record.chatHistory.push({ role: "assistant", text });
    await this.persist();
    this.sync?.schedule();
    this.emit();
    return { kind: "applied", changes: outcome.changes, narration: outcome.kind === "provider" ? outcome.narration : undefined };
  }

  undo(): boolean {
    if (this.record.undoStack.length === 0) return false;
    const prev = this.record.undoStack.pop()!;
    this.record.redoStack.push(this.record.doc);
    if (this.record.redoStack.length > HISTORY_LIMIT) this.record.redoStack.shift();
    this.record.doc = prev;
    return true;
  }

  redo(): boolean {
    if (this.record.redoStack.length === 0) return false;
    const next = this.record.redoStack.pop()!;
    this.record.undoStack.push(this.record.doc);
    this.record.doc = next;
    return true;
  }

  async undoManual(): Promise<void> {
    if (this.undo()) {
      await this.persist();
      this.sync?.schedule();
      this.emit();
    }
  }

  async redoManual(): Promise<void> {
    if (this.redo()) {
      await this.persist();
      this.sync?.schedule();
      this.emit();
    }
  }

  async replaceDoc(doc: PlanDocument): Promise<void> {
    this.pushUndo(this.record.doc);
    this.record.doc = doc;
    await this.persist();
    this.sync?.schedule();
    this.emit();
  }
}

export type { Patch, SyncStatus };
