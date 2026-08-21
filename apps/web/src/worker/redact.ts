// Shared redaction helper — specs.md SEC-5. Every error response passes through
// this before leaving the Worker, so a key leak can't happen per-call-site.

const KEY_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{16,}/g, // OpenAI-style
  /sk-ant-[a-zA-Z0-9-]{16,}/g, // Anthropic-style
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /or-[a-zA-Z0-9]{16,}/g, // OpenRouter-style
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

export function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: redact(message), ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
