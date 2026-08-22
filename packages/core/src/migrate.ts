// Document normalization for shape changes that predate schemaVersion bumps (DM-3).
// Phase 3 changed Level.generator from `{tree, detached?}` to a `{kind: "slicing"|
// "freeform", ...}` tagged union (types.ts). importJson already had a migration
// mechanism for schemaVersion changes, but IndexedDB documents (store.ts) and shared
// documents (the share-link adopt path) load their PlanDocument unchanged — without
// this, an old-shaped generator would silently read as "no layout" the moment
// generatorTree()'s `kind` check ran, because the old shape has no `kind` field at all.
// Call this on every load path, not just importJson.

import type { Generator, Level, PlanDocument, SlicingTree } from "./types.js";

type LegacyGenerator = { tree?: SlicingTree; detached?: boolean };

function normalizeGenerator(raw: unknown): Generator | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if ("kind" in raw) return raw as Generator;
  const legacy = raw as LegacyGenerator;
  // The pre-Phase-3 reducer never actually produced `detached: true` (freeform editing
  // didn't exist yet) — the only real legacy shape is a bare `{tree}`.
  return legacy.tree ? { kind: "slicing", tree: legacy.tree } : undefined;
}

export function normalizeDocument(doc: PlanDocument): PlanDocument {
  let changed = false;
  const levels = doc.levels.map((level): Level => {
    const generator = level.generator as unknown;
    if (!generator || "kind" in (generator as object)) return level;
    changed = true;
    return { ...level, generator: normalizeGenerator(generator) };
  });
  return changed ? { ...doc, levels } : doc;
}
