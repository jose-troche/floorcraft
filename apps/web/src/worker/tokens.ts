// Capability tokens for plan sharing — specs.md SEC-3 (>= 128 bits of entropy, stored
// hashed) and FR-14 (read-only share links, optional edit token).

/** 24 bytes = 192 bits, comfortably over SEC-3's floor. */
const TOKEN_BYTES = 24;

export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two hex digests without an early exit. The values being compared are hashes
 * rather than the tokens themselves, so a timing leak here is already weak — but a
 * constant-time compare costs nothing and removes the question.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashOwner(salt: string, clientId: string): Promise<string> {
  return hashToken(`${salt}:owner:${clientId}`);
}
