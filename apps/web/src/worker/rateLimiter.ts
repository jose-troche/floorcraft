// IP rate limit — specs.md SEC-1 (10 req/min on /api/infer, independent of the daily
// quota). Buckets are keyed by caller-supplied strings so different endpoints can meter
// the same IP separately.
// Best-effort, in-isolate only: Workers don't share memory across isolates, so
// this catches bursts within one isolate's lifetime; the D1 daily quota (T1-3/T1-4)
// is the actual hard backstop and is exact regardless of isolate topology.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
/**
 * Plan writes are an autosave path, not a paid one: a normal editing session fires one
 * every few seconds per tab, so the inference ceiling would trip on ordinary use.
 */
export const PLAN_WRITE_LIMIT = 60;
const buckets = new Map<string, number[]>();

export function isRateLimited(key: string, maxPerWindow = MAX_PER_WINDOW): boolean {
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= maxPerWindow) {
    buckets.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
  if (buckets.size > 5000) {
    // Cheap guard against unbounded growth within a long-lived isolate.
    const oldestKey = buckets.keys().next().value;
    if (oldestKey) buckets.delete(oldestKey);
  }
  return false;
}
