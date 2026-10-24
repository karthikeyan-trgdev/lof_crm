// Public webhook endpoints. Each one authenticates the sender (signature or shared token), is idempotent,
// logs the request in integration_logs (Testing Console → Logs) and returns quickly.
import { Hono } from 'hono';
import type { Env, Job } from '../types';
import { HttpError } from '../types';
import { Repo, nowIso } from '../lib/db';
import { normPhone } from '../lib/indexing';
import { hmacSha256Hex, safeEqual } from '../lib/crypto';
import { createLead, addEv, addAudit, notify } from '../domain/core';
import { allow, clientIp } from '../lib/ratelimit';
import { logInbound, settleLink } from '../domain/workflows';
import { dispatch } from '../jobs';
import { modeFor } from '../integrations/base';
import { verifyHubSignature, parseWebhook } from '../integrations/whatsapp';
import { parseLeadgenWebhook, fetchLead, mapLead } from '../integrations/meta';
import { parseStatus } from '../integrations/exotel';
import { razorpayVerifyWebhook, telrCheck } from '../integrations/payments';

type WEnv = { Bindings: Env; Variables: { isTest: boolean } };
export const webhooks = new Hono<WEnv>();

/** Internal marker the Testing Console puts on simulated events (never sent by providers). */
export const testToken = async (env: Env) => 'lof-test.' + (await hmacSha256Hex(env.JWT_SECRET, 'testing-console')).slice(0, 32);
webhooks.use('*', async (c, next) => {
  const h = c.req.header('x-lof-test');
  c.set('isTest', !!h && safeEqual(h, await testToken(c.env)));
  await next();
});

const waitOf = (c: any) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
const isTestReq = (c: any): boolean => c.get('isTest');

/** Allowed browser origins for the embedded enquiry form (array or comma-separated text from Configuration). */
const originsOf = (cfg: any): string[] => {
  const o = cfg?.integ?.web?.origins;
  return (Array.isArray(o) ? o : String(o || '').split(',')).map((x: string) => x.trim().replace(/\/+$/, '')).filter(Boolean);
};

/** Returns false if this provider event was already processed. */
async function firstTime(env: Env, provider: string, eventId: string) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (provider,event_id) VALUES (?,?)').bind(provider, eventId).run();
  return r.meta.changes > 0;
}

