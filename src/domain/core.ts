// Server-side business rules, ported 1:1 from the approved prototype so the API, webhooks and the
// screens behave the same way.
import { Repo, nowIso } from '../lib/db';
import { normPhone } from '../lib/indexing';

export const TZ = 'Asia/Dubai';
export const dayKey = (iso: string | Date) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const money = (a: number, c: string) => (c === 'INR' ? '₹ ' : (c || 'AED') + ' ') + Number(a || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDT = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------------- fees ----------------
export function feeFor(fees: any[], prog: string, branch: string, pkg?: string, today = dayKey(new Date())) {
  return fees.find((f) => f.active && f.prog === prog && f.branch === branch && (!pkg || f.pkg === pkg) && f.from <= today && (!f.to || f.to >= today));
}
export function calcFee(fee: any, disc: any, isNew: boolean) {
  const base = fee.amt, extra = isNew ? fee.extra.amt : 0;
  let d = 0;
  if (disc) d = disc.type === '%' ? r2((base * disc.value) / 100) : Math.min(Number(disc.value), base);
  const net = base - d + extra, tax = r2((net * fee.tax) / 100);
  return { base, extra, disc: d, net, tax, total: r2(net + tax) };
}

// ---------------- audit & notifications ----------------
export async function addAudit(repo: Repo, act: string, ref: string, det: string, by?: string) {
  const id = await repo.newId('audit');
  await repo.create('audit', { id, at: nowIso(), by: by || repo.actor, act, ref, det });
}
export async function notify(repo: Repo, n: { type: string; sev: string; text: string; route: any; roles?: string[]; branch?: string | null; cslr?: string | null }) {
  const id = await repo.newId('notif');
  const doc = { id, type: n.type, sev: n.sev, text: n.text, at: nowIso(), read: false, route: n.route, roles: n.roles, branch: n.branch ?? undefined, cslr: n.cslr ?? undefined };
  await repo.create('notification', doc);
  return doc;
}
export const addEv = (l: any, type: string, text: string, by = 'System') => {
  l.events = l.events || [];
  l.events.push({ at: nowIso(), type, text, by });
  l.last = nowIso();
};

// ---------------- routing ----------------
export async function counsellorLoad(repo: Repo, cfg: any, cid: string) {
  // Test records (Testing Console) never count toward a real counsellor's workload
  const ls = await repo.many<any>('lead', 'owner=? AND status=? AND is_test=0', [cid, 'Open']);
  const o: any = { open: ls.length, Hot: 0, Warm: 0, Cold: 0, other: 0, w: 0 };
  for (const l of ls) {
    if (o[l.cat] != null) o[l.cat]++; else o.other++;
    o.w += weight(cfg, l.cat);
  }
  return o;
}
export const weight = (cfg: any, cat: string) => {
  const w = cfg.routing?.weights?.[cat];
  return w == null ? 1 : w;
};

export async function eligibility(repo: Repo, cfg: any, branch: string, prog: string, cat: string) {
  const R = cfg.routing;
  const staff = (await repo.many<any>('staff', 'owner=?', ['Counsellor'])).filter((s) => s.status === 'Active');
  const rows: { s: any; L: any; why: string }[] = [];
  for (const s of staff) {
    const L = await counsellorLoad(repo, cfg, s.id);
    const w = weight(cfg, cat);
    let why = '';
    if (R.branchElig && s.branch !== branch) why = 'Different branch';
    else if (R.programRouting && !s.programs.includes(prog)) why = 'Programme not handled';
    else if (s.avail !== 'Available' && String(R.absence).startsWith('Skip')) why = 'On leave / unavailable';
    else if (L.w + w > s.max) why = `Workload limit (${L.w} + ${w} > ${s.max})`;
    rows.push({ s, L, why });
  }
  return rows;
}

export async function routeLead(repo: Repo, cfg: any, branch: string, prog: string, cat: string) {
  const rows = await eligibility(repo, cfg, branch, prog, cat);
  const ok = rows.filter((r) => !r.why).sort((a, b) => (a.s.id < b.s.id ? -1 : 1));
  let pick: any = null;
  if (ok.length) {
    if (cfg.routing.method === 'Round-robin') {
      const rr = await repo.setting<Record<string, string>>('rr_last');
      const last = rr[branch] || '';
      pick = ok.find((r) => r.s.id > last) || ok[0];
      rr[branch] = pick.s.id;
      await repo.putSetting('rr_last', rr);
    } else {
      pick = ok.slice().sort((a, b) => a.L.w / a.s.max - b.L.w / b.s.max || a.L.w - b.L.w)[0];
    }
  }
  return { pick: pick ? pick.s : null, rows };
}

// ---------------- duplicates ----------------
export async function findDup(repo: Repo, phone: string, email: string) {
  const ph = normPhone(phone), em = String(email || '').trim().toLowerCase();
  const out: any[] = [];
  const leads = await repo.many<any>('lead', '(ref1=? OR (ref2=? AND ref2 IS NOT NULL AND ref2<>\'\'))', [ph || '#', em || '#']);
  for (const l of leads) out.push({ kind: 'Lead', id: l.id, name: `${l.student} / ${l.parent}`, branch: l.branch, status: l.status });
  if (ph || em) {
    const like = await repo.many<any>('student', '(data LIKE ? OR data LIKE ?)', [ph ? `%${ph}%` : '#', em ? `%${em}%` : '#']);
    for (const s of like) {
      const hit = (s.parents || []).find((p: any) => (ph && normPhone(p.mobile) === ph) || (em && String(p.email).toLowerCase() === em));
      if (hit) out.push({ kind: 'Student', id: s.id, name: `${s.first} ${s.last} / ${hit.name}`, branch: s.branch, status: s.status });
    }
  }
  return out;
}

// ---------------- messaging templates ----------------
export function msgFrom(t: string, l: any, ctx: { progName: string; branchName: string; counsellor: string; sid?: string }) {
  return String(t)
    .replace(/\{parent_name\}/g, l.parent)
    .replace(/\{student_name\}/g, l.student)
    .replace(/\{programme\}/g, ctx.progName)
    .replace(/\{branch\}/g, ctx.branchName)
    .replace(/\{counsellor\}/g, ctx.counsellor)
    .replace(/\{student_id\}/g, ctx.sid || '');
}
/** Ordered placeholder values – used as WhatsApp template body parameters. */
export function templateParams(t: string, l: any, ctx: { progName: string; branchName: string; counsellor: string; sid?: string }) {
  const map: Record<string, string> = {
    parent_name: l.parent, student_name: l.student, programme: ctx.progName, branch: ctx.branchName, counsellor: ctx.counsellor, student_id: ctx.sid || '',
  };
  return [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => map[m[1]] ?? '');
}

// ---------------- lead creation (webhooks, API, tests) ----------------
export interface NewLeadInput {
  student: string; parent: string; phone: string; email?: string; branch: string; prog: string; src: string;
  camp?: string; cat?: string; dob?: string; age?: number; school?: string; grade?: string; curr?: string;
  wa?: boolean; em?: boolean; notes?: string; cslr?: string; enq?: string; external?: Record<string, unknown>;
}

export async function createLead(repo: Repo, input: NewLeadInput, by = 'System') {
  const cfg = await repo.setting<any>('cfg');
  const branch = await repo.get<any>('branch', input.branch);
  if (!branch) throw new Error(`Unknown branch ${input.branch}`);
  if (!branch.programs.includes(input.prog)) throw new Error(`Programme ${input.prog} is not offered at ${branch.name}`);
  const src = (cfg.sources || []).find((s: any) => s.n === input.src);
  if (src && !src.en) throw new Error(`Lead creation from ${input.src} is disabled in configuration`);

  const id = await repo.newId('lead');
  const now = nowIso();
  const l: any = {
    id, student: input.student, age: input.age || 0, dob: input.dob || '', parent: input.parent, phone: input.phone, email: input.email || '',
    branch: input.branch, prog: input.prog, src: input.src, camp: input.camp || '—', cat: input.cat || 'Warm', stage: 'New Lead', cslr: null,
    enq: input.enq || now, fc: null, status: 'Open', noResp: 0, nextFU: null, last: now, school: input.school || '', grade: input.grade || '',
    curr: input.curr || '', wa: !!input.wa, em: !!input.em, notes: input.notes || '', origCat: null, closeReason: '', lostReason: '',
    events: [], assign: [], avail: null, custom: {}, external: input.external || undefined, test: repo.isTest || undefined,
  };
  l.events.push({ at: l.enq, type: 'sys', text: `Lead created from ${l.src}${l.camp && l.camp !== '—' ? ' · ' + l.camp : ''}`, by });

  const dups = await findDup(repo, l.phone, l.email);
  if (dups.length) l.events.push({ at: now, type: 'warn', text: `Possible duplicate of ${dups.map((d) => d.id).join(', ')} (matched on phone or e-mail)`, by: 'System' });

  let rt: any = null;
  if (input.cslr) {
    l.cslr = input.cslr;
    l.assign.push({ at: now, from: '', to: input.cslr, by, how: 'Manual', reason: 'Selected at creation' });
  } else {
    rt = await routeLead(repo, cfg, l.branch, l.prog, l.cat);
    if (rt.pick) {
      l.cslr = rt.pick.id;
      l.assign.push({ at: now, from: '', to: rt.pick.id, by: 'Routing rules', how: `Auto (${cfg.routing.method})`, reason: 'New lead' });
      l.events.push({ at: now, type: 'sys', text: `Auto-assigned to ${rt.pick.name} (${cfg.routing.method})`, by: 'System' });
    } else {
      l.events.push({ at: now, type: 'crit', text: `No eligible counsellor – lead placed in Unassigned queue; ${cfg.routing.notifyNone} notified`, by: 'System' });
    }
  }
  await repo.create('lead', l);

  const programs = await repo.many<any>('program');
  const progName = (programs.find((p) => p.id === l.prog) || { name: l.prog }).name;
  const cslrName = l.cslr ? ((await repo.get<any>('staff', l.cslr)) || { name: 'our team' }).name : 'our team';
  const ctx = { progName, branchName: branch.name, counsellor: cslrName };

  const queuedComms: string[] = [];
  for (const [tid, key] of [['T1', 'wa'], ['T2', 'wa'], ['T3', 'em']] as const) {
    const t = (cfg.comms || []).find((x: any) => x.id === tid);
    if (!t || !t.auto) continue;
    const blocked = cfg.consentReq?.[key] && !l[key];
    const cid = await repo.newId('cm');
    await repo.create('comm', {
      id: cid, lead: id, ch: t.ch, tpl: t.n, tplId: t.id,
      text: blocked ? `Not sent – no ${key === 'wa' ? 'WhatsApp' : 'email'} consent recorded` : msgFrom(t.body, l, ctx),
      at: nowIso(), status: blocked ? 'Blocked – no consent' : 'Queued', by: 'System', test: repo.isTest || undefined,
    });
    if (!blocked) {
      queuedComms.push(cid);
      if (tid === 'T2') l.avail = { s: 'Requested', slot: null };
      l.events.push({ at: nowIso(), type: 'msg', text: `${t.ch} "${t.n}" queued`, by: 'System' });
    }
  }
  if (l.cslr) {
    const tid = await repo.newId('task');
    await repo.create('task', { id: tid, lead: id, cslr: l.cslr, due: new Date(Date.now() + cfg.sla.mins * 6e4).toISOString(), type: 'First call', status: 'Pending', remarks: 'First-call SLA task', outcome: '', next: '', test: repo.isTest || undefined });
    await notify(repo, { type: 'new', sev: 'info', text: `New lead created: ${l.student} (${l.src}) – assigned to ${cslrName}`, route: { page: 'lead', id }, roles: ['Counsellor', 'Centre Administrator'], branch: l.branch, cslr: l.cslr });
  } else {
    await notify(repo, { type: 'none', sev: 'crit', text: `No counsellor available: ${l.student} (${branch.name} · ${progName}) – lead in Unassigned queue`, route: { page: 'leads', preset: 'unassigned' }, roles: ['Admissions Head', 'Centre Administrator', 'System Administrator'], branch: l.branch });
  }
  await repo.put('lead', l);
  await addAudit(repo, 'Lead created', id, `Source ${l.src}; assigned to ${cslrName === 'our team' ? 'Unassigned' : cslrName}`, by);
  return { lead: l, route: rt, queuedComms, duplicates: dups };
}

// ---------------- payments ----------------
/** Record a payment against an enrollment; the server assigns the receipt number. */
export async function recordPayment(
  repo: Repo,
  p: { enr: string; amt: number; method: string; ref: string; at?: string; by: string; gateway?: any; id?: string },
) {
  const e = await repo.get<any>('enrollment', p.enr);
  if (!e) throw new Error('Enrollment not found');
  const out = r2(e.total - e.paid);
  if (!(p.amt > 0)) throw new Error('Amount must be greater than zero');
  if (p.amt > out + 0.005) throw new Error(`Amount exceeds the outstanding balance (${money(out, e.cur)})`);
  const id = p.id || (await repo.newId('pay'));
  const rcN = repo.isTest || e.test ? 0 : await repo.next('rc_' + e.branch);
  const pay: any = {
    id, enr: e.id, stu: e.stu, amt: r2(p.amt), cur: e.cur, method: p.method, ref: p.ref || '—', at: p.at || nowIso(),
    rc: rcN ? `RC-${e.branch}-26-${String(rcN).padStart(4, '0')}` : `RC-TEST-${id}`, status: 'Recorded', by: p.by, branch: e.branch,
    gateway: p.gateway, test: repo.isTest || undefined,
  };
  await repo.create('payment', pay);
  await recalcEnrollment(repo, e.id);
  return pay;
}

export async function recalcEnrollment(repo: Repo, enrId: string) {
  const e = await repo.get<any>('enrollment', enrId);
  if (!e) return null;
  const pays = await repo.many<any>('payment', 'ref1=?', [enrId]);
  e.paid = r2(pays.reduce((a, p) => a + Number(p.amt || 0), 0));
  e.payStatus = e.paid >= e.total - 0.005 ? 'Paid' : e.paid > 0 ? 'Partially paid' : 'Unpaid';
  await repo.put('enrollment', e);
  return e;
}
