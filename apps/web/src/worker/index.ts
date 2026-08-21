// Thin Cloudflare Worker — specs.md §2 ARC-1..ARC-3, §8.3. Static assets, feature
// flags, and the Tier 1 inference proxy. Never parses plan documents (there is no
// /api/plans endpoint in Phase 1 — persistence is IndexedDB-only per the phasing
// table) and never buffers the AI response body beyond relaying it (T1-6).

import type { Env } from "./env";
import { verifyTurnstile } from "./turnstile";
import { checkQuota, hashClientBucketKey, pruneOldQuotaRows, recordTurn } from "./quota";
import { isRateLimited } from "./rateLimiter";
import { readClientId, setClientIdCookie } from "./cookies";
import { errorResponse } from "./redact";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_INFER_BODY_BYTES = 100_000;

function getIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

async function handleConfig(env: Env): Promise<Response> {
  const tier1Enabled = env.TIER1_ENABLED !== "false" && Boolean(env.TURNSTILE_SITE_KEY);
  return new Response(
    JSON.stringify({
      tier1Enabled,
      turnstileSiteKey: tier1Enabled ? env.TURNSTILE_SITE_KEY : undefined,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function handleInfer(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return errorResponse("Tier 1 is not configured on this deployment", 503);
  }

  const ip = getIp(request);
  if (isRateLimited(ip)) {
    return errorResponse("Too many requests", 429, { reason: "rate_limited" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INFER_BODY_BYTES) {
    return errorResponse("Request body too large", 413);
  }

  let body: { system?: string; user?: string; turnstileToken?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { system, user, turnstileToken } = body;
  if (!system || !user || !turnstileToken) {
    return errorResponse("Missing system, user, or turnstileToken", 400);
  }

  const verified = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
  if (!verified) {
    return errorResponse("Turnstile verification failed", 403);
  }

  const responseHeaders = new Headers();
  let clientId = readClientId(request);
  if (!clientId) {
    clientId = crypto.randomUUID();
    setClientIdCookie(responseHeaders, clientId);
  }

  const bucketKey = await hashClientBucketKey(env, clientId, ip);
  const quotaCheck = await checkQuota(env, bucketKey);
  if (!quotaCheck.ok) {
    responseHeaders.set("content-type", "application/json");
    return new Response(JSON.stringify({ reason: quotaCheck.reason }), { status: 429, headers: responseHeaders });
  }

  // Neuron cost isn't known until the model finishes; log a cheap estimate from
  // prompt size now rather than inspecting the streamed response body (T1-6).
  const estimatedNeurons = Math.max(1, Math.ceil((system.length + user.length) / 4));
  await recordTurn(env, bucketKey, estimatedNeurons);
  env.ANALYTICS?.writeDataPoint({
    blobs: [DEFAULT_MODEL],
    doubles: [estimatedNeurons],
    indexes: [bucketKey.slice(0, 16)],
  });

  const model = env.TIER1_MODEL ?? DEFAULT_MODEL;
  let aiResult: unknown;
  try {
    aiResult = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
    });
  } catch (e) {
    return errorResponse(`Inference failed: ${(e as Error).message}`, 502);
  }

  responseHeaders.set("content-type", "text/event-stream");
  responseHeaders.set("cache-control", "no-store");
  return new Response(aiResult as ReadableStream, { headers: responseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return handleConfig(env);
    }
    if (url.pathname === "/api/infer" && request.method === "POST") {
      return handleInfer(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return errorResponse("Not found", 404);
    }

    return env.ASSETS.fetch(request);
  },

  // CF-5: prune quota rows older than 7 days. Configure a cron trigger in wrangler.toml.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await pruneOldQuotaRows(env);
  },
};