// ------------------------------------------------------------------ Website enquiry form
// Server-to-server: header X-LOF-Signature = hex HMAC-SHA256(raw body, WEBSITE_FORM_SECRET)
// Browser embed:    origin must be listed in Configuration → Integrations → Website (cfg.integ.web.origins)
webhooks.post('/website', async (c) => {
  const raw = await c.req.text();
  const repo = new Repo(c.env.DB, 'Website form', isTestReq(c));
  const cfg = await repo.setting<any>('cfg');
  if (!cfg.integ?.web?.on && !isTestReq(c)) throw new HttpError(503, 'Website lead capture is disabled');
  const sig = c.req.header('x-lof-signature');
  const origin = c.req.header('origin') || '';
  const origins = originsOf(cfg);
  const signed = sig && c.env.WEBSITE_FORM_SECRET && safeEqual(await hmacSha256Hex(c.env.WEBSITE_FORM_SECRET, raw), sig);
  const browserPost = !signed && !!origin && origins.includes(origin);
  if (browserPost && !isTestReq(c)) {
    if (!(await allow(c.env, 'web-ip:' + clientIp(c.req.raw), 10, 600))) throw new HttpError(429, 'Too many enquiries from this connection – please call the centre');
  }
  if (!signed && !browserPost) {
    await logInbound(c.env, 'website', 'lead.submit', false, raw, { error: 'unauthorised' }, undefined, isTestReq(c), 'Bad signature / origin');
    throw new HttpError(401, 'Invalid signature');
  }
  let body: any;
  try { body = raw.trim().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { throw new HttpError(400, 'Invalid body'); }
  if (body.website) return c.json({ ok: true }); // honeypot field filled by bots
  if (browserPost && c.env.TURNSTILE_SECRET && !isTestReq(c)) {
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: String(body['cf-turnstile-response'] || ''), remoteip: clientIp(c.req.raw) }) }).then((r) => r.json<any>()).catch(() => ({ success: false }));
    if (!v.success) throw new HttpError(400, 'Please complete the security check and try again');
  }
  for (const k of Object.keys(body)) if (typeof body[k] === 'string') body[k] = body[k].slice(0, 2000);
  for (const k of ['student', 'parent', 'phone', 'branch', 'prog']) if (!String(body[k] || '').trim()) throw new HttpError(400, `${k} is required`);
  try {
    const r = await createLead(repo, {
      student: body.student, parent: body.parent, phone: body.phone, email: body.email, branch: body.branch, prog: body.prog, src: 'Website',
      camp: body.campaign || 'Website Organic', cat: ['Hot', 'Warm', 'Cold'].includes(body.category) ? body.category : 'Warm', dob: body.dob, school: body.school, grade: body.grade,
      wa: body.wa_consent === true || body.wa_consent === 'on' || body.wa_consent === '1', em: body.email_consent === true || body.email_consent === 'on' || body.email_consent === '1',
      notes: body.message || '', external: { utm: body.utm || undefined, page: body.page || undefined },
    }, 'Website form');
    await dispatch(c.env, waitOf(c), r.queuedComms.map((id) => ({ kind: 'send_comm' as const, id })));
    await logInbound(c.env, 'website', 'lead.submit', true, raw, { lead: r.lead.id }, r.lead.id, isTestReq(c));
    const res = c.json({ ok: true, reference: r.lead.id });
    if (origin && origins.includes(origin)) res.headers.set('access-control-allow-origin', origin);
    return res;
  } catch (e: any) {
    await logInbound(c.env, 'website', 'lead.submit', false, raw, { error: e.message }, undefined, isTestReq(c), e.message);
    throw new HttpError(422, e.message);
  }
});
webhooks.options('/website', async (c) => {
  const cfg = await new Repo(c.env.DB).setting<any>('cfg');
  const origin = c.req.header('origin') || '';
  if (!originsOf(cfg).includes(origin)) return c.body(null, 403);
  return c.body(null, 204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
});

// ------------------------------------------------------------------ Meta Lead Ads
webhooks.get('/meta', (c) => {
  if (c.req.query('hub.mode') === 'subscribe' && c.env.META_VERIFY_TOKEN && safeEqual(c.req.query('hub.verify_token') || '', c.env.META_VERIFY_TOKEN)) return c.text(c.req.query('hub.challenge') || '');
  return c.text('Forbidden', 403);
});
webhooks.post('/meta', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyHubSignature(raw, c.req.header('x-hub-signature-256'), c.env.META_APP_SECRET))) {
    await logInbound(c.env, 'meta', 'leadgen.webhook', false, raw, {}, undefined, isTestReq(c), 'Bad signature');
    throw new HttpError(401, 'Invalid signature');
  }
  const repo = new Repo(c.env.DB, 'Meta Lead Ads', isTestReq(c));
  const cfg = await repo.setting<any>('cfg');
  const changes = parseLeadgenWebhook(JSON.parse(raw));
  const created: string[] = [];
  // Meta expects a fast 200; process in the background
  const work = (async () => {
    const [branches, programs] = await Promise.all([repo.many<any>('branch'), repo.many<any>('program')]);
    const jobs: Job[] = [];
    for (const ch of changes) {
      if (!(await firstTime(c.env, 'meta', ch.leadgenId))) continue;
      try {
        if (!cfg.integ?.meta?.on && !repo.isTest) throw new Error('Meta lead integration is disabled in Configuration');
        // Test events (Testing Console) carry a fake leadgen id, so their lead details come from the mock
        const lead = await fetchLead({ env: c.env, cfg, mode: repo.isTest ? 'mock' : modeFor(c.env, cfg, 'meta'), isTest: repo.isTest }, ch.leadgenId, ch.formId);
        const input = mapLead(cfg, lead, branches, programs);
        const r = await createLead(repo, input, 'Meta Lead Ads');
        created.push(r.lead.id);
        jobs.push(...r.queuedComms.map((id) => ({ kind: 'send_comm' as const, id })));
        await c.env.DB.prepare('UPDATE webhook_events SET result=? WHERE provider=? AND event_id=?').bind(r.lead.id, 'meta', ch.leadgenId).run();
      } catch (e: any) {
        await c.env.DB.prepare('UPDATE webhook_events SET result=? WHERE provider=? AND event_id=?').bind('error: ' + e.message, 'meta', ch.leadgenId).run();
        await notify(repo, { type: 'none', sev: 'crit', text: `Meta lead ${ch.leadgenId} could not be imported: ${e.message}`, route: { page: 'testing' }, roles: ['System Administrator', 'Admissions Head'] });
      }
    }
    await logInbound(c.env, 'meta', 'leadgen.webhook', true, raw, { leads: created }, created.join(','), repo.isTest);
    await dispatch(c.env, waitOf(c), jobs);
  })();
  c.executionCtx.waitUntil(work);
  if (isTestReq(c)) await work; // the Testing Console waits so it can show the result
  return c.json({ ok: true, received: changes.length, leads: created });
});

