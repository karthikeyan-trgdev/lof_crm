import type { Context, Next } from 'hono';
import { Repo } from './db';
import { loadSession, readToken, type SessionRow } from './session';
import { allow } from './ratelimit';
import type { Env, Role, User } from '../types';
import { HttpError } from '../types';

export type AppEnv = {
  Bindings: Env;
  Variables: { user: User; repo: Repo; perms: Record<string, Record<string, string>>; session: SessionRow };
};

export const ALL_ROLES: Role[] = ['Counsellor', 'Centre Administrator', 'Admissions Head', 'Reception', 'Management', 'System Administrator'];

export async function loadUser(repo: Repo, staffId: string): Promise<User | null> {
  const s = await repo.get<any>('staff', staffId);
  if (!s || s.status === 'Inactive' || s.access === 'Disabled' || !ALL_ROLES.includes(s.role)) return null;
  let scope: string[];
  if (s.role === 'Management' || s.role === 'System Administrator') {
    scope = (await repo.many<any>('branch')).map((b) => b.id);
  } else {
    const sc = await repo.setting<Record<string, string[]>>('scope');
    scope = Array.isArray(sc[s.id]) ? sc[s.id] : [s.branch];
  }
  return { id: s.id, name: s.name, role: s.role, branch: s.branch, email: s.email, scope };
}

export const mfaRequiredFor = (env: Env, role: string) =>
  String(env.MFA_REQUIRED_ROLES || '').split(',').map((x) => x.trim()).filter(Boolean).includes(role);

/** Paths a session that still has to change its password / enrol MFA may call. */
const LIMITED_OK = ['/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/auth/change-password', '/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/enable'];

/**
 * Session authentication for /api routes.
 *  • token from the HttpOnly session cookie (browser) or a Bearer header (API clients)
 *  • cookie-authenticated writes must carry `X-LOF-CSRF: 1` – a custom header other sites cannot send
 *  • sessions that must first change the password or enrol MFA can only reach those endpoints
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const t = readToken(c.env, c.req.raw);
  if (!t) throw new HttpError(401, 'Sign in required');
  const s = await loadSession(c.env, t.token);
  if (!s) throw new HttpError(401, 'Your session has ended – sign in again');
  if (t.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-lof-csrf') !== '1') {
    throw new HttpError(403, 'Request blocked (missing CSRF header)');
  }
  if (s.stage !== 'full' && !LIMITED_OK.includes(c.req.path)) {
    const err = new HttpError(403, s.stage === 'password_change' ? 'Change your password to continue' : 'Set up two-step verification to continue', { code: s.stage });
    throw err;
  }
  const repo = new Repo(c.env.DB);
  const user = await loadUser(repo, s.staff_id);
  if (!user) throw new HttpError(401, 'Your access is disabled');
  if (!(await allow(c.env, 'user:' + user.id, 600, 60))) throw new HttpError(429, 'Too many requests – slow down');
  repo.actor = user.name + (s.acting_as ? ` (preview by ${s.acting_as})` : '');
  c.set('user', user);
  c.set('repo', repo);
  c.set('session', s);
  c.set('perms', await repo.setting('perms'));
  await next();
}

export function can(perms: Record<string, Record<string, string>>, user: User, resource: string, cap: string): boolean {
  return ((perms[resource] || {})[user.role] || '').includes(cap);
}

export function need(c: Context<AppEnv>, resource: string, cap: string) {
  if (!can(c.get('perms'), c.get('user'), resource, cap)) {
    throw new HttpError(403, `${c.get('user').role} cannot ${({ V: 'view', C: 'create', E: 'edit', A: 'approve', D: 'delete' } as any)[cap] || cap} ${resource.replace(/_/g, ' ')}`);
  }
}

export function needScope(c: Context<AppEnv>, branch: string | null | undefined) {
  if (!branch || !c.get('user').scope.includes(branch)) throw new HttpError(403, 'Record is outside your branch access');
}

export const inList = (xs: string[]) => (xs.length ? xs.map(() => '?').join(',') : "''");
