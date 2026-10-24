// Regression tests for every finding of the independent security review, plus the session, CSRF and
// two-step-verification controls added afterwards.
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, PASSWORD, SECRETS, doc, type TestCtx } from '../helpers/app';
import { hotp, base32Decode } from '../../src/lib/totp';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
const sync = async (email: string, changes: any[], settings: any[] = []) => t.call('PUT', '/api/v1/sync', { token: await t.login(email), body: { changes, settings } });
const totpNow = (secret: string, offset = 0) => hotp(base32Decode(secret), Math.floor(Date.now() / 30000) + offset);

describe('sync input validation (C1, H1, M6)', () => {
  it('rejects unknown operations instead of skipping the guards', async () => {
    const l = await doc(t, 'lead', 'LD-26-1005');
    const r = await sync(USERS.priya, [{ coll: 'leads', id: 'ZZ', op: 'x', doc: { ...l, branch: 'KRM' } }]);
    expect(r.status).toBe(400);
    expect((await doc(t, 'lead', 'LD-26-1005')).branch).toBe('SPC');
  });
  it('requires the document id to match and to be a safe id', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    expect((await sync(USERS.priya, [{ coll: 'leads', id: 'LD-26-1001', op: 'upsert', doc: { ...l, id: 'LD-26-1005' } }])).status).toBe(400);
    const bad = 'LD-X"><img src=x onerror=alert(1)>';
    expect((await sync(USERS.priya, [{ coll: 'leads', id: bad, op: 'upsert', doc: { ...l, id: bad } }])).status).toBe(400);
  });
  it('caps record size', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    expect((await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, notes: 'x'.repeat(70_000) } }])).status).toBe(413);
  });
  it('payments and audit entries cannot be overwritten, even by an administrator', async () => {
    const p = await doc(t, 'payment', 'PY-26-0001');
    expect((await sync(USERS.admin, [{ coll: 'pay', id: p.id, op: 'upsert', doc: { ...p, amt: 1 } }])).status).toBe(409);
    const a = await doc(t, 'audit', 'AU1');
    expect((await sync(USERS.admin, [{ coll: 'audit', id: a.id, op: 'upsert', doc: { ...a, det: 'rewritten' } }])).status).toBe(409);
    expect((await doc(t, 'payment', 'PY-26-0001')).amt).toBe(p.amt);
  });
});

describe('branch scope on old and new versions (H2)', () => {
  it('blocks moving another branch’s opportunity, student or task into your branch', async () => {
    const o = await doc(t, 'opp', 'OP-26-0002'); // Sports City
    expect((await sync(USERS.priya, [{ coll: 'opps', id: o.id, op: 'upsert', doc: { ...o, branch: 'KRM' } }])).status).toBe(409);
    const o2 = await doc(t, 'opp', 'OP-26-0004'); // Bengaluru
    expect((await sync(USERS.priya, [{ coll: 'opps', id: o2.id, op: 'upsert', doc: { ...o2, branch: null } }])).status).toBe(409);
    const s = await doc(t, 'student', 'LOF-26-000004'); // Bengaluru
    expect((await sync(USERS.layla, [{ coll: 'students', id: s.id, op: 'upsert', doc: { ...s, branch: 'KRM' } }])).status).toBe(409);
    const task = (await t.sql<any>("SELECT data FROM docs WHERE type='task' AND branch='SPC' LIMIT 1")).map((x) => JSON.parse(x.data))[0];
    expect((await sync(USERS.priya, [{ coll: 'tasks', id: task.id, op: 'upsert', doc: { ...task, lead: 'LD-26-1001' } }])).status).toBe(409);
  });
});

