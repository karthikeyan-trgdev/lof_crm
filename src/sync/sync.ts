// Guarded document sync used by the CRM screens.
//
// The screens keep their client-side workflow logic; every change is sent here as a batch of
// document upserts. The server is authoritative and applies a batch all-or-nothing:
//
//  • Input: only 'upsert'/'delete', ids must match a strict pattern and the document's own id,
//    documents are size-capped, server-owned fields (test flags, receipt numbers, statuses,
//    timestamps, attribution) are ignored or rebuilt.
//  • Merge: the client sends the version it edited (`base`); only the fields the user actually
//    changed are applied on top of the current server copy, so two people editing different parts
//    of a record never overwrite each other, and appended history lists are merged.
//  • Authorisation: role permissions (Roles & Permissions matrix), branch scope on BOTH the
//    current and the new version, approval rules tied to the exact approved change, fee integrity,
//    payment rules, consent, append-only audit.
//  • Server-built records: approvals, Moodle sync records, refunds, notifications and audit
//    entries are rebuilt from validated inputs; receipt numbers come from server sequences.
//  • Side effects become real integration jobs (WhatsApp, e-mail, Moodle, ERPNext, Calendar).
import { Repo, nowIso } from '../lib/db';
import { COLLECTIONS, SETTINGS_KEYS } from '../lib/indexing';
import { can, ALL_ROLES } from '../lib/auth';
import type { Env, Job, User } from '../types';
import { HttpError } from '../types';
import { calcFee, feeFor, r2, recalcEnrollment, money, dayKey, msgFrom } from '../domain/core';
import { hashPassword } from '../lib/crypto';
import { buildSched, daysBetween, refundCalc, termProblem, refundProblem, targetsProblem, lmsProblem } from '../domain/terms';
import { checkEmailTemplates } from '../domain/email-templates';
import { checkMailSettings } from '../domain/mail';

export interface Change { coll: string; id: string; op: 'upsert' | 'delete'; doc?: any; base?: any }
export interface SettingChange { key: string; doc: any }
interface Rejection { coll: string; id: string; reason: string }

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_DOC = 64 * 1024;
const MAX_SETTING = 200 * 1024;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const changedKeys = (a: any, b: any) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => !same(a?.[k], b?.[k]));
};
const subset = (keys: string[], allowed: string[]) => keys.every((k) => allowed.includes(k));
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const isPlainObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

const APPROVAL_RES: Record<string, string> = { 'Exceptional Discount': 'discount_requests', 'Branch Transfer': 'branch_transfers', 'Counsellor Reassignment': 'reassignment' };
const APPROVAL_WF: Record<string, (t: string) => boolean> = {
  'Exceptional Discount': (t) => t.startsWith('Exceptional'),
  'Branch Transfer': (t) => t.startsWith('Branch'),
  'Counsellor Reassignment': (t) => t.startsWith('Counsellor reassignment (Counsellor'),
};
const CONFIG_COLLS = ['branches', 'programs', 'fees', 'discounts', 'staff'];
const NOTIF_TYPES = ['sla', 'none', 'disc', 'moodle', 'new', 'fu', 'transfer', 'pay', 'enr', 'mail', 'assign', 'call', 'erp'];
const NOTIF_PAGES = ['refunds', 'reports', 'payCollect', 'lead', 'leads', 'tasks', 'approvals', 'approvalHistory', 'integration', 'payRecords', 'student', 'opps', 'enrollments', 'dashboard', 'notifications'];
/** New business records must carry a number the server already issued (claimed or block-allocated), never a future one. */
const ISSUED: Record<string, [string, RegExp]> = {
  leads: ['lead', /^LD-26-(\d+)$/], opps: ['opp', /^OP-26-(\d+)$/], enr: ['enr', /^EN-26-(\d+)$/], pay: ['pay', /^PY-26-(\d+)$/],
  students: ['student', /^LOF-26-(\d+)$/], approvals: ['ap', /^AP-26-(\d+)$/], refunds: ['rf', /^RF-26-(\d+)$/], ms: ['ms', /^MS-(\d+)$/],
  tasks: ['task', /^T-(\d+)$/], calls: ['call', /^CL-(\d+)$/], comms: ['cm', /^CM(\d+)$/], notifs: ['notif', /^N(\d+)$/], audit: ['audit', /^AU(\d+)$/],
};
const HISTORY_KEYS = ['events', 'assign', 'hist', 'comm', 'testimonials', 'docs', 'waEvents'];
const QUIET_KEYS = ['last', 'nextFU', 'events', 'assign', 'hist', 'comm'];
const WRITE_ORDER = ['branch', 'program', 'fee', 'discount', 'staff', 'lead', 'opp', 'approval', 'student', 'enrollment', 'payment', 'moodle_sync', 'refund', 'task', 'call', 'comm', 'notification', 'audit'];

