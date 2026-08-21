// Native JSON export/import — specs.md §6.4 (FR-16 Phase 1 row: "Native JSON").
// Round-trippable: exportJson(doc) then importJson(...) reproduces an equal document.
// Migrations for older minor versions register here (DM-3).

import { SCHEMA_VERSION, type PlanDocument } from "./types.js";

export function exportJson(doc: PlanDocument): string {
  return JSON.stringify(doc, null, 2);
}

export type ImportResult = { ok: true; doc: PlanDocument } | { ok: false; error: string };

const migrations: Record<number, (doc: any) => any> = {
  // Register migrations here as schemaVersion minor bumps ship, e.g. `1: (doc) => ({...doc, newField: default})`.
};

export function importJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Document is not an object" };
  }
  const doc = parsed as Record<string, unknown>;
  const version = doc.schemaVersion;
  if (typeof version !== "number") {
    return { ok: false, error: "Missing schemaVersion" };
  }
  const majorOfDoc = Math.trunc(version);
  const majorSupported = Math.trunc(SCHEMA_VERSION);
  if (majorOfDoc > majorSupported) {
    return { ok: false, error: `Unsupported schema version ${version}; this build supports up to ${SCHEMA_VERSION}` };
  }

  let migrated: any = doc;
  let v = majorOfDoc;
  while (v < majorSupported) {
    const migrate = migrations[v];
    if (!migrate) break;
    migrated = migrate(migrated);
    v++;
  }
  migrated.schemaVersion = SCHEMA_VERSION;

  if (!Array.isArray(migrated.levels) || typeof migrated.activeLevelId !== "string" || typeof migrated.id !== "string") {
    return { ok: false, error: "Document is missing required fields" };
  }

  return { ok: true, doc: migrated as PlanDocument };
}