// ------------------------------------------------------------------ WhatsApp Cloud API
webhooks.get('/whatsapp', (c) => {
  if (c.req.query('hub.mode') === 'subscribe' && c.env.WHATSAPP_VERIFY_TOKEN && safeEqual(c.req.query('hub.verify_token') || '', c.env.WHATSAPP_VERIFY_TOKEN)) return c.text(c.req.query('hub.challenge') || '');
  return c.text('Forbidden', 403);
});
webhooks.post('/whatsapp', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyHubSignature(raw, c.req.header('x-hub-signature-256'), c.env.WHATSAPP_APP_SECRET))) {
    await logInbound(c.env, 'whatsapp', 'webhook', false, raw, {}, undefined, isTestReq(c), 'Bad signature');
    throw new HttpError(401, 'Invalid signature');
  }
  const repo = new Repo(c.env.DB, 'WhatsApp', isTestReq(c));
  const ev = parseWebhook(JSON.parse(raw));
  const result = { statuses: 0, messages: 0, unmatched: 0 };
  const ORDER = ['sent', 'delivered', 'read'];
  for (const s of ev.statuses) {
    const row = await c.env.DB.prepare("SELECT data FROM docs WHERE type='comm' AND ref2=?").bind(s.id).first<{ data: string }>();
    if (!row) { result.unmatched++; continue; }
    const cm = JSON.parse(row.data);
    const cur = String(cm.waStatus || 'sent');
    if (s.status === 'failed') { cm.waStatus = 'failed'; cm.status = `Failed – ${s.error || 'WhatsApp delivery failed'}`; }
    else if (ORDER.indexOf(s.status) >= ORDER.indexOf(cur)) { cm.waStatus = s.status; cm.status = s.status[0].toUpperCase() + s.status.slice(1); }
    (cm.waEvents ||= []).push({ status: s.status, at: s.timestamp ? new Date(+s.timestamp * 1000).toISOString() : nowIso() });
    await repo.put('comm', cm);
    result.statuses++;
  }
  for (const m of ev.messages) {
    if (!(await firstTime(c.env, 'whatsapp', m.id))) continue;
    const lead = await repo.many<any>('lead', 'ref1=?', [normPhone(m.from)], 'created_at DESC');
    const l = lead.find((x) => x.status === 'Open') || lead[0];
    if (!l) { result.unmatched++; await notify(repo, { type: 'new', sev: 'info', text: `WhatsApp from unknown number +${m.from}${m.name ? ' (' + m.name + ')' : ''}: "${m.text.slice(0, 80)}"`, route: { page: 'leads', preset: 'all' }, roles: ['Centre Administrator', 'Admissions Head'] }); continue; }
    const id = await repo.newId('cm');
    await repo.put('comm', { id, lead: l.id, ch: 'WhatsApp', tpl: 'Inbound', text: m.text, at: m.timestamp ? new Date(+m.timestamp * 1000).toISOString() : nowIso(), status: 'Received', by: l.parent, waMsgId: m.id, inbound: true });
    if (l.avail?.s === 'Requested') { l.avail = { s: 'Replied', slot: null, text: m.text }; }
    addEv(l, 'msg', `WhatsApp received from parent: "${m.text.slice(0, 120)}"`, l.parent);
    await repo.put('lead', l);
    await notify(repo, { type: 'new', sev: 'info', text: `WhatsApp reply from ${l.parent} (${l.student}): "${m.text.slice(0, 80)}"`, route: { page: 'lead', id: l.id }, roles: ['Counsellor', 'Centre Administrator'], branch: l.branch, cslr: l.cslr });
    result.messages++;
  }
  await logInbound(c.env, 'whatsapp', 'webhook', true, raw, result, undefined, repo.isTest);
  return c.json({ ok: true, ...result });
});

