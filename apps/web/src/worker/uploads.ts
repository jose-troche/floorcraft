// Raster import storage — specs.md FR-20: "The uploaded image MUST be stored in R2;
// processing MUST NOT occur in a Worker." This module is pure blob storage — upload and
// retrieve — and never looks at the image bytes beyond checking the content type and
// size; every pipeline stage (deskew, threshold, line detection, face traversal) runs in
// the browser (apps/web/src/client/rasterPipeline.ts, packages/core/src/rasterImport.ts).

import type { Env } from "./env";
import { errorResponse } from "./redact";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB — generous for a phone photo or scan
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function handleUploads(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!env.UPLOADS) return errorResponse("Raster import is not configured on this deployment", 503);

  if (url.pathname === "/api/uploads" && request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!ALLOWED_TYPES.has(contentType)) {
      return errorResponse(`Unsupported content type '${contentType}' — expected a JPEG, PNG, or WebP image`, 415);
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) {
      return errorResponse("Image must be non-empty and under 20 MB", 413);
    }

    const id = crypto.randomUUID();
    await env.UPLOADS.put(id, request.body, { httpMetadata: { contentType } });
    return new Response(JSON.stringify({ id }), { status: 201, headers: { "content-type": "application/json" } });
  }

  const getMatch = /^\/api\/uploads\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (getMatch && request.method === "GET") {
    const object = await env.UPLOADS.get(getMatch[1]!);
    if (!object) return errorResponse("Not found", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "private, max-age=3600");
    return new Response(object.body, { headers });
  }

  return null;
}
