// OpenRouter OAuth PKCE — specs.md T2-1..T2-2. Client-side PKCE was chosen over the
// server-side variant T2-4 prefers "if session infrastructure exists": it doesn't — the
// Worker has only the anonymous quota-bucket cookie (cookies.ts), no login session to
// hold a key behind. Adding one just for this would be a bigger, riskier change than the
// client-side flow it would replace, so this documents the trade-off rather than papering
// over it.
//
// The verifier lives in sessionStorage only for the seconds between redirect-out and
// redirect-back; the exchanged key lives in localStorage, same as Tier 3's BYOK keys
// (T3-2), and never touches the Worker (T2-3).

const VERIFIER_STORAGE_KEY = "fc.tier2.pkce_verifier";
const KEY_STORAGE_KEY = "fc.tier2.openrouter_key";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** T2-1: begins the connect flow by navigating away to OpenRouter. */
export async function beginConnect(): Promise<void> {
  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
  const challenge = await challengeFor(verifier);

  const callbackUrl = new URL(location.href);
  callbackUrl.searchParams.delete("code");
  const authUrl = new URL("https://openrouter.ai/auth");
  authUrl.searchParams.set("callback_url", callbackUrl.toString());
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  location.href = authUrl.toString();
}

/**
 * Completes the flow if the current URL carries OpenRouter's `?code=` redirect. Always
 * strips `code` from the URL via replaceState first — it must never sit in browser
 * history or be sent onward as a referrer, success or failure alike.
 */
export async function completeConnectIfPending(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_STORAGE_KEY);
  sessionStorage.removeItem(VERIFIER_STORAGE_KEY);
  params.delete("code");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);

  if (!verifier) return false; // e.g. the tab was reloaded after the exchange already ran

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new Error(`OpenRouter connect failed: ${res.status}`);
  const body = (await res.json()) as { key?: string };
  if (!body.key) throw new Error("OpenRouter did not return a key");
  localStorage.setItem(KEY_STORAGE_KEY, body.key);
  return true;
}

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE_KEY);
}

/** T2-2: one click, no server round trip — the key only ever lived in this browser. */
export function disconnect(): void {
  localStorage.removeItem(KEY_STORAGE_KEY);
}
