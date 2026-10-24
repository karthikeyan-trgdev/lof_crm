import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, PASSWORD, doc, type TestCtx } from '../helpers/app';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });

const sync = async (email: string, changes: any[], settings: any[] = []) => t.call('PUT', '/api/v1/sync', { token: await t.login(email), body: { changes, settings } });
const boot = async (email: string) => (await t.call('GET', '/api/v1/bootstrap', { token: await t.login(email) })).body;

describe('authentication', () => {
  it('rejects wrong passwords and locks the account after 5 attempts', async () => {
    for (let i = 0; i < 5; i++) expect((await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: 'nope' } })).status).toBe(401);
    const locked = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD } });
    expect(locked.status).toBe(401); // same message as a wrong password – no account enumeration
    expect(locked.body.error).toMatch(/temporarily locked/);
  });
  it('requires a token on API routes', async () => {
    expect((await t.call('GET', '/api/v1/bootstrap')).status).toBe(401);
    expect((await t.call('GET', '/api/v1/bootstrap', { token: 'x.y.z' })).status).toBe(401);
  });
  it('forces a strong password change before anything else works', async () => {
    t = await setup({}, { keepMustChange: true });
    const r0 = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: PASSWORD } });
    expect(r0.body.stage).toBe('password_change');
    const tok = r0.body.token;
    const blocked = await t.call('GET', '/api/v1/bootstrap', { token: tok });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe('password_change');
    for (const weak of ['short', 'alllowercaseletters', 'Priya.Nair2026!', 'Welcome2026Lof']) {
      expect((await t.call('POST', '/api/v1/auth/change-password', { token: tok, body: { current: PASSWORD, next: weak } })).status, weak).toBe(400);
    }
    const ok = await t.call('POST', '/api/v1/auth/change-password', { token: tok, body: { current: PASSWORD, next: 'Blue-Kettle-2026' } });
    expect(ok.body.stage).toBe('full');
    expect((await t.call('GET', '/api/v1/bootstrap', { token: tok })).status).toBe(200);
    const r = await t.call('POST', '/api/v1/auth/login', { body: { email: USERS.priya, password: 'Blue-Kettle-2026' } });
    expect(r.body.mustChangePassword).toBe(false);
  });
  it('allows role preview only when impersonation is enabled', async () => {
    const r = await t.call('POST', '/api/v1/auth/impersonate', { token: await t.login(USERS.admin), body: { staffId: 'S01' } });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('Counsellor');
    // a counsellor can never preview as someone else
    expect((await t.call('POST', '/api/v1/auth/impersonate', { token: await t.login(USERS.priya), body: { staffId: 'S12' } })).status).toBe(403);
    // and it is never available in production
    const tp = await setup({ APP_ENV: 'production' });
    expect((await tp.call('POST', '/api/v1/auth/impersonate', { token: await tp.login(USERS.admin), body: { staffId: 'S01' } })).status).toBe(403);
    const t2 = await setup({ ALLOW_IMPERSONATION: 'false' });
    expect((await t2.call('POST', '/api/v1/auth/impersonate', { token: await t2.login(USERS.admin), body: { staffId: 'S01' } })).status).toBe(403);
  });
});

describe('bootstrap is branch-scoped', () => {
  it('a Karama counsellor sees only Karama leads', async () => {
    const b = await boot(USERS.priya);
    expect(new Set(b.data.leads.map((l: any) => l.branch))).toEqual(new Set(['KRM']));
    expect(b.data.tasks.every((x: any) => b.data.leads.some((l: any) => l.id === x.lead))).toBe(true);
  });
  it('the India Admissions Head sees Bengaluru and Hyderabad only', async () => {
    const b = await boot(USERS.deepa);
    expect(new Set(b.data.leads.map((l: any) => l.branch))).toEqual(new Set(['BLR', 'HYD']));
  });
  it('Management sees every branch and the audit log', async () => {
    const b = await boot(USERS.khalid);
    expect(b.data.leads.length).toBe(31);
    expect(b.data.audit.length).toBeGreaterThan(0);
  });
  it('never sends password hashes', async () => {
    const b = await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) });
    expect(b.text).not.toContain('pbkdf2');
  });
});

