import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setup, SECRETS, USERS, doc, stubFetch, type TestCtx } from '../helpers/app';
import { hmacSha256Hex } from '../../src/lib/crypto';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
afterEach(() => vi.unstubAllGlobals());

const sign = (secret: string, body: string) => hmacSha256Hex(secret, body);

describe('website lead capture', () => {
  const form = { student: 'Ali Test', parent: 'Sara Test', phone: '+971 50 999 1111', email: 'sara.test@example.com', branch: 'KRM', prog: 'SPA', category: 'Hot', wa_consent: true, email_consent: true };

  it('creates, routes and greets a lead from a signed submission', async () => {
    const raw = JSON.stringify(form);
    const r = await t.call('POST', '/webhooks/website', { raw, headers: { 'content-type': 'application/json', 'x-lof-signature': await sign(SECRETS.WEBSITE_FORM_SECRET, raw) } });
    expect(r.status).toBe(200);
    const l = await doc(t, 'lead', r.body.reference);
    expect(l).toMatchObject({ src: 'Website', branch: 'KRM', prog: 'SPA', cat: 'Hot', stage: 'New Lead', status: 'Open' });
    expect(l.cslr).toBe('S02'); // the only Karama counsellor handling Space & Astronomy
    const comms = await t.sql<any>("SELECT data FROM docs WHERE type='comm' AND ref1=?", l.id);
    expect(comms.map((c) => JSON.parse(c.data).status)).toEqual(['Sent (mock)', 'Sent (mock)', 'Sent (mock)']);
    const tasks = await t.sql<any>("SELECT data FROM docs WHERE type='task' AND ref1=?", l.id);
    expect(JSON.parse(tasks[0].data).type).toBe('First call');
  });
  it('rejects unsigned or tampered submissions', async () => {
    const raw = JSON.stringify(form);
    expect((await t.call('POST', '/webhooks/website', { raw, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await t.call('POST', '/webhooks/website', { raw: raw.replace('Ali', 'Bob'), headers: { 'content-type': 'application/json', 'x-lof-signature': await sign(SECRETS.WEBSITE_FORM_SECRET, raw) } })).status).toBe(401);
  });
  it('accepts browser posts from an allowed origin and ignores bots (honeypot)', async () => {
    await t.setCfg((c) => { c.integ.web.origins = ['https://labofuture.example']; });
    const ok = await t.call('POST', '/webhooks/website', { raw: JSON.stringify(form), headers: { 'content-type': 'application/json', origin: 'https://labofuture.example' } });
    expect(ok.status).toBe(200);
    const bot = await t.call('POST', '/webhooks/website', { raw: JSON.stringify({ ...form, website: 'spam' }), headers: { 'content-type': 'application/json', origin: 'https://labofuture.example' } });
    expect(bot.body.reference).toBeUndefined();
  });
  it('refuses a programme the branch does not offer', async () => {
    const raw = JSON.stringify({ ...form, branch: 'HYD', prog: 'SPA' });
    const r = await t.call('POST', '/webhooks/website', { raw, headers: { 'content-type': 'application/json', 'x-lof-signature': await sign(SECRETS.WEBSITE_FORM_SECRET, raw) } });
    expect(r.status).toBe(422);
  });
});

describe('Meta Lead Ads (live mode, Graph API stubbed)', () => {
  it('verifies the subscription and imports a lead once', async () => {
    t = await setup({ INTEGRATION_MODE: 'auto' });
    const v = await t.call('GET', `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${SECRETS.META_VERIFY_TOKEN}&hub.challenge=42`);
    expect(v.text).toBe('42');
    expect((await t.call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status).toBe(403);

    await t.setCfg((c) => { c.integ.meta.forms = { F9: { branch: 'SPC', prog: 'AI', camp: 'Meta Lead Form – AI Coding', cat: 'Hot' } }; });
    const { calls } = stubFetch([[/graph\.facebook\.com\/v21\.0\/L777/, () => ({ json: { id: 'L777', form_id: 'F9', platform: 'fb', field_data: [{ name: 'full_name', values: ['Huda Saleh'] }, { name: 'student_name', values: ['Omar Saleh'] }, { name: 'phone_number', values: ['+971501234999'] }, { name: 'email', values: ['huda@example.com'] }] } })]]);
    const raw = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'L777', form_id: 'F9' } }] }] });
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await sign(SECRETS.META_APP_SECRET, raw)) };
    expect((await t.call('POST', '/webhooks/meta', { raw, headers })).status).toBe(200);
    expect(calls[0].url).toContain('access_token=meta-page-token');
    const leads = await t.sql<any>("SELECT data FROM docs WHERE type='lead' AND ref1='501234999'");
    expect(leads).toHaveLength(1);
    expect(JSON.parse(leads[0].data)).toMatchObject({ student: 'Omar Saleh', parent: 'Huda Saleh', src: 'Facebook', branch: 'SPC', prog: 'AI', cat: 'Hot' });
    await t.call('POST', '/webhooks/meta', { raw, headers }); // Meta retries – must not duplicate
    expect(await t.sql("SELECT id FROM docs WHERE type='lead' AND ref1='501234999'")).toHaveLength(1);
    const log = await t.sql<any>("SELECT url FROM integration_logs WHERE integration='meta' AND direction='out'");
    expect(log[0].url).not.toContain('meta-page-token'); // redacted
  });
});

