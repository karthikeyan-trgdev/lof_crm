// Settings → Database: read-only data browser, CSV export, backup and restore.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, USERS, SECRETS, type TestCtx } from '../helpers/app';

let t: TestCtx;
let tok: string;
beforeEach(async () => { t = await setup(); tok = await t.login(USERS.admin); });

describe('database browser', () => {
  it('is for the System Administrator only', async () => {
    for (const u of [USERS.khalid, USERS.hassan, USERS.priya]) {
      expect((await t.call('GET', '/api/v1/admin/db/tables', { token: await t.login(u) })).status).toBe(403);
    }
    expect((await t.call('GET', '/api/v1/admin/db/tables')).status).toBe(401);
  });
  it('lists every dataset with row counts', async () => {
    const r = await t.call('GET', '/api/v1/admin/db/tables', { token: tok });
    const by = Object.fromEntries(r.body.datasets.map((d: any) => [d.name, d]));
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['leads', 'students', 'enrollments', 'instalments', 'payments', 'refunds', 'lms_calls', 'staff', 'targets', 'audit', 'integration_logs', 'sequences']));
    expect(by.leads.rows).toBeGreaterThan(20);
    expect(by.instalments.rows).toBeGreaterThan(by.enrollments.rows); // split plans give several rows per enrolment
    expect(by.targets.rows).toBeGreaterThan(0);
  });
  it('pages, searches and filters by branch; test records are hidden unless asked for', async () => {
    const all = await t.call('GET', '/api/v1/admin/db/rows?name=leads&limit=5', { token: tok });
    expect(all.body.rows).toHaveLength(5);
    expect(all.body.total).toBeGreaterThan(5);
    const blr = await t.call('GET', '/api/v1/admin/db/rows?name=leads&branch=BLR&limit=200', { token: tok });
    const bi = blr.body.columns.indexOf('branch');
    expect(blr.body.rows.every((r: any[]) => r[bi] === 'BLR')).toBe(true);
    const q = await t.call('GET', '/api/v1/admin/db/rows?name=students&q=Hashimi', { token: tok });
    expect(q.body.rows).toHaveLength(1);
    await t.sql("UPDATE docs SET is_test=1 WHERE type='lead' AND id='LD-26-1001'");
    const hidden = await t.call('GET', '/api/v1/admin/db/rows?name=leads&q=LD-26-1001', { token: tok });
    expect(hidden.body.total).toBe(0);
    const shown = await t.call('GET', '/api/v1/admin/db/rows?name=leads&q=LD-26-1001&test=1', { token: tok });
    expect(shown.body.total).toBe(1);
  });
  it('never exposes password hashes, two-step secrets or session tokens', async () => {
    const staff = await t.call('GET', '/api/v1/admin/db/rows?name=staff&limit=500', { token: tok });
    expect(staff.body.columns).not.toContain('password_hash');
    expect(JSON.stringify(staff.body)).not.toMatch(/pbkdf2_sha256/);
    expect(staff.body.rows.find((r: any[]) => r[0] === 'S12')[staff.body.columns.indexOf('has_login')]).toBe(1);
    const sessions = await t.call('GET', '/api/v1/admin/db/rows?name=sessions', { token: tok });
    expect(sessions.body.columns).not.toContain('id_hash');
    expect(sessions.body.total).toBeGreaterThan(0);
    expect((await t.call('GET', '/api/v1/admin/db/rows?name=staff_auth', { token: tok })).status).toBe(404);
    expect((await t.call('GET', "/api/v1/admin/db/rows?name=leads%20UNION%20SELECT%20*%20FROM%20staff_auth", { token: tok })).status).toBe(404);
  });
  it('opens a full record and an integration log entry', async () => {
    const r = await t.call('GET', '/api/v1/admin/db/record?name=enrollments&id=EN-26-0004', { token: tok });
    expect(r.body.record).toMatchObject({ id: 'EN-26-0004', term: 'PT3' });
    expect(r.body.meta.type).toBe('enrollment');
    await t.call('POST', '/api/v1/testing/integrations/lms/test', { token: tok });
    const logs = await t.call('GET', '/api/v1/admin/db/rows?name=integration_logs&q=lms&test=1', { token: tok });
    const log = await t.call('GET', `/api/v1/admin/db/record?name=integration_logs&id=${logs.body.rows[0][0]}`, { token: tok });
    expect(log.body.record.integration).toBe('lms');
  });
  it('exports CSV safely and records it in the audit log', async () => {
    await t.sql("UPDATE docs SET data=json_set(data,'$.student','=HYPERLINK(\"http://x\")') WHERE type='lead' AND id='LD-26-1001'");
    const r = await t.call('GET', '/api/v1/admin/db/rows.csv?name=leads', { token: tok });
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/lof-leads-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = r.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('id,student,parent,phone,email,branch,programme,source,campaign,category,stage,status,counsellor,enquiry_at,first_call_at,next_follow_up');
    expect(r.text).toContain(`"'=HYPERLINK(""http://x"")"`); // formula neutralised
    const audit = await t.sql("SELECT id FROM docs WHERE type='audit' AND json_extract(data,'$.act')='Data exported (CSV)'");
    expect(audit).toHaveLength(1);
  });
});

