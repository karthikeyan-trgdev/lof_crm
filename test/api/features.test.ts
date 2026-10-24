// Counsellor targets, payment terms & instalments, refund rules and the LMS integration (server side).
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, doc, type TestCtx } from '../helpers/app';
import { calcFee, feeFor } from '../../src/domain/core';
import { cron } from '../../src/jobs';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
const sync = async (email: string, changes: any[], settings: any[] = []) => t.call('PUT', '/api/v1/sync', { token: await t.login(email), body: { changes, settings } });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const cfgDoc = async () => JSON.parse((await t.sql<any>("SELECT data FROM settings WHERE key='cfg'"))[0].data);

/** A new-student enrolment exactly as the enrolment form builds it. */
async function enrolment(term: string, extra: any = {}) {
  const fees = (await t.sql<any>("SELECT data FROM docs WHERE type='fee'")).map((r) => JSON.parse(r.data));
  const fee = feeFor(fees, 'ROB', 'KRM', 'Term (24 sessions)', today());
  const c = calcFee(fee, null, true);
  const s = { id: 'LOF-26-000700', first: 'Tara', last: 'Joseph', dob: '2014-02-02', branch: 'KRM', fam: 'FAM-26-0700', email: 'tara@example.com', mobile: '+971 50 111 2222', parents: [{ name: 'Joe Joseph', rel: 'Father', email: 'joe@example.com', mobile: '+971 50 111 3333' }], status: 'Active', comm: [] };
  const e = { id: 'EN-26-0700', stu: s.id, prog: 'ROB', branch: 'KRM', pkg: fee.pkg, date: today(), status: 'Active', cur: fee.cur, total: c.total, discInfo: null, term, sched: [{ n: 1, due: '2030-01-01', amt: 1 }], cslr: 'S99', ...extra };
  const m = { id: 'MS-700', enr: e.id, stu: s.id, op: 'enrol', cid: 'FAKE', credits: ['X'] };
  return { s, e, m, total: c.total };
}

describe('payment terms and instalments', () => {
  it('builds the instalment schedule on the server from the chosen term', async () => {
    const { s, e, m, total } = await enrolment('PT3');
    const r = await sync(USERS.hassan, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }, { coll: 'ms', id: m.id, op: 'upsert', doc: m }]);
    expect(r.status).toBe(200);
    const saved = await doc(t, 'enrollment', e.id);
    expect(saved.term).toBe('PT3');
    expect(saved.cslr).toBeNull(); // only taken from a linked opportunity, never from the browser
    expect(saved.sched.map((x: any) => x.pct)).toEqual([40, 30, 30]);
    expect(saved.sched.reduce((a: number, x: any) => a + x.amt, 0)).toBeCloseTo(total, 2);
    expect(saved.sched[0].due).toBe(today());
    const inst = await t.call('GET', `/api/v1/enrollments/${e.id}/instalments`, { token: await t.login(USERS.layla) });
    expect(inst.body.instalments.map((i: any) => i.st)).toEqual(['Due', 'Upcoming', 'Upcoming']);
    const lms = await doc(t, 'moodle_sync', 'MS-700');
    expect(lms).toMatchObject({ op: 'enrol', cid: 'ROB-TRK-10021', credits: ['ROB-TRK-10021-C1', 'ROB-TRK-10021-C2', 'ROB-TRK-10021-C3', 'ROB-TRK-10021-C4'] });
  });
  it('refuses an inactive or unknown payment term', async () => {
    await t.setCfg((c) => { c.payTerms.find((x: any) => x.id === 'PT4').active = false; });
    const { s, e, m } = await enrolment('PT4');
    const r = await sync(USERS.hassan, [{ coll: 'students', id: s.id, op: 'upsert', doc: s }, { coll: 'enr', id: e.id, op: 'upsert', doc: e }, { coll: 'ms', id: m.id, op: 'upsert', doc: m }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Payment term is not active/);
  });
  it('keeps the schedule and term fixed after enrolment', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const r = await sync(USERS.hassan, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, term: 'PT1' }, base: e }]);
    expect(r.status).toBe(409);
  });
  it('notifies Reception once per overdue instalment', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0004'); // 40/30/30 every 21 days from 2026-09-10, 60% paid
    expect(e.term).toBe('PT3');
    const before = await t.sql("SELECT id FROM docs WHERE type='notification' AND json_extract(data,'$.text') LIKE 'Instalment overdue%'");
    const r1 = await cron(t.env, () => {});
    const after = await t.sql("SELECT id FROM docs WHERE type='notification' AND json_extract(data,'$.text') LIKE 'Instalment overdue%'");
    expect(r1.overdueInstalments).toBeGreaterThan(0);
    expect(after.length - before.length).toBe(r1.overdueInstalments);
    const r2 = await cron(t.env, () => {});
    expect(r2.overdueInstalments).toBe(0);
  });
});

