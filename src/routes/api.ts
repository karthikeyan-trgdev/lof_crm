import { Hono } from 'hono';
import { requireAuth, need, needScope, inList, can, type AppEnv } from '../lib/auth';
import { allow } from '../lib/ratelimit';
import { nowIso } from '../lib/db';
import { EXACT_SEQS, BLOCK_SEQS } from '../lib/indexing';
import { HttpError } from '../types';
import { bootstrap } from '../sync/bootstrap';
import { applySync } from '../sync/sync';
import { createLead, findDup, addAudit, addEv, money, r2, dayKey } from '../domain/core';
import { instStatus, refundCalc, daysBetween, lmsEnrolPayload, lmsMissing } from '../domain/terms';
import { createPaymentLink, processSync } from '../domain/workflows';
import { dispatch } from '../jobs';
import { modeFor } from '../integrations/base';
import { clickToCall } from '../integrations/exotel';
import { receiptHtml } from './receipt';
import { sendToParent } from '../domain/workflows';

export const api = new Hono<AppEnv>();
api.use('*', requireAuth);

const wait = (c: any) => (p: Promise<unknown>) => c.executionCtx.waitUntil(p);

// ------------------------------------------------------------------ state for the screens
api.get('/bootstrap', async (c) => c.json(await bootstrap(c.env, c.get('repo'), c.get('user'), c.get('perms'))));

api.put('/sync', async (c) => {
  const raw = await c.req.text();
  if (raw.length > 2_000_000) throw new HttpError(413, 'Too much data in one save');
  let body: { changes?: any[]; settings?: any[] };
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  if ((body.changes?.length || 0) > 500) throw new HttpError(413, 'Too many changes in one batch');
  const r = await applySync(c.env, c.get('repo'), c.get('user'), c.get('perms'), body.changes || [], body.settings || []);
  if (!r.ok) return c.json({ ok: false, error: r.rejected.map((x) => x.reason).join('; '), rejected: r.rejected }, 409);
  await dispatch(c.env, wait(c), r.jobs);
  return c.json({ ok: true, docs: r.docs, notices: r.notices, settings: r.settings, jobs: r.jobs.length });
});

api.post('/seq/claim', async (c) => {
  if (!(await allow(c.env, 'seq:' + c.get('user').id, 120, 60))) throw new HttpError(429, 'Too many requests');
  const { name, expect } = await c.req.json<{ name: string; expect: number }>();
  if (!EXACT_SEQS.includes(name)) throw new HttpError(400, 'Unknown sequence');
  return c.json(await c.get('repo').claim(name, +expect));
});
api.post('/seq/block', async (c) => {
  if (!(await allow(c.env, 'seqb:' + c.get('user').id, 60, 60))) throw new HttpError(429, 'Too many requests');
  const { name, size } = await c.req.json<{ name: string; size?: number }>();
  if (!BLOCK_SEQS.includes(name)) throw new HttpError(400, 'Unknown sequence');
  const n = Math.min(Math.max(+(size || 20), 1), 100);
  return c.json({ start: await c.get('repo').block(name, n), size: n });
});