describe('approvals are tied to the exact approved change (H3, M7)', () => {
  it('a rejected transfer cannot move the lead, and an approved one only to the approved branch', async () => {
    const ap = await doc(t, 'approval', 'AP-26-0002'); // SPC → KRM, Layla Qadir
    const l = await doc(t, 'lead', 'LD-26-1008');
    const rejected = { ...ap, status: 'Rejected', decision: { remarks: 'no' } };
    expect((await sync(USERS.nadia, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: rejected }, { coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, branch: 'BLR', cslr: 'S05' } }])).status).toBe(409);
    const approved = { ...ap, status: 'Approved', decision: { remarks: 'ok' } };
    expect((await sync(USERS.nadia, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: approved }, { coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, branch: 'BLR', cslr: 'S05' } }])).status).toBe(409);
    expect((await doc(t, 'lead', l.id)).branch).toBe('SPC');
  });
  it('rebuilds new requests on the server (approver, payload, history)', async () => {
    const r = await sync(USERS.priya, [{ coll: 'approvals', id: 'AP-26-0050', op: 'upsert', doc: { id: 'AP-26-0050', type: 'Exceptional Discount', status: 'Approved', approverRole: 'Counsellor', branch: 'SPC', payload: { opp: 'OP-26-0003', type: '%', value: 20, final: 0 }, reason: 'Sibling', hist: [{ action: 'Approved', by: 'S11' }] } }]);
    expect(r.body.error ?? 'ok').toBe('ok');
    const a = await doc(t, 'approval', 'AP-26-0050');
    expect(a).toMatchObject({ status: 'Pending', approverRole: 'Management', by: 'S01', branch: 'KRM', refKind: 'opp', ref: 'OP-26-0003' });
    expect(a.payload.final).toBeGreaterThan(0);
    expect(a.hist).toHaveLength(1);
    expect(a.hist[0]).toMatchObject({ action: 'Requested', by: 'S01' });
  });
  it('refuses a discount request on another branch’s opportunity', async () => {
    const r = await sync(USERS.priya, [{ coll: 'approvals', id: 'AP-26-0051', op: 'upsert', doc: { id: 'AP-26-0051', type: 'Exceptional Discount', payload: { opp: 'OP-26-0004', type: '%', value: 100 } } }]);
    expect(r.status).toBe(409);
  });
});

describe('fee integrity (H4, M4)', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  it('rejects invented discount kinds and reused approvals', async () => {
    const base = { stu: 'LOF-26-000001', prog: 'AI', branch: 'KRM', pkg: 'Term (24 sessions)', date: today(), status: 'Active', cur: 'AED', opp: null, course: { moodleId: 4103 } };
    const manual = { ...base, id: 'EN-26-9001', total: 0, discInfo: { kind: 'manual', type: '%', value: 100 } };
    expect((await sync(USERS.layla, [{ coll: 'enr', id: manual.id, op: 'upsert', doc: manual }])).body.error).toMatch(/Unknown discount kind/);
    const reused = { ...base, id: 'EN-26-9002', total: 2457, discInfo: { kind: 'exceptional', ref: 'AP-26-0005', type: '%', value: 10 } }; // approved for OP-26-0001, not this
    expect((await sync(USERS.layla, [{ coll: 'enr', id: reused.id, op: 'upsert', doc: reused }])).body.error).toMatch(/not approved for this opportunity/);
  });
  it('rejects enrolments for students outside your branches', async () => {
    const e = { id: 'EN-26-9003', stu: 'LOF-26-000006', prog: 'ROB', branch: 'KRM', pkg: 'Term (24 sessions)', date: today(), total: 2520, cur: 'AED', course: { moodleId: 4101 } };
    expect((await sync(USERS.layla, [{ coll: 'enr', id: e.id, op: 'upsert', doc: e }])).body.error).toMatch(/Student not found or outside/);
  });
});