describe('refund rules', () => {
  it('suggests a refund from the rules and marks larger requests as exceptions for the approver', async () => {
    // 20 sessions is beyond every rule, so the suggestion is 0 and any refund is an exception
    const sug = await t.call('GET', '/api/v1/refunds/suggest?enrollmentId=EN-26-0002&sessions=20', { token: await t.login(USERS.hassan) });
    expect(sug.status).toBe(200);
    expect(sug.body).toMatchObject({ approver: 'Management', confirmed: false });
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    expect(sug.body.suggested).toBe(0);
    const over = 100;
    const r = await sync(USERS.hassan, [
      { coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e },
      { coll: 'refunds', id: 'RF-26-0300', op: 'upsert', doc: { id: 'RF-26-0300', enr: e.id, amt: over, reason: 'Moving', sessions: 20, exception: false, suggested: 99999 } },
    ]);
    expect(r.status).toBe(200);
    const rf = await doc(t, 'refund', 'RF-26-0300');
    expect(rf).toMatchObject({ status: 'Requested', sessions: 20, suggested: 0, approverRole: 'Management', exception: true });
    // Only the approver role may process an exception – not even the System Administrator
    const byAdmin = await sync(USERS.admin, [{ coll: 'refunds', id: rf.id, op: 'upsert', doc: { ...rf, status: 'Processed' }, base: rf }]);
    expect(byAdmin.status).toBe(409);
    expect(byAdmin.body.error).toMatch(/Only Management can decide/);
    const byMgmt = await sync(USERS.khalid, [{ coll: 'refunds', id: rf.id, op: 'upsert', doc: { ...rf, status: 'Processed' }, base: rf }]);
    expect(byMgmt.status).toBe(200);
    expect(await doc(t, 'refund', rf.id)).toMatchObject({ status: 'Processed', approvedBy: 'Khalid Rahman' });
  });
  it('needs the sessions attended', async () => {
    const r = await sync(USERS.hassan, [{ coll: 'refunds', id: 'RF-26-0301', op: 'upsert', doc: { id: 'RF-26-0301', enr: 'EN-26-0002', amt: 10, reason: 'x' } }]);
    expect(r.body.error).toMatch(/sessions attended/);
  });
});

describe('LMS calls', () => {
  it('creates one cancel call per withdrawal and refuses cancel calls without one', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const bad = await sync(USERS.hassan, [{ coll: 'ms', id: 'MS-800', op: 'upsert', doc: { id: 'MS-800', enr: e.id, op: 'cancel' } }]);
    expect(bad.status).toBe(409);
    const ok = await sync(USERS.hassan, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }, { coll: 'ms', id: 'MS-801', op: 'upsert', doc: { id: 'MS-801', enr: e.id, op: 'cancel' } }]);
    expect(ok.status).toBe(200);
    const cancels = await t.sql("SELECT id FROM docs WHERE type='moodle_sync' AND json_extract(data,'$.op')='cancel'");
    expect(cancels).toHaveLength(1);
    const again = await sync(USERS.hassan, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...(await doc(t, 'enrollment', e.id)), status: 'Active' } }]);
    expect(again.status).toBe(409); // a withdrawn enrolment is not reactivated
  });
  it('previews the enrol call for an enrolment', async () => {
    const r = await t.call('GET', '/api/v1/lms/preview/EN-26-0001', { token: await t.login(USERS.hassan) });
    expect(r.body.enrol).toMatchObject({ call: 'enrol', reference: 'EN-26-0001', branch: 'KRM01' });
    expect(r.body.cancel).toEqual({ call: 'cancel', reference: 'EN-26-0001' });
    expect(r.body.missing).toEqual([]);
    expect((await t.call('GET', '/api/v1/lms/preview/EN-26-0003', { token: await t.login(USERS.priya) })).status).toBe(403);
  });
});