// ------------------------------------------------------------------ helpers
const page = (c: any) => ({ limit: Math.min(Math.max(Math.floor(+(c.req.query('limit') || 50)) || 50, 1), 200), offset: Math.max(Math.floor(+(c.req.query('offset') || 0)) || 0, 0) });
async function list(c: any, type: string, where: string[], binds: unknown[], order = 'at DESC') {
  const { limit, offset } = page(c);
  const w = where.length ? ' AND ' + where.join(' AND ') : '';
  const total = await c.env.DB.prepare(`SELECT COUNT(*) n FROM docs WHERE type=?${w}`).bind(type, ...binds).first();
  const r = await c.env.DB.prepare(`SELECT data FROM docs WHERE type=?${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(type, ...binds, limit, offset).all();
  return { total: total?.n ?? 0, limit, offset, items: (r.results || []).map((x: any) => JSON.parse(x.data)) };
}
const scopeWhere = (c: any, col = 'branch') => { const sc = c.get('user').scope; return { sql: `${col} IN (${inList(sc)})`, binds: sc }; };

// ------------------------------------------------------------------ leads
api.get('/leads', async (c) => {
  need(c, 'leads', 'V');
  const s = scopeWhere(c);
  const where = [s.sql], binds: unknown[] = [...s.binds];
  const q = c.req.query();
  if (q.status) { where.push('status=?'); binds.push(q.status); }
  if (q.branch) { where.push('branch=?'); binds.push(q.branch); }
  if (q.counsellor) { where.push('owner=?'); binds.push(q.counsellor); }
  if (q.category) { where.push("json_extract(data,'$.cat')=?"); binds.push(q.category); }
  if (q.source) { where.push("json_extract(data,'$.src')=?"); binds.push(q.source); }
  if (q.from) { where.push('at>=?'); binds.push(q.from); }
  if (q.to) { where.push('at<=?'); binds.push(q.to + 'T23:59:59Z'); }
  if (q.q) { where.push('(id LIKE ? OR data LIKE ?)'); binds.push(`%${q.q}%`, `%${q.q}%`); }
  return c.json(await list(c, 'lead', where, binds));
});

api.get('/leads/:id', async (c) => {
  need(c, 'leads', 'V');
  const repo = c.get('repo');
  const l = await repo.get<any>('lead', c.req.param('id'));
  if (!l) throw new HttpError(404, 'Lead not found');
  needScope(c, l.branch);
  const [tasks, calls, comms, opps] = await Promise.all(['task', 'call', 'comm', 'opp'].map((t) => repo.many(t, 'ref1=?', [l.id], 'at')));
  return c.json({ lead: l, tasks, calls, comms, opportunities: opps });
});

api.post('/leads', async (c) => {
  need(c, 'leads', 'C');
  const body = await c.req.json<any>();
  for (const k of ['student', 'parent', 'phone', 'branch', 'prog', 'src']) if (!String(body[k] ?? '').trim()) throw new HttpError(400, `${k} is required`);
  if (!/^\+?[\d\s()-]{7,20}$/.test(body.phone)) throw new HttpError(400, 'Enter a valid mobile number');
  if (body.email && !/^\S+@\S+\.\S+$/.test(body.email)) throw new HttpError(400, 'Enter a valid e-mail address');
  needScope(c, body.branch);
  const repo = c.get('repo');
  // Only documented fields reach the record; free text is length-capped
  const str = (v: unknown, n = 200) => (v == null ? undefined : String(v).slice(0, n));
  const cat = ['Hot', 'Warm', 'Cold'].includes(body.cat) ? body.cat : undefined;
  let cslr: string | undefined;
  if (body.cslr) {
    const st = await repo.get<any>('staff', String(body.cslr));
    if (!st || st.role !== 'Counsellor' || st.status !== 'Active' || st.access === 'Disabled' || st.branch !== body.branch) throw new HttpError(422, 'Selected counsellor cannot take leads for this branch');
    cslr = st.id;
  }
  const input: any = {
    student: str(body.student, 120), parent: str(body.parent, 120), phone: str(body.phone, 20), email: str(body.email, 160), branch: String(body.branch), prog: String(body.prog), src: str(body.src, 60),
    camp: str(body.camp, 120), cat, age: Number.isFinite(+body.age) ? Math.max(0, Math.min(25, Math.floor(+body.age))) : 0, dob: /^\d{4}-\d{2}-\d{2}$/.test(body.dob || '') ? body.dob : '',
    school: str(body.school, 160), grade: str(body.grade, 40), curr: str(body.curr, 60), notes: str(body.notes, 2000), cslr, wa: body.wa !== false, em: body.em !== false,
  };
  const dups = await findDup(repo, input.phone, input.email);
  if (dups.length && !body.allowDuplicate) {
    const sc = c.get('user').scope;
    return c.json({ error: 'Possible duplicate', duplicates: dups.map((d: any) => (sc.includes(d.branch) ? d : { kind: d.kind, id: d.id, branch: d.branch, name: 'Record in another branch' })) }, 409);
  }
  try {
    const r = await createLead(repo, input, c.get('user').name);
    await dispatch(c.env, wait(c), r.queuedComms.map((id) => ({ kind: 'send_comm' as const, id })));
    return c.json({ lead: r.lead, assignedTo: r.route?.pick?.id ?? r.lead.cslr, duplicates: r.duplicates }, 201);
  } catch (e: any) {
    throw new HttpError(422, e.message);
  }
});

api.post('/leads/duplicates', async (c) => {
  need(c, 'leads', 'V');
  const { phone, email } = await c.req.json<any>();
  const sc = c.get('user').scope;
  const dups = (await findDup(c.get('repo'), phone, email)).map((d: any) => (sc.includes(d.branch) ? d : { kind: d.kind, id: d.id, branch: d.branch, name: 'Record in another branch' }));
  return c.json({ duplicates: dups });
});

/** Exotel click-to-call: rings the counsellor's mobile, then bridges to the parent. */
api.post('/leads/:id/click-to-call', async (c) => {
  need(c, 'leads', 'E');
  const repo = c.get('repo');
  const l = await repo.get<any>('lead', c.req.param('id'));
  if (!l) throw new HttpError(404, 'Lead not found');
  needScope(c, l.branch);
  const me = await repo.get<any>('staff', c.get('user').id);
  if (!me?.mobile) throw new HttpError(400, 'Add your mobile number to your staff profile first');
  const cfg = await repo.setting<any>('cfg');
  const mode = modeFor(c.env, cfg, 'exotel');
  const cb = `${c.env.APP_BASE_URL.replace(/\/+$/, '')}/webhooks/exotel/status?token=${encodeURIComponent(c.env.EXOTEL_WEBHOOK_TOKEN || '')}&lead=${l.id}&staff=${me.id}`;
  try {
    const r = await clickToCall({ env: c.env, mode }, me.mobile, l.phone, cb, l.id);
    addEv(l, 'call', `Click-to-call started via Exotel${mode === 'mock' ? ' (mock)' : ''} – ringing ${me.name} first`, me.name);
    (l.pendingCalls ||= []).push({ sid: r.sid, at: nowIso(), by: me.id });
    await repo.put('lead', l);
    return c.json({ ok: true, mode, callSid: r.sid });
  } catch (e: any) {
    throw new HttpError(502, e.message);
  }
});

/** Incoming-call screen-pop polling (Exotel passthru writes call_events). */
api.get('/calls/incoming', async (c) => {
  const u = c.get('user');
  const since = c.req.query('since') || new Date(Date.now() - 60_000).toISOString();
  const r = await c.env.DB.prepare(`SELECT * FROM call_events WHERE at>? AND (staff_id=? OR (staff_id IS NULL AND branch IN (${inList(u.scope)}))) ORDER BY at DESC LIMIT 5`)
    .bind(since, u.id, ...u.scope).all();
  return c.json({ events: r.results || [], now: nowIso() });
});

// ------------------------------------------------------------------ opportunities, approvals, tasks
api.get('/opportunities', async (c) => {
  need(c, 'opportunities', 'V');
  const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('stage')) { where.push('status=?'); binds.push(c.req.query('stage')); }
  return c.json(await list(c, 'opp', where, binds, 'created_at DESC'));
});
api.get('/approvals', async (c) => {
  const u = c.get('user'), perms = c.get('perms');
  if (!['discount_requests', 'branch_transfers', 'reassignment'].some((r) => can(perms, u, r, 'V'))) throw new HttpError(403, `${u.role} cannot view approvals`);
  const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('status')) { where.push('status=?'); binds.push(c.req.query('status')); }
  if (c.req.query('type')) { where.push("json_extract(data,'$.type')=?"); binds.push(c.req.query('type')); }
  return c.json(await list(c, 'approval', where, binds));
});
api.get('/tasks', async (c) => {
  need(c, 'leads', 'V');
  const u = c.get('user'); const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (u.role === 'Counsellor') { where.push('owner=?'); binds.push(u.id); }
  if (c.req.query('status')) { where.push('status=?'); binds.push(c.req.query('status')); }
  if (c.req.query('overdue') === '1') { where.push("status='Pending' AND at<?"); binds.push(nowIso()); }
  return c.json(await list(c, 'task', where, binds, 'at ASC'));
});

// ------------------------------------------------------------------ students, enrolments, payments
api.get('/students', async (c) => {
  need(c, 'students', 'V');
  const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('q')) { where.push('(id LIKE ? OR data LIKE ?)'); binds.push(`%${c.req.query('q')}%`, `%${c.req.query('q')}%`); }
  return c.json(await list(c, 'student', where, binds, 'id ASC'));
});
api.get('/students/:id', async (c) => {
  need(c, 'students', 'V');
  const repo = c.get('repo');
  const s = await repo.get<any>('student', c.req.param('id'));
  if (!s) throw new HttpError(404, 'Student not found');
  const enrollments = await repo.many<any>('enrollment', 'ref1=?', [s.id], 'at');
  if (!c.get('user').scope.includes(s.branch) && !enrollments.some((e) => c.get('user').scope.includes(e.branch))) throw new HttpError(403, 'Outside your branch access');
  const u = c.get('user'), perms = c.get('perms');
  const canEnr = can(perms, u, 'enrollments', 'V');
  const payments = can(perms, u, 'payments', 'V') ? (await repo.many<any>('payment', 'ref2=?', [s.id], 'at')).filter((p) => u.scope.includes(p.branch)) : [];
  const syncs = canEnr ? await repo.many('moodle_sync', 'ref2=?', [s.id], 'at') : [];
  return c.json({ student: s, enrollments: canEnr ? enrollments.filter((e) => u.scope.includes(e.branch)) : [], payments, moodle: syncs });
});
api.get('/enrollments', async (c) => {
  need(c, 'enrollments', 'V');
  const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('status')) { where.push('status=?'); binds.push(c.req.query('status')); }
  return c.json(await list(c, 'enrollment', where, binds));
});
api.get('/payments', async (c) => {
  need(c, 'payments', 'V');
  const s = scopeWhere(c); const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('from')) { where.push('at>=?'); binds.push(c.req.query('from')); }
  if (c.req.query('to')) { where.push('at<=?'); binds.push(c.req.query('to') + 'T23:59:59Z'); }
  return c.json(await list(c, 'payment', where, binds));
});
api.get('/payments/:id/receipt', async (c) => {
  need(c, 'payments', 'V');
  const repo = c.get('repo');
  const p = await repo.get<any>('payment', c.req.param('id'));
  if (!p) throw new HttpError(404, 'Payment not found');
  needScope(c, p.branch);
  const [e, s, b, programs] = await Promise.all([repo.get<any>('enrollment', p.enr), repo.get<any>('student', p.stu), repo.get<any>('branch', p.branch), repo.many<any>('program')]);
  await addAudit(repo, 'Receipt generated', p.id, p.rc);
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  c.header('cache-control', 'no-store');
  return c.html(receiptHtml(p, e, s, b, programs));
});

api.post('/payments/links', async (c) => {
  need(c, 'payments', 'C');
  const { enrollmentId, amount } = await c.req.json<{ enrollmentId: string; amount?: number }>();
  const repo = c.get('repo');
  const e = await repo.get<any>('enrollment', enrollmentId);
  if (!e) throw new HttpError(404, 'Enrollment not found');
  needScope(c, e.branch);
  try {
    return c.json(await createPaymentLink(c.env, repo, enrollmentId, amount, c.get('user').name), 201);
  } catch (err: any) {
    throw new HttpError(422, err.message);
  }
});
api.get('/payments/links', async (c) => {
  need(c, 'payments', 'V');
  const enr = c.req.query('enrollmentId');
  const sc = c.get('user').scope;
  const r = await c.env.DB.prepare(`SELECT l.* FROM payment_links l JOIN docs e ON e.type='enrollment' AND e.id=l.enrollment_id WHERE e.branch IN (${inList(sc)}) ${enr ? 'AND l.enrollment_id=?' : ''} ORDER BY l.created_at DESC LIMIT 100`).bind(...sc, ...(enr ? [enr] : [])).all();
  return c.json({ items: r.results || [] });
});

/** Send a payment link to the parent over WhatsApp or e-mail (respects consent). */
api.post('/payments/links/:id/send', async (c) => {
  need(c, 'payments', 'C');
  const { channel } = await c.req.json<{ channel: 'WhatsApp' | 'Email' }>();
  const link = await c.env.DB.prepare('SELECT * FROM payment_links WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!link) throw new HttpError(404, 'Link not found');
  const repo = c.get('repo');
  const e = await repo.get<any>('enrollment', link.enrollment_id);
  needScope(c, e.branch);
  if (link.status !== 'created') throw new HttpError(409, `This link is ${link.status}`);
  if (!['WhatsApp', 'Email'].includes(channel)) throw new HttpError(400, 'Choose WhatsApp or Email');
  const s = await repo.get<any>('student', e.stu);
  const opp = e.opp ? await repo.get<any>('opp', e.opp) : null;
  const lead = opp ? await repo.get<any>('lead', opp.lead) : null;
  const parent = (s?.parents || [])[0] || {};
  const text = `Dear ${lead?.parent || parent.name || 'Parent'}, please use this secure link to pay ${money(link.amount, link.currency)} for ${s.first}'s enrolment at Lab of Future: ${link.url}`;
  if (lead) {
    const id = await repo.newId('cm');
    await repo.put('comm', { id, lead: lead.id, ch: channel, tpl: 'Payment link', text, at: nowIso(), status: 'Queued', by: c.get('user').name });
    await dispatch(c.env, wait(c), [{ kind: 'send_comm', id }]);
    return c.json({ ok: true, commId: id });
  }
  // Walk-in / existing students: send to the parent on the student record (transactional message about their own enrolment)
  const r = await sendToParent(c.env, repo, s, channel, text);
  return c.json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502);
});

