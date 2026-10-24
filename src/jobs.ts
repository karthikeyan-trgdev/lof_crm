import { Repo, nowIso } from './lib/db';
import type { Env, Job } from './types';
import { processSync, sendComm, sendStudentMail, pushPaymentToErp, calendarForTask, settleLink } from './domain/workflows';
import { addAudit, addEv, notify, money } from './domain/core';
import { instStatus } from './domain/terms';
import { modeFor } from './integrations/base';
import { telrCheck } from './integrations/payments';

export async function runJob(env: Env, job: Job) {
  const repo = new Repo(env.DB, 'System');
  switch (job.kind) {
    case 'moodle_sync': return processSync(env, repo, job.id);
    case 'send_comm': return sendComm(env, repo, job.id);
    case 'send_student_mail': return sendStudentMail(env, repo, job.studentId, job.index);
    case 'erp_payment': return pushPaymentToErp(env, repo, job.id);
    case 'calendar_event': return calendarForTask(env, repo, job.taskId);
  }
}

/** Queue when bound (production); otherwise run in the background of the current request. */
export async function dispatch(env: Env, waitUntil: (p: Promise<unknown>) => void, jobs: Job[]) {
  if (!jobs.length) return;
  if (env.JOBS) {
    await env.JOBS.sendBatch(jobs.map((body) => ({ body })));
    return;
  }
  waitUntil((async () => {
    for (const j of jobs) {
      try { await runJob(env, j); } catch (e) { console.error('job failed', j, e); }
    }
  })());
}

export async function queueConsumer(batch: MessageBatch<Job>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await runJob(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error('job error', msg.body, e);
      msg.retry({ delaySeconds: 60 });
    }
  }
}

