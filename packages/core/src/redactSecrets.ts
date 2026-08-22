// Shared secret redaction — specs.md SEC-5 ("a shared error-serialization helper, not
// per call site") and T2-3/T3-2 (a connected key must never appear in an error, log, or
// telemetry). Originally Worker-only (SEC-5 was written with only the Worker's own
// errors in mind); Tiers 2 and 3 now put provider keys in the browser too, so any error
// message built from a failed fetch — theirs or the Worker's — has to pass through the
// same helper. Pure string transform, no platform dependency (usable from the Worker,
// the client, or a test).

const KEY_PATTERNS: RegExp[] = [
  // "sk-" covers OpenAI (sk-...), Anthropic (sk-ant-...) and OpenRouter (sk-or-v1-...)
  // alike — they share the prefix shape, and one broad pattern is less to keep in sync
  // than one per provider as new prefixes show up.
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}