// ------------------------------------------------------------------ LMS calls (enrol / cancel); /moodle/syncs kept as an alias
const syncList = async (c: any) => {
  need(c, 'enrollments', 'V');
  const s = scopeWhere(c);
  const where = [s.sql]; const binds: unknown[] = [...s.binds];
  if (c.req.query('status')) { where.push('status=?'); binds.push(c.req.query('status')); }
  if (c.req.query('op')) { where.push("json_extract(data,'$.op')=?"); binds.push(c.req.query('op')); }
  return c.json(await list(c, 'moodle_sync', where, binds));
};
const syncGet = async (c: any) => {
  need(c, 'enrollments', 'V');
  const m = await c.get('repo').get('moodle_sync', c.req.param('id'));
  if (!m) throw new HttpError(404, 'LMS call not found');
  needScope(c, (await c.get('repo').getRow('moodle_sync', m.id))?.branch);
  return c.json(m);
};
const syncRetry = async (c: any) => {
  const u = c.get('user');
  if (!['System Administrator', 'Admissions Head', 'Centre Administrator', 'Management'].includes(u.role)) throw new HttpError(403, `${u.role} cannot retry LMS calls`);
  const repo = c.get('repo');
  const m = await repo.get('moodle_sync', c.req.param('id'));
  if (!m) throw new HttpError(404, 'LMS call not found');
  needScope(c, (await repo.getRow('moodle_sync', m.id))?.branch);
  if (m.status === 'Processing') throw new HttpError(409, 'The call is already running');
  if (m.status === 'Success') throw new HttpError(409, 'The call already succeeded');
  m.status = 'Pending';
  m.hist.push({ at: nowIso(), s: 'Pending', msg: `Manual retry by ${u.name}` });
  await repo.put('moodle_sync', m);
  return c.json(await processSync(c.env, repo, m.id));
};
for (const base of ['/lms/calls', '/moodle/syncs']) {
  api.get(base, syncList);
  api.get(base + '/:id', syncGet);
  api.post(base + '/:id/retry', syncRetry);
}