describe('server-owned fields (H5, M1, M2, M3, M5, L4)', () => {
  it('ignores client test flags and backdating on payments', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const forged = await sync(USERS.layla, [{ coll: 'pay', id: 'PY-ZZ', op: 'upsert', doc: { id: 'PY-ZZ', enr: e.id, amt: 10, method: 'Cash', ref: '—' } }]);
    expect(forged.status).toBe(409); // ids must come from the server's sequence
    const r = await sync(USERS.layla, [{ coll: 'pay', id: 'PY-26-0500', op: 'upsert', doc: { id: 'PY-26-0500', enr: e.id, amt: 10, method: 'Cash', ref: '—', at: '2025-01-01T00:00:00Z', test: true, rc: 'RC-X', status: 'Refunded' } }]);
    expect(r.status).toBe(200);
    const [row] = await t.sql<any>("SELECT is_test, data FROM docs WHERE type='payment' AND id='PY-26-0500'");
    expect(row.is_test).toBe(0);
    const p = JSON.parse(row.data);
    expect(p.rc).toMatch(/^RC-KRM-26-\d{4}$/);
    expect(p.status).toBe('Recorded');
    expect(p.at.slice(0, 4)).toBe(String(new Date().getFullYear()));
  });
  it('Moodle sync records can only be created with their enrolment and are built on the server', async () => {
    const r = await sync(USERS.layla, [{ coll: 'ms', id: 'MS-ZZ', op: 'upsert', doc: { id: 'MS-ZZ', enr: 'EN-26-0002', stu: 'LOF-26-000004', cid: 9999, mid: 2, status: 'Pending' } }]);
    expect(r.status).toBe(409);
  });
  it('appended student messages are recorded but never sent with client text', async () => {
    const s = await doc(t, 'student', 'LOF-26-000001');
    s.parents[0].email = 'victim@evil.test';
    s.comm = [...s.comm, { at: 'x', ch: 'Email', tpl: 'Enrolment welcome', text: 'Click http://evil.test to pay', status: 'Sent (simulated)' }];
    expect((await sync(USERS.layla, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }])).status).toBe(200);
    const after = await doc(t, 'student', s.id);
    expect(after.comm.at(-1).status).toBe('Recorded (not sent)');
    expect(await t.sql("SELECT id FROM integration_logs WHERE integration='email' AND request LIKE '%evil.test%'")).toHaveLength(0);
  });
  it('notifications are sanitised and attributed', async () => {
    await sync(USERS.priya, [{ coll: 'notifs', id: 'N900', op: 'upsert', doc: { id: 'N900', type: 'x', sev: 'boom', text: 'y'.repeat(500), roles: ['System Administrator', 'Hacker'], branch: 'KRM', route: { page: 'evil', id: 'a"b' } } }]);
    const n = await doc(t, 'notification', 'N900');
    expect(n).toMatchObject({ type: 'new', sev: 'info', roles: ['System Administrator'], by: 'S01', route: { page: 'dashboard' } });
    expect(n.text.length).toBe(300);
    expect((await sync(USERS.priya, [{ coll: 'notifs', id: 'N900', op: 'upsert', doc: { ...n, text: 'changed' } }])).status).toBe(409);
  });
  it('refund requests start as Requested; calls are attributed to the caller', async () => {
    await sync(USERS.hassan, [{ coll: 'refunds', id: 'RF-26-0009', op: 'upsert', doc: { id: 'RF-26-0009', enr: 'EN-26-0002', amt: 5, status: 'Refunded', reason: 'x', sessions: 1 } }]);
    expect((await doc(t, 'refund', 'RF-26-0009')).status).toBe('Requested');
    await sync(USERS.priya, [{ coll: 'calls', id: 'CL-900', op: 'upsert', doc: { id: 'CL-900', lead: 'LD-26-1001', dir: 'Outgoing', status: 'Completed', outcome: 'Interested', by: 'S02' } }]);
    expect((await doc(t, 'call', 'CL-900')).by).toBe('S01');
  });
});

