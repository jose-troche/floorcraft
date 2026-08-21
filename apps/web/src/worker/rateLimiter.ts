// IP rate limit — specs.md SEC-1 (10 req/min, independent of the daily quota).
// Best-effort, in-isolate only: Workers don't share memory across isolates, so
// this catches bursts within one isolate's lifetime; the D1 daily quota (T1-3/T1-4)
// is the actual hard backstop and is exact regardless of isolate topology.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const buckets = new Map<string, number[]>();

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (buckets.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_PER_WINDOW) {
    buckets.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  buckets.set(ip, timestamps);
  if (buckets.size > 5000) {
    // Cheap guard against unbounded growth within a long-lived isolate.
    const oldestKey = buckets.keys().next().value;
    if (oldestKey) buckets.delete(oldestKey);
  }
  return false;
}
