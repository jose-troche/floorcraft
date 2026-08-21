// Tier setup and routing — specs.md §5.4 (RTE-1..RTE-4). Tier 0 on-device first,
// Tier 1 hosted pool second, else no provider — and the app must keep working
// as a manual editor when neither is available.

import { Tier0Provider, Tier1Provider, type Availability, type PlanProvider } from "@floorcraft/core";
import { getTurnstileToken, initTurnstile } from "./turnstile";

export type ProviderId = "tier0-on-device" | "tier1-hosted";

export type ProviderState = {
  activeId: ProviderId | null;
  tier0Availability: Availability;
  tier1Availability: Availability;
};

type ConfigResponse = {
  turnstileSiteKey?: string;
  tier1Enabled?: boolean;
};

export class ProviderManager {
  readonly tier0 = new Tier0Provider();
  tier1: Tier1Provider | null = null;

  private activeId: ProviderId | null = null;
  private listeners: Array<(s: ProviderState) => void> = [];
  private tier0Availability: Availability = "unavailable";
  private tier1Availability: Availability = "unavailable";

  async init(): Promise<void> {
    let config: ConfigResponse = {};
    try {
      const res = await fetch("/api/config");
      if (res.ok) config = await res.json();
    } catch {
      // No worker reachable (e.g. static-only preview) — Tier 1 simply stays unavailable.
    }

    if (config.tier1Enabled && config.turnstileSiteKey) {
      await initTurnstile(config.turnstileSiteKey);
      this.tier1 = new Tier1Provider({ getTurnstileToken: () => getTurnstileToken() });
    }

    await this.refreshAvailability();
    this.autoSelect();
  }

  async refreshAvailability(): Promise<void> {
    this.tier0Availability = await this.tier0.availability();
    this.tier1Availability = this.tier1 ? await this.tier1.availability() : "unavailable";
    this.emit();
  }

  /** RTE-1: Tier 0 if available, else Tier 1 if quota remains, else none. */
  autoSelect(): void {
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
    this.activeId = id;
    this.emit();
  }

  getActiveProvider(): PlanProvider | null {
    if (this.activeId === "tier0-on-device") return this.tier0;
    if (this.activeId === "tier1-hosted") return this.tier1;
    return null;
  }

  getState(): ProviderState {
    return { activeId: this.activeId, tier0Availability: this.tier0Availability, tier1Availability: this.tier1Availability };
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