// ------------------------------------------------------------------ Exotel
const exoAuth = (c: any) => {
  if (!c.env.EXOTEL_WEBHOOK_TOKEN || !safeEqual(c.req.query('token') || '', c.env.EXOTEL_WEBHOOK_TOKEN)) throw new HttpError(401, 'Invalid token');
  const allowed = String(c.env.EXOTEL_ALLOWED_IPS || '').split(',').map((x: string) => x.trim()).filter(Boolean);
  if (allowed.length && !isTestReq(c) && !allowed.includes(clientIp(c.req.raw))) throw new HttpError(403, 'Caller not allowed');
};
async function exoParams(c: any): Promise<Record<string, any>> {
  const q = c.req.query();
  if (c.req.method === 'GET') return q;
  const ct = c.req.header('content-type') || '';
  const raw = await c.req.text();
  const body = ct.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
  return { ...q, ...body };
}

/** Passthru applet on the incoming-call flow: identifies the caller and pops the lead on screen. */
webhooks.all('/exotel/incoming', async (c) => {
  exoAuth(c);
  const p = await exoParams(c);
  const repo = new Repo(c.env.DB, 'Exotel', isTestReq(c));
  const from = String(p.CallFrom || p.From || '');
  const leads = await repo.many<any>('lead', 'ref1=?', [normPhone(from)], 'created_at DESC');
  const l = leads.find((x) => x.status === 'Open') || leads[0] || null;
  await c.env.DB.prepare('INSERT INTO call_events (call_sid,from_number,lead_id,staff_id,branch) VALUES (?,?,?,?,?)').bind(p.CallSid || null, from, l?.id || null, l?.cslr || null, l?.branch || null).run();
  if (l) {
    (l.pendingCalls ||= []).push({ sid: p.CallSid, at: nowIso(), dir: 'Incoming' });
    addEv(l, 'call', `Incoming call from ${from} (Exotel)`, 'Exotel');
    await repo.put('lead', l);
  }
  await logInbound(c.env, 'exotel', 'incoming.passthru', true, p, { lead: l?.id || null }, l?.id, repo.isTest);
  return c.text('OK', 200); // 200 lets the call continue in the Exotel flow
});

