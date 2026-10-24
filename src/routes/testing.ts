// Testing module (API side of Settings → Testing console)
//   GET  /testing/status                    integration readiness: config toggle, mode, missing secrets, webhook URLs, last result
//   POST /testing/integrations/:key/test    authenticated "ping" against the provider (or mock)
//   POST /testing/webhooks/:kind/simulate   builds a correctly signed sample event and sends it through the real webhook handler
//   POST /testing/scenarios/:name/run       end-to-end business scenario across the integrations, step by step
//   GET  /testing/logs, /testing/logs/:id   request/response log (secrets redacted)
//   POST /testing/flags                     failure injection for mock mode (e.g. LMS outage)
//   POST /testing/cron                      run the 5-minute scheduler now
//   POST /testing/cleanup                   delete everything created by tests (is_test = 1)
import { Hono } from 'hono';
import type { Env, User } from '../types';
import { HttpError } from '../types';
import { requireAuth, can, type AppEnv } from '../lib/auth';
import { Repo, nowIso } from '../lib/db';
import { hmacSha256Hex } from '../lib/crypto';
import { INTEGRATIONS, enabledInConfig, missingSecrets, modeFor, type IntegrationKey } from '../integrations/base';
import { ping as lmsPing } from '../integrations/lms';
import { phoneNumberInfo } from '../integrations/whatsapp';
import { me as metaMe } from '../integrations/meta';
import { accountInfo } from '../integrations/exotel';
import { razorpayPing, telrCheck } from '../integrations/payments';
import { loggedUser } from '../integrations/erpnext';
import { calendarPing, emailPing } from '../integrations/gcal-email';
import { applySync } from '../sync/sync';
import { calcFee, feeFor, routeLead } from '../domain/core';
import { createPaymentLink } from '../domain/workflows';
import { runJob, cron } from '../jobs';
import { testToken } from './webhooks';

type FetchApp = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

const WEBHOOK_PATHS: Partial<Record<IntegrationKey, string[]>> = {
  website: ['POST /webhooks/website'],
  meta: ['GET+POST /webhooks/meta'],
  whatsapp: ['GET+POST /webhooks/whatsapp'],
  exotel: ['/webhooks/exotel/incoming?token=…', '/webhooks/exotel/status?token=…'],
  telr: ['POST /webhooks/telr', 'GET /webhooks/pay/return'],
  razorpay: ['POST /webhooks/razorpay'],
};

