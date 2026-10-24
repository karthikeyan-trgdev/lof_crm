import type { Env } from '../types';

/** Fixed-window counter in D1. Returns true while the caller is within `limit` hits per `windowSec`. */
export async function allow(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSec);
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < excluded.window_start THEN 1 ELSE rate_limits.count + 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  ).bind(key, start).first<{ count: number }>();
  return (r?.count ?? 0) <= limit;
}

export const clientIp = (req: Request) => req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown';
