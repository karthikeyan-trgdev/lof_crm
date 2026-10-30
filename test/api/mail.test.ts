// Configuration → Email Outgoing / Email Incoming: settings validation, sending rules, incoming filing.
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, type TestCtx } from '../helpers/app';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
const cfgDoc = async () => JSON.parse((await t.sql<any>("SELECT data FROM settings WHERE key='cfg'"))[0].data);
const bootCfg = async () => (await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) })).body.data.cfg;
const save = async (fn: (c: any) => void) => {
  const c = await bootCfg();
  fn(c);
  return t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.admin), body: { changes: [], settings: [{ key: 'cfg', doc: c }] } });
};
const post = async (path: string, body: any, email = USERS.admin) => t.call('POST', '/api/v1/mail' + path, { token: await t.login(email), body });
const simulate = (body: any) => post('/inbound/simulate', { subject: 'Hello', text: 'When is the next class?', ...body });
const lastMail = async () => JSON.parse((await t.sql<any>("SELECT request FROM integration_logs WHERE integration='email' AND direction='out' ORDER BY id DESC LIMIT 1"))[0].request);

describe('email settings', () => {
  it('shows defaults: sending on, incoming off, unknown senders held for review', async () => {
    const c = await bootCfg();
    expect(c.mailOut).toMatchObject({ on: true, fromName: 'Lab of Future', dailyLimit: 1800 });
    expect(c.mailIn).toMatchObject({ on: false, unknown: 'review', block: [] });
  });
  it('saves cleaned settings and rejects invalid ones', async () => {
    expect((await save((c) => { c.mailOut.replyTo = 'not-an-address'; })).body.error).toMatch(/Reply-to/);
    expect((await save((c) => { c.mailOut.fromName = 'Evil <x@y.z>'; })).body.error).toMatch(/Sender name/);
    expect((await save((c) => { c.mailOut.dailyLimit = -1; })).body.error).toMatch(/Daily limit/);
    expect((await save((c) => { c.mailIn.unknown = 'lead'; })).body.error).toMatch(/branch/);
    expect((await save((c) => { c.mailIn.block = ['not a domain']; })).body.error).toMatch(/Blocked sender/);
    const r = await save((c) => { c.mailIn = { ...c.mailIn, on: true, unknown: 'lead', branch: 'KRM', prog: 'ROB', block: [' @Spam.example ', 'x@y.com', 'x@y.com'], extra: 1 }; });
    expect(r.status).toBe(200);
    expect((await cfgDoc()).mailIn).toEqual({ on: true, mailbox: '', unknown: 'lead', branch: 'KRM', prog: 'ROB', block: ['@spam.example', 'x@y.com'], notify: true });
  });
});

describe('email outgoing', () => {
  it('applies sender name, reply-to, copy and signature to every e-mail', async () => {
    await save((c) => { c.mailOut = { on: true, fromName: 'LOF Karama', replyTo: 'communications@laboffuture.com', bcc: 'archive@laboffuture.com', signature: 'Lab of Future Karama', dailyLimit: 100 }; });
    const r = await post('/test-send', { to: 'Parent@Example.com' });
    expect(r.body).toMatchObject({ ok: true, mode: 'mock' });
    const m = await lastMail();
    expect(m.from).toMatch(/^LOF Karama </);
    expect(m.to).toEqual(['parent@example.com']);
    expect(m.reply_to).toEqual(['communications@laboffuture.com']);
    expect(m.bcc).toEqual(['archive@laboffuture.com']);
    expect(m.text).toMatch(/\n\nLab of Future Karama$/);
  });
  it('does not send while sending is paused', async () => {
    await save((c) => { c.mailOut.on = false; });
    const r = await post('/test-send', { to: 'parent@example.com' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/paused/);
  });
  it('needs configuration edit access', async () => {
    expect((await post('/test-send', { to: 'parent@example.com' }, USERS.priya)).status).toBe(403);
    expect((await post('/inbound/simulate', { from: 'a@b.com' }, USERS.layla)).status).toBe(403);
  });
});

describe('email incoming', () => {
  it('files a parent e-mail on the student record and notifies the branch', async () => {
    const s = JSON.parse((await t.sql<any>("SELECT data FROM docs WHERE type='student' AND json_extract(data,'$.parents[0].email') <> '' LIMIT 1"))[0].data);
    const from = s.parents[0].email.toUpperCase();
    const r = await simulate({ from, fromName: s.parents[0].name });
    expect(r.body).toMatchObject({ status: 'Matched to student', refType: 'student' });
    expect(r.body.ref.split(', ')).toContain(s.id);
    const after = JSON.parse((await t.sql<any>("SELECT data FROM docs WHERE type='student' AND id=?", s.id))[0].data);
    expect(after.comm.at(-1)).toMatchObject({ ch: 'Email', inbound: true, status: 'Received', subject: 'Hello', sim: true });
  });
  it('files a lead e-mail on the lead', async () => {
    const l = JSON.parse((await t.sql<any>("SELECT data FROM docs WHERE type='lead' AND ref2 <> '' AND ref2 NOT IN (SELECT lower(json_extract(p.value,'$.email')) FROM docs d, json_each(json_extract(d.data,'$.parents')) p WHERE d.type='student') LIMIT 1"))[0].data);
    const r = await simulate({ from: l.email });
    expect(r.body).toMatchObject({ status: 'Matched to lead', refType: 'lead' });
    const comm = (await t.sql<any>("SELECT data FROM docs WHERE type='comm' AND json_extract(data,'$.inbound')=1 AND json_extract(data,'$.ch')='Email'")).map((x) => JSON.parse(x.data));
    expect(comm.some((c) => c.lead === r.body.ref && c.text === 'When is the next class?')).toBe(true);
  });
  it('applies the unknown-sender rule', async () => {
    expect((await simulate({ from: 'new.parent@example.org' })).body.status).toBe('Needs review');
    await save((c) => { c.mailIn = { ...c.mailIn, unknown: 'lead', branch: 'KRM', prog: 'ROB' }; });
    const r = await simulate({ from: 'another.parent@example.org', fromName: 'Sara Ali' });
    expect(r.body.status).toBe('New lead created');
    expect(r.body.ref).toMatch(/^TST-/); // simulations never create real leads
    await save((c) => { c.mailIn.unknown = 'ignore'; });
    expect((await simulate({ from: 'third@example.org' })).body.status).toBe('Ignored – unknown sender');
  });
  it('skips blocked senders and auto-replies, and lists what arrived', async () => {
    await save((c) => { c.mailIn.block = ['@spam.example']; });
    expect((await simulate({ from: 'offers@spam.example' })).body.status).toBe('Blocked sender');
    expect((await simulate({ from: 'x@example.org', subject: 'Out of office: back Monday' })).body.status).toBe('Auto-reply skipped');
    const list = await t.call('GET', '/api/v1/mail/inbound', { token: await t.login(USERS.admin) });
    expect(list.body.items.map((i: any) => i.status)).toEqual(expect.arrayContaining(['Blocked sender', 'Auto-reply skipped']));
    expect(list.body.items[0]).toHaveProperty('from');
  });
});