/** Every 5 minutes: SLA alerts/escalations, overdue follow-ups and instalments, LMS auto-retry, gateway reconciliation. */
export async function cron(env: Env, waitUntil: (p: Promise<unknown>) => void) {
  const repo = new Repo(env.DB, 'System');
  const cfg = await repo.setting<any>('cfg');
  const now = Date.now();
  const jobs: Job[] = [];

  // First-call SLA: notify on breach, escalate after escMins
  const open = await repo.many<any>('lead', 'status=?', ['Open']);
  for (const l of open) {
    if (l.fc) continue;
    const el = (now - new Date(l.enq).getTime()) / 6e4;
    let dirty = false;
    if (el >= cfg.sla.mins && !l.slaNotified) {
      l.slaNotified = nowIso();
      dirty = true;
      await notify(repo, { type: 'sla', sev: 'crit', text: `First-call SLA breached: ${l.student} (${l.id}) – ${Math.round(el)} min without a call`, route: { page: 'lead', id: l.id }, roles: ['Counsellor', 'Centre Administrator', 'Admissions Head'], branch: l.branch, cslr: l.cslr });
    }
    if (el >= cfg.sla.escMins && !l.esc) {
      l.esc = true;
      dirty = true;
      addEv(l, 'crit', `SLA escalation sent to ${cfg.sla.escTo} (automatic)`);
      await notify(repo, { type: 'sla', sev: 'crit', text: `Escalation: first call overdue for ${l.student} (${l.id})`, route: { page: 'lead', id: l.id }, roles: ['Centre Administrator', 'Admissions Head', 'Management'], branch: l.branch });
      await addAudit(repo, 'SLA escalation', l.id, `${cfg.sla.escTo} (automatic)`, 'System');
    }
    if (dirty) await repo.put('lead', l);
  }

  // Overdue follow-ups (notify once)
  const tasks = await repo.many<any>('task', "status='Pending' AND at < ?", [new Date(now).toISOString()]);
  for (const t of tasks) {
    if (t.overdueNotified) continue;
    const l = await repo.get<any>('lead', t.lead);
    if (!l || l.status !== 'Open') continue;
    t.overdueNotified = nowIso();
    await repo.put('task', t);
    await notify(repo, { type: 'fu', sev: 'warn', text: `Follow-up overdue: ${l.student} (${t.type}, due ${new Date(t.due).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })})`, route: { page: 'tasks' }, roles: ['Counsellor', 'Centre Administrator'], branch: l.branch, cslr: t.cslr });
  }

  // Overdue instalments (notify once per instalment, after the payment term's grace days)
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const active = await repo.many<any>('enrollment', "status IN ('Active','On Hold') AND json_extract(data,'$.sched') IS NOT NULL");
  let overdueInst = 0;
  for (const e of active) {
    const term = (cfg.payTerms || []).find((t: any) => t.id === e.term);
    const late = instStatus(e, term, today).filter((i) => i.st.startsWith('Overdue') && !(e.instNotified || []).includes(i.n));
    if (!late.length) continue;
    overdueInst += late.length;
    // Write only the marker: a full put could overwrite a withdrawal or payment saved in the meantime
    await env.DB.prepare("UPDATE docs SET data=json_set(data,'$.instNotified',json(?)) WHERE type='enrollment' AND id=?").bind(JSON.stringify([...(e.instNotified || []), ...late.map((i) => i.n)]), e.id).run();
    for (const i of late) await notify(repo, { type: 'pay', sev: 'warn', text: `Instalment overdue: ${e.id} – instalment ${i.n} of ${e.sched.length}, ${money(i.bal, e.cur)} due ${i.due}`, route: { page: 'reports', rep: 'r22' }, roles: ['Reception', 'Centre Administrator'], branch: e.branch });
  }

  // LMS call auto-retry
  const retryMin = cfg.integ?.lms?.retryMin ?? 15, retryMax = cfg.integ?.lms?.retryMax ?? 3;
  const failed = await repo.many<any>('moodle_sync', "status='Failed'");
  for (const m of failed) {
    if ((m.attempts || 0) >= retryMax) continue;
    if (now - new Date(m.last).getTime() < retryMin * 6e4) continue;
    m.status = 'Pending';
    m.hist.push({ at: nowIso(), s: 'Pending', msg: `Automatic retry ${m.attempts} of ${retryMax}` });
    await repo.put('moodle_sync', m);
    jobs.push({ kind: 'moodle_sync', id: m.id });
  }

  // Unsent payments → ERPNext retry (up to 5 attempts)
  const pays = await repo.many<any>('payment', "json_extract(data,'$.erp.error') IS NOT NULL");
  for (const p of pays) if ((p.erp.attempts || 0) < 5) jobs.push({ kind: 'erp_payment', id: p.id });

  // Telr reconciliation (Telr's transaction advice is optional, so poll open orders)
  const links = await env.DB.prepare("SELECT * FROM payment_links WHERE status='created' AND provider='telr' AND created_at > ?")
    .bind(new Date(now - 3 * 864e5).toISOString()).all<any>();
  for (const link of links.results || []) {
    try {
      const st = await telrCheck({ env, mode: modeFor(env, cfg, 'telr') }, link.provider_ref);
      if (st.paid) await settleLink(env, repo, link.id, { amount: st.amount, txnRef: st.txnRef, method: 'Card' });
      else if (st.final) await env.DB.prepare('UPDATE payment_links SET status=? WHERE id=?').bind(st.status, link.id).run();
    } catch (e) { console.error('telr reconcile', link.id, e); }
  }

  // Data retention: integration logs 30 days, webhook ids 90 days, sessions and rate counters when expired
  const d = (days: number) => new Date(now - days * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM integration_logs WHERE at < ?').bind(d(30)),
    env.DB.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(d(90)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?').bind(d(1), d(30)),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(now / 1000) - 86400),
    env.DB.prepare('DELETE FROM call_events WHERE at < ?').bind(d(2)),
  ]);

  await dispatch(env, waitUntil, jobs);
  return { leadsChecked: open.length, overdue: tasks.length, overdueInstalments: overdueInst, lmsRetries: jobs.filter((j) => j.kind === 'moodle_sync').length };
}
