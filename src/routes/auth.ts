import { Hono } from 'hono';
import { hashPassword, verifyPassword, sha256Hex } from '../lib/crypto';
import { requireAuth, loadUser, mfaRequiredFor, type AppEnv } from '../lib/auth';
import { Repo, nowIso } from '../lib/db';
import { allow, clientIp } from '../lib/ratelimit';
import { createSession, sessionCookie, clearCookie, revokeAll, revokeSession, setStage, type Stage } from '../lib/session';
import { newTotpSecret, otpauthUri, verifyTotp, encryptSecret, decryptSecret } from '../lib/totp';
import { addAudit } from '../domain/core';
import { HttpError } from '../types';
import type { Env } from '../types';

export const auth = new Hono<AppEnv>();

const MAX_FAILS = 5, LOCK_MIN = 15;
const GENERIC = 'Incorrect e-mail or password, or the account is temporarily locked';
const COMMON = ['password', 'welcome', 'qwerty', 'letmein', 'admin', 'labofuture', 'changeme', '123456', 'iloveyou'];

/** ≥ 10 characters, at least 3 of: lower, upper, digit, symbol; not built on the e-mail name or a common word. */
export function passwordProblem(pw: string, email = ''): string | null {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 128) return 'Use 10 to 128 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Use at least three of: lower-case, upper-case, digits, symbols';
  const lower = pw.toLowerCase();
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Do not include your e-mail name in the password';
  if (COMMON.some((w) => lower.includes(w))) return 'Avoid common words such as "password" or "welcome"';
  return null;
}

const audit = (env: Env, by: string, act: string, det: string) => addAudit(new Repo(env.DB, by), act, 'Session', det, by);
const browser = (c: any) => c.req.header('x-lof-csrf') === '1'; // the CRM screens; API clients get the token in the body

function startStage(env: Env, row: any, role: string): Stage {
  if (row.must_change) return 'password_change';
  if (mfaRequiredFor(env, role) && !row.mfa_enabled) return 'mfa_setup';
  return 'full';
}

auth.post('/login', async (c) => {
  // Only JSON bodies (no cross-site HTML form posts), and a browser Origin must be this app
  if (!(c.req.header('content-type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send the sign-in as JSON');
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.env.APP_BASE_URL).origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'Sign-in from another site is not allowed');
  const body = await c.req.json<{ email?: string; password?: string; code?: string }>().catch(() => ({} as any));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !body.password) throw new HttpError(400, 'E-mail and password are required');
  const ip = clientIp(c.req.raw);
  if (!(await allow(c.env, 'login-ip:' + ip, 30, 900)) || !(await allow(c.env, 'login-email:' + email, 10, 900))) {
    throw new HttpError(429, 'Too many sign-in attempts – wait 15 minutes and try again');
  }
  const row = await c.env.DB.prepare('SELECT * FROM staff_auth WHERE email=?').bind(email).first<any>();
  if (!row) { await verifyPassword(body.password, 'pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); throw new HttpError(401, GENERIC); }
  if (row.locked_until && row.locked_until > nowIso()) throw new HttpError(401, GENERIC);
  const fail = async (why: string) => {
    const fails = row.failed_count + 1;
    const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 6e4).toISOString() : null;
    await c.env.DB.prepare('UPDATE staff_auth SET failed_count=?, locked_until=? WHERE staff_id=?').bind(lock ? 0 : fails, lock, row.staff_id).run();
    await audit(c.env, row.staff_id, 'Access', `Sign-in failed (${why}) from ${ip}${lock ? ' – account locked for 15 minutes' : ''}`);
  };
  if (!(await verifyPassword(body.password, row.password_hash))) { await fail('password'); throw new HttpError(401, GENERIC); }

  if (row.mfa_enabled) {
    if (!body.code) return c.json({ mfaRequired: true });
    const secret = await decryptSecret(row.mfa_secret, c.env.JWT_SECRET);
    const step = await verifyTotp(secret, body.code, row.mfa_last_step || 0);
    if (!step) { await fail('verification code'); throw new HttpError(401, 'The verification code is not valid – use the current code from your authenticator app'); }
    await c.env.DB.prepare('UPDATE staff_auth SET mfa_last_step=? WHERE staff_id=?').bind(step, row.staff_id).run();
  }

  const repo = new Repo(c.env.DB);
  const user = await loadUser(repo, row.staff_id);
  if (!user) throw new HttpError(403, 'Your access is disabled – contact the System Administrator');
  await c.env.DB.prepare('UPDATE staff_auth SET failed_count=0, locked_until=NULL, last_login_at=? WHERE staff_id=?').bind(nowIso(), row.staff_id).run();
  const stage = startStage(c.env, row, user.role);
  const token = await createSession(c.env, user.id, stage, c.req.raw);
  await audit(c.env, user.name, 'Access', `Signed in from ${ip}${row.mfa_enabled ? ' (two-step verified)' : ''}`);
  c.header('set-cookie', sessionCookie(c.env, token));
  return c.json({ user, stage, mustChangePassword: stage === 'password_change', mfaSetupRequired: stage === 'mfa_setup', ...(browser(c) ? {} : { token }) });
});