/** What the enrol call would send for an enrolment, and which required fields are still missing. */
api.get('/lms/preview/:enrollmentId', async (c) => {
  need(c, 'enrollments', 'V');
  const repo = c.get('repo');
  const e = await repo.get<any>('enrollment', c.req.param('enrollmentId'));
  if (!e) throw new HttpError(404, 'Enrolment not found');
  needScope(c, e.branch);
  const [s, program, cfg] = await Promise.all([repo.get<any>('student', e.stu), repo.get<any>('program', e.prog), repo.setting<any>('cfg')]);
  const payload = lmsEnrolPayload(e, s, program, cfg.lms || {});
  return c.json({ enrol: { call: 'enrol', ...payload }, cancel: { call: 'cancel', reference: e.id }, missing: lmsMissing(payload), mode: modeFor(c.env, cfg, 'lms') });
});

// ------------------------------------------------------------------ instalments, refunds, targets
api.get('/enrollments/:id/instalments', async (c) => {
  need(c, 'payments', 'V');
  const repo = c.get('repo');
  const e = await repo.get<any>('enrollment', c.req.param('id'));
  if (!e) throw new HttpError(404, 'Enrolment not found');
  needScope(c, e.branch);
  const cfg = await repo.setting<any>('cfg');
  const term = (cfg.payTerms || []).find((t: any) => t.id === e.term) || null;
  return c.json({ enrollment: e.id, term: term ? { id: term.id, name: term.name, grace: term.grace } : null, currency: e.cur, total: e.total, paid: e.paid, instalments: instStatus(e, term, dayKey(new Date())) });
});
api.get('/refunds/suggest', async (c) => {
  const u = c.get('user'), perms = c.get('perms');
  if (!(can(perms, u, 'enrollments', 'E') || can(perms, u, 'payments', 'C'))) throw new HttpError(403, `${u.role} cannot request refunds`);
  const repo = c.get('repo');
  const e = await repo.get<any>('enrollment', c.req.query('enrollmentId') || '');
  if (!e) throw new HttpError(404, 'Enrolment not found');
  needScope(c, e.branch);
  const sessions = Math.floor(+(c.req.query('sessions') || 0));
  if (!(sessions >= 0)) throw new HttpError(400, 'sessions must be 0 or more');
  const cfg = await repo.setting<any>('cfg');
  const days = daysBetween(e.date, dayKey(new Date()));
  const r = refundCalc(e, days, sessions, cfg.refund || { rules: [] });
  return c.json({ enrollment: e.id, currency: e.cur, days, sessions, ...r, approver: cfg.refund?.approver, confirmed: !!cfg.refund?.confirmed });
});
api.get('/targets', async (c) => {
  const u = c.get('user'), perms = c.get('perms');
  const month = c.req.query('month') || dayKey(new Date()).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
  const repo = c.get('repo');
  const cfg = await repo.setting<any>('cfg');
  const staff = (await repo.many<any>('staff')).filter((s) => s.role === 'Counsellor' && u.scope.includes(s.branch) && (u.role !== 'Counsellor' || s.id === u.id));
  if (u.role !== 'Counsellor' && !can(perms, u, 'reports', 'V')) throw new HttpError(403, `${u.role} cannot view targets`);
  const enr = (await repo.many<any>('enrollment', `branch IN (${inList(u.scope)})`, u.scope)).filter((e) => e.date?.startsWith(month) && e.status !== 'Withdrawn');
  const leads = await repo.many<any>('lead', `branch IN (${inList(u.scope)})`, u.scope);
  const rows = staff.map((s) => {
    const t = (cfg.targets || []).find((x: any) => x.m === month && x.c === s.id) || null;
    const mine = enr.filter((e) => e.cslr === s.id);
    const ls = leads.filter((l) => l.cslr === s.id && dayKey(new Date(l.enq)).startsWith(month));
    return { counsellor: s.id, name: s.name, branch: s.branch, target: t && { enrolments: t.enr, revenue: t.rev, conversion: t.conv },
      achieved: { enrolments: mine.length, revenue: r2(mine.reduce((a, e) => a + e.total - e.tax, 0)), leads: ls.length, conversion: ls.length ? Math.round((mine.length / ls.length) * 100) : 0 } };
  });
  return c.json({ month, items: rows });
});

