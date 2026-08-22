// Tier 3 BYOK key storage — specs.md T3-2: localStorage only, never sent to the origin
// server. One slot per vendor so switching vendors doesn't discard the others' keys, but
// the UI only ever connects one at a time (see ui.ts's Tier 3 picker).

export type Tier3Vendor = "anthropic" | "openai" | "google";

const VENDORS: readonly Tier3Vendor[] = ["anthropic", "openai", "google"];

function storageKey(vendor: Tier3Vendor): string {
  return `fc.tier3.${vendor}.key`;
}

export function getByokKey(vendor: Tier3Vendor): string | null {
  return localStorage.getItem(storageKey(vendor));
}

export function setByokKey(vendor: Tier3Vendor, key: string): void {
  localStorage.setItem(storageKey(vendor), key);
}

export function clearByokKey(vendor: Tier3Vendor): void {
  localStorage.removeItem(storageKey(vendor));
}

/** Whichever vendor currently has a key on file, if any — the UI treats Tier 3 as one
 * connected vendor at a time even though each vendor's key is stored separately. */
export function connectedByokVendor(): Tier3Vendor | null {
  return VENDORS.find((v) => getByokKey(v) !== null) ?? null;
}