describe('settings validation', () => {
  const save = async (fn: (c: any) => void) => { const c = await cfgDoc(); fn(c); return sync(USERS.admin, [], [{ key: 'cfg', doc: c }]); };
  it('accepts valid settings and strips LMS credentials', async () => {
    const r = await save((c) => { c.payTerms.push({ id: 'PT9', name: '60 / 40', split: [60, 40], gap: 45, minFirst: 50, grace: 5, active: true }); c.integ.lms.token = 'secret'; c.targets.push({ m: '2026-12', c: 'S01', enr: 7, rev: 20000, conv: 30 }); });
    expect(r.status).toBe(200);
    const c = await cfgDoc();
    expect(c.payTerms.find((x: any) => x.id === 'PT9')).toBeTruthy();
    expect(c.integ.lms.token).toBeUndefined();
  });
  it('rejects bad payment terms, refund rules, targets and LMS codes', async () => {
    expect((await save((c) => { c.payTerms[1].split = [50, 40]; })).body.error).toMatch(/add up to 100/);
    expect((await save((c) => { c.payTermDefault = 'PT404'; })).body.error).toMatch(/default payment term/);
    expect((await save((c) => { c.refund.rules[0].pct = 140; })).body.error).toMatch(/0–100%/);
    expect((await save((c) => { c.refund.approver = 'Anyone'; })).body.error).toMatch(/approver/);
    expect((await save((c) => { c.targets.push({ m: '2026-10', c: 'S07', enr: 1, rev: 1, conv: 1 }); })).body.error).toMatch(/existing counsellor/);
    expect((await save((c) => { c.lms.programmes.ROB.track = 'ROB TRK <x>'; })).body.error).toMatch(/Track code/);
    expect((await save((c) => { c.lms.validMonths = 0; })).body.error).toMatch(/1–60 months/);
  });
});

describe('counsellor targets', () => {
  it('counsellors see only their own targets; managers see achievement for everyone in scope', async () => {
    const b = await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.priya) });
    expect(b.body.data.cfg.targets.length).toBeGreaterThan(0);
    expect(b.body.data.cfg.targets.every((x: any) => x.c === 'S01')).toBe(true);
    const month = today().slice(0, 7);
    const mine = await t.call('GET', `/api/v1/targets?month=${month}`, { token: await t.login(USERS.priya) });
    expect(mine.body.items.map((i: any) => i.counsellor)).toEqual(['S01']);
    const all = await t.call('GET', `/api/v1/targets?month=${month}`, { token: await t.login(USERS.khalid) });
    expect(all.body.items.length).toBe(6);
    expect(all.body.items[0]).toHaveProperty('achieved.enrolments');
    expect((await t.call('GET', '/api/v1/targets', { token: await t.login(USERS.layla) })).status).toBe(403); // Reception has no reports access
  });
  it('fills defaults for databases created before these settings existed', async () => {
    await t.setCfg((c) => { delete c.payTerms; delete c.refund; delete c.targets; delete c.lms; delete c.integ.lms; });
    const b = await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) });
    const c = b.body.data.cfg;
    expect(c.payTerms.map((x: any) => x.id)).toEqual(['PT1', 'PT2', 'PT3', 'PT4']);
    expect(c.refund.confirmed).toBe(false);
    expect(Object.keys(c.lms.programmes).length).toBe(8);
    expect(c.integ.lms.on).toBe(false);
  });
});