export function testingRoutes(app: FetchApp) {
  const t = new Hono<AppEnv>();
  t.use('*', requireAuth);
  t.use('*', async (c, next) => {
    const u = c.get('user');
    if (u.role !== 'System Administrator' || !can(c.get('perms'), u, 'configuration', 'V')) throw new HttpError(403, 'Testing console is for System Administrators');
    await next();
  });

  /** Run a webhook through the real handler, in-process, and wait for its background work. */
  async function hit(env: Env, method: string, path: string, body: string | null, headers: Record<string, string>) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const req = new Request('https://internal' + path, { method, body, headers: { 'x-lof-test': await testToken(env), ...headers } });
    const res = await app.fetch(req, env, ctx);
    await Promise.allSettled(pending);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, ok: res.ok, body: json ?? text };
  }

  // ---------------------------------------------------------------- status
  t.get('/status', async (c) => {
    const repo = c.get('repo');
    const cfg = await repo.setting<any>('cfg');
    const base = c.env.APP_BASE_URL.replace(/\/+$/, '');
    const out: any[] = [];
    for (const key of Object.keys(INTEGRATIONS) as IntegrationKey[]) {
      const last = await c.env.DB.prepare('SELECT at,ok,mode,operation,error FROM integration_logs WHERE integration=? ORDER BY id DESC LIMIT 1').bind(key).first();
      const lastOk = await c.env.DB.prepare('SELECT at FROM integration_logs WHERE integration=? AND ok=1 AND mode=? ORDER BY id DESC LIMIT 1').bind(key, 'live').first();
      out.push({
        key, label: INTEGRATIONS[key].label, enabled: enabledInConfig(cfg, key), mode: modeFor(c.env, cfg, key), missing: missingSecrets(c.env, key),
        webhooks: (WEBHOOK_PATHS[key] || []).map((p) => p.replace('/webhooks', base + '/webhooks')), last, lastLiveSuccess: lastOk?.at || null,
      });
    }
    const flags = await repo.setting('test_flags');
    const testDocs = await c.env.DB.prepare('SELECT COUNT(*) n FROM docs WHERE is_test=1').first<{ n: number }>();
    return c.json({ env: c.env.APP_ENV, forcedMock: c.env.INTEGRATION_MODE === 'mock', integrations: out, flags, testRecords: testDocs?.n ?? 0, queue: !!c.env.JOBS });
  });

  // ---------------------------------------------------------------- connection tests
  t.post('/integrations/:key/test', async (c) => {
    const key = c.req.param('key') as IntegrationKey;
    if (!INTEGRATIONS[key]) throw new HttpError(404, 'Unknown integration');
    const cfg = await c.get('repo').setting<any>('cfg');
    const mode = modeFor(c.env, cfg, key);
    const ctx = { env: c.env, cfg, mode, isTest: true };
    const t0 = Date.now();
    try {
      let detail: unknown;
      switch (key) {
        case 'website': detail = { signing: !!c.env.WEBSITE_FORM_SECRET, allowedOrigins: cfg.integ?.web?.origins || [] }; break;
        case 'meta': detail = await metaMe(ctx); break;
        case 'whatsapp': detail = await phoneNumberInfo(ctx); break;
        case 'exotel': detail = await accountInfo(ctx); break;
        case 'lms': detail = await lmsPing(ctx); break;
        case 'telr':
          try { detail = await telrCheck(ctx, 'CONNECTIVITY-TEST'); }
          catch (e: any) { if (/not found|invalid order/i.test(e.message)) detail = { authenticated: true, note: 'Store credentials accepted (test order reference not found, as expected)' }; else throw e; }
          break;
        case 'razorpay': detail = await razorpayPing(ctx); break;
        case 'erpnext': detail = { user: await loggedUser(ctx) }; break;
        case 'gcal': detail = await calendarPing(ctx); break;
        case 'email': detail = await emailPing(ctx); break;
      }
      return c.json({ ok: true, key, mode, ms: Date.now() - t0, detail, note: mode === 'mock' ? mockNote(c.env, cfg, key) : undefined });
    } catch (e: any) {
      return c.json({ ok: false, key, mode, ms: Date.now() - t0, error: e.message });
    }
  });

  // ---------------------------------------------------------------- webhook simulation
  t.post('/webhooks/:kind/simulate', async (c) => {
    const kind = c.req.param('kind');
    const opts = await c.req.json<any>().catch(() => ({}));
    const r = await simulate(c.env, c.get('repo'), kind, opts, c.get('user'), c.get('perms'));
    return c.json(r);
  });

  async function simulate(env: Env, repo: Repo, kind: string, o: any = {}, user?: User, perms?: any) {
    const need = (v: string | undefined, name: string) => { if (!v) throw new HttpError(400, `${name} is not set – add it as a Worker secret to test signature verification`); return v; };
    const phone = o.phone || '+97150' + String(Math.floor(1000000 + Math.random() * 8999999));
    switch (kind) {
      case 'website': {
        const body = JSON.stringify({ student: o.student || 'TEST Website Student', parent: o.parent || 'TEST Parent', phone, email: `test.${Date.now()}@example.com`, branch: o.branch || 'KRM', prog: o.prog || 'ROB', category: 'Hot', wa_consent: true, email_consent: true, campaign: 'Website Organic', message: 'Testing console' });
        return hit(env, 'POST', '/webhooks/website', body, { 'content-type': 'application/json', 'x-lof-signature': await hmacSha256Hex(need(env.WEBSITE_FORM_SECRET, 'WEBSITE_FORM_SECRET'), body) });
      }
      case 'meta': {
        const body = JSON.stringify({ object: 'page', entry: [{ id: 'TESTPAGE', time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: 'TEST' + Date.now(), form_id: o.formId || 'TESTFORM', page_id: 'TESTPAGE', created_time: Math.floor(Date.now() / 1000) } }] }] });
        return hit(env, 'POST', '/webhooks/meta', body, { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await hmacSha256Hex(need(env.META_APP_SECRET, 'META_APP_SECRET'), body)) });
      }
      case 'meta-verify': {
        const ch = 'challenge-' + Date.now();
        const r = await hit(env, 'GET', `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(need(env.META_VERIFY_TOKEN, 'META_VERIFY_TOKEN'))}&hub.challenge=${ch}`, null, {});
        return { ...r, ok: r.ok && r.body === ch };
      }
      case 'whatsapp-verify': {
        const ch = 'challenge-' + Date.now();
        const r = await hit(env, 'GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(need(env.WHATSAPP_VERIFY_TOKEN, 'WHATSAPP_VERIFY_TOKEN'))}&hub.challenge=${ch}`, null, {});
        return { ...r, ok: r.ok && r.body === ch };
      }
      case 'whatsapp-status': {
        const row = o.messageId ? { ref2: o.messageId } : await env.DB.prepare("SELECT ref2 FROM docs WHERE type='comm' AND ref2 IS NOT NULL AND is_test=1 ORDER BY updated_at DESC LIMIT 1").first<any>();
        if (!row) throw new HttpError(409, 'No test WhatsApp message to update yet – run the "Website lead" simulation first');
        const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: row.ref2, status: o.status || 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '971500000000' }] } }] }] });
        return hit(env, 'POST', '/webhooks/whatsapp', body, { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await hmacSha256Hex(need(env.WHATSAPP_APP_SECRET, 'WHATSAPP_APP_SECRET'), body)) });
      }
      case 'whatsapp-inbound': {
        const lead = await testLead(env, o.leadId);
        const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ wa_id: lead.phone.replace(/\D/g, ''), profile: { name: lead.parent } }], messages: [{ from: lead.phone.replace(/\D/g, ''), id: 'wamid.TEST' + Date.now(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: o.text || 'Tomorrow after 5 pm is good for a call.' } }] } }] }] });
        return hit(env, 'POST', '/webhooks/whatsapp', body, { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await hmacSha256Hex(need(env.WHATSAPP_APP_SECRET, 'WHATSAPP_APP_SECRET'), body)) });
      }
      case 'exotel-incoming': {
        const lead = await testLead(env, o.leadId);
        const q = new URLSearchParams({ token: need(env.EXOTEL_WEBHOOK_TOKEN, 'EXOTEL_WEBHOOK_TOKEN'), CallSid: 'TESTIN' + Date.now(), CallFrom: lead.phone, CallTo: env.EXOTEL_CALLER_ID || '04XXXXXXX', Direction: 'incoming' });
        return hit(env, 'GET', `/webhooks/exotel/incoming?${q}`, null, {});
      }
      case 'exotel-status': {
        const lead = await testLead(env, o.leadId);
        const q = new URLSearchParams({ token: need(env.EXOTEL_WEBHOOK_TOKEN, 'EXOTEL_WEBHOOK_TOKEN'), lead: lead.id, staff: lead.cslr || '' });
        const body = JSON.stringify({ CallSid: 'TESTCALL' + Date.now(), Status: o.status || 'completed', ConversationDuration: o.duration ?? 185, RecordingUrl: 'https://recordings.exotel.example/test.mp3', From: '+971500000001', To: lead.phone, Direction: 'outbound-api' });
        return hit(env, 'POST', `/webhooks/exotel/status?${q}`, body, { 'content-type': 'application/json' });
      }
      case 'telr-paid': {
        const link = await testLink(env, o.linkId, 'telr', user, perms);
        return hit(env, 'POST', '/webhooks/telr', new URLSearchParams({ tran_store: env.TELR_STORE_ID || 'TEST', tran_type: 'sale', tran_status: 'A', tran_ref: 'TESTTXN' + Date.now(), tran_cartid: link.id, tran_amount: String(link.amount), tran_currency: link.currency }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
      }
      case 'razorpay-paid': {
        const link = await testLink(env, o.linkId, 'razorpay', user, perms);
        const body = JSON.stringify({
          entity: 'event', event: 'payment_link.paid', created_at: Math.floor(Date.now() / 1000),
          payload: { payment_link: { entity: { id: link.provider_ref, reference_id: link.id, amount: Math.round(link.amount * 100), amount_paid: Math.round(link.amount * 100), status: 'paid' } }, payment: { entity: { id: 'pay_TEST' + Date.now(), amount: Math.round(link.amount * 100), currency: link.currency, method: 'upi', status: 'captured' } } },
        });
        return hit(env, 'POST', '/webhooks/razorpay', body, { 'content-type': 'application/json', 'x-razorpay-signature': await hmacSha256Hex(need(env.RAZORPAY_WEBHOOK_SECRET, 'RAZORPAY_WEBHOOK_SECRET'), body), 'x-razorpay-event-id': 'evt_TEST' + Date.now() });
      }
      case 'bad-signature': {
        const body = JSON.stringify({ object: 'page', entry: [] });
        const r = await hit(env, 'POST', '/webhooks/meta', body, { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' });
        return { ...r, ok: r.status === 401, expectation: 'Rejected with 401' };
      }
    }
    throw new HttpError(404, 'Unknown simulation');
  }

  async function testLead(env: Env, id?: string) {
    const row = id
      ? await env.DB.prepare("SELECT data FROM docs WHERE type='lead' AND id=? AND is_test=1").bind(id).first<any>()
      : await env.DB.prepare("SELECT data FROM docs WHERE type='lead' AND is_test=1 ORDER BY created_at DESC LIMIT 1").first<any>();
    if (!row) throw new HttpError(409, 'No test lead yet – run the "Website lead" simulation first (simulations only touch test records)');
    return JSON.parse(row.data);
  }
  /** An open test payment link; creates a test student + enrolment + link when none is open. */
  async function testLink(env: Env, id: string | undefined, provider: string, user?: User, perms?: any) {
    let row = id
      ? await env.DB.prepare('SELECT * FROM payment_links WHERE id=? AND is_test=1').bind(id).first<any>()
      : await env.DB.prepare("SELECT * FROM payment_links WHERE is_test=1 AND status='created' AND provider LIKE ? ORDER BY created_at DESC LIMIT 1").bind(provider + '%').first<any>();
    if (!row && !id && user) {
      const trepo = new Repo(env.DB, user.name + ' (testing)', true);
      const enr = await makeTestEnrollment(env, trepo, user, perms, provider === 'razorpay' ? 'INR' : 'AED');
      const l = await createPaymentLink(env, trepo, enr, undefined, user.name);
      row = await env.DB.prepare('SELECT * FROM payment_links WHERE id=?').bind(l.id).first<any>();
    }
    if (!row) throw new HttpError(409, `No open test ${provider} payment link`);
    return row;
  }

  // ---------------------------------------------------------------- end-to-end scenarios
  t.post('/scenarios/:name/run', async (c) => {
    const name = c.req.param('name');
    const user = c.get('user');
    const steps: { step: string; ok: boolean; detail?: unknown; ms: number }[] = [];
    const run = async (step: string, fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      try { const detail = await fn(); steps.push({ step, ok: true, detail, ms: Date.now() - t0 }); return detail as any; }
      catch (e: any) { steps.push({ step, ok: false, detail: e.message, ms: Date.now() - t0 }); throw e; }
    };
    const repo = new Repo(c.env.DB, user.name + ' (testing)', true);
    try {
      if (name === 'uae-lead-to-enrolment' || name === 'india-lead-to-enrolment') {
        const india = name.startsWith('india');
        await e2e(c.env, repo, user, c.get('perms'), india ? { branch: 'BLR', prog: 'ROB', provider: 'razorpay' } : { branch: 'KRM', prog: 'SPA', provider: 'telr' }, run);
      } else if (name === 'meta-lead') {
        await run('Meta leadgen webhook (signed) → lead imported', async () => {
          const r = await simulate(c.env, repo, 'meta');
          if (!r.ok || !r.body?.leads?.length) throw new Error(`Webhook returned ${r.status}: ${JSON.stringify(r.body)}`);
          return r.body;
        });
        await run('Bad signature is rejected', async () => {
          const r = await simulate(c.env, repo, 'bad-signature');
          if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
          return 'HTTP 401';
        });
      } else if (name === 'lms-failure-retry' || name === 'moodle-failure-retry') {
        await moodleRetry(c.env, repo, user, c.get('perms'), run);
      } else throw new HttpError(404, 'Unknown scenario');
      return c.json({ ok: true, scenario: name, steps });
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) throw e;
      return c.json({ ok: false, scenario: name, steps, error: e.message });
    }
  });

  // ---------------------------------------------------------------- logs, flags, cron, cleanup
  t.get('/logs', async (c) => {
    const q = c.req.query();
    const where: string[] = [], binds: unknown[] = [];
    if (q.integration) { where.push('integration=?'); binds.push(q.integration); }
    if (q.ok === '0') where.push('ok=0');
    if (q.mode) { where.push('mode=?'); binds.push(q.mode); }
    const lim = Math.min(+(q.limit || 100), 500);
    const r = await c.env.DB.prepare(`SELECT id,at,integration,direction,operation,mode,method,url,status,ok,duration_ms,error,ref,is_test FROM integration_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).bind(...binds, lim).all();
    return c.json({ items: r.results || [] });
  });
  t.get('/logs/:id', async (c) => {
    const r = await c.env.DB.prepare('SELECT * FROM integration_logs WHERE id=?').bind(+c.req.param('id')).first();
    if (!r) throw new HttpError(404, 'Not found');
    return c.json(r);
  });
  t.post('/flags', async (c) => {
    const body = await c.req.json<any>();
    const repo = c.get('repo');
    const flags = { ...(await repo.setting<any>('test_flags')), ...body };
    await repo.putSetting('test_flags', flags);
    return c.json({ ok: true, flags });
  });
  t.post('/cron', async (c) => {
    const pending: Promise<unknown>[] = [];
    const r = await cron(c.env, (p) => pending.push(p));
    await Promise.allSettled(pending);
    return c.json({ ok: true, ...r });
  });
  t.post('/cleanup', async (c) => {
    const ids = (await c.env.DB.prepare("SELECT id FROM docs WHERE type='lead' AND is_test=1").all<any>()).results?.map((x: any) => x.id) || [];
    const res = await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM docs WHERE is_test=1'),
      c.env.DB.prepare('DELETE FROM payment_links WHERE is_test=1'),
      c.env.DB.prepare('DELETE FROM integration_logs WHERE is_test=1'),
      c.env.DB.prepare(`DELETE FROM call_events WHERE lead_id IN (${ids.map(() => '?').join(',') || "''"})`).bind(...ids),
    ]);
    await c.get('repo').putSetting('test_flags', {});
    return c.json({ ok: true, deleted: res[0].meta.changes });
  });

  return t;
}

function mockNote(env: Env, cfg: any, key: IntegrationKey) {
  if (env.INTEGRATION_MODE === 'mock') return 'INTEGRATION_MODE=mock forces every integration to mock in this environment.';
  if (!enabledInConfig(cfg, key)) return 'Disabled in Configuration → Integrations. Enable it to go live.';
  const m = missingSecrets(env, key);
  return m.length ? `Missing: ${m.join(', ')}` : '';
}

// ---------------------------------------------------------------- scenario: lead → enrolment → payment → LMS → ERPNext → withdrawal
async function e2e(env: Env, repo: Repo, user: User, perms: any, o: { branch: string; prog: string; provider: 'telr' | 'razorpay' }, run: (s: string, f: () => Promise<unknown>) => Promise<any>) {
  const app = (globalThis as any).__lofApp as FetchApp;
  const sim = async (path: string, body: string, headers: Record<string, string>) => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request('https://internal' + path, { method: 'POST', body, headers: { 'x-lof-test': await testToken(env), ...headers } }), env, ctx);
    await Promise.allSettled(pending);
    const txt = await res.text();
    try { return { status: res.status, body: JSON.parse(txt) }; } catch { return { status: res.status, body: txt }; }
  };
  const tag = Date.now().toString().slice(-6);
  // Pick a branch/programme in the same country where routing currently has a counsellor with capacity
  const cfg = await repo.setting<any>('cfg');
  const india = o.provider === 'razorpay';
  const branches = (await repo.many<any>('branch')).filter((b) => b.status === 'Operating' && (b.cur === 'INR') === india);
  const pairs = [[o.branch, o.prog], ...branches.flatMap((b) => b.programs.map((p: string) => [b.id, p]))];
  let chosen: string[] | null = null;
  for (const [b, p] of pairs) {
    if (!(await repo.get<any>('branch', b))?.programs.includes(p) || !feeFor(await repo.many<any>('fee'), p, b, 'Term (24 sessions)')) continue;
    if ((await routeLead(repo, cfg, b, p, 'Hot')).pick) { chosen = [b, p]; break; }
  }
  await run('Routing capacity check', async () => {
    if (!chosen) throw new Error(`No counsellor has capacity for a Hot lead in any ${india ? 'India' : 'UAE'} branch – check workload limits and availability`);
    return { branch: chosen[0], programme: chosen[1] };
  });
  o = { ...o, branch: chosen![0], prog: chosen![1] };
  const phone = (india ? '+9198' : '+97150') + tag + '1';

  const leadId = await run('Website form → signed webhook creates lead, routes it, queues WhatsApp/e-mail', async () => {
    if (!env.WEBSITE_FORM_SECRET) throw new Error('WEBSITE_FORM_SECRET is not set');
    const body = JSON.stringify({ student: `TEST Student ${tag}`, parent: `TEST Parent ${tag}`, phone, email: `test.parent.${tag}@example.com`, branch: o.branch, prog: o.prog, category: 'Hot', wa_consent: true, email_consent: true });
    const r = await sim('/webhooks/website', body, { 'content-type': 'application/json', 'x-lof-signature': await hmacSha256Hex(env.WEBSITE_FORM_SECRET, body) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.reference;
  });
  await run('Automated WhatsApp / e-mail messages queued or sent (consent respected)', async () => {
    const comms = await repo.many<any>('comm', 'ref1=?', [leadId]);
    return comms.map((x) => `${x.ch} ${x.tpl}: ${x.status}`);
  });
  const lead = await run('Lead assigned to an eligible counsellor', async () => {
    const l = await repo.get<any>('lead', leadId);
    if (!l.cslr) throw new Error('No eligible counsellor (check workload limits / availability in this branch)');
    return { id: l.id, counsellor: l.cslr };
  }).then(() => repo.get<any>('lead', leadId));
  await run('Exotel status callback logs the first call and stops the SLA clock', async () => {
    const q = new URLSearchParams({ token: env.EXOTEL_WEBHOOK_TOKEN || '', lead: leadId, staff: lead.cslr });
    const r = await sim(`/webhooks/exotel/status?${q}`, JSON.stringify({ CallSid: 'TESTCALL' + tag, Status: 'completed', ConversationDuration: 240, To: phone }), { 'content-type': 'application/json' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const l = await repo.get<any>('lead', leadId);
    if (!l.fc) throw new Error('First call not recorded');
    return { call: r.body.call, stage: l.stage };
  });

  // Convert + enrol exactly as the screens do (through the guarded sync)
  const fees = await repo.many<any>('fee');
  const fee = feeFor(fees, o.prog, o.branch, 'Term (24 sessions)');
  const program = await repo.get<any>('program', o.prog);
  const ids = { opp: repo.testId('opp'), stu: repo.testId('student'), enr: repo.testId('enr'), ms: repo.testId('ms') };
  await run('Lead qualified and converted to an opportunity (guarded sync)', async () => {
    const l = await repo.get<any>('lead', leadId);
    l.stage = 'Opportunity'; l.status = 'Converted'; l.test = true;
    const opp = { id: ids.opp, lead: l.id, student: l.student, parent: l.parent, branch: l.branch, prog: l.prog, pkg: fee.pkg, cslr: l.cslr, stage: 'Opportunity', exp: nowIso(), next: 'Enrol', discount: null, discReq: null, decision: 'Accepted', lost: '', stu: null, hist: [{ at: nowIso(), by: user.name, text: 'Created by testing console' }], test: true };
    const r = await applySync(env, repo, user, perms, [{ coll: 'leads', id: l.id, op: 'upsert', doc: l }, { coll: 'opps', id: opp.id, op: 'upsert', doc: opp }]);
    if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
    return opp.id;
  });
  await run('New student registered and enrolled (server re-checks the fee)', async () => {
    const c = calcFee(fee, null, true);
    const l = await repo.get<any>('lead', leadId);
    const opp = await repo.get<any>('opp', ids.opp);
    const today = nowIso().slice(0, 10);
    const s = { id: ids.stu, first: 'TEST', last: `Student ${tag}`, dob: '2015-05-05', gender: 'Female', nat: '—', school: '—', grade: '—', curr: '—', address: '—', fam: 'FAM-TEST', branch: o.branch, reg: today, parents: [{ name: l.parent, rel: 'Mother', email: l.email, mobile: l.phone, job: '—' }], moodle: null, interests: [program.name], status: 'Active', uni: '', degree: '', linkedin: '', portfolio: '', photoConsent: 'Not provided', consentDate: '', consentDoc: '', testimonials: [], docs: [], comm: [{ at: nowIso(), ch: 'Email', tpl: 'Enrolment welcome', text: `Welcome to Lab of Future! ${ids.stu}`, status: 'Sent (simulated)' }], test: true };
    const e = { id: ids.enr, stu: s.id, prog: o.prog, branch: o.branch, pkg: fee.pkg, date: today, status: 'Active', cur: fee.cur, fee: c.base, reg: c.extra, disc: c.disc, discInfo: null, tax: c.tax, total: c.total, taxPct: fee.tax, paid: 0, payStatus: 'Unpaid', opp: ids.opp, course: program.courses[0], sessions: fee.sessions, credits: program.credits, newStu: true, ms: ids.ms, test: true };
    const m = { id: ids.ms, enr: e.id, stu: s.id, status: 'Pending', mid: null, cid: e.course.moodleId, course: e.course.name, mode: 'new', last: nowIso(), err: '', attempts: 0, hist: [{ at: nowIso(), s: 'Pending', msg: 'Sync queued after enrolment' }], test: true };
    opp.stage = 'Enrolled'; opp.stu = s.id;
    const r = await applySync(env, repo, user, perms, [
      { coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }, { coll: 'ms', id: m.id, op: 'upsert', doc: m }, { coll: 'opps', id: opp.id, op: 'upsert', doc: opp },
    ]);
    if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
    for (const j of r.jobs) await runJob(env, j);
    return { student: s.id, enrolment: e.id, total: `${fee.cur} ${c.total}` };
  });
  await run('LMS enrol call accepted (Track + Credit codes, no payment data)', async () => {
    const m = await repo.get<any>('moodle_sync', ids.ms);
    if (m.status !== 'Success') throw new Error(`LMS call ${m.status}: ${m.err}`);
    return { track: m.cid, credits: m.credits?.length };
  });
  const link = await run(`Payment link created (${o.provider === 'telr' ? 'Telr, AED' : 'Razorpay, INR'})`, async () => {
    const r = await createPaymentLink(env, repo, ids.enr, undefined, user.name);
    return r;
  });
  await run('Gateway confirms payment → receipt issued, balance cleared', async () => {
    let r;
    if (o.provider === 'telr') {
      r = await sim('/webhooks/telr', new URLSearchParams({ tran_status: 'A', tran_cartid: link.id, tran_ref: 'TESTTXN' + tag, tran_amount: String(link.amount), tran_currency: link.currency }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
    } else {
      if (!env.RAZORPAY_WEBHOOK_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');
      const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.providerRef, reference_id: link.id } }, payment: { entity: { id: 'pay_TEST' + tag, amount: Math.round(link.amount * 100), method: 'upi' } } } });
      r = await sim('/webhooks/razorpay', body, { 'content-type': 'application/json', 'x-razorpay-signature': await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, body), 'x-razorpay-event-id': 'evt_TEST' + tag });
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const e = await repo.get<any>('enrollment', ids.enr);
    if (e.payStatus !== 'Paid') throw new Error(`Enrolment is ${e.payStatus}`);
    const pays = await repo.many<any>('payment', 'ref1=?', [ids.enr]);
    return { receipt: pays[0]?.rc, payment: pays[0]?.id, payStatus: e.payStatus };
  });
  await run('Payment pushed to ERPNext as a Payment Entry', async () => {
    const pays = await repo.many<any>('payment', 'ref1=?', [ids.enr]);
    const p = pays[0];
    if (!p.erp?.name) { await runJob(env, { kind: 'erp_payment', id: p.id }); }
    const fresh = await repo.get<any>('payment', p.id);
    if (!fresh.erp?.name) throw new Error(fresh.erp?.error || 'Not pushed');
    return fresh.erp;
  });
  await run('Duplicate gateway event is ignored (idempotency)', async () => {
    const r = o.provider === 'telr'
      ? await sim('/webhooks/telr', new URLSearchParams({ tran_status: 'A', tran_cartid: link.id }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
      : null;
    const pays = await repo.many<any>('payment', 'ref1=?', [ids.enr]);
    if (pays.length !== 1) throw new Error(`Expected 1 payment, found ${pays.length}`);
    return { payments: pays.length, response: r?.status ?? 'n/a' };
  });
  await run('Withdrawal: refund suggested from the refund rules, LMS cancel call sent', async () => {
    const e = await repo.get<any>('enrollment', ids.enr);
    const rf = { id: repo.testId('rf'), enr: e.id, amt: 1, reason: 'Testing console withdrawal', sessions: 0, test: true };
    const r = await applySync(env, repo, user, perms, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }, { coll: 'refunds', id: rf.id, op: 'upsert', doc: rf }]);
    if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
    for (const j of r.jobs) await runJob(env, j);
    const refund = await repo.get<any>('refund', rf.id);
    const cancel = (await repo.many<any>('moodle_sync', 'ref1=?', [e.id])).find((m) => m.op === 'cancel');
    if (!cancel || cancel.status !== 'Success') throw new Error(`LMS cancel call ${cancel ? cancel.status + ': ' + cancel.err : 'not created'}`);
    return { suggested: refund.suggested, rule: refund.rule, exception: refund.exception, cancelCall: cancel.id };
  });
}

// ---------------------------------------------------------------- scenario: LMS outage → failure → retry → success
async function moodleRetry(env: Env, repo: Repo, user: User, perms: any, run: (s: string, f: () => Promise<unknown>) => Promise<any>) {
  const cfg = await repo.setting<any>('cfg');
  if (modeFor(env, cfg, 'lms') === 'live') throw new Error('The LMS is live – the outage scenario only runs in mock mode');
  const fees = await repo.many<any>('fee');
  const fee = feeFor(fees, 'COD', 'KRM', 'Term (24 sessions)');
  const program = await repo.get<any>('program', 'COD');
  const ids = { stu: repo.testId('student'), enr: repo.testId('enr'), ms: repo.testId('ms') };
  const c = calcFee(fee, null, true);
  const today = nowIso().slice(0, 10);
  await run('Simulate LMS outage (failure injection)', async () => { await repo.putSetting('test_flags', { ...(await repo.setting('test_flags')), moodleFail: true }); return 'moodleFail = true'; });
  await run('Enrol a test student – the LMS enrol call fails and is recorded', async () => {
    const s = { id: ids.stu, first: 'TEST', last: 'LMS Retry', dob: '2014-01-01', gender: 'Male', branch: 'KRM', reg: today, parents: [{ name: 'TEST Parent', rel: 'Father', email: `lms.test.${Date.now()}@example.com`, mobile: '+971500000009' }], moodle: null, interests: [], status: 'Active', comm: [], docs: [], testimonials: [], test: true };
    const e = { id: ids.enr, stu: s.id, prog: 'COD', branch: 'KRM', pkg: fee.pkg, date: today, status: 'Active', cur: fee.cur, fee: c.base, reg: c.extra, disc: 0, discInfo: null, tax: c.tax, total: c.total, taxPct: fee.tax, paid: 0, payStatus: 'Unpaid', opp: null, course: program.courses[0], sessions: fee.sessions, credits: program.credits, newStu: true, ms: ids.ms, test: true };
    const m = { id: ids.ms, enr: e.id, stu: s.id, status: 'Pending', mid: null, cid: e.course.moodleId, course: e.course.name, mode: 'new', last: nowIso(), err: '', attempts: 0, hist: [], test: true };
    const r = await applySync(env, repo, user, perms, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }, { coll: 'ms', id: m.id, op: 'upsert', doc: m }]);
    if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
    for (const j of r.jobs) if (j.kind === 'moodle_sync') await runJob(env, j);
    const after = await repo.get<any>('moodle_sync', ids.ms);
    if (after.status !== 'Failed') throw new Error(`Expected Failed, got ${after.status}`);
    return { status: after.status, error: after.err };
  });
  await run('Outage cleared, retry succeeds (the LMS applies each reference once)', async () => {
    await repo.putSetting('test_flags', { ...(await repo.setting('test_flags')), moodleFail: false });
    const m = await repo.get<any>('moodle_sync', ids.ms);
    m.status = 'Pending';
    m.hist.push({ at: nowIso(), s: 'Pending', msg: 'Retry requested from testing console' });
    const r = await applySync(env, repo, user, perms, [{ coll: 'ms', id: m.id, op: 'upsert', doc: m }]);
    if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
    for (const j of r.jobs) await runJob(env, j);
    const after = await repo.get<any>('moodle_sync', ids.ms);
    if (after.status !== 'Success') throw new Error(`Expected Success, got ${after.status}: ${after.err}`);
    return { status: after.status, attempts: after.attempts, track: after.cid };
  });
}

/** A test student with one unpaid enrolment in a branch of the given currency (Testing console only). */
async function makeTestEnrollment(env: Env, repo: Repo, user: User, perms: any, currency: 'AED' | 'INR') {
  const branches = (await repo.many<any>('branch')).filter((b) => b.status === 'Operating' && b.cur === currency && user.scope.includes(b.id));
  const fees = await repo.many<any>('fee');
  for (const b of branches) {
    for (const prog of b.programs) {
      const fee = feeFor(fees, prog, b.id, 'Term (24 sessions)');
      const program = await repo.get<any>('program', prog);
      if (!fee || !program?.courses?.length) continue;
      const c = calcFee(fee, null, true);
      const today = nowIso().slice(0, 10);
      const ids = { stu: repo.testId('student'), enr: repo.testId('enr') };
      const s = { id: ids.stu, first: 'TEST', last: 'Payment', dob: '2015-01-01', branch: b.id, reg: today, parents: [{ name: 'TEST Parent', rel: 'Mother', email: `pay.test.${Date.now()}@example.com`, mobile: '+971500000010' }], moodle: null, status: 'Active', comm: [], docs: [] };
      const e = { id: ids.enr, stu: s.id, prog, branch: b.id, pkg: fee.pkg, date: today, status: 'Active', cur: fee.cur, total: c.total, discInfo: null, opp: null, course: program.courses[0], newStu: true };
      const r = await applySync(env, repo, user, perms, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }]);
      if (!r.ok) throw new Error(r.rejected.map((x) => x.reason).join('; '));
      return e.id;
    }
  }
  throw new Error(`No operating ${currency} branch with an active fee in your scope`);
}
