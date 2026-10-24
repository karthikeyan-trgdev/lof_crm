import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setup } from '../helpers/app';

describe('scripts/create-admin.mjs', () => {
  it('creates a System Administrator who can sign in and open the testing console', async () => {
    const sql = execFileSync(process.execPath, ['scripts/create-admin.mjs', '--email', 'Admin.Test@Example.com', '--name', 'Admin Test'], {
      env: { ...process.env, ADMIN_PASSWORD: 'Strong-Pass-2026', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
    });
    expect(sql).not.toContain('Strong-Pass-2026');
    const t = await setup();
    t.d1.db.exec(sql);
    const r = await t.call('POST', '/api/v1/auth/login', { body: { email: 'admin.test@example.com', password: 'Strong-Pass-2026' } });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ role: 'System Administrator', name: 'Admin Test' });
    expect(r.body.mustChangePassword).toBe(false);
    expect(r.body.user.scope.length).toBe(5);
    expect((await t.call('GET', '/api/v1/testing/status', { token: r.body.token })).status).toBe(200);
    t.d1.db.exec(sql); // re-running updates instead of duplicating
    expect(await t.sql("SELECT id FROM docs WHERE type='staff' AND id='S16'")).toHaveLength(1);
  });
});
