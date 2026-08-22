// Thin Cloudflare Worker — specs.md §2 ARC-1..ARC-3, §8.3. Static assets, feature
// flags, the Tier 1 inference proxy, and plan document CRUD. Plan bodies are stored and
// returned as opaque text and are never parsed (ARC-1); the AI response body is never
// buffered beyond relaying it (T1-6).

import type { Env } from "./env";
import { verifyTurnstile } from "./turnstile";
import { checkQuota, hashClientBucketKey, pruneOldQuotaRows, recordTurn } from "./quota";
import { isRateLimited, PLAN_WRITE_LIMIT } from "./rateLimiter";
import { readClientId, setClientIdCookie } from "./cookies";
import { errorResponse } from "./redact";
import { handlePlans } from "./plans";

// Workers AI retires models on a published schedule, and a retired id fails the whole
// request (the previous default was deprecated out from under this Worker mid-flight).
// Candidates are tried in order so a future retirement degrades to the next model
// instead of taking Tier 1 down; TIER1_MODEL, when set, is tried first.
const MODEL_CANDIDATES = ["@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.2-1b-instruct"];
const DEFAULT_MODEL = MODEL_CANDIDATES[0]!;
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
      // The client only offers cloud sync and share links when D1 is actually bound;
      // without it, editing carries on against IndexedDB alone (ARC-3, RTE-4's spirit).
      cloudSyncEnabled: Boolean(env.DB) && env.CLOUD_SYNC_ENABLED !== "false",
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function handleInfer(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return errorResponse("Tier 1 is not configured on this deployment", 503);
  }

  const ip = getIp(request);
  if (isRateLimited(`infer:${ip}`)) {
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

  const models = env.TIER1_MODEL ? [env.TIER1_MODEL, ...MODEL_CANDIDATES.filter((m) => m !== env.TIER1_MODEL)] : MODEL_CANDIDATES;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let aiResult: unknown;
  let firstError: Error | null = null;
  for (const model of models) {
    try {
      aiResult = await env.AI.run(model, { messages, stream: true });
      break;
    } catch (e) {
      // Keep the first failure: it names the configured model, which is the one worth
      // fixing. Later candidates are only a safety net.
      firstError ??= e as Error;
    }
  }
  if (!aiResult) {
    return errorResponse(`Inference failed: ${firstError?.message ?? "no model available"}`, 502);
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
    if (url.pathname.startsWith("/api/plans")) {
      if (env.CLOUD_SYNC_ENABLED === "false") return errorResponse("Cloud sync is disabled on this deployment", 503);
      const ip = getIp(request);
      if (request.method !== "GET" && isRateLimited(`plans:${ip}`, PLAN_WRITE_LIMIT)) {
        return errorResponse("Too many requests", 429, { reason: "rate_limited" });
      }
      // A plan's owner is identified by the same client cookie the quota uses; a first
      // save mints it, and the response has to carry it back or the next save is a
      // different owner.
      let clientId = readClientId(request);
      let mintedCookie = false;
      if (!clientId) {
        clientId = crypto.randomUUID();
        mintedCookie = true;
      }
      const response = await handlePlans(request, env, url, clientId);
      if (!response) return errorResponse("Not found", 404);
      if (!mintedCookie) return response;
      const headers = new Headers(response.headers);
      setClientIdCookie(headers, clientId);
      return new Response(response.body, { status: response.status, headers });
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