/** Status callback for click-to-call and for incoming calls (Connect applet). Logs the call on the lead. */
webhooks.all('/exotel/status', async (c) => {
  exoAuth(c);
  const p = await exoParams(c);
  const st = parseStatus(p);
  if (st.sid && !(await firstTime(c.env, 'exotel', st.sid))) return c.json({ ok: true, duplicate: true });
  const repo = new Repo(c.env.DB, 'Exotel', isTestReq(c));
  let l: any = p.lead ? await repo.get<any>('lead', String(p.lead)) : null;
  if (!l) {
    const other = String(p.Direction || '').includes('incoming') ? st.from : st.to;
    const ls = await repo.many<any>('lead', 'ref1=?', [normPhone(other)], 'created_at DESC');
    l = ls.find((x) => x.status === 'Open') || ls[0] || null;
  }
  if (!l) {
    await logInbound(c.env, 'exotel', 'call.status', true, p, { matched: false }, st.sid, repo.isTest);
    return c.json({ ok: true, matched: false });
  }
  const pending = (l.pendingCalls || []).find((x: any) => x.sid === st.sid);
  const incoming = pending?.dir === 'Incoming' || String(p.Direction || '').includes('incoming');
  const staffId = String(p.staff || pending?.by || l.cslr || '');
  const branchName = ((await repo.get<any>('branch', l.branch)) || {}).name || l.branch;
  const callId = await repo.newId('call');
  const first = !l.fc && !incoming && st.status === 'Completed';
  await repo.put('call', {
    id: callId, lead: l.id, dir: incoming ? 'Incoming' : 'Outgoing', from: incoming ? l.phone : 'LOF ' + branchName, to: incoming ? 'LOF ' + branchName : l.phone,
    at: nowIso(), dur: st.durationMin, status: st.status, outcome: st.status === 'Completed' ? 'Connected – add outcome' : 'No answer', notes: 'Logged automatically from Exotel',
    rec: st.recordingUrl, first, by: staffId, sid: st.sid, test: repo.isTest || undefined,
  });
  l.pendingCalls = (l.pendingCalls || []).filter((x: any) => x.sid !== st.sid);
  if (st.status === 'Completed' && !l.fc) l.fc = nowIso();
  if (st.status === 'Completed' && l.stage === 'New Lead') l.stage = 'Contacted';
  addEv(l, 'call', `${incoming ? 'Incoming' : 'Outgoing'} call ${st.status.toLowerCase()} · ${st.durationMin} min (Exotel)${st.recordingUrl ? ' · recording available' : ''}`, 'Exotel');
  await repo.put('lead', l);
  if (staffId) await notify(repo, { type: 'call', sev: 'info', text: `Call with ${l.parent} ${st.status.toLowerCase()} – add the call outcome for ${l.student}`, route: { page: 'lead', id: l.id }, roles: ['Counsellor', 'Centre Administrator'], branch: l.branch, cslr: staffId });
  await logInbound(c.env, 'exotel', 'call.status', true, p, { lead: l.id, call: callId }, l.id, repo.isTest);
  return c.json({ ok: true, lead: l.id, call: callId });
});

// ------------------------------------------------------------------ Razorpay
webhooks.post('/razorpay', async (c) => {
  const raw = await c.req.text();
  if (!(await razorpayVerifyWebhook(raw, c.req.header('x-razorpay-signature'), c.env.RAZORPAY_WEBHOOK_SECRET))) {
    await logInbound(c.env, 'razorpay', 'webhook', false, raw, {}, undefined, isTestReq(c), 'Bad signature');
    throw new HttpError(401, 'Invalid signature');
  }
  const body = JSON.parse(raw);
  const eventId = c.req.header('x-razorpay-event-id') || `${body.event}:${body.payload?.payment?.entity?.id || body.created_at}`;
  if (!(await firstTime(c.env, 'razorpay', eventId))) return c.json({ ok: true, duplicate: true });
  const repo = new Repo(c.env.DB, 'Payment gateway', isTestReq(c));
  let result: any = { ignored: body.event };
  if (body.event === 'payment_link.paid') {
    const pl = body.payload.payment_link.entity, pay = body.payload.payment.entity;
    const link = await c.env.DB.prepare('SELECT id FROM payment_links WHERE provider_ref=? OR id=?').bind(pl.id, pl.reference_id).first<any>();
    if (!link) result = { error: 'unknown link' };
    else {
      const methods: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Bank transfer', wallet: 'Online' };
      result = await settleLink(c.env, repo, link.id, { amount: pay.amount / 100, txnRef: pay.id, method: methods[pay.method] || 'Online' });
      if (result.paymentId) await dispatch(c.env, waitOf(c), [{ kind: 'erp_payment', id: result.paymentId }]);
    }
  } else if (['payment_link.cancelled', 'payment_link.expired'].includes(body.event)) {
    const pl = body.payload.payment_link.entity;
    await c.env.DB.prepare("UPDATE payment_links SET status=? WHERE provider_ref=? AND status='created'").bind(body.event.split('.')[1], pl.id).run();
    result = { updated: body.event };
  }
  await logInbound(c.env, 'razorpay', body.event, true, raw, result, result.paymentId, repo.isTest);
  return c.json({ ok: true, ...result, payment: undefined });
});