describe('WhatsApp webhooks', () => {
  it('updates delivery status and threads inbound replies onto the lead', async () => {
    const tok = await t.login(USERS.admin);
    await t.call('PUT', '/api/v1/sync', { token: tok, body: { changes: [{ coll: 'comms', id: 'CM950', op: 'upsert', doc: { id: 'CM950', lead: 'LD-26-1009', ch: 'WhatsApp', tpl: 'Follow-up nudge', text: 'hi', at: new Date().toISOString(), status: 'Sent (simulated)', by: 'x' } }] } });
    const wamid = (await doc(t, 'comm', 'CM950')).waMsgId;
    const status = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'read', timestamp: '1760000000' }] } }] }] });
    await t.call('POST', '/webhooks/whatsapp', { raw: status, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await sign(SECRETS.WHATSAPP_APP_SECRET, status)) } });
    expect((await doc(t, 'comm', 'CM950')).status).toBe('Read');

    const l = await doc(t, 'lead', 'LD-26-1009');
    const inbound = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.IN1', from: l.phone.replace(/\D/g, ''), type: 'text', text: { body: 'Call me at 6pm' } }] } }] }] });
    const r = await t.call('POST', '/webhooks/whatsapp', { raw: inbound, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + (await sign(SECRETS.WHATSAPP_APP_SECRET, inbound)) } });
    expect(r.body.messages).toBe(1);
    const after = await doc(t, 'lead', 'LD-26-1009');
    expect(after.avail).toMatchObject({ s: 'Replied', text: 'Call me at 6pm' });
    expect(after.events.at(-1).text).toContain('Call me at 6pm');
  });
  it('rejects unsigned events', async () => {
    expect((await t.call('POST', '/webhooks/whatsapp', { raw: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
  });
});

describe('Exotel webhooks', () => {
  it('pops incoming calls to the assigned counsellor and logs completed calls', async () => {
    const l = await doc(t, 'lead', 'LD-26-1009'); // uncalled, Priya
    expect(l.fc).toBeNull();
    await t.call('GET', `/webhooks/exotel/incoming?token=${SECRETS.EXOTEL_WEBHOOK_TOKEN}&CallSid=IN1&CallFrom=${encodeURIComponent(l.phone)}&Direction=incoming`);
    const pop = await t.call('GET', '/api/v1/calls/incoming?since=2000-01-01', { token: await t.login(USERS.priya) });
    expect(pop.body.events[0].lead_id).toBe('LD-26-1009');

    const r = await t.call('POST', `/webhooks/exotel/status?token=${SECRETS.EXOTEL_WEBHOOK_TOKEN}&lead=LD-26-1009&staff=S01`, { raw: JSON.stringify({ CallSid: 'OUT1', Status: 'completed', ConversationDuration: 200, RecordingUrl: 'https://rec/1.mp3', To: l.phone }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    const after = await doc(t, 'lead', 'LD-26-1009');
    expect(after.fc).not.toBeNull();
    expect(after.stage).toBe('Contacted');
    const call = await doc(t, 'call', r.body.call);
    expect(call).toMatchObject({ dir: 'Outgoing', status: 'Completed', dur: 3.3, rec: 'https://rec/1.mp3', first: true });
    const dup = await t.call('POST', `/webhooks/exotel/status?token=${SECRETS.EXOTEL_WEBHOOK_TOKEN}&lead=LD-26-1009`, { raw: JSON.stringify({ CallSid: 'OUT1', Status: 'completed' }), headers: { 'content-type': 'application/json' } });
    expect(dup.body.duplicate).toBe(true);
  });
  it('rejects requests without the shared token', async () => {
    expect((await t.call('GET', '/webhooks/exotel/incoming?CallFrom=1')).status).toBe(401);
  });
});

describe('payment gateways', () => {
  async function link(enr: string) {
    const r = await t.call('POST', '/api/v1/payments/links', { token: await t.login(USERS.admin), body: { enrollmentId: enr } });
    expect(r.status).toBe(201);
    return r.body;
  }
  it('Razorpay: signed payment_link.paid records the payment once', async () => {
    // Make an INR enrolment with a balance: Dhruv (BLR) is fully paid, so use a fresh partial payment state
    // give the (fully paid) Bengaluru enrolment an open balance of 1,000 INR
    await t.d1.prepare("UPDATE docs SET data=json_set(data,'$.total',json_extract(data,'$.total')+1000,'$.payStatus','Partially paid') WHERE type='enrollment' AND id='EN-26-0006'").run();
    const l = await link('EN-26-0006');
    expect(l.provider).toBe('razorpay');
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: l.providerRef, reference_id: l.id } }, payment: { entity: { id: 'pay_1', amount: Math.round(l.amount * 100), method: 'upi' } } } });
    const headers = { 'content-type': 'application/json', 'x-razorpay-signature': await sign(SECRETS.RAZORPAY_WEBHOOK_SECRET, body), 'x-razorpay-event-id': 'evt_1' };
    expect((await t.call('POST', '/webhooks/razorpay', { raw: body, headers })).status).toBe(200);
    const e = await doc(t, 'enrollment', 'EN-26-0006');
    expect(e.payStatus).toBe('Paid');
    const pays = (await t.sql<any>("SELECT data FROM docs WHERE type='payment' AND ref1='EN-26-0006'")).map((x) => JSON.parse(x.data)).filter((x) => x.gateway);
    expect(pays).toHaveLength(1);
    const p = pays[0];
    expect(p).toMatchObject({ method: 'UPI', ref: 'pay_1', branch: 'BLR', amt: 1000 });
    expect(p.rc).toMatch(/^RC-BLR-26-\d{4}$/);
    expect(p.erp.name).toBe('ACC-PAY-MOCK-' + p.id); // pushed to ERPNext (mock)
    expect((await t.call('POST', '/webhooks/razorpay', { raw: body, headers })).body.duplicate).toBe(true);
    expect((await t.call('POST', '/webhooks/razorpay', { raw: body, headers: { ...headers, 'x-razorpay-signature': 'bad' } })).status).toBe(401);
  });
  it('Telr: transaction advice is confirmed with Telr before recording (live, stubbed)', async () => {
    t = await setup({ INTEGRATION_MODE: 'auto' });
    await t.setCfg((c) => { c.integ.pay.on = true; });
    let checks = 0;
    stubFetch([[/secure\.telr\.com\/gateway\/order\.json/, (req) => {
      const b = JSON.parse(req.body);
      expect(b.authkey).toBe(SECRETS.TELR_AUTH_KEY);
      if (b.method === 'create') return { json: { method: 'create', order: { ref: 'TELRREF1', url: 'https://secure.telr.com/gateway/process.html?o=TELRREF1' } } };
      checks++;
      return { json: { order: { ref: 'TELRREF1', status: { code: 3, text: 'Paid' }, amount: '1260.00', currency: 'AED', transaction: { ref: 'TXN9' } } } };
    }]]);
    const l = await link('EN-26-0002');
    expect(l.url).toContain('secure.telr.com');
    await t.call('POST', '/webhooks/telr', { raw: `tran_cartid=${l.id}&tran_status=A&tran_ref=forged`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(checks).toBe(1);
    const pays = (await t.sql<any>("SELECT data FROM docs WHERE type='payment' AND ref1='EN-26-0002'")).map((x) => JSON.parse(x.data));
    const p = pays.find((x) => x.gateway);
    expect(p).toMatchObject({ method: 'Card', ref: 'TXN9' }); // reference comes from Telr's check, not the advice body
    // Customer returning to the site does not record it twice
    const ret = await t.call('GET', `/webhooks/pay/return?link=${l.id}`);
    expect(ret.text).toContain('payment was received');
    expect((await t.sql("SELECT id FROM docs WHERE type='payment' AND ref1='EN-26-0002'")).length).toBe(pays.length);
  });
  it('refuses links above the outstanding balance', async () => {
    const r = await t.call('POST', '/api/v1/payments/links', { token: await t.login(USERS.admin), body: { enrollmentId: 'EN-26-0002', amount: 999999 } });
    expect(r.status).toBe(422);
  });
});
