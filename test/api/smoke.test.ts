import { describe, it, expect } from 'vitest';
import { setup, USERS } from '../helpers/app';

describe('smoke', () => {
  it('health, login and bootstrap', async () => {
    const t = await setup();
    expect((await t.call('GET', '/health')).status).toBe(200);
    const tok = await t.login(USERS.admin);
    const b = await t.call('GET', '/api/v1/bootstrap', { token: tok });
    expect(b.status).toBe(200);
    expect(b.body.data.leads.length).toBe(31);
    expect(b.body.me.role).toBe('System Administrator');
  });
});
