import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, type TestCtx } from '../helpers/app';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });

describe('REST resources', () => {
  it('creates a lead with routing and detects duplicates', async () => {
    const tok = await t.login(USERS.hassan);
    const body = { student: 'Rami K', parent: 'Nour K', phone: '+971 50 777 1212', email: 'nour@example.com', branch: 'KRM', prog: 'SPA', src: 'Manual', cat: 'Warm' };
    const r = await t.call('POST', '/api/v1/leads', { token: tok, body });
    expect(r.status).toBe(201);
    expect(r.body.lead.id).toBe('LD-26-1032');
    expect(r.body.assignedTo).toBe('S02'); // only Karama counsellor handling Space
    const dup = await t.call('POST', '/api/v1/leads', { token: tok, body });
    expect(dup.status).toBe(409);
    expect(dup.body.duplicates[0].id).toBe('LD-26-1032');
  });
  it('validates input and branch scope', async () => {
    const tok = await t.login(USERS.priya);
    expect((await t.call('POST', '/api/v1/leads', { token: tok, body: { student: 'x' } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/leads', { token: tok, body: { student: 'a', parent: 'b', phone: '+971501110000', branch: 'BLR', prog: 'ROB', src: 'Manual' } })).status).toBe(403);
    expect((await t.call('POST', '/api/v1/leads', { token: await t.login(USERS.layla), body: { student: 'a', parent: 'b', phone: '+971501110000', branch: 'KRM', prog: 'ROB', src: 'Manual' } })).status).toBe(403);
  });
  it('lists leads with filters inside scope', async () => {
    const r = await t.call('GET', '/api/v1/leads?category=Hot&limit=5', { token: await t.login(USERS.fatima) });
    expect(r.body.items.every((l: any) => l.branch === 'SPC' && l.cat === 'Hot')).toBe(true);
  });
  it('serves a student 360 and a printable receipt', async () => {
    const tok = await t.login(USERS.layla);
    const s = await t.call('GET', '/api/v1/students/LOF-26-000001', { token: tok });
    expect(s.body.enrollments).toHaveLength(2);
    const rc = await t.call('GET', `/api/v1/payments/${s.body.payments[0].id}/receipt`, { token: tok });
    expect(rc.text).toContain('Payment receipt');
    expect(rc.text).toContain(s.body.payments[0].rc);
  });
  it('lets Reception send a payment link to the parent', async () => {
    const tok = await t.login(USERS.admin);
    const link = await t.call('POST', '/api/v1/payments/links', { token: tok, body: { enrollmentId: 'EN-26-0002' } });
    expect(link.body.provider).toBe('telr');
    expect(link.body.id).toMatch(/^PL-[A-Z2-9]{10}$/); // random, not guessable
    // EN-26-0002 has no lead (walk-in) → sent to the parent on the student record
    const sent = await t.call('POST', `/api/v1/payments/links/${link.body.id}/send`, { token: tok, body: { channel: 'WhatsApp' } });
    expect(sent.body).toMatchObject({ ok: true, status: 'Sent (mock)' });
  });
  it('returns notifications filtered for the role', async () => {
    const r = await t.call('GET', '/api/v1/notifications', { token: await t.login(USERS.layla) });
    expect(r.body.items.every((n: any) => !n.roles || n.roles.includes('Reception'))).toBe(true);
  });
});