auth.post('/logout', requireAuth, async (c) => {
  await revokeSession(c.env, c.get('session').id_hash);
  c.header('set-cookie', clearCookie(c.env));
  return c.json({ ok: true });
});

auth.get('/me', requireAuth, async (c) => {
  const row = await c.env.DB.prepare('SELECT mfa_enabled FROM staff_auth WHERE staff_id=?').bind(c.get('user').id).first<any>();
  return c.json({ user: c.get('user'), stage: c.get('session').stage, mfaEnabled: !!row?.mfa_enabled, mfaRequired: mfaRequiredFor(c.env, c.get('user').role) });
});

auth.post('/change-password', requireAuth, async (c) => {
  const { current, next } = await c.req.json<{ current: string; next: string }>();
  const u = c.get('user');
  if (!(await allow(c.env, 'pwchange:' + u.id, 10, 900))) throw new HttpError(429, 'Too many attempts – wait 15 minutes');
  const row = await c.env.DB.prepare('SELECT * FROM staff_auth WHERE staff_id=?').bind(u.id).first<any>();
  if (!row || !(await verifyPassword(current || '', row.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  const problem = passwordProblem(next, u.email);
  if (problem) throw new HttpError(400, problem);
  if (await verifyPassword(next, row.password_hash)) throw new HttpError(400, 'Choose a password you have not used just now');
  await c.env.DB.prepare('UPDATE staff_auth SET password_hash=?, must_change=0, password_changed_at=? WHERE staff_id=?').bind(await hashPassword(next), nowIso(), u.id).run();
  const s = c.get('session');
  await revokeAll(c.env, u.id, s.id_hash); // sign out every other device
  const stage: Stage = mfaRequiredFor(c.env, u.role) && !row.mfa_enabled ? 'mfa_setup' : 'full';
  await setStage(c.env, s.id_hash, stage);
  await audit(c.env, u.name, 'Access', 'Password changed – other sessions signed out');
  return c.json({ ok: true, stage });
});

// ---------------------------------------------------------------- two-step verification (TOTP)
auth.post('/mfa/setup', requireAuth, async (c) => {
  const u = c.get('user');
  const row = await c.env.DB.prepare('SELECT mfa_enabled FROM staff_auth WHERE staff_id=?').bind(u.id).first<any>();
  if (row?.mfa_enabled) throw new HttpError(409, 'Two-step verification is already on');
  const secret = newTotpSecret();
  await c.env.DB.prepare('UPDATE staff_auth SET mfa_secret=?, mfa_last_step=0 WHERE staff_id=?').bind(await encryptSecret(secret, c.env.JWT_SECRET), u.id).run();
  return c.json({ secret, otpauth: otpauthUri(secret, u.email) });
});

auth.post('/mfa/enable', requireAuth, async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  const u = c.get('user');
  if (!(await allow(c.env, 'mfa:' + u.id, 10, 600))) throw new HttpError(429, 'Too many attempts – wait 10 minutes');
  const row = await c.env.DB.prepare('SELECT mfa_secret, mfa_enabled FROM staff_auth WHERE staff_id=?').bind(u.id).first<any>();
  if (!row?.mfa_secret) throw new HttpError(400, 'Start the setup first');
  const step = await verifyTotp(await decryptSecret(row.mfa_secret, c.env.JWT_SECRET), code, 0);
  if (!step) throw new HttpError(400, 'That code is not valid – check the time on your phone and try the current code');
  await c.env.DB.prepare('UPDATE staff_auth SET mfa_enabled=1, mfa_last_step=? WHERE staff_id=?').bind(step, u.id).run();
  const s = c.get('session');
  if (s.stage === 'mfa_setup') await setStage(c.env, s.id_hash, 'full');
  await revokeAll(c.env, u.id, s.id_hash);
  await audit(c.env, u.name, 'Access', 'Two-step verification turned on');
  return c.json({ ok: true, stage: 'full' });
});

auth.post('/mfa/disable', requireAuth, async (c) => {
  const { password, code } = await c.req.json<{ password: string; code: string }>();
  const u = c.get('user');
  if (mfaRequiredFor(c.env, u.role)) throw new HttpError(403, `Two-step verification is required for ${u.role}`);
  if (!(await allow(c.env, 'mfa:' + u.id, 10, 600))) throw new HttpError(429, 'Too many attempts – wait 10 minutes');
  const row = await c.env.DB.prepare('SELECT * FROM staff_auth WHERE staff_id=?').bind(u.id).first<any>();
  const BAD = 'Password or verification code is incorrect';
  if (!row?.mfa_enabled) throw new HttpError(400, 'Two-step verification is not on');
  const pwOk = await verifyPassword(password || '', row.password_hash);
  const step = await decryptSecret(row.mfa_secret || '', c.env.JWT_SECRET).then((sec) => verifyTotp(sec, code, row.mfa_last_step || 0)).catch(() => 0);
  if (!pwOk || !step) throw new HttpError(400, BAD);
  await c.env.DB.prepare('UPDATE staff_auth SET mfa_enabled=0, mfa_secret=NULL, mfa_last_step=? WHERE staff_id=?').bind(step, u.id).run();
  await audit(c.env, u.name, 'Access', 'Two-step verification turned off');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- administration
/** System Administrator: temporary password (and optionally reset two-step verification); signs the user out everywhere. */
auth.post('/reset-password', requireAuth, async (c) => {
  const u = c.get('user');
  if (u.role !== 'System Administrator') throw new HttpError(403, 'Only a System Administrator can reset passwords');
  const { staffId, resetMfa } = await c.req.json<{ staffId: string; resetMfa?: boolean }>();
  if (staffId === u.id) throw new HttpError(400, 'Use Change password for your own account');
  const temp = 'Lof-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10) + '7';
  const r = await c.env.DB.prepare(`UPDATE staff_auth SET password_hash=?, must_change=1, failed_count=0, locked_until=NULL${resetMfa ? ', mfa_enabled=0, mfa_secret=NULL' : ''} WHERE staff_id=?`).bind(await hashPassword(temp), staffId).run();
  if (!r.meta.changes) throw new HttpError(404, 'User has no login');
  await revokeAll(c.env, staffId);
  await addAudit(c.get('repo'), 'Access', staffId, `Password reset by administrator${resetMfa ? ' (two-step verification reset)' : ''}; all sessions signed out`);
  return c.json({ ok: true, temporaryPassword: temp });
});

/** Sign a user out of every device (System Administrator). */
auth.post('/revoke-sessions', requireAuth, async (c) => {
  if (c.get('user').role !== 'System Administrator') throw new HttpError(403, 'Only a System Administrator can do this');
  const { staffId } = await c.req.json<{ staffId: string }>();
  await revokeAll(c.env, staffId);
  await addAudit(c.get('repo'), 'Access', staffId, 'All sessions signed out by administrator');
  return c.json({ ok: true });
});

/** Staging only: System Administrators preview the CRM as another role. Never available in production. */
auth.post('/impersonate', requireAuth, async (c) => {
  const me = c.get('user');
  if (c.env.ALLOW_IMPERSONATION !== 'true' || c.env.APP_ENV === 'production') throw new HttpError(403, 'Role preview is disabled in this environment');
  const s = c.get('session');
  const originalId = s.acting_as || me.id;
  const original = await loadUser(new Repo(c.env.DB), originalId);
  if (!original || original.role !== 'System Administrator') throw new HttpError(403, 'Only a System Administrator can preview other roles');
  const { staffId } = await c.req.json<{ staffId: string }>();
  const target = await loadUser(new Repo(c.env.DB), staffId);
  if (!target) throw new HttpError(404, 'User not found or disabled');
  await revokeSession(c.env, s.id_hash);
  const token = await createSession(c.env, target.id, 'full', c.req.raw, target.id === originalId ? undefined : originalId);
  await addAudit(c.get('repo'), 'Access', 'Session', `${original.name} previewing as ${target.name} (${target.role})`);
  c.header('set-cookie', sessionCookie(c.env, token));
  return c.json({ user: target, ...(browser(c) ? {} : { token }) });
});

export { sha256Hex };
