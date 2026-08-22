// Shared redaction helper — specs.md SEC-5. Every error response passes through
// this before leaving the Worker, so a key leak can't happen per-call-site. The pattern
// list itself lives in @floorcraft/core (packages/core/src/redactSecrets.ts) so the
// client's Tier 2/3 error paths use the exact same rules, not a second copy that can
// drift (T2-3, T3-2).

import { redactSecrets } from "@floorcraft/core";

export function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: redactSecrets(message), ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