export async function applySync(env: Env, repo: Repo, user: User, perms: any, changes: Change[], settings: SettingChange[] = []) {
  const P = (res: string, cap: string) => can(perms, user, res, cap);
  const inScope = (b: unknown) => typeof b === 'string' && user.scope.includes(b);
  const rejected: Rejection[] = [];
  const reject = (c: { coll: string; id: string }, reason: string) => rejected.push({ coll: c.coll, id: c.id, reason });
  const notices: string[] = [];
  const jobs: Job[] = [];
  const writes: { type: string; doc: any; coll: string }[] = [];
  const postPaymentsFor = new Set<string>();
  const receiptFor: any[] = [];
  const withdrawals: { enr: string; stu: string }[] = [];
  const cancelsFor = new Set<string>();
  const enrolsFor = new Set<string>();
  const leadBranchMoves: { id: string; branch: string }[] = [];
  const staffAuth: { id: string; email: string; temp?: string }[] = [];
  const usedApprovals = new Set<string>();
  const cslrMoves: { lead: string; cslr: string | null }[] = [];
  const now = nowIso();
  const today = dayKey(new Date());

  // ---------------------------------------------------------------- 1. input validation
  if (!Array.isArray(changes) || !Array.isArray(settings)) throw new HttpError(400, 'changes and settings must be arrays');
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c || !COLLECTIONS[c.coll]) throw new HttpError(400, `Unknown collection ${c?.coll}`);
    if (c.op !== 'upsert' && c.op !== 'delete') throw new HttpError(400, `Unknown operation ${String(c.op).slice(0, 20)}`);
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) throw new HttpError(400, `Invalid record id in ${c.coll}`);
    if (seen.has(c.coll + ':' + c.id)) throw new HttpError(400, `Duplicate change for ${c.coll}/${c.id}`);
    seen.add(c.coll + ':' + c.id);
    if (c.op === 'upsert') {
      if (!isPlainObject(c.doc) || c.doc.id !== c.id) throw new HttpError(400, `Document id mismatch for ${c.coll}/${c.id}`);
      if (JSON.stringify(c.doc).length > MAX_DOC) throw new HttpError(413, `Record ${c.id} is too large`);
      if (c.base !== undefined && (!isPlainObject(c.base) || c.base.id !== c.id)) throw new HttpError(400, `Invalid base version for ${c.coll}/${c.id}`);
    }
  }

  // ---------------------------------------------------------------- 2. load current versions
  const old = new Map<string, any>();
  const byType: Record<string, string[]> = {};
  for (const c of changes) (byType[COLLECTIONS[c.coll]] ||= []).push(c.id);
  for (const [type, ids] of Object.entries(byType)) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await env.DB.prepare(`SELECT id,data FROM docs WHERE type=? AND id IN (${chunk.map(() => '?').join(',')})`).bind(type, ...chunk).all<any>();
      for (const row of r.results || []) old.set(type + ':' + row.id, JSON.parse(row.data));
    }
  }
  const oldOf = (coll: string, id: string) => old.get(COLLECTIONS[coll] + ':' + id) || null;

  const seqNow = !repo.isTest && changes.some((c) => c.op === 'upsert' && ISSUED[c.coll] && !oldOf(c.coll, c.id)) ? await repo.peekAll() : {};
  for (const c of changes) {
    if (c.op !== 'upsert' || !ISSUED[c.coll] || oldOf(c.coll, c.id) || repo.isTest) continue;
    const [seqName, re] = ISSUED[c.coll];
    const m = c.id.match(re);
    if (!m || +m[1] >= (seqNow[seqName] ?? 1)) throw new HttpError(409, `Record number ${c.id} was not issued by the server – reload and try again`);
  }

  // ---------------------------------------------------------------- 3. field-level merge
  // keys = what THIS user changed (base → doc); merged = current server copy + those changes
  const eff = new Map<string, { d: any; o: any; keys: string[] }>();
  for (const c of changes) {
    if (c.op !== 'upsert') continue;
    const o = oldOf(c.coll, c.id);
    const doc = structuredClone(c.doc);
    delete doc.test; // test flags are server-only
    if (!o) { eff.set(c.coll + ':' + c.id, { d: doc, o: null, keys: Object.keys(doc) }); continue; }
    const base = c.base ?? o;
    const keys = changedKeys(base, doc).filter((k) => k !== 'test');
    const d = structuredClone(o);
    for (const k of keys) {
      const b = base[k], n = doc[k], cur = o[k];
      if (Array.isArray(b) && Array.isArray(n) && Array.isArray(cur) && n.length >= b.length && same(b, n.slice(0, b.length)) && same(b, cur.slice(0, b.length))) {
        // appended entries merge with a colleague's concurrent appends; the server stamps who and when
        const added = n.slice(b.length).map((x: any) => (isPlainObject(x) && HISTORY_KEYS.includes(k) && k !== 'comm' && k !== 'docs' ? { ...x, at: now, by: x.by === 'System' || x.by === 'Routing rules' ? x.by : user.name } : x));
        d[k] = cur.concat(added);
      } else if (HISTORY_KEYS.includes(k) && Array.isArray(cur) && !(Array.isArray(n) && n.length >= cur.length && same(cur, n.slice(0, cur.length)))) {
        throw new HttpError(409, `History on ${c.id} can only be added to, not changed – reload and try again`);
      } else {
        if (n === undefined) delete d[k]; else d[k] = n;
        if (!same(b, cur) && !QUIET_KEYS.includes(k)) notices.push(`${c.id}: "${k}" was also changed by a colleague – your value was saved`);
      }
    }
    eff.set(c.coll + ':' + c.id, { d, o, keys });
  }
  const effDoc = (coll: string, id: string) => eff.get(coll + ':' + id)?.d ?? null;
  const isNew = (coll: string, id: string) => eff.has(coll + ':' + id) && !eff.get(coll + ':' + id)!.o;
  const batchItems = (coll: string) => [...eff.entries()].filter(([k]) => k.startsWith(coll + ':')).map(([, v]) => v);
  // Related records are read as STORED: a client's unchecked edit to an existing record (e.g. enrolment.paid,
  // student.moodle) must never feed another record's rule. Only records new in this batch come from the batch,
  // and those are rule-checked first (see the WRITE_ORDER sort below).
  const getDoc = async (coll: string, type: string, id: string) =>
    (isNew(coll, id) ? effDoc(coll, id) : oldOf(coll, id)) ?? (id && typeof id === 'string' && ID_RE.test(id) ? await repo.get<any>(type, id) : null);
  /** An approval in this batch that this user is deciding as Approved and that matches `pred`. */
  const approvedNow = (pred: (a: any) => boolean) => batchItems('approvals').some((x) => x.o && x.o.status === 'Pending' && x.d.status === 'Approved' && pred(x.d));
  const decidedNow = (pred: (a: any) => boolean) => batchItems('approvals').some((x) => x.o && x.o.status === 'Pending' && x.d.status !== 'Pending' && pred(x.d));

  const cfg = await repo.setting<any>('cfg');
  const fees = await repo.many<any>('fee');
  const discounts = await repo.many<any>('discount');
  const branches = await repo.many<any>('branch');
  const staffList = await repo.many<any>('staff');
  const programs = await repo.many<any>('program');
  /** LMS call record: Track and Credit codes come from Settings → LMS Integration, never from the browser. */
  const lmsCallDoc = (id: string, op: 'enrol' | 'cancel', e: any) => {
    const code = cfg.lms?.programmes?.[e.prog] || {};
    const prog = programs.find((p) => p.id === e.prog);
    return { id, enr: e.id, stu: e.stu, op, status: 'Pending', mid: null, cid: code.track || '—', credits: op === 'enrol' ? (code.credits || []).slice() : [], course: `${prog?.name || e.prog} · ${e.pkg}`, mode: op, last: now, err: '', attempts: 0,
      hist: [{ at: now, s: 'Pending', msg: op === 'cancel' ? 'Cancel call queued after withdrawal' : 'Enrol call queued after enrolment' }], ...(e.test ? { test: true } : {}) };
  };
  const isCounsellor = (id: unknown) => staffList.some((s) => s.id === id && s.role === 'Counsellor' && s.status === 'Active');

  // ---------------------------------------------------------------- 4. per-record rules
  const ruleOrder = (c: Change) => { const i = WRITE_ORDER.indexOf(COLLECTIONS[c.coll]); return i < 0 ? 99 : i; };
  for (const c of [...changes].sort((a, b) => ruleOrder(a) - ruleOrder(b))) {
    const type = COLLECTIONS[c.coll];

    if (c.op === 'delete') {
      const o = oldOf(c.coll, c.id);
      if (!CONFIG_COLLS.includes(c.coll) || !P('configuration', 'D')) { reject(c, 'Records of this type cannot be deleted'); continue; }
      if (c.coll === 'staff' && c.id === user.id) { reject(c, 'You cannot delete your own user'); continue; }
      if (o) writes.push({ type, doc: { id: c.id, __delete: true }, coll: c.coll });
      continue;
    }
    const { d, o, keys } = eff.get(c.coll + ':' + c.id)!;
    if (o && !keys.length) continue; // nothing this user changed
    if (o?.test) d.test = true;

    switch (c.coll) {
      // ---------------------------------------------------------------- configuration masters
      case 'branches': case 'programs': case 'fees': case 'discounts': case 'staff': {
        if (!P('configuration', o ? 'E' : 'C')) { reject(c, `${user.role} cannot change configuration`); break; }
        if (c.coll === 'staff') {
          const email = String(d.email || '').trim().toLowerCase();
          if (!/^\S+@\S+\.\S+$/.test(email)) { reject(c, 'A valid staff e-mail is required'); break; }
          if (!ALL_ROLES.includes(d.role)) { reject(c, 'Unknown role'); break; }
          if (!branches.some((b) => b.id === d.branch)) { reject(c, 'Unknown branch'); break; }
          d.email = email;
          const clash = await env.DB.prepare('SELECT staff_id FROM staff_auth WHERE email=? AND staff_id<>?').bind(email, d.id).first();
          if (clash) { reject(c, `E-mail ${email} already belongs to another user`); break; }
          if (o && o.id === user.id && (d.role !== o.role || d.access === 'Disabled' || d.status === 'Inactive')) { reject(c, 'You cannot change your own role or disable your own access'); break; }
          if (!o) {
            const temp = 'Lof-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10) + '9';
            staffAuth.push({ id: d.id, email, temp });
            notices.push(`Login created for ${d.name}: ${email} / temporary password ${temp} (must be changed at first sign-in)`);
          } else if (String(o.email).toLowerCase() !== email) staffAuth.push({ id: d.id, email });
        }
        if (c.coll === 'branches' && !/^[A-Z0-9]{2,5}$/.test(d.id)) { reject(c, 'Branch short ID must be 2–5 capital letters or digits'); break; }
        if (c.coll === 'fees') {
          if (!(num(d.amt) > 0) || !(num(d.tax) >= 0) || !(num(d.extra?.amt) >= 0)) { reject(c, 'Fee, tax and registration must be valid numbers'); break; }
          if (o && (o.amt !== d.amt || o.tax !== d.tax || o.extra?.amt !== d.extra?.amt || o.prog !== d.prog || o.branch !== d.branch) && o.from <= today) {
            const used = await repo.count('enrollment', "json_extract(data,'$.feeId')=?", [o.id]);
            if (used) { reject(c, 'This fee is used by enrolments – create a new version instead of editing the amount'); break; }
          }
        }
        if (c.coll === 'discounts' && (!(num(d.value) > 0) || (d.type === '%' && d.value > 100) || !['%', 'flat'].includes(d.type))) { reject(c, 'Invalid discount value'); break; }
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- leads
      case 'leads': {
        if (!o) {
          if (!P('leads', 'C')) { reject(c, `${user.role} cannot create leads`); break; }
          if (!inScope(d.branch)) { reject(c, 'Lead is outside your branch access'); break; }
          const b = branches.find((x) => x.id === d.branch);
          if (!b || !b.programs.includes(d.prog)) { reject(c, `${d.prog} is not offered at ${b?.name || d.branch}`); break; }
          if (d.cslr && !isCounsellor(d.cslr)) { reject(c, 'Assigned counsellor is not an active counsellor'); break; }
          if (!str(d.student, 200).trim() || !str(d.parent, 200).trim() || !String(d.phone || '').replace(/\D/g, '').match(/^\d{7,15}$/)) { reject(c, 'Student, parent and a valid mobile number are required'); break; }
          d.status = 'Open';
          d.enq = d.enq && Math.abs(Date.parse(d.enq) - Date.now()) < 7 * 864e5 ? d.enq : now;
          writes.push({ type, doc: d, coll: c.coll });
          break;
        }
        const transfer = approvedNow((a) => a.type === 'Branch Transfer' && a.payload?.lead === d.id && a.payload?.from === o.branch && a.payload?.to === d.branch);
        const reassign = approvedNow((a) => a.type === 'Counsellor Reassignment' && a.payload?.lead === d.id && a.payload?.to === d.cslr);
        const decided = decidedNow((a) => a.payload?.lead === d.id);
        if (!inScope(o.branch)) { reject(c, 'Lead is outside your branch access'); break; }
        if (!inScope(d.branch) && !transfer) { reject(c, 'Lead is outside your branch access'); break; }
        if (keys.includes('id') || keys.includes('enq')) { reject(c, 'Lead ID and enquiry time cannot change'); break; }
        if (keys.includes('branch')) {
          if (!transfer) { reject(c, 'Branch can only change through an approved branch transfer'); break; }
          leadBranchMoves.push({ id: d.id, branch: d.branch });
        }
        if (keys.includes('cslr')) {
          if (!(P('reassignment', 'E') || transfer || reassign)) { reject(c, 'Reassignment needs approval for your role'); break; }
          if (d.cslr && !isCounsellor(d.cslr)) { reject(c, 'Assigned counsellor is not an active counsellor'); break; }
          cslrMoves.push({ lead: d.id, cslr: d.cslr || null });
        }
        if (!P('leads', 'E')) {
          const callNow = batchItems('calls').some((x) => !x.o && x.d.lead === d.id);
          const allowed = ['events', 'last', 'avail', 'nextFU', 'esc',
            ...(callNow ? ['fc', 'cat', 'noResp', 'origCat'] : []),
            ...(callNow && d.stage === 'Contacted' && o.stage === 'New Lead' ? ['stage'] : []),
            ...(transfer || reassign || P('reassignment', 'E') ? ['branch', 'cslr', 'assign'] : []),
            ...(decided ? [] : [])];
          if (!subset(keys, allowed)) { reject(c, `${user.role} cannot edit leads`); break; }
        }
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- opportunities
      case 'opps': {
        if (!o) {
          if (!(P('opportunities', 'C') || P('leads', 'E'))) { reject(c, `${user.role} cannot create opportunities`); break; }
          const lead = await getDoc('leads', 'lead', d.lead);
          if (!lead || !inScope(lead.branch)) { reject(c, 'Linked lead not found or outside your branch access'); break; }
          if (!feeFor(fees, lead.prog, lead.branch, d.pkg, today)) { reject(c, 'No active fee for this package'); break; }
          Object.assign(d, { branch: lead.branch, prog: lead.prog, cslr: lead.cslr, stage: 'Opportunity', discount: null, discReq: null, stu: null, decision: null, lost: '' });
          writes.push({ type, doc: d, coll: c.coll });
          break;
        }
        const transfer = approvedNow((a) => a.type === 'Branch Transfer' && a.payload?.lead === o.lead && a.payload?.to === d.branch);
        const reassign = approvedNow((a) => a.payload?.lead === o.lead);
        if (!inScope(o.branch)) { reject(c, 'Opportunity is outside your branch access'); break; }
        if (!inScope(d.branch) && !transfer) { reject(c, 'Opportunity is outside your branch access'); break; }
        if (keys.some((k) => ['id', 'lead', 'prog'].includes(k))) { reject(c, 'Lead and programme of an opportunity cannot change'); break; }
        if (keys.includes('branch') && !transfer) { reject(c, 'Branch can only change through an approved branch transfer'); break; }
        const enrolling = batchItems('enr').find((x) => !x.o && x.d.opp === d.id);
        const discDecision = decidedNow((a) => a.type === 'Exceptional Discount' && a.payload?.opp === d.id);
        const discRequest = batchItems('approvals').some((x) => !x.o && x.d.type === 'Exceptional Discount' && x.d.payload?.opp === d.id);
        let ok = P('opportunities', 'E');
        if (!ok && enrolling && subset(keys, ['stage', 'stu', 'next', 'decision', 'hist'])) ok = true;
        if (!ok && discDecision && subset(keys, ['discount', 'discReq', 'next', 'hist'])) ok = true;
        if (!ok && discRequest && subset(keys, ['discReq', 'hist'])) ok = true;
        if (!ok && (transfer || reassign) && subset(keys, ['branch', 'cslr'])) ok = true;
        if (!ok) { reject(c, `${user.role} cannot edit opportunities`); break; }
        if (keys.includes('stage') && d.stage === 'Enrolled' && (!enrolling || d.stu !== enrolling.d.stu)) { reject(c, 'An opportunity becomes Enrolled only through the enrolment form'); break; }
        if (keys.includes('stu') && (!enrolling || d.stu !== enrolling.d.stu)) { reject(c, 'Student link is set by the enrolment form'); break; }
        if (keys.includes('discount') && d.discount) {
          if (d.discount.kind === 'exceptional') {
            const ap = await getDoc('approvals', 'approval', d.discount.ref);
            if (!ap || (ap.status !== 'Approved' && !approvedNow((a) => a.id === ap.id)) || ap.payload?.opp !== d.id || +ap.payload.value !== +d.discount.value || ap.payload.type !== d.discount.type) { reject(c, 'Exceptional discount must match an approved request'); break; }
          } else if (d.discount.kind === 'predefined') {
            const pd = discounts.find((x) => x.id === d.discount.ref);
            if (!pd || !pd.active || +pd.value !== +d.discount.value || pd.type !== d.discount.type) { reject(c, 'Predefined discount not found or changed'); break; }
          } else { reject(c, 'Unknown discount kind'); break; }
        }
        if (keys.includes('discReq') && d.discReq) {
          const ap = await getDoc('approvals', 'approval', d.discReq);
          if (!ap || ap.payload?.opp !== d.id) { reject(c, 'Discount request does not belong to this opportunity'); break; }
        }
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- approvals (rebuilt on the server)
      case 'approvals': {
        if (!o) {
          const res = APPROVAL_RES[d.type];
          if (!res) { reject(c, 'Unknown approval type'); break; }
          if (!P(res, 'C')) { reject(c, `${user.role} cannot raise ${d.type} requests`); break; }
          const p = d.payload || {};
          let branch = '', summary = '', payload: any = {}, refKind = '', ref = '';
          if (d.type === 'Exceptional Discount') {
            const opp = await getDoc('opps', 'opp', p.opp);
            if (!opp || !inScope(opp.branch) || ['Enrolled', 'Lost'].includes(opp.stage)) { reject(c, 'Opportunity not found, closed or outside your branch access'); break; }
            const fee = feeFor(fees, opp.prog, opp.branch, opp.pkg, today);
            const v = num(p.value);
            if (!fee || !['%', 'flat'].includes(p.type) || !(v > 0) || (p.type === '%' && v > 100) || (p.type === 'flat' && v > fee.amt)) { reject(c, 'Invalid discount value'); break; }
            const disc = p.type === '%' ? r2((fee.amt * v) / 100) : v;
            payload = { opp: opp.id, type: p.type, value: v, orig: fee.amt, disc, final: r2(fee.amt - disc), cur: fee.cur };
            branch = opp.branch; refKind = 'opp'; ref = opp.id;
            summary = `${p.type === '%' ? v + '%' : money(v, fee.cur)} exceptional discount – ${opp.student}`;
          } else {
            const lead = await getDoc('leads', 'lead', p.lead);
            if (!lead || !inScope(lead.branch)) { reject(c, 'Lead not found or outside your branch access'); break; }
            branch = lead.branch; refKind = 'lead'; ref = lead.id;
            if (d.type === 'Branch Transfer') {
              const to = branches.find((b) => b.id === p.to && b.status === 'Operating');
              if (!to || to.id === lead.branch) { reject(c, 'Choose a different operating branch'); break; }
              payload = { lead: lead.id, from: lead.branch, to: to.id, reason: str(p.reason, 200) };
              summary = `Transfer ${lead.student}: ${(branches.find((b) => b.id === lead.branch) || {}).name} → ${to.name}`;
            } else {
              if (!isCounsellor(p.to) || p.to === lead.cslr) { reject(c, 'Choose a different active counsellor'); break; }
              payload = { lead: lead.id, from: lead.cslr || '', to: p.to };
              summary = `Reassign ${lead.student}`;
            }
          }
          const dup = await repo.count('approval', "status='Pending' AND ref1=? AND json_extract(data,'$.type')=?", [ref, d.type]);
          if (dup || batchItems('approvals').some((x) => x.d !== d && !x.o && x.d.type === d.type && x.d.payload?.[refKind] === ref)) { reject(c, 'A request of this type is already pending for this record'); break; }
          const wf = (cfg.wf || []).find((w: any) => APPROVAL_WF[d.type](w.t));
          const reason = str(d.reason, 500);
          const rebuilt = { id: d.id, type: d.type, by: user.id, at: now, status: 'Pending', refKind, ref, branch, summary, reason, payload, decision: null, approverRole: wf?.ap && wf.ap !== '—' ? wf.ap : d.type === 'Exceptional Discount' ? 'Management' : 'Admissions Head', hist: [{ at: now, by: user.id, action: 'Requested', remarks: reason }] };
          writes.push({ type, doc: rebuilt, coll: c.coll });
          eff.get(c.coll + ':' + c.id)!.d = rebuilt;
          break;
        }
        const res = APPROVAL_RES[o.type];
        if (o.status !== 'Pending') { reject(c, 'This request has already been decided'); break; }
        if (!subset(keys, ['status', 'decision', 'hist'])) { reject(c, 'Request details cannot be changed after submission'); break; }
        if (!['Approved', 'Rejected'].includes(d.status)) { reject(c, 'Invalid decision'); break; }
        if (!P(res, 'A')) { reject(c, `${user.role} cannot approve this request type`); break; }
        if (o.approverRole !== user.role) { reject(c, `Configured approver is ${o.approverRole}`); break; }
        if (!inScope(o.type === 'Branch Transfer' ? o.payload?.from : o.branch)) { reject(c, 'Outside your branch scope'); break; }
        if (o.by === user.id) { reject(c, 'Requester cannot approve their own request'); break; }
        const remarks = str(d.decision?.remarks, 500);
        const decidedDoc = { ...o, status: d.status, decision: { by: user.id, at: now, remarks }, hist: [...(o.hist || []), { at: now, by: user.id, action: d.status, remarks }] };
        writes.push({ type, doc: decidedDoc, coll: c.coll });
        eff.get(c.coll + ':' + c.id)!.d = decidedDoc;
        break;
      }

      // ---------------------------------------------------------------- tasks, calls, communications
      case 'tasks': case 'calls': case 'comms': {
        if (o && keys.includes('lead')) { reject(c, 'A record cannot be moved to another lead'); break; }
        const lead = await getDoc('leads', 'lead', d.lead);
        const leadOld = lead && oldOf('leads', lead.id);
        const moving = decidedNow((a) => a.payload?.lead === d.lead);
        if (!lead || (!inScope(lead.branch) && !moving) || (leadOld && !inScope(leadOld.branch))) { reject(c, 'Lead is outside your branch access'); break; }
        if (c.coll === 'calls') {
          if (o) { reject(c, 'Call logs cannot be edited'); break; }
          if (!P('leads', 'V')) { reject(c, 'No lead access'); break; }
          d.by = user.id;
          d.at = d.at && Math.abs(Date.parse(d.at) - Date.now()) < 864e5 ? d.at : now;
          delete d.sim;
          d.manual = true;
        } else if (c.coll === 'comms') {
          if (o) { reject(c, 'Sent messages cannot be edited'); break; }
          if (!(P('leads', 'E') || P('leads', 'C') || isNew('leads', d.lead))) { reject(c, `${user.role} cannot message leads`); break; }
          if (!['WhatsApp', 'Email'].includes(d.ch)) { reject(c, 'Unknown channel'); break; }
          d.text = str(d.text, 4096);
          d.at = now;
          const key = d.ch === 'WhatsApp' ? 'wa' : 'em';
          const tpl = (cfg.comms || []).find((t: any) => t.n === d.tpl && t.ch === d.ch);
          if (tpl) d.tplId = tpl.id;
          if (/^Blocked/.test(d.status)) d.status = 'Blocked – no consent';
          else if (cfg.consentReq?.[key] && !lead[key]) d.status = 'Blocked – no consent';
          else { d.status = 'Queued'; jobs.push({ kind: 'send_comm', id: d.id }); }
          d.by = d.by === 'System' && isNew('leads', d.lead) ? 'System' : user.name;
          delete d.waMsgId; delete d.mailId;
        } else {
          if (!(P('leads', 'E') || P('leads', 'C') || P('reassignment', 'E'))) {
            const onlyDone = o && subset(keys, ['status', 'outcome', 'remarks']) && batchItems('calls').some((x) => !x.o && x.d.lead === d.lead);
            if (!onlyDone) { reject(c, `${user.role} cannot manage follow-ups`); break; }
          }
          if (d.cslr && !isCounsellor(d.cslr)) d.cslr = lead.cslr;
          if (!o && cfg.integ?.cal?.on && d.status === 'Pending' && d.type !== 'First call') jobs.push({ kind: 'calendar_event', taskId: d.id });
        }
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- students
      case 'students': {
        const enrolNow = batchItems('enr').find((x) => !x.o && x.d.stu === d.id);
        if (!o) {
          if (!P('enrollments', 'C')) { reject(c, `${user.role} cannot register students`); break; }
          if (!enrolNow) { reject(c, 'A new student is registered together with the first enrolment'); break; }
          if (!inScope(d.branch)) { reject(c, 'Student is outside your branch access'); break; }
          if (!Array.isArray(d.parents) || !d.parents.length || !/^\S+@\S+\.\S+$/.test(String(d.parents[0].email || ''))) { reject(c, 'A parent with a valid e-mail is required'); break; }
          d.moodle = null;
          d.reg = today;
          if (d.email && !/^\S+@\S+\.\S+$/.test(String(d.email))) { reject(c, 'Student e-mail is not valid'); break; }
          if (d.mobile && !/^\+?[\d\s()-]{7,20}$/.test(String(d.mobile))) { reject(c, 'Student mobile is not valid'); break; }
          d.email = str(d.email, 160); d.mobile = str(d.mobile, 20);
        } else {
          const visible = inScope(o.branch) || (await repo.count('enrollment', `ref1=? AND branch IN (${user.scope.map(() => '?').join(',') || "''"})`, [o.id, ...user.scope])) > 0;
          if (!visible) { reject(c, 'Student is outside your branch access'); break; }
          if (keys.some((k) => ['id', 'reg', 'branch', 'fam'].includes(k))) { reject(c, 'Student ID, branch, family and registration date are permanent'); break; }
          d.moodle = o.moodle; // owned by the Moodle sync
          if (!P('students', 'E') && !(P('enrollments', 'C') && subset(keys, ['status', 'comm', 'moodle']))) { reject(c, `${user.role} cannot edit student profiles`); break; }
        }
        // Messages: only the server-built welcome e-mail is sent, to the parent address on record
        const prevLen = o?.comm?.length || 0;
        const t4 = (cfg.comms || []).find((t: any) => t.id === 'T4');
        const toAddr = String((o || d).parents?.[0]?.email || '');
        (d.comm || []).forEach((m: any, i: number) => {
          if (i < prevLen) { d.comm[i] = o.comm[i]; return; }
          const welcome = enrolNow && m.tpl === 'Enrolment welcome' && t4?.auto;
          if (welcome) {
            const prog = programs.find((p) => p.id === enrolNow.d.prog);
            const branch = branches.find((b) => b.id === enrolNow.d.branch);
            d.comm[i] = { at: now, ch: 'Email', tpl: 'Enrolment welcome', to: toAddr, status: 'Queued', text: msgFrom(t4.body, { parent: d.parents?.[0]?.name || '', student: `${d.first} ${d.last}` }, { progName: prog?.name || '', branchName: branch?.name || '', counsellor: '', sid: d.id }) };
            jobs.push({ kind: 'send_student_mail', studentId: d.id, index: i });
          } else {
            d.comm[i] = { at: now, ch: str(m.ch, 20), tpl: str(m.tpl, 80), text: str(m.text, 2000), status: 'Recorded (not sent)' };
          }
        });
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- enrolments
      case 'enr': {
        if (!o) {
          if (!P('enrollments', 'C')) { reject(c, `${user.role} cannot create enrolments`); break; }
          if (!inScope(d.branch)) { reject(c, 'Enrolment is outside your branch access'); break; }
          const stu = await getDoc('students', 'student', d.stu);
          const stuOk = stu && (isNew('students', d.stu) || inScope(stu.branch) || (await repo.count('enrollment', `ref1=? AND branch IN (${user.scope.map(() => '?').join(',')})`, [stu.id, ...user.scope])) > 0);
          if (!stuOk) { reject(c, 'Student not found or outside your branch access'); break; }
          if (d.opp) {
            const opp = await getDoc('opps', 'opp', d.opp);
            if (!opp || !inScope(opp.branch) || ['Enrolled', 'Lost'].includes(oldOf('opps', d.opp)?.stage ?? opp.stage)) { reject(c, 'Linked opportunity not found, closed or outside your branch access'); break; }
          }
          if (!d.date || d.date > today || d.date < dayKey(new Date(Date.now() - 7 * 864e5))) d.date = today;
          const fee = feeFor(fees, d.prog, d.branch, d.pkg, d.date);
          if (!fee) { reject(c, 'No active fee record for this programme, branch and package'); break; }
          const program = programs.find((p) => p.id === d.prog);
          if (!program || !program.active || !(branches.find((b) => b.id === d.branch)?.programs || []).includes(d.prog)) { reject(c, 'Programme is not offered at this branch'); break; }
          const course = (program.courses || []).find((x: any) => +x.moodleId === +d.course?.moodleId) || program.courses?.[0];
          let disc: any = d.discInfo || null;
          if (disc) {
            if (disc.kind === 'exceptional') {
              const ap = await repo.get<any>('approval', disc.ref);
              const opp = d.opp ? await getDoc('opps', 'opp', d.opp) : null;
              if (!ap || ap.status !== 'Approved' || ap.type !== 'Exceptional Discount' || ap.payload?.opp !== d.opp || +ap.payload.value !== +disc.value || ap.payload.type !== disc.type || ap.usedBy || usedApprovals.has(ap.id)
                || !opp || opp.prog !== d.prog || opp.pkg !== d.pkg || +ap.payload.orig !== +fee.amt) { reject(c, 'Exceptional discount is not approved for this opportunity, programme and fee, or was already used'); break; }
              usedApprovals.add(ap.id);
              disc = { kind: 'exceptional', ref: ap.id, name: 'Exceptional discount', type: ap.payload.type, value: ap.payload.value };
              writes.push({ type: 'approval', doc: { ...ap, usedBy: d.id }, coll: 'approvals' });
            } else if (disc.kind === 'predefined') {
              const pd = discounts.find((x) => x.id === disc.ref && x.active);
              const country = branches.find((b) => b.id === d.branch)?.country;
              if (!pd || (pd.branches !== 'All' && !((pd.branches === 'UAE') === (country === 'UAE')))) { reject(c, 'Predefined discount is not active for this branch'); break; }
              disc = { kind: 'predefined', ref: pd.id, name: pd.name, type: pd.type, value: pd.value };
            } else { reject(c, 'Unknown discount kind'); break; }
          }
          const newStu = isNew('students', d.stu);
          const calc = calcFee(fee, disc, newStu);
          if (Math.abs(calc.total - num(d.total)) > 0.01) { reject(c, `Fee mismatch: server total ${money(calc.total, fee.cur)} vs ${money(d.total, d.cur)}`); break; }
          const terms = Array.isArray(cfg.payTerms) ? cfg.payTerms : [];
          const term = terms.find((t: any) => t.id === d.term && t.active) || (d.term ? null : terms.find((t: any) => t.id === cfg.payTermDefault) || null);
          if (d.term && !term) { reject(c, 'Payment term is not active'); break; }
          const linkedOpp = d.opp ? await getDoc('opps', 'opp', d.opp) : null;
          Object.assign(d, { cur: fee.cur, fee: calc.base, reg: calc.extra, disc: calc.disc, discInfo: disc, tax: calc.tax, total: calc.total, taxPct: fee.tax, paid: 0, payStatus: 'Unpaid', feeId: fee.id, pkg: fee.pkg, sessions: fee.sessions, credits: program.credits, course, newStu, status: 'Active',
            term: term?.id || null, sched: buildSched(term, calc.total, d.date), cslr: linkedOpp?.cslr || null });
          writes.push({ type, doc: d, coll: c.coll });
          break;
        }
        if (!inScope(o.branch)) { reject(c, 'Enrolment is outside your branch access'); break; }
        const frozen = ['id', 'stu', 'prog', 'branch', 'pkg', 'date', 'cur', 'fee', 'reg', 'disc', 'tax', 'total', 'taxPct', 'discInfo', 'newStu', 'feeId', 'course', 'sessions', 'credits', 'opp', 'ms', 'term', 'sched', 'cslr'];
        if (keys.some((k) => frozen.includes(k))) { reject(c, 'Fee and programme details of an enrolment cannot be edited'); break; }
        d.paid = o.paid; d.payStatus = o.payStatus; // owned by payments
        const userKeys = keys.filter((k) => !['paid', 'payStatus'].includes(k));
        if (!userKeys.length) break;
        if (!P('enrollments', 'E')) { reject(c, `${user.role} cannot edit enrolments`); break; }
        if (userKeys.includes('status') && !['Active', 'On Hold', 'Withdrawn', 'Completed'].includes(d.status)) { reject(c, 'Invalid enrolment status'); break; }
        if (userKeys.includes('status') && o.status === 'Withdrawn' && d.status !== 'Withdrawn') { reject(c, 'A withdrawn enrolment cannot be reactivated – create a new enrolment'); break; }
        if (d.status === 'Withdrawn' && o.status !== 'Withdrawn') withdrawals.push({ enr: d.id, stu: o.stu });
        writes.push({ type, doc: d, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- payments
      case 'pay': {
        if (o) { reject(c, 'Payments cannot be edited – record a refund instead'); break; }
        const e = await getDoc('enr', 'enrollment', d.enr);
        const atEnrolment = P('enrollments', 'C') && isNew('enr', d.enr);
        if (!P('payments', 'C') && !atEnrolment) { reject(c, `${user.role} cannot record payments`); break; }
        if (!e || !inScope(e.branch) || e.status === 'Withdrawn') { reject(c, 'Enrolment not found, withdrawn or outside your branch access'); break; }
        const amt = r2(num(d.amt));
        const dbPaid = isNew('enr', d.enr) ? 0 : (await repo.many<any>('payment', 'ref1=?', [d.enr])).reduce((a, p) => a + p.amt, 0);
        const batchPaid = receiptFor.filter((p) => p.enr === d.enr).reduce((a, p) => a + p.amt, 0);
        const outstanding = r2((isNew('enr', d.enr) ? effDoc('enr', d.enr)?.total : e.total) - dbPaid - batchPaid);
        if (!(amt > 0) || amt > outstanding + 0.005) { reject(c, `Amount must be between 0 and the outstanding ${money(outstanding, e.cur)}`); break; }
        if (!(cfg.pm || []).includes(d.method)) { reject(c, 'Unknown payment method'); break; }
        const ref = str(d.ref, 100).trim();
        if (d.method !== 'Cash' && (!ref || ref === '—')) { reject(c, `Reference is required for ${d.method}`); break; }
        const at = d.at && Date.parse(d.at) <= Date.now() + 60e3 && Date.parse(d.at) >= Date.now() - 30 * 864e5 ? new Date(d.at).toISOString() : now;
        const p = { id: d.id, enr: e.id, stu: e.stu, amt, cur: e.cur, method: d.method, ref: d.method === 'Cash' ? '—' : ref, at, rc: null as string | null, status: 'Recorded', by: user.id, branch: e.branch, ...(e.test ? { test: true } : {}) };
        receiptFor.push(p);
        postPaymentsFor.add(e.id);
        jobs.push({ kind: 'erp_payment', id: d.id });
        writes.push({ type, doc: p, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- refunds
      case 'refunds': {
        if (!o) {
          if (!(P('enrollments', 'E') || P('payments', 'C'))) { reject(c, `${user.role} cannot request refunds`); break; }
          const e = await getDoc('enr', 'enrollment', d.enr);
          if (!e || !inScope(e.branch)) { reject(c, 'Enrolment outside your branch access'); break; }
          const amt = r2(num(d.amt));
          const already = (await repo.many<any>('refund', 'ref1=?', [e.id])).reduce((a, r) => a + (r.status === 'Rejected' ? 0 : r.amt), 0)
            + batchItems('refunds').filter((x) => !x.o && x.d !== d && x.d.enr === e.id && writes.some((w) => w.doc.id === x.d.id)).reduce((a, x) => a + num(x.d.amt), 0);
          if (!(amt > 0) || amt > e.paid - already + 0.005) { reject(c, `Refund must be more than zero and no more than the refundable ${money(Math.max(0, e.paid - already), e.cur)}`); break; }
          const sessions = Number.isInteger(d.sessions) && d.sessions >= 0 && d.sessions <= 1000 ? d.sessions : NaN;
          if (Number.isNaN(sessions)) { reject(c, 'Enter the number of sessions attended'); break; }
          const R = cfg.refund || { rules: [], regFee: 'retain', tax: 'refund', adminFee: {}, approver: 'Management' };
          const days = daysBetween(e.date, today);
          const calc = refundCalc(e, days, sessions, R);
          // The suggestion covers the whole enrolment: earlier refund requests use it up, so splitting a refund cannot avoid approval
          const suggested = r2(Math.max(0, calc.suggested - already));
          const exception = amt > suggested + 0.005;
          writes.push({ type, doc: { id: d.id, enr: e.id, amt, reason: str(d.reason, 500), status: 'Requested', at: now, by: user.name, byId: user.id, sessions, days, suggested, rule: calc.rule ? `${calc.rule.label} (${calc.pct}%)` : 'No rule (0%)', exception, approverRole: R.approver || 'Management', note: exception ? `Above the suggested refund – needs ${R.approver || 'Management'} approval` : '' }, coll: c.coll });
          if (exception) notices.push(`${d.id}: refund is above the suggested ${money(suggested, e.cur)} and needs ${R.approver || 'Management'} approval`);
          break;
        }
        const e = await repo.get<any>('enrollment', o.enr);
        if (!e || !inScope(e.branch)) { reject(c, 'Enrolment outside your branch access'); break; }
        if (!subset(keys, ['status', 'processedBy', 'processedAt', 'rejectedBy', 'rejectedAt']) || o.status !== 'Requested' || !['Processed', 'Rejected'].includes(d.status)) { reject(c, 'Only a requested refund can be marked processed or rejected'); break; }
        if (o.exception) {
          if (user.role !== o.approverRole) { reject(c, `Only ${o.approverRole} can decide this refund exception`); break; }
          if (o.byId === user.id || (!o.byId && o.by === user.name)) { reject(c, 'You cannot approve a refund you requested'); break; }
        } else if (!P('payments', 'E')) { reject(c, `${user.role} cannot process refunds`); break; }
        writes.push({ type, doc: d.status === 'Rejected' ? { ...o, status: 'Rejected', rejectedAt: now, rejectedBy: user.name } : { ...o, status: 'Processed', processedAt: now, processedBy: user.name, ...(o.exception ? { approvedBy: user.name } : {}) }, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- LMS call records (built on the server; stored as moodle_sync)
      case 'ms': {
        if (!o) {
          const op = d.op === 'cancel' ? 'cancel' : 'enrol';
          const e = op === 'enrol' ? effDoc('enr', d.enr) : batchItems('enr').find((x) => x.o && x.d.id === d.enr)?.d;
          if (op === 'enrol') {
            if (!P('enrollments', 'C')) { reject(c, `${user.role} cannot create enrolments`); break; }
            if (!e || !isNew('enr', d.enr) || enrolsFor.has(d.enr)) { reject(c, 'One LMS enrol call is created together with its enrolment'); break; }
            enrolsFor.add(d.enr);
          } else {
            if (!e || !withdrawals.some((w) => w.enr === d.enr) || cancelsFor.has(d.enr)) { reject(c, 'An LMS cancel call is created together with the withdrawal'); break; }
            cancelsFor.add(d.enr);
          }
          writes.push({ type, doc: lmsCallDoc(d.id, op, e), coll: c.coll });
          jobs.push({ kind: 'moodle_sync', id: d.id });
          break;
        }
        const e = await repo.get<any>('enrollment', o.enr);
        if (!e || !inScope(e.branch)) { reject(c, 'Enrolment outside your branch access'); break; }
        if (d.status !== 'Pending' || ['Processing', 'Pending', 'Success', 'Closed'].includes(o.status)) { reject(c, 'LMS call status is managed by the server – only a failed call can be retried'); break; }
        if (!(P('configuration', 'V') || ['Admissions Head', 'Centre Administrator', 'Management'].includes(user.role))) { reject(c, `${user.role} cannot retry syncs`); break; }
        jobs.push({ kind: 'moodle_sync', id: d.id });
        writes.push({ type, doc: { ...o, status: 'Pending', hist: [...(o.hist || []), { at: now, s: 'Pending', msg: `Retry requested by ${user.name}` }] }, coll: c.coll });
        break;
      }

      // ---------------------------------------------------------------- notifications & audit
      case 'notifs': {
        if (o) {
          if (!subset(keys, ['read']) || (o.branch && !inScope(o.branch))) { reject(c, 'Notifications are read-only'); break; }
          writes.push({ type, doc: { ...o, read: !!d.read }, coll: c.coll });
          break;
        }
        if (!inScope(d.branch)) { reject(c, 'Notifications must name a branch you can access'); break; }
        const roles = Array.isArray(d.roles) ? d.roles.filter((r: string) => ALL_ROLES.includes(r as any)) : undefined;
        const route = isPlainObject(d.route) && NOTIF_PAGES.includes(d.route.page) ? { page: d.route.page, ...(typeof d.route.id === 'string' && ID_RE.test(d.route.id) ? { id: d.route.id } : {}), ...(typeof d.route.preset === 'string' ? { preset: str(d.route.preset, 30) } : {}) } : { page: 'dashboard' };
        writes.push({ type, doc: { id: d.id, type: NOTIF_TYPES.includes(d.type) ? d.type : 'new', sev: ['info', 'ok', 'warn', 'crit'].includes(d.sev) ? d.sev : 'info', text: str(d.text, 300), at: now, read: false, route, roles, branch: d.branch || undefined, cslr: typeof d.cslr === 'string' && ID_RE.test(d.cslr) ? d.cslr : undefined, by: user.id }, coll: c.coll });
        break;
      }
      case 'audit': {
        if (o) { reject(c, 'Audit log is append-only'); break; }
        writes.push({ type, doc: { id: d.id, at: now, by: user.name, act: str(d.act, 120), ref: str(d.ref, 64), det: str(d.det, 1000) }, coll: c.coll });
        break;
      }
    }
  }

  // Every withdrawal tells the LMS to withdraw unused credits, even when the client did not send the cancel call
  if (!rejected.length) {
    for (const w of withdrawals) {
      if (cancelsFor.has(w.enr)) continue;
      const e = batchItems('enr').find((x) => x.d.id === w.enr)!.d;
      const id = await repo.newId('ms');
      writes.push({ type: 'moodle_sync', doc: lmsCallDoc(id, 'cancel', e), coll: 'ms' });
      jobs.push({ kind: 'moodle_sync', id });
    }
  }

  // ---------------------------------------------------------------- 5. settings documents
  const settingWrites: SettingChange[] = [];
  for (const s of settings) {
    if (!s || !SETTINGS_KEYS.includes(s.key)) throw new HttpError(400, `Unknown setting ${s?.key}`);
    if (!isPlainObject(s.doc) || JSON.stringify(s.doc).length > MAX_SETTING) throw new HttpError(413, `Setting ${s.key} is invalid or too large`);
    const cur = await repo.setting(s.key);
    if (same(cur, s.doc)) continue;
    if (!P('configuration', 'E')) { rejected.push({ coll: 'settings', id: s.key, reason: `${user.role} cannot change configuration` }); continue; }
    const doc = structuredClone(s.doc);
    if (s.key === 'perms') {
      const bad = Object.entries(doc).some(([, roles]) => !isPlainObject(roles) || Object.entries(roles as any).some(([r, v]) => !ALL_ROLES.includes(r as any) || typeof v !== 'string' || !/^[VCEAD]*$/.test(v)));
      if (bad) { rejected.push({ coll: 'settings', id: 'perms', reason: 'Invalid permission matrix' }); continue; }
      if (!String(doc.configuration?.['System Administrator'] || '').includes('V') || !String(doc.configuration?.['System Administrator'] || '').includes('E')) {
        rejected.push({ coll: 'settings', id: 'perms', reason: 'System Administrator must keep configuration view and edit access' }); continue;
      }
    }
    if (s.key === 'cfg') {
      if (doc.integ?.moodle) doc.integ.moodle.token = '';
      for (const k of ['token', 'url', 'secret']) if (doc.integ?.lms) delete doc.integ.lms[k]; // LMS credentials live in server secrets only
      const counsellors = new Set(staffList.filter((x) => x.role === 'Counsellor').map((x) => x.id as string));
      const terms = doc.payTerms;
      const problem = (terms !== undefined && (!Array.isArray(terms) || terms.length > 30 ? 'Payment terms are invalid' : terms.map(termProblem).find(Boolean)
          || (new Set(terms.map((t: any) => t.id)).size !== terms.length ? 'Two payment terms share an id' : '')
          || (!terms.some((t: any) => t.id === doc.payTermDefault && t.active) ? 'The default payment term must exist and be active' : '')))
        || (doc.refund !== undefined && refundProblem(doc.refund))
        || (doc.refund && !ALL_ROLES.includes(doc.refund.approver) ? 'Refund approver must be a role' : '')
        || (doc.targets !== undefined && targetsProblem(doc.targets, counsellors))
        || (doc.lms !== undefined && lmsProblem(doc.lms));
      if (problem) { rejected.push({ coll: 'settings', id: 'cfg', reason: problem }); continue; }
      if (doc.emailTpls !== undefined) {
        const r = checkEmailTemplates(doc.emailTpls, branches.map((b) => b.id));
        if ('problem' in r) { rejected.push({ coll: 'settings', id: 'cfg', reason: r.problem }); continue; }
        doc.emailTpls = r.tpls;
      }
      const mail = checkMailSettings(doc.mailOut, doc.mailIn, branches);
      if ('problem' in mail) { rejected.push({ coll: 'settings', id: 'cfg', reason: mail.problem }); continue; }
      Object.assign(doc, mail);
    }
    settingWrites.push({ key: s.key, doc });
  }

  if (rejected.length) return { ok: false as const, rejected };

  if (repo.isTest) for (const w of writes) if (!w.doc.__delete) w.doc.test = true; // Testing console records
  for (const p of receiptFor) p.rc = p.test ? `RC-TEST-${p.id}` : `RC-${p.branch}-26-${String(await repo.next('rc_' + p.branch)).padStart(4, '0')}`;

  // ---------------------------------------------------------------- 6. apply atomically (one D1 batch)
  const extraDocs: { coll: string; doc: any }[] = [];
  const puts = writes.filter((w) => !w.doc.__delete).sort((a, b) => WRITE_ORDER.indexOf(a.type) - WRITE_ORDER.indexOf(b.type));
  try {
    await repo.putMany(puts.map((w) => ({ type: w.type, doc: w.doc })));
  } catch (e: any) {
    if (/overpayment/.test(String(e?.message))) return { ok: false as const, rejected: [{ coll: 'pay', id: '', reason: 'Payment exceeds the outstanding balance (another payment was just recorded)' }] };
    if (/immutable/.test(String(e?.message))) return { ok: false as const, rejected: [{ coll: '', id: '', reason: 'Payments and audit entries cannot be changed' }] };
    throw e;
  }
  for (const w of writes.filter((x) => x.doc.__delete)) await repo.del(w.type, w.doc.id);
  for (const s of settingWrites) await repo.putSetting(s.key, s.doc);
  for (const mv of cslrMoves) {
    const inBatchIds = new Set(puts.map((w) => w.doc.id));
    const followUps = [...(await repo.many<any>('task', 'ref1=? AND status=?', [mv.lead, 'Pending'])), ...(await repo.many<any>('opp', 'ref1=?', [mv.lead])).filter((o) => !['Enrolled', 'Lost'].includes(o.stage))];
    for (const x of followUps) {
      if (inBatchIds.has(x.id) || x.cslr === mv.cslr) continue;
      x.cslr = mv.cslr;
      await repo.put(x.stage ? 'opp' : 'task', x);
      extraDocs.push({ coll: x.stage ? 'opps' : 'tasks', doc: x });
    }
  }
  for (const mv of leadBranchMoves) await env.DB.prepare("UPDATE docs SET branch=? WHERE type IN ('task','call','comm') AND ref1=?").bind(mv.branch, mv.id).run();
  for (const a of staffAuth) {
    if (a.temp) await env.DB.prepare('INSERT INTO staff_auth (staff_id,email,password_hash,must_change) VALUES (?,?,?,1) ON CONFLICT(staff_id) DO UPDATE SET email=excluded.email').bind(a.id, a.email, await hashPassword(a.temp)).run();
    else await env.DB.prepare('UPDATE staff_auth SET email=? WHERE staff_id=?').bind(a.email, a.id).run();
  }
  const extra: { coll: string; doc: any }[] = extraDocs;
  for (const enrId of postPaymentsFor) {
    const e = await recalcEnrollment(repo, enrId);
    if (e) extra.push({ coll: 'enr', doc: e });
  }

  const docs = [...puts.map((w) => ({ coll: w.coll, doc: w.doc })), ...extra];
  return { ok: true as const, docs, notices: notices.slice(0, 5), jobs, settings: settingWrites.map((s) => s.key) };
}
