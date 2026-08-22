// Security headers — specs.md SEC-4. The Worker must set a strict CSP, and Tier 2/3's
// direct-to-provider calls (T2-1, T3-3) must be reflected in connect-src or the browser
// blocks them outright even though they never touch this Worker. No inline scripts or
// styles exist anywhere in the client (index.html, ui.ts, svgRenderer.ts all avoid them),
// so this stays free of 'unsafe-inline'.
//
// Known gap: by default, Cloudflare serves anything matching a file under `[assets]`
// (index.html, the JS/CSS bundles) directly, without invoking this Worker at all — so
// this header currently reaches /api/* responses only, not the HTML page itself. Closing
// that gap needs `run_worker_first = true` in wrangler.toml, which routes every asset
// request through the Worker first (this function would then wrap env.ASSETS.fetch's
// response too) — at the cost of moving asset traffic onto the Workers Free tier's
// request quota instead of the ASSETS binding's unbilled/unlimited path (specs.md §8.1).
// Deliberately left off for now; revisit if CSP coverage on the page itself becomes a
// requirement rather than a nice-to-have.

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "frame-src https://challenges.cloudflare.com",
  // Tier 1 goes through this Worker ('self'); Tiers 2/3 call their providers directly
  // from the browser (T2-1, T3-3) and need their own origins here or the browser's own
  // CSP — not just this Worker's absence from the request path — blocks them.
  "connect-src 'self' https://openrouter.ai https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