describe('review fixes', () => {
  it('rejects odd dataset names and numbers with 404/400, not a crash', async () => {
    for (const n of ['constructor', '__proto__', 'toString']) expect((await t.call('GET', `/api/v1/admin/db/rows?name=${n}`, { token: tok })).status).toBe(404);
    expect((await t.call('GET', '/api/v1/admin/db/rows?name=leads&offset=1e400', { token: tok })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/admin/db/record?name=integration_logs&id=abc', { token: tok })).status).toBe(400);
  });
  it('searches % and _ literally', async () => {
    const pct = await t.call('GET', '/api/v1/admin/db/rows?name=leads&q=%25', { token: tok });
    expect(pct.body.total).toBe(0);
    const us = await t.call('GET', '/api/v1/admin/db/rows?name=leads&q=_', { token: tok });
    expect(us.body.total).toBe(0);
  });
  it('keeps negative numbers numeric in CSV', async () => {
    await t.sql("UPDATE docs SET data=json_set(data,'$.paid',-50) WHERE type='enrollment' AND id='EN-26-0001'");
    const r = await t.call('GET', '/api/v1/admin/db/rows.csv?name=enrollments&q=EN-26-0001', { token: tok });
    expect(r.text).toMatch(/,-50,/);
    expect(r.text).not.toContain("'-50");
    expect(r.headers.get('x-lof-truncated')).toBe('0');
  });
  it('never puts integration credentials from settings into a backup', async () => {
    await t.sql(`UPDATE settings SET data=json_set(data,'$.integ.lms.token','leaked-token-123','$.integ.lms.url','https://x') WHERE key='cfg'`);
    const r = await t.call('GET', '/api/v1/admin/db/backup', { token: tok });
    expect(r.text).not.toContain('leaked-token-123');
  });
  it('restore refuses a database that already has business records', async () => {
    const r = await t.call('GET', '/api/v1/admin/db/backup', { token: tok });
    const dir = mkdtempSync(join(tmpdir(), 'lofbk-'));
    const file = join(dir, 'backup.json');
    writeFileSync(file, r.text);
    const sql = execFileSync(process.execPath, ['scripts/restore-backup.mjs', file], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    expect(() => t.d1.db.exec(sql)).toThrow(/CHECK constraint/);
  });
});

describe('backup and restore', () => {
  it('downloads every business record, setting and sequence, and the restore script rebuilds them', async () => {
    const r = await t.call('GET', '/api/v1/admin/db/backup', { token: tok });
    expect(r.body.format).toBe('lof-crm-backup/1');
    expect(r.text).not.toMatch(/pbkdf2_sha256|id_hash|mfa_secret/);
    const docs = await t.sql<any>("SELECT COUNT(*) n FROM docs WHERE NOT (type='audit' AND json_extract(data,'$.act')='Data backup downloaded')");
    expect(r.body.docs.length).toBe(docs[0].n); // the backup's own audit entry is written after the snapshot
    expect(r.body.settings.map((s: any) => s.key)).toContain('cfg');

    const dir = mkdtempSync(join(tmpdir(), 'lofbk-'));
    const file = join(dir, 'backup.json');
    writeFileSync(file, r.text);
    const sql = execFileSync(process.execPath, ['scripts/restore-backup.mjs', file], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    // Fresh database holding only masters (as a "masters" deployment does), then restore
    const fresh = await setup();
    fresh.d1.db.exec(`DROP TRIGGER trg_payment_no_delete; DROP TRIGGER trg_audit_no_delete;
      DELETE FROM docs WHERE type NOT IN ('branch','program','fee','discount','staff');
      CREATE TRIGGER trg_payment_no_delete BEFORE DELETE ON docs WHEN OLD.type='payment' BEGIN SELECT RAISE(ABORT,'x'); END;`);
    fresh.d1.db.exec(sql);
    const [orig] = await t.sql<any>("SELECT version, created_at FROM docs WHERE type='lead' AND id='LD-26-1001'");
    const [back] = await fresh.sql<any>("SELECT version, created_at FROM docs WHERE type='lead' AND id='LD-26-1001'");
    expect(back).toEqual(orig); // original version and timestamps kept
    const [a] = await t.sql<any>("SELECT COUNT(*) n FROM docs WHERE type IN ('lead','enrollment','payment','refund')");
    const [b] = await fresh.sql<any>("SELECT COUNT(*) n FROM docs WHERE type IN ('lead','enrollment','payment','refund')");
    expect(b.n).toBe(a.n);
    const pay = await fresh.sql<any>("SELECT branch, ref1 FROM docs WHERE type='payment' AND id='PY-26-0001'");
    expect(pay[0].ref1).toBe('EN-26-0001');
    expect(SECRETS.JWT_SECRET).toBeTruthy();
  });
  it('is rate-limited', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await t.call('GET', '/api/v1/admin/db/backup', { token: tok })).status;
    expect(last).toBe(429);
  });
});
