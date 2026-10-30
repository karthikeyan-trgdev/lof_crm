// Builds the branch-scoped CRM state the screens run on (same shape as the approved prototype).
import { Repo } from '../lib/db';
import { can, inList } from '../lib/auth';
import type { Env, User } from '../types';
import { INTEGRATIONS, modeFor, missingSecrets, type IntegrationKey } from '../integrations/base';
import { cfgDefaults } from '../domain/terms';
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_PLACEHOLDERS, EMAIL_TPL_CATEGORIES } from '../domain/email-templates';
import { MAIL_IN_DEFAULTS, MAIL_OUT_DEFAULTS } from '../domain/mail';

const rows = async (env: Env, sql: string, binds: unknown[]) =>
  ((await env.DB.prepare(sql).bind(...binds).all<{ data: string }>()).results || []).map((r) => JSON.parse(r.data));

export async function bootstrap(env: Env, repo: Repo, user: User, perms: any) {
  const sc = user.scope;
  // Test records are visible to System Administrators only (Testing console); everyone else sees business data
  const T = user.role === 'System Administrator' ? '' : ' AND is_test=0';
  const S = inList(sc);
  const newest = 'ORDER BY created_at DESC, rowid DESC';
  const oldest = 'ORDER BY created_at ASC, rowid ASC';
  const leadIds = `SELECT id FROM docs WHERE type='lead'${T} AND branch IN (${S})`;
  const stuIds = `SELECT id FROM docs WHERE type='student'${T} AND (branch IN (${S}) OR id IN (SELECT ref1 FROM docs WHERE type='enrollment'${T} AND branch IN (${S})))`;
  const enrIds = `SELECT id FROM docs WHERE type='enrollment'${T} AND ref1 IN (${stuIds})`;

  const [branches, programs, fees, discounts, staff] = await Promise.all(['branch', 'program', 'fee', 'discount', 'staff'].map((t) => rows(env, `SELECT data FROM docs WHERE type=? ${oldest}`, [t])));
  const [cfg, permsDoc, scope, fx, hist] = await Promise.all(['cfg', 'perms', 'scope', 'fx', 'hist'].map((k) => repo.setting(k)));

  const leads = await rows(env, `SELECT data FROM docs WHERE type='lead'${T} AND branch IN (${S}) ${newest}`, sc);
  const opps = await rows(env, `SELECT data FROM docs WHERE type='opp'${T} AND branch IN (${S}) ${newest}`, sc);
  const tasks = await rows(env, `SELECT data FROM docs WHERE type='task'${T} AND ref1 IN (${leadIds}) ${oldest}`, sc);
  const calls = await rows(env, `SELECT data FROM docs WHERE type='call'${T} AND ref1 IN (${leadIds}) ORDER BY at DESC`, sc);
  const comms = await rows(env, `SELECT data FROM docs WHERE type='comm'${T} AND ref1 IN (${leadIds}) ${oldest}`, sc);
  const students = await rows(env, `SELECT data FROM docs WHERE type='student'${T} AND id IN (${stuIds}) ${oldest}`, [...sc, ...sc]);
  const enr = await rows(env, `SELECT data FROM docs WHERE type='enrollment'${T} AND ref1 IN (${stuIds}) ${oldest}`, [...sc, ...sc]);
  const pay = can(perms, user, 'payments', 'V')
    ? await rows(env, `SELECT data FROM docs WHERE type='payment'${T} AND ref2 IN (${stuIds}) ${oldest}`, [...sc, ...sc]) : [];
  const ms = await rows(env, `SELECT data FROM docs WHERE type='moodle_sync'${T} AND ref1 IN (${enrIds}) ${oldest}`, [...sc, ...sc]);
  const refunds = await rows(env, `SELECT data FROM docs WHERE type='refund'${T} AND ref1 IN (${enrIds}) ${oldest}`, [...sc, ...sc]);
  const approvals = await rows(env,
    `SELECT data FROM docs WHERE type='approval'${T} AND (branch IN (${S}) OR owner=? OR json_extract(data,'$.payload.to') IN (${S})) ${newest}`, [...sc, user.id, ...sc]);
  const notifs = await rows(env, `SELECT data FROM docs WHERE type='notification'${T} AND (branch IS NULL OR branch IN (${S})) ORDER BY at DESC LIMIT 300`, sc);
  const audit = can(perms, user, 'audit_logs', 'V')
    ? await rows(env, `SELECT data FROM docs WHERE type='audit' ORDER BY at DESC, rowid DESC LIMIT 1000`, [])
    : await rows(env, `SELECT data FROM docs WHERE type='audit' AND (ref1 IN (${leadIds}) OR json_extract(data,'$.by')=?) ORDER BY at DESC LIMIT 500`, [...sc, user.name]);

  const seq = await repo.peekAll();
  const integrations = Object.fromEntries((Object.keys(INTEGRATIONS) as IntegrationKey[]).map((k) => [k, modeFor(env, cfg, k)]));

  // Staff contact details only for configuration roles (everyone else needs names and roles)
  const staffOut = can(perms, user, 'configuration', 'V') ? staff : staff.map((x: any) => (x.id === user.id ? x : { ...x, email: '', mobile: '' }));
  const cfgOut = structuredClone(cfg);
  if (cfgOut?.integ?.moodle) cfgOut.integ.moodle.token = '';
  // Settings added after go-live: show defaults until an administrator saves them
  const def = cfgDefaults(programs, branches);
  for (const k of ['targets', 'payTerms', 'payTermDefault', 'refund', 'lms'] as const) if (cfgOut[k] === undefined) cfgOut[k] = def[k];
  if (cfgOut.emailTpls === undefined) cfgOut.emailTpls = structuredClone(DEFAULT_EMAIL_TEMPLATES);
  cfgOut.mailOut = { ...MAIL_OUT_DEFAULTS, ...(cfgOut.mailOut || {}) };
  cfgOut.mailIn = { ...structuredClone(MAIL_IN_DEFAULTS), ...(cfgOut.mailIn || {}) };
  cfgOut.integ = cfgOut.integ || {};
  if (!cfgOut.integ.lms) cfgOut.integ.lms = def.lmsInteg;
  for (const p of programs) if (!cfgOut.lms.programmes[p.id]) cfgOut.lms.programmes[p.id] = { track: '', credits: [] };
  // Counsellors see their own targets only
  if (user.role === 'Counsellor') cfgOut.targets = (cfgOut.targets || []).filter((t: any) => t.c === user.id);

  return {
    me: user,
    server: { env: env.APP_ENV, now: new Date().toISOString(), impersonation: env.ALLOW_IMPERSONATION === 'true', integrations, lmsSecrets: missingSecrets(env, 'lms').length === 0,
      emailTemplates: { categories: EMAIL_TPL_CATEGORIES, placeholders: EMAIL_PLACEHOLDERS } },
    data: { branches, programs, fees, discounts, staff: staffOut, cfg: cfgOut, perms: permsDoc, scope, fx, hist, leads, opps, tasks, calls, comms, students, enr, pay, ms, refunds, approvals, notifs, audit },
    seq,
  };
}
