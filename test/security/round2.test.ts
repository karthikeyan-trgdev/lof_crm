// Regression tests for the second independent review (N1–N14) and the QA fixes that followed it.
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, PASSWORD, doc, type TestCtx } from '../helpers/app';
import { modeFor, writeLog } from '../../src/integrations/base';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
const sync = async (email: string, changes: any[]) => t.call('PUT', '/api/v1/sync', { token: await t.login(email), body: { changes, settings: [] } });

describe('record numbers come from the server (N1)', () => {
  it('refuses new records whose number was never issued', async () => {
    t = await setup({}, { strictIds: true });
    const r = await sync(USERS.priya, [{ coll: 'calls', id: 'CL-99999', op: 'upsert', doc: { id: 'CL-99999', lead: 'LD-26-1001', dir: 'Outgoing', status: 'Completed', outcome: 'Interested' } }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not issued by the server/);
  });
  it('accepts a number handed out by /seq/block', async () => {
    t = await setup({}, { strictIds: true });
    const tok = await t.login(USERS.priya);
    const b = await t.call('POST', '/api/v1/seq/block', { token: tok, body: { name: 'call', size: 1 } });
    const id = 'CL-' + b.body.start;
    const r = await sync(USERS.priya, [{ coll: 'calls', id, op: 'upsert', doc: { id, lead: 'LD-26-1001', dir: 'Outgoing', status: 'Completed', outcome: 'Interested' } }]);
    expect(r.status).toBe(200);
  });
});

describe('history is append-only (N4)', () => {
  it('refuses rewriting an existing history entry and stamps appended ones', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    const rewritten = { ...l, events: l.events.map((e: any, i: number) => (i === 0 ? { ...e, text: 'changed' } : e)) };
    const bad = await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: rewritten, base: l }]);
    expect(bad.status).toBe(409);
    const ok = await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, events: [...l.events, { at: '2020-01-01T00:00:00Z', type: 'note', text: 'hello', by: 'Someone else' }] }, base: l }]);
    expect(ok.status).toBe(200);
    const last = (await doc(t, 'lead', l.id)).events.at(-1);
    expect(last.text).toBe('hello');
    expect(last.by).toBe('Priya Nair');
    expect(last.at).not.toBe('2020-01-01T00:00:00Z');
  });
});

describe('refunds cannot exceed what was paid (N8)', () => {
  it('caps the total of refund requests', async () => {
    const one = await sync(USERS.hassan, [{ coll: 'refunds', id: 'RF-26-0101', op: 'upsert', doc: { id: 'RF-26-0101', enr: 'EN-26-0002', amt: 900, reason: 'x', sessions: 0 } }]);
    expect(one.status).toBe(200);
    const two = await sync(USERS.hassan, [{ coll: 'refunds', id: 'RF-26-0102', op: 'upsert', doc: { id: 'RF-26-0102', enr: 'EN-26-0002', amt: 200, reason: 'x', sessions: 0 } }]);
    expect(two.status).toBe(409);
  });
});

describe('rules read related records as stored (round 3)', () => {
  it('an edit to paid in the same batch cannot lift the refund cap', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const r = await sync(USERS.hassan, [
      { coll: 'refunds', id: 'RF-26-0103', op: 'upsert', doc: { id: 'RF-26-0103', enr: e.id, amt: 5000, reason: 'x', sessions: 0 } },
      { coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, paid: 50000 }, base: e },
    ]);
    expect(r.status).toBe(409);
    expect(await doc(t, 'refund', 'RF-26-0103')).toBeNull();
    expect((await doc(t, 'enrollment', e.id)).paid).toBe(e.paid);
  });
});

describe('student 360 respects permissions (N9)', () => {
  it('a counsellor sees the student but not payments', async () => {
    const r = await t.call('GET', '/api/v1/students/LOF-26-000001', { token: await t.login(USERS.priya) });
    expect(r.status).toBe(200);
    expect(r.body.payments).toEqual([]);
    const rc = await t.call('GET', '/api/v1/students/LOF-26-000001', { token: await t.login(USERS.layla) });
    expect(rc.body.payments.length).toBeGreaterThan(0);
  });
});

describe('REST lead creation takes only documented fields (N10)', () => {
  it('ignores server-owned fields and checks the chosen counsellor', async () => {
    const tok = await t.login(USERS.hassan);
    const base = { student: 'Zed Q', parent: 'Mona Q', phone: '+971 50 333 4411', branch: 'KRM', prog: 'SPA', src: 'Manual' };
    const r = await t.call('POST', '/api/v1/leads', { token: tok, body: { ...base, stage: 'Enrolled', status: 'Won', enq: '2020-01-01T00:00:00Z', events: [{ text: 'forged' }], test: true } });
    expect(r.status).toBe(201);
    expect(r.body.lead).toMatchObject({ stage: 'New Lead', status: 'Open' });
    expect(r.body.lead.enq).not.toBe('2020-01-01T00:00:00Z');
    expect(r.body.lead.events.some((e: any) => e.text === 'forged')).toBe(false);
    const bad = await t.call('POST', '/api/v1/leads', { token: tok, body: { ...base, phone: '+971 50 333 9999', cslr: 'S16' } });
    expect(bad.status).toBe(422);
  });
});

describe('sign-in hardening (N12, N13)', () => {
  it('accepts sign-in only as JSON and only from this site', async () => {
    const raw = JSON.stringify({ email: USERS.priya, password: PASSWORD });
    expect((await t.call('POST', '/api/v1/auth/login', { raw, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await t.call('POST', '/api/v1/auth/login', { raw, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status).toBe(403);
    expect((await t.call('POST', '/api/v1/auth/login', { raw, headers: { 'content-type': 'application/json', origin: 'https://crm.test' } })).status).toBe(200);
  });
  it('rate-limits turning two-step verification off', async () => {
    const tok = await t.login(USERS.priya);
    await t.sql("UPDATE staff_auth SET mfa_enabled=1 WHERE email=?", USERS.priya);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await t.call('POST', '/api/v1/auth/mfa/disable', { token: tok, body: { password: 'wrong', code: '000000' } })).status);
    expect(codes.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
  it('rate-limits sequence blocks', async () => {
    const tok = await t.login(USERS.priya);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await t.call('POST', '/api/v1/seq/block', { token: tok, body: { name: 'task', size: 1 } })).status;
    expect(last).toBe(429);
  });
});

describe('integration safety (N7, N14)', () => {
  it('test records never reach live providers in production', () => {
    const env: any = { APP_ENV: 'production', INTEGRATION_MODE: 'auto', RESEND_API_KEY: 'k', EMAIL_FROM: 'x' };
    expect(modeFor(env, {}, 'email', false)).toBe('live');
    expect(modeFor(env, {}, 'email', true)).toBe('mock');
  });
  it('removes any configured secret from integration logs', async () => {
    await writeLog(t.env, { integration: 'lms', direction: 'out', operation: 'x', mode: 'live', ok: false, response: 'echo ' + t.env.ERPNEXT_API_SECRET + ' and ' + t.env.WHATSAPP_ACCESS_TOKEN });
    const [row] = await t.sql<any>("SELECT response FROM integration_logs WHERE operation='x'");
    expect(row.response).not.toContain(t.env.ERPNEXT_API_SECRET);
    expect(row.response).not.toContain(t.env.WHATSAPP_ACCESS_TOKEN);
  });
});
