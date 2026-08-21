// Provider interface — specs.md §5.1 (INF-1). All inference is accessed through
// this single interface; no feature may call a provider directly.

import type { Patch, PlanSummary, ProviderId, Turn } from "../types.js";

export type Availability = "available" | "unavailable" | "downloadable" | "exhausted";

export interface PlanProvider {
  readonly id: ProviderId;
  readonly tier: 0 | 1 | 2 | 3;
  availability(): Promise<Availability>;
  propose(input: { summary: PlanSummary; utterance: string; history: Turn[] }): Promise<Patch>;
}
