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

/** Client address. On a self-hosted server the runtime reports the local reverse proxy (loopback), so the
 *  address that proxy appended to X-Forwarded-For (the rightmost entry) is used instead. */
export const clientIp = (req: Request) => {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '';
  if (/^(127\.|::1$|::ffff:127\.)/.test(ip)) {
    const fwd = (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (fwd) return fwd;
  }
  return ip || 'unknown';
};
