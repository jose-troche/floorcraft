/**
 * Parses a model's response without throwing. Unparseable output is returned as-is so
 * the orchestrator's validator reports it as a normal validation failure and gets its
 * one repair retry (INF-4) — a throw here would skip that and kill the turn outright.
 *
 * Also tolerates the most common wrapper a chat model adds despite being told not to:
 * a ```json fenced block around the object.
 */
export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    return unfenced;
  }
}