describe('guarded sync', () => {
  it('lets a counsellor update a lead in scope and records it', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    l.notes = 'Parent prefers evenings';
    const r = await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: l }]);
    expect(r.status).toBe(200);
    expect((await doc(t, 'lead', 'LD-26-1001')).notes).toBe('Parent prefers evenings');
  });
  it('blocks edits outside the branch scope', async () => {
    const l = await doc(t, 'lead', 'LD-26-1005'); // Sports City
    l.notes = 'x';
    const r = await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: l }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/outside your branch/);
  });
  it('blocks changing branch without an approved transfer and reassignment without rights', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    expect((await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, branch: 'KRM', cslr: 'S02' } }])).body.error).toMatch(/Reassignment needs approval/);
    expect((await sync(USERS.hassan, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, branch: 'SPC' } }])).body.error).toMatch(/outside your branch/);
    expect((await sync(USERS.admin, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, branch: 'SPC' } }])).body.error).toMatch(/approved branch transfer/);
    expect((await sync(USERS.hassan, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, cslr: 'S02' } }])).status).toBe(200);
  });
  it('applies a branch transfer when the Admissions Head approves it', async () => {
    const ap = await doc(t, 'approval', 'AP-26-0002'); // Layla Qadir SPC → KRM
    const l = await doc(t, 'lead', 'LD-26-1008');
    ap.status = 'Approved'; ap.decision = { by: 'S09', at: 'x', remarks: 'ok' }; ap.hist.push({ at: 'x', by: 'S09', action: 'Approved', remarks: 'ok' });
    l.branch = 'KRM'; l.cslr = 'S01';
    const r = await sync(USERS.nadia, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: ap }, { coll: 'leads', id: l.id, op: 'upsert', doc: l }]);
    expect(r.status).toBe(200);
    expect((await doc(t, 'lead', 'LD-26-1008')).branch).toBe('KRM');
    const [row] = await t.sql("SELECT branch FROM docs WHERE type='task' AND ref1='LD-26-1008' LIMIT 1");
    expect(row?.branch ?? 'KRM').toBe('KRM');
  });
  it('enforces approver rules: role, requester and decided state', async () => {
    const ap = await doc(t, 'approval', 'AP-26-0001'); // Exceptional discount → Management
    const decided = { ...ap, status: 'Approved', decision: { remarks: '' }, hist: [...ap.hist, { action: 'Approved' }] };
    expect((await sync(USERS.nadia, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: decided }])).body.error).toMatch(/cannot approve|Configured approver/);
    expect((await sync(USERS.khalid, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: decided }])).status).toBe(200);
    const now = await doc(t, 'approval', ap.id); // the server's copy, with its stamped history
    expect((await sync(USERS.khalid, [{ coll: 'approvals', id: ap.id, op: 'upsert', doc: { ...now, status: 'Rejected' } }])).body.error).toMatch(/already been decided/);
  });
  it('rejects an exceptional discount on an opportunity unless it was approved', async () => {
    const o = await doc(t, 'opp', 'OP-26-0002');
    o.discount = { kind: 'exceptional', ref: 'AP-26-0007', name: 'x', type: '%', value: 30 }; // AP-7 was rejected
    expect((await sync(USERS.fatima, [{ coll: 'opps', id: o.id, op: 'upsert', doc: o }])).body.error).toMatch(/approved request/);
  });
  it('re-checks enrolment fees on the server', async () => {
    const b = await boot(USERS.hassan);
    const e = { ...b.data.enr[0], id: 'EN-26-0099', stu: 'LOF-26-000001', date: new Date().toISOString().slice(0, 10), total: 1, newStu: false, discInfo: null, opp: null, status: 'Active' };
    const r = await sync(USERS.hassan, [{ coll: 'enr', id: e.id, op: 'upsert', doc: e }]);
    expect(r.body.error).toMatch(/Fee mismatch/);
  });
  it('records payments with server receipt numbers and recomputes the balance', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002'); // half paid, Al Karama
    const out = Math.round((e.total - e.paid) * 100) / 100;
    const over = { id: 'PY-26-0009', enr: e.id, stu: e.stu, amt: out + 50, cur: 'AED', method: 'Cash', ref: '—', at: new Date().toISOString(), rc: 'RC-FAKE', status: 'x', by: 'S10', branch: 'KRM' };
    expect((await sync(USERS.layla, [{ coll: 'pay', id: over.id, op: 'upsert', doc: over }])).body.error).toMatch(/outstanding/);
    const ok = await sync(USERS.layla, [{ coll: 'pay', id: over.id, op: 'upsert', doc: { ...over, amt: out } }]);
    expect(ok.status).toBe(200);
    const p = await doc(t, 'payment', 'PY-26-0009');
    expect(p.rc).toBe('RC-KRM-26-0004');
    expect(p.status).toBe('Recorded');
    expect((await doc(t, 'enrollment', e.id)).payStatus).toBe('Paid');
    expect((await sync(USERS.layla, [{ coll: 'pay', id: p.id, op: 'upsert', doc: { ...p, amt: 1 } }])).body.error).toMatch(/cannot be edited/);
  });
  it('blocks messages without consent and queues the rest for delivery', async () => {
    const noConsent = await doc(t, 'lead', 'LD-26-1014'); // wa=false
    expect(noConsent.wa).toBe(false);
    await t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.admin), body: { changes: [
      { coll: 'comms', id: 'CM900', op: 'upsert', doc: { id: 'CM900', lead: 'LD-26-1014', ch: 'WhatsApp', tpl: 'Follow-up nudge', text: 'hi', at: new Date().toISOString(), status: 'Sent (simulated)', by: 'x' } },
      { coll: 'comms', id: 'CM901', op: 'upsert', doc: { id: 'CM901', lead: 'LD-26-1001', ch: 'WhatsApp', tpl: 'Follow-up nudge', text: 'hi', at: new Date().toISOString(), status: 'Sent (simulated)', by: 'x' } },
    ] } });
    expect((await doc(t, 'comm', 'CM900')).status).toBe('Blocked – no consent');
    const sent = await doc(t, 'comm', 'CM901');
    expect(sent.status).toBe('Sent (mock)');
    expect(sent.waMsgId).toMatch(/^wamid\./);
  });
  it('keeps the audit log append-only and stamps the real user', async () => {
    const r = await sync(USERS.priya, [{ coll: 'audit', id: 'AU500', op: 'upsert', doc: { id: 'AU500', at: '2000-01-01', by: 'Someone else', act: 'x', ref: 'y', det: 'z' } }]);
    expect(r.status).toBe(200);
    const a = await doc(t, 'audit', 'AU500');
    expect(a.by).toBe('Priya Nair');
    expect(a.at).not.toBe('2000-01-01');
    expect((await sync(USERS.admin, [{ coll: 'audit', id: 'AU500', op: 'upsert', doc: { ...a, det: 'edited' } }])).body.error).toMatch(/append-only/);
  });
  it('only configuration roles can change settings, and secrets are stripped', async () => {
    const b = await boot(USERS.admin);
    const cfg = b.data.cfg;
    cfg.sla.mins = 45;
    cfg.integ.lms.token = 'should-not-be-stored';
    expect((await sync(USERS.priya, [], [{ key: 'cfg', doc: cfg }])).status).toBe(409);
    expect((await sync(USERS.admin, [], [{ key: 'cfg', doc: cfg }])).status).toBe(200);
    const [row] = await t.sql("SELECT data FROM settings WHERE key='cfg'");
    expect(JSON.parse(row.data).sla.mins).toBe(45);
    expect(row.data).not.toContain('should-not-be-stored');
  });
  it('creates a login with a temporary password when staff are added', async () => {
    const r = await sync(USERS.admin, [{ coll: 'staff', id: 'S40', op: 'upsert', doc: { id: 'S40', name: 'New Person', emp: 'LOF-E999', role: 'Counsellor', branch: 'KRM', dept: 'Admissions', email: 'new.person@example.com', mobile: '', programs: ['ROB'], status: 'Active', access: 'Enabled', avail: 'Available', max: 10, leave: null, backup: '' } }]);
    expect(r.status).toBe(200);
    const temp = r.body.notices[0].match(/temporary password (\S+)/)[1];
    expect((await t.call('POST', '/api/v1/auth/login', { body: { email: 'new.person@example.com', password: temp } })).body.mustChangePassword).toBe(true);
  });
  it('rolls back the whole batch when one change is rejected', async () => {
    const l = await doc(t, 'lead', 'LD-26-1001');
    const bad = await doc(t, 'lead', 'LD-26-1005');
    await sync(USERS.priya, [{ coll: 'leads', id: l.id, op: 'upsert', doc: { ...l, notes: 'should not save' } }, { coll: 'leads', id: bad.id, op: 'upsert', doc: { ...bad, notes: 'x' } }]);
    expect((await doc(t, 'lead', 'LD-26-1001')).notes).not.toBe('should not save');
  });
});