// ------------------------------------------------------------------ notifications & audit
api.get('/notifications', async (c) => {
  const u = c.get('user');
  const r = await c.env.DB.prepare(`SELECT data FROM docs WHERE type='notification' AND (branch IS NULL OR branch IN (${inList(u.scope)})) ORDER BY at DESC LIMIT 100`).bind(...u.scope).all<any>();
  const items = (r.results || []).map((x: any) => JSON.parse(x.data)).filter((n: any) => (!n.roles || n.roles.includes(u.role)) && (!n.cslr || u.role !== 'Counsellor' || n.cslr === u.id));
  return c.json({ items, unread: items.filter((n: any) => !n.read).length });
});
api.post('/notifications/read', async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  const repo = c.get('repo');
  const sc = c.get('user').scope;
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
    if (typeof id !== 'string') continue;
    const n = await repo.get<any>('notification', id);
    if (n && !n.read && (!n.branch || sc.includes(n.branch))) { n.read = true; await repo.put('notification', n); }
  }
  return c.json({ ok: true });
});
api.get('/audit', async (c) => {
  need(c, 'audit_logs', 'V');
  const where: string[] = []; const binds: unknown[] = [];
  if (c.req.query('ref')) { where.push('ref1=?'); binds.push(c.req.query('ref')); }
  return c.json(await list(c, 'audit', where, binds));
});