// ------------------------------------------------------------------ Telr (transaction advice + customer return)
async function telrVerify(c: any, linkId: string, mockPaid: boolean) {
  const link = await c.env.DB.prepare('SELECT * FROM payment_links WHERE id=?').bind(linkId).first();
  if (!link) throw new HttpError(404, 'Unknown payment link');
  // A mock "paid" result is only ever honoured for test links or outside production
  if (mockPaid && !(link.is_test || c.env.APP_ENV !== 'production')) mockPaid = false;
  const repo = new Repo(c.env.DB, 'Payment gateway', !!link.is_test);
  const cfg = await repo.setting<any>('cfg');
  // Never trust the browser or the advice body alone: confirm with Telr server-to-server
  const mode = link.provider.endsWith('-mock') ? 'mock' : modeFor(c.env, cfg, 'telr');
  const st = await telrCheck({ env: c.env, mode }, link.provider_ref, mockPaid ? { amount: link.amount, currency: link.currency } : undefined);
  if (st.paid) {
    const r = await settleLink(c.env, repo, link.id, { amount: st.amount || link.amount, txnRef: st.txnRef, method: 'Card' });
    if (r.paymentId) await dispatch(c.env, waitOf(c), [{ kind: 'erp_payment', id: r.paymentId }]);
    return { link, status: 'paid', ...r };
  }
  if (st.final) await c.env.DB.prepare("UPDATE payment_links SET status=? WHERE id=? AND status='created'").bind(st.status, link.id).run();
  return { link, status: st.status };
}
webhooks.post('/telr', async (c) => {
  const p = Object.fromEntries(new URLSearchParams(await c.req.text())) as any;
  const linkId = p.tran_cartid || p.cart_id;
  if (!linkId) throw new HttpError(400, 'Missing cart id');
  const r = await telrVerify(c, linkId, isTestReq(c) && p.tran_status === 'A');
  await logInbound(c.env, 'telr', 'transaction.advice', true, p, { status: r.status, paymentId: (r as any).paymentId }, linkId, isTestReq(c));
  return c.text('OK');
});

/** Customer lands here after Telr / Razorpay checkout. */
webhooks.get('/pay/return', async (c) => {
  const linkId = c.req.query('link') || '';
  const link = await c.env.DB.prepare('SELECT * FROM payment_links WHERE id=?').bind(linkId).first<any>();
  let msg = 'We could not find this payment.';
  if (link) {
    if (link.provider.startsWith('telr')) {
      const r = await telrVerify(c, linkId, c.req.query('mock') === '1' && link.provider.endsWith('-mock'));
      msg = r.status === 'paid' ? 'Thank you – your payment was received. A receipt will follow.' : r.status === 'created' ? 'Your payment is being confirmed. You may close this page.' : 'The payment was not completed. Please contact the centre.';
    } else {
      const fresh = await c.env.DB.prepare('SELECT status FROM payment_links WHERE id=?').bind(linkId).first<any>();
      msg = fresh?.status === 'paid' || c.req.query('razorpay_payment_link_status') === 'paid' ? 'Thank you – your payment was received. A receipt will follow.' : 'Your payment is being confirmed. You may close this page.';
    }
  }
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title><body style="font-family:Arial,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f3f5f9;color:#1b2633"><div style="background:#fff;border:1px solid #e1e6ee;border-radius:10px;padding:28px;max-width:420px;text-align:center"><h1 style="font-size:18px;color:#1d3557;margin:0 0 8px">Lab of Future</h1><p>${msg}</p></div></body>`);
});

export { addAudit };
