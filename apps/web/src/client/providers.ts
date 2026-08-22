// Tier setup and routing — specs.md §5.4 (RTE-1..RTE-4). Tier 0 on-device first,
// Tier 1 hosted pool second, else no provider — and the app must keep working
// as a manual editor when neither is available. Tiers 2 and 3 (specs.md §5.3
// T2-1..T3-3) are never auto-selected — RTE-1's routing only ever chooses between
// Tier 0, Tier 1, and nothing; connecting Tier 2/3 is always an explicit user action,
// and once connected they're only ever reached via setActive (RTE-2).

import { Tier0Provider, Tier1Provider, Tier2Provider, Tier3Provider, type Availability, type PlanProvider } from "@floorcraft/core";
import { getTurnstileToken, initTurnstile } from "./turnstile";
import { getApiKey as getOpenRouterKey } from "./openrouterAuth";
import { connectedByokVendor, getByokKey, type Tier3Vendor } from "./byokKeys";

export type ProviderId = "tier0-on-device" | "tier1-hosted" | "tier2-openrouter" | "tier3-byok";

export type ProviderState = {
  activeId: ProviderId | null;
  tier0Availability: Availability;
  tier1Availability: Availability;
  tier2Availability: Availability;
  tier3Availability: Availability;
  tier3Vendor: Tier3Vendor | null;
};

type ConfigResponse = {
  turnstileSiteKey?: string;
  tier1Enabled?: boolean;
  cloudSyncEnabled?: boolean;
};

export class ProviderManager {
  readonly tier0 = new Tier0Provider();
  tier1: Tier1Provider | null = null;
  readonly tier2: Tier2Provider;
  tier3: Tier3Provider | null = null;

  private activeId: ProviderId | null = null;
  private listeners: Array<(s: ProviderState) => void> = [];
  private tier0Availability: Availability = "unavailable";
  private tier1Availability: Availability = "unavailable";
  private tier2Availability: Availability = "unavailable";
  private tier3Availability: Availability = "unavailable";
  // Set once the user picks a tier by hand, so a late-arriving Tier 1 can't yank the
  // selection back out from under them mid-session (RTE-2 beats RTE-1).
  private manuallySelected = false;
  /** /api/config as fetched during init; empty until then, and after a failed fetch. */
  private config: ConfigResponse = {};

  constructor() {
    this.tier2 = new Tier2Provider({ getApiKey: () => getOpenRouterKey() });
    this.rebuildTier3();
  }

  async init(): Promise<void> {
    // Tier 0 is the whole reason a first turn can feel instant, and nothing about it
    // needs the network — so probe and warm it *before* awaiting /api/config and the
    // Turnstile script, not after. Sequencing it behind those meant the on-device
    // session only started loading once a third-party script had finished downloading,
    // which is exactly the cold start warmup() exists to hide. The catch is attached now
    // rather than at the await below, which only lands once the network work is done —
    // long enough for a rejection to be reported as unhandled in the meantime.
    const tier0Ready = this.initTier0().catch(() => {});

    let config: ConfigResponse = {};
    try {
      const res = await fetch("/api/config");
      if (res.ok) config = await res.json();
    } catch {
      // No worker reachable (e.g. static-only preview) — Tier 1 simply stays unavailable.
    }
    this.config = config;

    if (config.tier1Enabled && config.turnstileSiteKey) {
      try {
        await initTurnstile(config.turnstileSiteKey);
        this.tier1 = new Tier1Provider({ getTurnstileToken: () => getTurnstileToken() });
      } catch {
        // Turnstile blocked (extension, offline, CSP) means Tier 1 has no token to send,
        // so it stays unavailable — but it must not take Tier 0 or the manual editor
        // down with it, which is what letting this reject did.
      }
    }

    await tier0Ready;
    this.tier1Availability = this.tier1 ? await this.tier1.availability() : "unavailable";
    this.tier2Availability = await this.tier2.availability();
    this.tier3Availability = this.tier3 ? await this.tier3.availability() : "unavailable";
    this.applyAutoSelection();
  }

  /** Probes Tier 0 and starts its session warm-up, publishing the result as soon as it lands. */
  private async initTier0(): Promise<void> {
    this.tier0Availability = await this.tier0.availability();
    if (this.tier0Availability === "available") this.tier0.warmup();
    // Select immediately rather than waiting on Tier 1: when Tier 0 is there it wins
    // outright (RTE-1), so chat can go live while the rest of init is still in flight.
    this.applyAutoSelection();
  }

  /** Rebuilds the Tier 3 provider from whichever vendor's key is currently on file. */
  private rebuildTier3(): void {
    const vendor = connectedByokVendor();
    this.tier3 = vendor ? new Tier3Provider({ vendor, getApiKey: () => getByokKey(vendor) }) : null;
  }

  async refreshAvailability(): Promise<void> {
    this.tier0Availability = await this.tier0.availability();
    if (this.tier0Availability === "available") this.tier0.warmup();
    this.tier1Availability = this.tier1 ? await this.tier1.availability() : "unavailable";
    this.tier2Availability = await this.tier2.availability();
    this.tier3Availability = this.tier3 ? await this.tier3.availability() : "unavailable";
    this.emit();
  }

  /** Call after connecting or disconnecting Tier 2/3, so the picker reflects it immediately. */
  async refreshConnections(): Promise<void> {
    this.rebuildTier3();
    this.tier2Availability = await this.tier2.availability();
    this.tier3Availability = this.tier3 ? await this.tier3.availability() : "unavailable";
    this.emit();
  }

  /** RTE-2: the user explicitly choosing "Auto" — hands routing back to RTE-1. */
  autoSelect(): void {
    this.manuallySelected = false;
    this.applyAutoSelection();
  }

  /** RTE-1's routing (Tier 0 -> Tier 1 -> nothing), but only while the user hasn't
   * overridden it by hand, and never onto Tier 2/3 — those are opt-in only. */
  private applyAutoSelection(): void {
    if (this.manuallySelected) return;
    if (this.tier0Availability === "available") {
      this.activeId = "tier0-on-device";
    } else if (this.tier1 && (this.tier1Availability === "available" || this.tier1Availability === "downloadable")) {
      this.activeId = "tier1-hosted";
    } else {
      this.activeId = null;
    }
    this.emit();
  }

  /** RTE-2: manual override, always available regardless of auto-selection. */
  setActive(id: ProviderId | null): void {
    this.manuallySelected = true;
    this.activeId = id;
    this.emit();
  }

  getActiveProvider(): PlanProvider | null {
    if (this.activeId === "tier0-on-device") return this.tier0;
    if (this.activeId === "tier1-hosted") return this.tier1;
    if (this.activeId === "tier2-openrouter") return this.tier2Availability === "available" ? this.tier2 : null;
    if (this.activeId === "tier3-byok") return this.tier3Availability === "available" ? this.tier3 : null;
    return null;
  }

  /** Feature flags from the Worker. Cloud sync and share links are gated on these. */
  getConfig(): ConfigResponse {
    return this.config;
  }

  getState(): ProviderState {
    return {
      activeId: this.activeId,
      tier0Availability: this.tier0Availability,
      tier1Availability: this.tier1Availability,
      tier2Availability: this.tier2Availability,
      tier3Availability: this.tier3Availability,
      tier3Vendor: connectedByokVendor(),
    };
  }

  subscribe(fn: (s: ProviderState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    const s = this.getState();
    for (const fn of this.listeners) fn(s);
  }
}
