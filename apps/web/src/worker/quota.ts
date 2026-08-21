// D1-backed quota — specs.md T1-3, T1-4, CF-4. One row per (bucket, day); every
// increment is a single INSERT ... ON CONFLICT DO UPDATE.

import type { Env } from "./env";

export const GLOBAL_BUCKET = "GLOBAL";

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

async function readTurnsAndNeurons(db: D1Database, bucketKey: string, day: string): Promise<{ turns: number; neurons: number }> {
  const row = await db
    .prepare("SELECT turns, neurons FROM quota WHERE bucket_key = ? AND day = ?")
    .bind(bucketKey, day)
    .first<{ turns: number; neurons: number }>();
  return row ?? { turns: 0, neurons: 0 };
}

export async function checkQuota(
  env: Env,
  clientBucketKey: string,
): Promise<{ ok: true } | { ok: false; reason: "client_quota_exceeded" | "global_pool_exhausted" }> {
  const day = today();
  const dailyQuotaPerClient = Number(env.DAILY_QUOTA_PER_CLIENT ?? 12);
  const globalNeuronBudget = Number(env.GLOBAL_NEURON_BUDGET ?? 10000 * 0.7);

  const [client, global] = await Promise.all([
    readTurnsAndNeurons(env.DB, clientBucketKey, day),
    readTurnsAndNeurons(env.DB, GLOBAL_BUCKET, day),
  ]);

  if (client.turns >= dailyQuotaPerClient) return { ok: false, reason: "client_quota_exceeded" };
  if (global.neurons >= globalNeuronBudget) return { ok: false, reason: "global_pool_exhausted" };
  return { ok: true };
}

export async function recordTurn(env: Env, clientBucketKey: string, estimatedNeurons: number): Promise<void> {
  const day = today();
  const stmt = `
    INSERT INTO quota (bucket_key, day, turns, neurons) VALUES (?, ?, 1, ?)
    ON CONFLICT (bucket_key, day) DO UPDATE SET turns = turns + 1, neurons = neurons + excluded.neurons
  `;
  await env.DB.batch([
    env.DB.prepare(stmt).bind(clientBucketKey, day, estimatedNeurons),
    env.DB.prepare(stmt).bind(GLOBAL_BUCKET, day, estimatedNeurons),
  ]);
}

export async function pruneOldQuotaRows(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM quota WHERE day < ?").bind(cutoff).run();
}

export async function hashClientBucketKey(env: Env, clientId: string, ip: string): Promise<string> {
  const salt = env.QUOTA_SALT ?? "floorcraft-dev-salt";
  const data = new TextEncoder().encode(`${salt}:${clientId}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
