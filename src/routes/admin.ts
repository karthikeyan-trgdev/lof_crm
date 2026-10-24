// Settings → Database: read-only data browser, CSV export and JSON backup (System Administrator only).
//   GET /api/v1/admin/db/tables                       datasets with row counts
//   GET /api/v1/admin/db/rows?name=&q=&branch=&test=&limit=&offset=   one page of a dataset
//   GET /api/v1/admin/db/rows.csv?name=&q=&branch=&test=             the whole (filtered) dataset as CSV
//   GET /api/v1/admin/db/record?name=&id=             one full record (JSON document or log entry)
//   GET /api/v1/admin/db/backup                       every business record, setting and sequence as JSON
// Only whitelisted views/tables and columns are reachable; password hashes, two-step secrets and session
// tokens are never selected. Exports and backups are rate-limited and written to the audit log.
import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../lib/auth';
import { allow } from '../lib/ratelimit';
import { HttpError } from '../types';
import { addAudit } from '../domain/core';

interface Dataset { label: string; group: 'Business' | 'Settings' | 'System'; src: string; cols: string[]; order: string; branch?: boolean; test?: boolean; key?: string; docType?: string; note?: string }

export const DATASETS: Record<string, Dataset> = {
  leads: { label: 'Leads', group: 'Business', src: 'v_leads', order: 'enquiry_at DESC', branch: true, test: true, docType: 'lead', key: 'id',
    cols: ['id', 'student', 'parent', 'phone', 'email', 'branch', 'programme', 'source', 'campaign', 'category', 'stage', 'status', 'counsellor', 'enquiry_at', 'first_call_at', 'next_follow_up'] },
  opportunities: { label: 'Opportunities', group: 'Business', src: 'v_opportunities', order: 'id DESC', branch: true, test: true, docType: 'opp', key: 'id',
    cols: ['id', 'lead_id', 'student', 'branch', 'programme', 'package', 'counsellor', 'stage', 'decision', 'lost_reason', 'student_id'] },
  students: { label: 'Students', group: 'Business', src: 'v_students', order: 'id DESC', branch: true, test: true, docType: 'student', key: 'id',
    cols: ['id', 'first_name', 'last_name', 'dob', 'branch', 'status', 'student_email', 'student_mobile', 'family_id', 'parent_name', 'parent_mobile', 'parent_email', 'registered_on'] },
  enrollments: { label: 'Enrolments', group: 'Business', src: 'v_enrollments', order: 'enrolled_on DESC', branch: true, test: true, docType: 'enrollment', key: 'id',
    cols: ['id', 'student_id', 'opportunity_id', 'branch', 'programme', 'package', 'status', 'enrolled_on', 'counsellor', 'payment_term', 'currency', 'fee', 'registration', 'discount', 'tax', 'total', 'paid', 'outstanding', 'payment_status'] },
  instalments: { label: 'Instalments', group: 'Business', src: 'v_instalments', order: 'due_date ASC', branch: true, test: true, docType: 'enrollment', key: 'enrollment_id',
    cols: ['enrollment_id', 'student_id', 'branch', 'enrollment_status', 'payment_term', 'instalment', 'percent', 'due_date', 'amount', 'currency', 'enrollment_paid'],
    note: 'Paid amounts are applied to the earliest instalment first; the CRM shows each instalment’s status.' },
  payments: { label: 'Payments', group: 'Business', src: 'v_payments', order: 'paid_at DESC', branch: true, test: true, docType: 'payment', key: 'id',
    cols: ['id', 'receipt_no', 'enrollment_id', 'student_id', 'branch', 'paid_at', 'amount', 'currency', 'method', 'reference', 'status', 'gateway', 'erpnext_payment_entry'] },
  refunds: { label: 'Refunds', group: 'Business', src: 'v_refunds', order: 'requested_at DESC', branch: true, test: true, docType: 'refund', key: 'id',
    cols: ['id', 'enrollment_id', 'branch', 'status', 'requested_at', 'amount', 'suggested', 'rule', 'days_since_enrolment', 'sessions_attended', 'exception', 'approver_role', 'requested_by', 'decided_by', 'reason'] },
  lms_calls: { label: 'LMS calls', group: 'Business', src: 'v_lms_calls', order: 'last_attempt DESC', branch: true, test: true, docType: 'moodle_sync', key: 'id',
    cols: ['id', 'call', 'enrollment_id', 'student_id', 'branch', 'status', 'track', 'credits', 'attempts', 'last_attempt', 'error'] },
  approvals: { label: 'Approvals', group: 'Business', src: 'v_approvals', order: 'requested_at DESC', branch: true, test: true, docType: 'approval', key: 'id',
    cols: ['id', 'type', 'branch', 'status', 'summary', 'requested_by', 'requested_at', 'approver_role', 'decided_by', 'decided_at', 'remarks'] },
  tasks: { label: 'Follow-up tasks', group: 'Business', src: 'v_tasks', order: 'due DESC', branch: true, test: true, docType: 'task', key: 'id',
    cols: ['id', 'lead_id', 'branch', 'counsellor', 'type', 'status', 'due', 'outcome', 'remarks'] },
  calls: { label: 'Call log', group: 'Business', src: 'v_calls', order: 'called_at DESC', branch: true, test: true, docType: 'call', key: 'id',
    cols: ['id', 'lead_id', 'branch', 'called_at', 'direction', 'status', 'minutes', 'outcome', 'counsellor'] },
  staff: { label: 'Staff & logins', group: 'Settings', src: 'v_staff', order: 'id ASC', branch: true, docType: 'staff', key: 'id',
    cols: ['id', 'name', 'role', 'branch', 'email', 'employment', 'access', 'has_login', 'two_step', 'must_change_password', 'last_login_at', 'locked_until'],
    note: 'Sign-in state only – password hashes and two-step secrets are never shown.' },
  targets: { label: 'Counsellor targets', group: 'Settings', src: 'v_targets', order: 'month DESC, counsellor ASC', cols: ['month', 'counsellor', 'enrolment_target', 'revenue_target', 'conversion_target'] },
  audit: { label: 'Audit log', group: 'System', src: 'v_audit', order: 'at DESC', test: true, docType: 'audit', key: 'id', cols: ['id', 'at', 'user', 'action', 'reference', 'detail'] },
  integration_logs: { label: 'Integration log', group: 'System', src: 'integration_logs', order: 'id DESC', test: true, key: 'id',
    cols: ['id', 'at', 'integration', 'direction', 'operation', 'mode', 'status', 'ok', 'duration_ms', 'ref', 'error'], note: 'Requests and responses are stored with secrets redacted; open a row to see them. Kept 30 days.' },
  payment_links: { label: 'Payment links', group: 'System', src: 'payment_links', order: 'created_at DESC', test: true, key: 'id',
    cols: ['id', 'provider', 'provider_ref', 'enrollment_id', 'amount', 'currency', 'status', 'payment_id', 'created_by', 'created_at', 'paid_at'] },
  webhook_events: { label: 'Webhook events', group: 'System', src: 'webhook_events', order: 'received_at DESC', cols: ['provider', 'event_id', 'received_at', 'result'], note: 'Kept 90 days to ignore provider retries.' },
  sessions: { label: 'Sessions', group: 'System', src: 'sessions', order: 'last_seen_at DESC', cols: ['staff_id', 'created_at', 'last_seen_at', 'expires_at', 'revoked_at', 'stage', 'acting_as', 'ip'], note: 'Session tokens are never stored or shown – only their metadata.' },
  sequences: { label: 'Number sequences', group: 'System', src: 'sequences', order: 'name ASC', cols: ['name', 'value'], note: 'The next number each series will issue.' },
};