describe('concurrent edits merge field by field (QA #1)', () => {
  it('two people changing different fields of the same lead both keep their change', async () => {
    const base = await doc(t, 'lead', 'LD-26-1004');
    const priyaEdit = { ...base, cat: 'Hot' };
    const hassanEdit = { ...base, cslr: 'S02' };
    expect((await sync(USERS.hassan, [{ coll: 'leads', id: base.id, op: 'upsert', doc: hassanEdit, base }])).status).toBe(200);
    expect((await sync(USERS.priya, [{ coll: 'leads', id: base.id, op: 'upsert', doc: priyaEdit, base }])).status).toBe(200);
    const after = await doc(t, 'lead', base.id);
    expect(after.cat).toBe('Hot');
    expect(after.cslr).toBe('S02');
  });
  it('appends to history lists from both sides', async () => {
    const base = await doc(t, 'lead', 'LD-26-1001');
    const a = { ...base, events: [...base.events, { at: 'a', type: 'sys', text: 'from A', by: 'A' }] };
    const b = { ...base, events: [...base.events, { at: 'b', type: 'sys', text: 'from B', by: 'B' }] };
    await sync(USERS.priya, [{ coll: 'leads', id: base.id, op: 'upsert', doc: a, base }]);
    await sync(USERS.hassan, [{ coll: 'leads', id: base.id, op: 'upsert', doc: b, base }]);
    const texts = (await doc(t, 'lead', base.id)).events.map((e: any) => e.text);
    expect(texts).toContain('from A');
    expect(texts).toContain('from B');
  });
});

describe('database-level integrity', () => {
  it('a trigger blocks overpayment and payment/audit changes even if application code is bypassed', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const over = { id: 'PY-RAW', enr: e.id, amt: e.total * 2 };
    expect(() => t.d1.db.prepare("INSERT INTO docs (type,id,ref1,data) VALUES ('payment',?,?,?)").run(over.id, e.id, JSON.stringify(over))).toThrow(/overpayment/);
    expect(() => t.d1.db.exec("UPDATE docs SET data=json_set(data,'$.amt',1) WHERE type='payment' AND id='PY-26-0001'")).toThrow(/immutable/);
    expect(() => t.d1.db.exec("DELETE FROM docs WHERE type='audit' AND id='AU1'")).toThrow(/immutable/);
  });
});

describe('payment links (H6, L1)', () => {
  it('a mock link is never marked paid from the return URL in production', async () => {
    t = await setup({ APP_ENV: 'production' });
    const r = await t.call('POST', '/api/v1/payments/links', { token: await t.login(USERS.admin), body: { enrollmentId: 'EN-26-0002' } });
    expect(r.status).toBe(422); // gateways not live → no fake links in production
    expect(r.body.error).toMatch(/not set up yet/);
  });
  it('lists only links in your branches', async () => {
    const admin = await t.login(USERS.admin);
    await t.call('POST', '/api/v1/payments/links', { token: admin, body: { enrollmentId: 'EN-26-0004' } }); // Sports City
    const r = await t.call('GET', '/api/v1/payments/links', { token: await t.login(USERS.hassan) }); // Karama
    expect(r.body.items).toHaveLength(0);
  });
});

describe('API hygiene (L2, L3)', () => {
  it('clamps paging and redacts webhook tokens in logs', async () => {
    const r = await t.call('GET', '/api/v1/leads?limit=-1', { token: await t.login(USERS.admin) });
    expect(r.body.limit).toBe(1);
    await t.call('GET', `/webhooks/exotel/incoming?token=${SECRETS.EXOTEL_WEBHOOK_TOKEN}&CallFrom=1`);
    const logs = await t.sql<any>("SELECT request FROM integration_logs WHERE integration='exotel'");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => !String(l.request).includes(SECRETS.EXOTEL_WEBHOOK_TOKEN))).toBe(true);
  });
  it('sets security headers on API responses', async () => {
    const r = await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) });
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses to run with a weak server secret', async () => {
    const weak = await setup({ JWT_SECRET: 'short' });
    expect((await weak.call('POST', '/api/v1/auth/login', { body: { email: USERS.admin, password: PASSWORD } })).status).toBe(500);
  });
});

