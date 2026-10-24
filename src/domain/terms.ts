// Payment terms (instalment schedules), refund rules, counsellor targets and the LMS call payload.
// The CRM screens use the same formulas (prototype: buildSched / instStatus / refundCalc / lmsPayload);
// the server recomputes everything that matters so a browser can never choose its own schedule or refund.
import { r2 } from './core';

export interface PayTerm { id: string; name: string; split: number[]; gap: number; minFirst: number; grace: number; active: boolean }
export interface Instalment { n: number; due: string; pct: number; amt: number }
export interface RefundRule { label: string; days: number; sessions: number; pct: number }
export interface RefundCfg { rules: RefundRule[]; regFee: 'retain' | 'refund'; adminFee: Record<string, number>; tax: 'refund' | 'retain'; approver: string; confirmed?: boolean }

export const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** Same day n months later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export const addMonthsDay = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + n, 0, 12)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last), 12)).toISOString().slice(0, 10);
};
export const daysBetween = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 864e5));

/** Problems with a payment term definition, or '' when valid. */
export function termProblem(t: any): string {
  if (!t || typeof t !== 'object') return 'Invalid payment term';
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(String(t.id || ''))) return 'Payment term id is invalid';
  if (!String(t.name || '').trim()) return `Payment term ${t.id} needs a name`;
  const sp = t.split;
  if (!Array.isArray(sp) || !sp.length || sp.length > 12 || sp.some((x: unknown) => typeof x !== 'number' || !(x > 0))) return `${t.name}: each instalment must be more than 0% (1–12 instalments)`;
  if (Math.abs(sp.reduce((a: number, b: number) => a + b, 0) - 100) > 0.001) return `${t.name}: the split must add up to 100%`;
  if (sp.length > 1 && !(+t.gap >= 1)) return `${t.name}: days between instalments must be at least 1`;
  if (!(+t.minFirst >= 0 && +t.minFirst <= 100)) return `${t.name}: minimum first instalment must be 0–100%`;
  if (sp[0] < +t.minFirst) return `${t.name}: the first instalment is below the minimum first instalment`;
  if (!(+t.grace >= 0)) return `${t.name}: grace days must be 0 or more`;
  return '';
}

export function buildSched(term: PayTerm | null | undefined, total: number, date: string): Instalment[] {
  const sp = term?.split?.length ? term.split : [100];
  let acc = 0;
  return sp.map((p, i) => {
    const amt = i === sp.length - 1 ? r2(total - acc) : r2((total * p) / 100);
    acc = r2(acc + amt);
    return { n: i + 1, due: addDays(date, i * (term?.gap || 0)), pct: p, amt };
  });
}

/** Instalments with what has been paid against each (earliest first) and their status on `today`. */
export function instStatus(e: any, term: PayTerm | null | undefined, today: string) {
  const sch: Instalment[] = e.sched?.length ? e.sched : buildSched(term, e.total, e.date);
  const grace = +(term?.grace || 0);
  let left = +e.paid || 0;
  return sch.map((x) => {
    const paid = r2(Math.min(Math.max(left, 0), x.amt));
    left = r2(left - paid);
    let st: string;
    if (paid >= x.amt - 0.005) st = 'Paid';
    else if (e.status === 'Withdrawn' || e.status === 'Completed') st = 'Closed';
    else if (addDays(x.due, grace) < today) st = paid > 0 ? 'Overdue (part paid)' : 'Overdue';
    else if (x.due <= today) st = paid > 0 ? 'Partly paid' : 'Due';
    else st = paid > 0 ? 'Partly paid' : 'Upcoming';
    return { ...x, paid, bal: r2(x.amt - paid), st };
  });
}

export function refundProblem(R: any): string {
  if (!R || !Array.isArray(R.rules) || R.rules.length > 20) return 'Refund rules are missing or too many';
  for (const r of R.rules) {
    if (!String(r?.label || '').trim() || !(+r.days >= 0) || !(+r.sessions >= 0) || !(+r.pct >= 0 && +r.pct <= 100)) return 'Each refund rule needs a name, days and sessions ≥ 0 and a refund of 0–100%';
  }
  if (!['retain', 'refund'].includes(R.regFee) || !['retain', 'refund'].includes(R.tax)) return 'Registration fee and tax handling must be retain or refund';
  if (!R.adminFee || Object.values(R.adminFee).some((v) => !(+(v as number) >= 0))) return 'Admin fees must be 0 or more';
  return '';
}

/** Suggested refund for an enrolment from the ordered refund rules. */
export function refundCalc(e: any, days: number, sessions: number, R: RefundCfg) {
  const rule = (R?.rules || []).find((r) => days <= +r.days && sessions <= +r.sessions) || null;
  const pct = rule ? +rule.pct : 0;
  const net = r2(e.fee - e.disc);
  const base = r2((net * pct) / 100);
  const tax = R?.tax === 'refund' ? r2((base * e.taxPct) / 100) : 0;
  const reg = R?.regFee === 'refund' && pct > 0 ? r2(e.reg * (1 + e.taxPct / 100)) : 0;
  const admin = pct > 0 ? +(R?.adminFee?.[e.cur] || 0) : 0;
  const gross = r2(base + tax + reg - admin);
  return { rule, pct, net, base, tax, reg, admin, gross, suggested: r2(Math.max(0, Math.min(+e.paid || 0, gross))) };
}