export const admin = new Hono<AppEnv>();
admin.use('*', requireAuth);
admin.use('*', async (c, next) => {
  if (c.get('user').role !== 'System Administrator') throw new HttpError(403, 'Only a System Administrator can open the database');
  await next();
});

const dataset = (name: string | undefined) => {
  const d = name && Object.hasOwn(DATASETS, name) ? DATASETS[name] : undefined;
  if (!d) throw new HttpError(404, 'Unknown dataset');
  return d;
};
function where(d: Dataset, q: Record<string, string>) {
  const w: string[] = [], b: unknown[] = [];
  if (d.test && q.test !== '1') w.push('is_test=0');
  if (d.branch && q.branch) { w.push('branch=?'); b.push(q.branch); }
  const text = String(q.q || '').trim().slice(0, 100);
  if (text) {
    const like = '%' + text.replace(/[\\%_]/g, (m) => '\\' + m) + '%'; // % and _ are searched for literally
    w.push('(' + d.cols.map((col) => `CAST(${col} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (const _ of d.cols) b.push(like);
  }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', binds: b };
}
const intIn = (v: unknown, def: number, min: number, max: number) => {
  const n = v == null || v === '' ? def : Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new HttpError(400, 'Invalid number');
  return Math.min(Math.max(n, min), max);
};
const CSV_MAX = 50_000;
const cell = (v: unknown) => (v == null ? '' : String(v));
const csvCell = (v: unknown) => {
  let s = cell(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // no spreadsheet formulas from text (numbers stay numbers)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

admin.get('/db/tables', async (c) => {
  const out: any[] = [];
  for (const [name, d] of Object.entries(DATASETS)) {
    const w = d.test ? ' WHERE is_test=0' : '';
    const r = await c.env.DB.prepare(`SELECT COUNT(*) n FROM ${d.src}${w}`).first<{ n: number }>();
    out.push({ name, label: d.label, group: d.group, rows: r?.n ?? 0, columns: d.cols, branch: !!d.branch, hasTest: !!d.test, detail: !!(d.docType || d.src === 'integration_logs'), note: d.note || '' });
  }
  return c.json({ datasets: out });
});

admin.get('/db/rows', async (c) => {
  const q = c.req.query();
  const d = dataset(q.name);
  const limit = intIn(q.limit, 50, 1, 500), offset = intIn(q.offset, 0, 0, 10_000_000);
  // Paging through a whole table is an export too: bounded per hour like CSV downloads
  if (!(await allow(c.env, 'dbrows:' + c.get('user').id, 600, 3600))) throw new HttpError(429, 'Too many requests – try again later');
  const w = where(d, q);
  const total = await c.env.DB.prepare(`SELECT COUNT(*) n FROM ${d.src}${w.sql}`).bind(...w.binds).first<{ n: number }>();
  const r = await c.env.DB.prepare(`SELECT ${d.cols.join(', ')} FROM ${d.src}${w.sql} ORDER BY ${d.order} LIMIT ? OFFSET ?`).bind(...w.binds, limit, offset).all<any>();
  return c.json({ name: q.name, label: d.label, columns: d.cols, total: total?.n ?? 0, limit, offset, rows: (r.results || []).map((x) => d.cols.map((col) => x[col] ?? null)) });
});

admin.get('/db/rows.csv', async (c) => {
  const u = c.get('user');
  if (!(await allow(c.env, 'export:' + u.id, 30, 3600))) throw new HttpError(429, 'Too many exports – try again later');
  const q = c.req.query();
  const d = dataset(q.name);
  const w = where(d, q);
  const r = await c.env.DB.prepare(`SELECT ${d.cols.join(', ')} FROM ${d.src}${w.sql} ORDER BY ${d.order} LIMIT ${CSV_MAX + 1}`).bind(...w.binds).all<any>();
  const rows = (r.results || []).slice(0, CSV_MAX), truncated = (r.results || []).length > CSV_MAX;
  const lines = [d.cols.join(','), ...rows.map((x) => d.cols.map((col) => csvCell(x[col])).join(','))];
  if (truncated) lines.push(`"Only the first ${CSV_MAX} rows are included – narrow the search or branch filter, or use the full backup."`);
  await addAudit(c.get('repo'), 'Data exported (CSV)', q.name!, `${rows.length} rows${truncated ? ' (truncated)' : ''}${q.branch ? ' · ' + q.branch : ''}${q.q ? ' · search "' + String(q.q).slice(0, 40) + '"' : ''}`);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="lof-${q.name}-${stamp}.csv"`, 'cache-control': 'no-store', 'x-lof-truncated': truncated ? '1' : '0' } });
});

