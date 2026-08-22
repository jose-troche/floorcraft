/**
 * Parses a model's response without throwing. Unparseable output is returned as-is so
 * the orchestrator's validator reports it as a normal validation failure and gets its
 * one repair retry (INF-4) — a throw here would skip that and kill the turn outright.
 *
 * Also tolerates the two most common wrappers a chat model adds despite being told not
 * to: a ```json fenced block around the object, and a stray lead-in/trailing sentence
 * ("Here's the updated plan: {...}") around otherwise-valid JSON.
 */
export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    const extracted = extractFirstJsonObject(unfenced);
    if (extracted === null) return unfenced;
    try {
      return JSON.parse(extracted);
    } catch {
      return unfenced;
    }
  }
}

/** Scans for the first balanced {...} span, respecting string literals, so prose
 * wrapped around an otherwise-complete object doesn't sink the whole parse. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