export function targetsProblem(T: any, staffIds: Set<string>): string {
  if (!Array.isArray(T) || T.length > 5000) return 'Counsellor targets are invalid';
  const seen = new Set<string>();
  for (const t of T) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(t?.m)) || !staffIds.has(t.c)) return 'Each target needs a month (YYYY-MM) and an existing counsellor';
    if (!Number.isInteger(t.enr) || t.enr < 0 || !(t.rev >= 0) || !(t.conv >= 0 && t.conv <= 100)) return 'Targets: whole enrolments, revenue ≥ 0 and conversion 0–100%';
    const k = t.m + '|' + t.c;
    if (seen.has(k)) return 'A counsellor has two targets for the same month';
    seen.add(k);
  }
  return '';
}

const CODE = /^[A-Za-z0-9._-]{1,64}$/;
export function lmsProblem(L: any): string {
  if (!L || typeof L !== 'object') return 'LMS settings are missing';
  if (!(+L.validMonths >= 1 && +L.validMonths <= 60)) return 'LMS access validity must be 1–60 months';
  for (const [p, c] of Object.entries<any>(L.programmes || {})) {
    if (!c || typeof c !== 'object') return `LMS codes for ${p} are invalid`;
    if (c.track && !CODE.test(c.track)) return `LMS Track code for ${p} may use letters, digits, . _ - only`;
    if (!Array.isArray(c.credits) || c.credits.some((x: unknown) => !CODE.test(String(x)))) return `LMS Credit codes for ${p} may use letters, digits, . _ - only`;
    if (new Set(c.credits).size !== c.credits.length) return `Duplicate LMS Credit code for ${p}`;
  }
  for (const v of Object.values<any>(L.branchMap || {})) if (v && !CODE.test(String(v))) return 'LMS branch codes may use letters, digits, . _ - only';
  return '';
}

export const LMS_MUST = ['reference', 'student_id', 'student_first_name', 'student_last_name', 'student_email', 'student_phone', 'student_dob', 'branch', 'valid_until'] as const;

/** The enrol call body from the "LOF Booking Platform – what ERPNext sends us" sheet (v3). No payment data. */
export function lmsEnrolPayload(e: any, s: any, program: any, L: any) {
  const p = s?.parents?.[0] || {};
  const code = L?.programmes?.[e.prog] || {};
  return {
    reference: e.id,
    student_id: s.id,
    student_first_name: s.first || '',
    student_last_name: s.last || '',
    student_email: s.email || p.email || '',
    student_phone: s.mobile || p.mobile || '',
    student_dob: s.dob || '',
    parent_id: s.fam || '',
    parent_name: p.name || '',
    parent_email: p.email || '',
    parent_phone: p.mobile || '',
    branch: L?.branchMap?.[e.branch] || '',
    valid_until: addDays(addMonthsDay(e.date, +(L?.validMonths || 12)), -1),
    products: [{ product_name: `${program?.name || e.prog} – ${e.pkg}`, track: code.track || '', credits: (code.credits || []).slice() }],
  };
}

export function lmsMissing(pl: ReturnType<typeof lmsEnrolPayload>): string[] {
  const m: string[] = LMS_MUST.filter((k) => !String((pl as any)[k] || '').trim());
  pl.products.forEach((x, i) => {
    if (!x.track) m.push(`products[${i}].track`);
    if (!x.credits.length) m.push(`products[${i}].credits`);
  });
  return m;
}

/** Defaults for settings added after go-live (payment terms, refund rules, targets, LMS). Bootstrap fills
 *  any that are missing so older databases show the new screens; saving the settings stores them. */
export function cfgDefaults(programs: any[], branches: any[]) {
  return {
    targets: [] as any[],
    payTerms: [
      { id: 'PT1', name: 'Full payment', split: [100], gap: 0, minFirst: 100, grace: 0, active: true },
      { id: 'PT2', name: '50 / 50', split: [50, 50], gap: 30, minFirst: 50, grace: 7, active: true },
      { id: 'PT3', name: '40 / 30 / 30', split: [40, 30, 30], gap: 21, minFirst: 40, grace: 7, active: true },
      { id: 'PT4', name: 'Quarterly (4 × 25%)', split: [25, 25, 25, 25], gap: 90, minFirst: 25, grace: 10, active: true },
    ],
    payTermDefault: 'PT1',
    refund: {
      rules: [{ label: 'Cooling-off', days: 7, sessions: 2, pct: 100 }, { label: 'Early withdrawal', days: 30, sessions: 6, pct: 75 }, { label: 'Mid-term', days: 60, sessions: 12, pct: 50 }, { label: 'Late withdrawal', days: 90, sessions: 18, pct: 25 }],
      regFee: 'retain', adminFee: { AED: 100, INR: 1500 }, tax: 'refund', approver: 'Management', confirmed: false,
    },
    lms: {
      validMonths: 12, confirmed: false,
      programmes: Object.fromEntries(programs.map((p) => [p.id, { track: '', credits: [] as string[] }])),
      branchMap: Object.fromEntries(branches.map((b) => [b.id, ''])),
    },
    lmsInteg: { on: false, retryMax: 3, retryMin: 15, notify: 'Admissions Head, System Administrator' },
  };
}
