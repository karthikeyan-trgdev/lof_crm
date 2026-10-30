// Configuration → Email Outgoing / Email Incoming (API side).
//   GET  /api/v1/mail/status              provider, live/mock mode, sender address, missing secrets
//   POST /api/v1/mail/test-send           { to }  sends a test e-mail with the Email Outgoing rules
//   GET  /api/v1/mail/inbound             the 50 most recent received e-mails and how each was filed
//   POST /api/v1/mail/inbound/simulate    { from, fromName, subject, text }  runs the Email Incoming rules on a sample e-mail
// Viewing needs configuration view access; sending and simulating need configuration edit access.
import { Hono } from 'hono';
import { requireAuth, need, type AppEnv } from '../lib/auth';
import { allow } from '../lib/ratelimit';
import { Repo } from '../lib/db';
import { HttpError } from '../types';
import { addAudit } from '../domain/core';
import { deliverEmail, processInboundEmail, recentInbound } from '../domain/mail';
import { missingSecrets, modeFor } from '../integrations/base';
import { dispatch } from '../jobs';

const mail = new Hono<AppEnv>();
mail.use('*', requireAuth);
const wait = (c: any) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const cfgOf = (c: any) => new Repo(c.env.DB).setting<any>('cfg');

mail.get('/status', async (c) => {
  need(c, 'configuration', 'V');
  const cfg = await cfgOf(c);
  return c.json({
    outgoing: { provider: 'Resend', mode: modeFor(c.env, cfg, 'email'), from: c.env.EMAIL_FROM || '', missing: missingSecrets(c.env, 'email') },
    incoming: { connected: false, note: 'Automatic import from the mailbox starts when the Gmail connection is set up.' },
  });
});

mail.post('/test-send', async (c) => {
  need(c, 'configuration', 'E');
  const user = c.get('user');
  const to = String((await c.req.json().catch(() => ({})))?.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Enter a valid e-mail address');
  if (!(await allow(c.env, 'mail-test:' + user.id, 10, 3600))) throw new HttpError(429, 'At most 10 test e-mails per hour');
  const cfg = await cfgOf(c);
  const mode = modeFor(c.env, cfg, 'email');
  try {
    const r = await deliverEmail(c.env, cfg, { mode }, {
      to, ref: 'TEST-MAIL', subject: 'Lab of Future CRM – test e-mail',
      text: `This is a test e-mail from the Lab of Future CRM, sent by ${user.name}.\n\nIf you can read this, outgoing e-mail is working.`,
    });
    await addAudit(new Repo(c.env.DB, user.name), 'Test e-mail sent', to, `Mode ${mode}`);
    return c.json({ ok: true, mode, id: r.id });
  } catch (e: any) {
    throw new HttpError(400, String(e?.message || e));
  }
});

mail.get('/inbound', async (c) => {
  need(c, 'configuration', 'V');
  return c.json({ items: await recentInbound(c.env) });
});

mail.post('/inbound/simulate', async (c) => {
  need(c, 'configuration', 'E');
  const user = c.get('user');
  const b = (await c.req.json().catch(() => ({}))) || {};
  const from = String(b.from || '').trim();
  if (!EMAIL_RE.test(from)) throw new HttpError(400, 'Enter the sender’s e-mail address');
  if (!(await allow(c.env, 'mail-sim:' + user.id, 30, 3600))) throw new HttpError(429, 'At most 30 simulations per hour');
  const cfg = await cfgOf(c);
  const r = await processInboundEmail(c.env, new Repo(c.env.DB, 'E-mail simulation'), cfg, {
    messageId: 'sim-' + crypto.randomUUID(), from, fromName: String(b.fromName || '').slice(0, 80),
    subject: String(b.subject || '(no subject)').slice(0, 200), text: String(b.text || '').slice(0, 4096),
  }, true);
  if (r.queuedComms?.length) await dispatch(c.env, wait(c), r.queuedComms.map((id) => ({ kind: 'send_comm' as const, id })));
  return c.json({ ok: true, status: r.status, ref: r.ref || null, refType: r.refType || null });
});

export default mail;