admin.get('/db/record', async (c) => {
  const q = c.req.query();
  const d = dataset(q.name);
  if (!q.id) throw new HttpError(400, 'id is required');
  if (d.src === 'integration_logs') {
    const row = await c.env.DB.prepare('SELECT * FROM integration_logs WHERE id=?').bind(intIn(q.id, 0, 1, Number.MAX_SAFE_INTEGER)).first();
    if (!row) throw new HttpError(404, 'Not found');
    return c.json({ record: row });
  }
  if (!d.docType) throw new HttpError(400, 'This dataset has no record view');
  const row = await c.env.DB.prepare('SELECT type, id, branch, status, is_test, version, created_at, updated_at, updated_by, data FROM docs WHERE type=? AND id=?').bind(d.docType, q.id).first<any>();
  if (!row) throw new HttpError(404, 'Not found');
  const { data, ...meta } = row;
  return c.json({ record: JSON.parse(data), meta });
});

// Integration credentials belong in server secrets; never let a stored copy leave in a backup
function scrubSettings(key: string, data: any) {
  if (key !== 'cfg' || !data?.integ) return data;
  if (data.integ.moodle) data.integ.moodle.token = '';
  if (data.integ.lms) for (const k of ['token', 'url', 'secret']) delete data.integ.lms[k];
  return data;
}

admin.get('/db/backup', async (c) => {
  const u = c.get('user');
  if (!(await allow(c.env, 'backup:' + u.id, 5, 3600))) throw new HttpError(429, 'Too many backups – try again later');
  // One batch = one transaction, so record numbers and their counters are a consistent snapshot
  const [docs, settings, sequences] = await c.env.DB.batch<any>([
    c.env.DB.prepare('SELECT type, id, is_test, version, created_at, updated_at, updated_by, data FROM docs ORDER BY type, id'),
    c.env.DB.prepare('SELECT key, updated_at, updated_by, data FROM settings ORDER BY key'),
    c.env.DB.prepare('SELECT name, value FROM sequences ORDER BY name'),
  ]);
  const body = {
    format: 'lof-crm-backup/1', exportedAt: new Date().toISOString(), exportedBy: u.name,
    note: 'Business records, settings and number sequences. Logins, sessions and logs are not included. Restore with scripts/restore-backup.mjs.',
    docs: (docs.results || []).map((r) => ({ ...r, data: JSON.parse(r.data) })),
    settings: (settings.results || []).map((r) => ({ ...r, data: scrubSettings(r.key, JSON.parse(r.data)) })),
    sequences: sequences.results || [],
  };
  await addAudit(c.get('repo'), 'Data backup downloaded', 'Database', `${body.docs.length} records, ${body.settings.length} settings`);
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="lof-crm-backup-${body.exportedAt.slice(0, 10)}.json"`, 'cache-control': 'no-store' } });
});
