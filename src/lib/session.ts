// Server-side sessions. The browser keeps a random token in an HttpOnly, Secure, SameSite=Strict cookie
// (unreadable by page scripts); API clients may send the same token as a Bearer header.
import type { Env } from '../types';
import { b64url, sha256Hex } from './crypto';

export type Stage = 'full' | 'password_change' | 'mfa_setup';
const ABSOLUTE_HOURS = 12;

export const cookieName = (env: Env) => (String(env.APP_BASE_URL).startsWith('https://') ? '__Host-lof_session' : 'lof_session');
export function sessionCookie(env: Env, token: string, maxAgeSec = ABSOLUTE_HOURS * 3600) {
  const secure = String(env.APP_BASE_URL).startsWith('https://') ? '; Secure' : '';
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
export const clearCookie = (env: Env) => sessionCookie(env, '', 0);

export function readToken(env: Env, req: Request): { token: string; viaCookie: boolean } | null {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7).trim(), viaCookie: false };
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + cookieName(env).replace(/[$]/g, '\\$') + '=([^;]+)'));
  return m ? { token: m[1], viaCookie: true } : null;
}

export async function createSession(env: Env, staffId: string, stage: Stage, req: Request, actingAs?: string) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await env.DB.prepare(
    'INSERT INTO sessions (id_hash,staff_id,created_at,last_seen_at,expires_at,stage,acting_as,ip,user_agent) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(await sha256Hex(token), staffId, now.toISOString(), now.toISOString(), new Date(now.getTime() + ABSOLUTE_HOURS * 3600e3).toISOString(), stage, actingAs ?? null,
    req.headers.get('cf-connecting-ip') || null, (req.headers.get('user-agent') || '').slice(0, 200)).run();
  return token;
}

export interface SessionRow { id_hash: string; staff_id: string; stage: Stage; acting_as: string | null; last_seen_at: string; expires_at: string; revoked_at: string | null }

export async function loadSession(env: Env, token: string): Promise<SessionRow | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id_hash=?').bind(hash).first<SessionRow>();
  if (!s || s.revoked_at) return null;
  const now = Date.now();
  const idle = (+(env.SESSION_IDLE_MINUTES || 60)) * 60e3;
  if (Date.parse(s.expires_at) < now || Date.parse(s.last_seen_at) + idle < now) {
    await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id_hash=?').bind(new Date().toISOString(), hash).run();
    return null;
  }
  if (now - Date.parse(s.last_seen_at) > 60e3) await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').bind(new Date().toISOString(), hash).run();
  return s;
}

export async function setStage(env: Env, idHash: string, stage: Stage) {
  await env.DB.prepare('UPDATE sessions SET stage=? WHERE id_hash=?').bind(stage, idHash).run();
}
export async function revokeSession(env: Env, idHash: string) {
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id_hash=? AND revoked_at IS NULL').bind(new Date().toISOString(), idHash).run();
}
export async function revokeAll(env: Env, staffId: string, exceptHash?: string) {
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE staff_id=? AND revoked_at IS NULL AND id_hash<>?').bind(new Date().toISOString(), staffId, exceptHash || '').run();
}