describe('browser sessions: HttpOnly cookie + CSRF header', () => {
  async function cookieLogin() {
    const r = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD }, headers: { 'x-lof-csrf': '1' } });
    expect(r.body.token).toBeUndefined(); // the page never sees the token
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Secure/);
    return set.split(';')[0];
  }
  it('works with the cookie, and refuses cookie writes without the CSRF header', async () => {
    const cookie = await cookieLogin();
    expect((await t.call('GET', '/api/v1/bootstrap', { headers: { cookie } })).status).toBe(200);
    expect((await t.call('PUT', '/api/v1/sync', { headers: { cookie }, body: { changes: [] } })).status).toBe(403);
    expect((await t.call('PUT', '/api/v1/sync', { headers: { cookie, 'x-lof-csrf': '1' }, body: { changes: [] } })).status).toBe(200);
  });
  it('logout and password change end sessions', async () => {
    const cookie = await cookieLogin();
    const other = await t.login(USERS.priya); // a second device (bearer)
    await t.call('POST', '/api/v1/auth/change-password', { headers: { cookie, 'x-lof-csrf': '1' }, body: { current: PASSWORD, next: 'Green-Lantern-77' } });
    expect((await t.call('GET', '/api/v1/bootstrap', { token: other })).status).toBe(401); // other device signed out
    expect((await t.call('GET', '/api/v1/bootstrap', { headers: { cookie } })).status).toBe(200);
    await t.call('POST', '/api/v1/auth/logout', { headers: { cookie, 'x-lof-csrf': '1' } });
    expect((await t.call('GET', '/api/v1/bootstrap', { headers: { cookie } })).status).toBe(401);
  });
  it('ends idle sessions', async () => {
    const tok = await t.login(USERS.priya);
    await t.d1.prepare("UPDATE sessions SET last_seen_at='2020-01-01T00:00:00Z'").run();
    expect((await t.call('GET', '/api/v1/bootstrap', { token: tok })).status).toBe(401);
  });
  it('rate-limits sign-in attempts', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await t.call('POST', '/api/v1/auth/login', { body: { email: 'nobody@example.com', password: 'x' } })).status;
    expect(last).toBe(429);
  });
});

describe('two-step verification (TOTP)', () => {
  it('enrol, then sign-in needs a valid, unused code', async () => {
    const tok = await t.login(USERS.priya);
    const setupR = await t.call('POST', '/api/v1/auth/mfa/setup', { token: tok });
    expect(setupR.body.otpauth).toMatch(/^otpauth:\/\/totp\//);
    const [row] = await t.sql<any>("SELECT mfa_secret FROM staff_auth WHERE staff_id='S01'");
    expect(row.mfa_secret).not.toContain(setupR.body.secret); // encrypted at rest
    expect((await t.call('POST', '/api/v1/auth/mfa/enable', { token: tok, body: { code: '000000' } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/auth/mfa/enable', { token: tok, body: { code: await totpNow(setupR.body.secret) } })).status).toBe(200);

    const step1 = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD } });
    expect(step1.body).toEqual({ mfaRequired: true });
    expect((await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD, code: '123456' } })).status).toBe(401);
    const code = await totpNow(setupR.body.secret, 1);
    const ok = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD, code } });
    expect(ok.body.stage).toBe('full');
    expect((await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD, code } })).status).toBe(401); // replay
  });
  it('roles that require it must enrol before using the CRM', async () => {
    t = await setup({ MFA_REQUIRED_ROLES: 'System Administrator,Management' });
    const r = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.admin, password: PASSWORD } });
    expect(r.body.stage).toBe('mfa_setup');
    const blocked = await t.call('GET', '/api/v1/bootstrap', { token: r.body.token });
    expect(blocked.status).toBe(403);
    const s = await t.call('POST', '/api/v1/auth/mfa/setup', { token: r.body.token });
    await t.call('POST', '/api/v1/auth/mfa/enable', { token: r.body.token, body: { code: await totpNow(s.body.secret) } });
    expect((await t.call('GET', '/api/v1/bootstrap', { token: r.body.token })).status).toBe(200);
    expect((await t.call('POST', '/api/v1/auth/mfa/disable', { token: r.body.token, body: { password: PASSWORD, code: '1' } })).status).toBe(403);
  });
});
