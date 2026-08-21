// Cloudflare bindings — specs.md §8.1. Kept loose/minimal on purpose: this Worker
// is a thin pipe (ARC-1) and has no reason to depend on the full Workers AI type
// surface for a single text-generation call.

export interface Env {
  ASSETS: Fetcher;
  AI: { run: (model: string, options: Record<string, unknown>) => Promise<unknown> };
  DB: D1Database;
  ANALYTICS?: { writeDataPoint: (data: Record<string, unknown>) => void };

  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TIER1_ENABLED?: string;
  DAILY_QUOTA_PER_CLIENT?: string;
  GLOBAL_NEURON_BUDGET?: string;
  QUOTA_SALT?: string;
  TIER1_MODEL?: string;
}