describe('review fixes (feature round)', () => {
  it('a refund split into two requests still needs approval once the suggestion is used up', async () => {
    await t.sql("UPDATE docs SET data=json_set(data,'$.date',?) WHERE type='enrollment' AND id='EN-26-0002'", today()); // keep the rule window independent of the run date
    const sug = await t.call('GET', '/api/v1/refunds/suggest?enrollmentId=EN-26-0002&sessions=10', { token: await t.login(USERS.hassan) }); // Mid-term rule, below the amount paid
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    expect(sug.body.suggested).toBeLessThan(e.paid - 20);
    const a = await sync(USERS.hassan, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }, { coll: 'refunds', id: 'RF-26-0400', op: 'upsert', doc: { id: 'RF-26-0400', enr: e.id, amt: sug.body.suggested - 10, reason: 'part 1', sessions: 10 } }]);
    expect(a.status).toBe(200);
    expect((await doc(t, 'refund', 'RF-26-0400')).exception).toBe(false);
    const b = await sync(USERS.hassan, [{ coll: 'refunds', id: 'RF-26-0401', op: 'upsert', doc: { id: 'RF-26-0401', enr: e.id, amt: 20, reason: 'part 2', sessions: 10 } }]);
    expect(b.status).toBe(200);
    expect(await doc(t, 'refund', 'RF-26-0401')).toMatchObject({ exception: true, suggested: 10 });
  });
  it('the person who requested an exception cannot approve it; the approver can reject it', async () => {
    await t.setCfg((c) => { c.refund.approver = 'System Administrator'; });
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    await sync(USERS.admin, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }, { coll: 'refunds', id: 'RF-26-0402', op: 'upsert', doc: { id: 'RF-26-0402', enr: e.id, amt: 50, reason: 'x', sessions: 40 } }]);
    const rf = await doc(t, 'refund', 'RF-26-0402');
    expect(rf.exception).toBe(true);
    const self = await sync(USERS.admin, [{ coll: 'refunds', id: rf.id, op: 'upsert', doc: { ...rf, status: 'Processed' }, base: rf }]);
    expect(self.body.error).toMatch(/cannot approve a refund you requested/);
    await t.setCfg((c) => { c.refund.approver = 'Management'; });
    await t.sql("UPDATE docs SET data=json_set(data,'$.approverRole','Management') WHERE type='refund' AND id='RF-26-0402'");
    const fresh = await doc(t, 'refund', rf.id);
    const rej = await sync(USERS.khalid, [{ coll: 'refunds', id: rf.id, op: 'upsert', doc: { ...fresh, status: 'Rejected' }, base: fresh }]);
    expect(rej.status).toBe(200);
    expect((await doc(t, 'refund', rf.id)).status).toBe('Rejected');
  });
  it('never re-opens LMS access after a withdrawal, and a successful call cannot be re-run', async () => {
    const e = await doc(t, 'enrollment', 'EN-26-0003'); // its enrol call MS-003 failed
    expect((await sync(USERS.admin, [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }])).status).toBe(200);
    const r = await t.call('POST', '/api/v1/lms/calls/MS-003/retry', { token: await t.login(USERS.admin) });
    expect(r.body).toMatchObject({ status: 'Closed' });
    const ok = await doc(t, 'moodle_sync', 'MS-001'); // a successful enrol call
    const again = await sync(USERS.admin, [{ coll: 'ms', id: ok.id, op: 'upsert', doc: { ...ok, status: 'Pending' }, base: ok }]);
    expect(again.status).toBe(409);
  });
  it('clamps valid_until at month end', async () => {
    const { lmsEnrolPayload } = await import('../../src/domain/terms');
    const p = lmsEnrolPayload({ id: 'E', prog: 'P', pkg: 'x', branch: 'B', date: '2026-01-31' }, { id: 'S', parents: [] }, { name: 'P' }, { validMonths: 1, programmes: {}, branchMap: {} });
    expect(p.valid_until).toBe('2026-02-27');
  });
});