describe('sequences', () => {
  it('claims gapless numbers and resolves concurrent claims', async () => {
    const tok = await t.login(USERS.priya);
    const a = await t.call('POST', '/api/v1/seq/claim', { token: tok, body: { name: 'lead', expect: 1032 } });
    expect(a.body).toEqual({ ok: true, value: 1032 });
    const b = await t.call('POST', '/api/v1/seq/claim', { token: tok, body: { name: 'lead', expect: 1032 } });
    expect(b.body).toEqual({ ok: false, value: 1033 });
    const blk = await t.call('POST', '/api/v1/seq/block', { token: tok, body: { name: 'task', size: 10 } });
    expect(blk.body.size).toBe(10);
  });
});

describe('enrolment with first payment', () => {
  it('lets a Centre Administrator take the first payment inside a new enrolment, but not standalone payments', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fee = (await t.sql<any>("SELECT data FROM docs WHERE type='fee' AND id='FEE-001'")).map((x) => JSON.parse(x.data))[0]; // KRM Robotics term
    const total = Math.round((fee.amt + fee.extra.amt) * 1.05 * 100) / 100;
    const s = { id: 'LOF-26-000007', first: 'New', last: 'Kid', dob: '2015-01-01', branch: 'KRM', reg: today, parents: [{ name: 'P', mobile: '+971500000077', email: 'p77@example.com' }], status: 'Active', comm: [] };
    const e = { id: 'EN-26-0009', stu: s.id, prog: 'ROB', branch: 'KRM', pkg: fee.pkg, date: today, status: 'Active', cur: 'AED', fee: fee.amt, reg: fee.extra.amt, disc: 0, discInfo: null, tax: 0, total, paid: 0, payStatus: 'Unpaid', opp: null, course: { name: 'x', moodleId: 4101 }, newStu: true };
    const p = { id: 'PY-26-0009', enr: e.id, stu: s.id, amt: total, method: 'Cash', ref: '—', at: new Date().toISOString(), branch: 'KRM' };
    const r = await sync(USERS.hassan, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }, { coll: 'pay', id: p.id, op: 'upsert', doc: p }]);
    expect(r.status).toBe(200);
    expect((await doc(t, 'enrollment', e.id)).payStatus).toBe('Paid');
    const old = await doc(t, 'enrollment', 'EN-26-0002');
    const r2 = await sync(USERS.hassan, [{ coll: 'pay', id: 'PY-26-0010', op: 'upsert', doc: { ...p, id: 'PY-26-0010', enr: old.id, stu: old.stu, amt: 5 } }]);
    expect(r2.body.error).toMatch(/cannot record payments/);
  });
});
