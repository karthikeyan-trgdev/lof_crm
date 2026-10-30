// Settings → Email templates: defaults, server validation and rendering.
import { describe, it, expect, beforeEach } from 'vitest';
import { setup, USERS, type TestCtx } from '../helpers/app';
import { DEFAULT_EMAIL_TEMPLATES, checkEmailTemplates, findEmailTemplate, renderEmailTemplate } from '../../src/domain/email-templates';

let t: TestCtx;
beforeEach(async () => { t = await setup(); });
const cfgDoc = async () => JSON.parse((await t.sql<any>("SELECT data FROM settings WHERE key='cfg'"))[0].data);
const bootCfg = async () => (await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) })).body.data.cfg;
const save = async (fn: (c: any) => void, email = USERS.admin) => {
  const c = await bootCfg();
  fn(c);
  return t.call('PUT', '/api/v1/sync', { token: await t.login(email), body: { changes: [], settings: [{ key: 'cfg', doc: c }] } });
};

describe('email templates (server)', () => {
  it('shows the default templates and the placeholder list until an administrator saves a change', async () => {
    const b = await t.call('GET', '/api/v1/bootstrap', { token: await t.login(USERS.admin) });
    expect(b.body.data.cfg.emailTpls.map((x: any) => x.n)).toContain('Fee receipt');
    expect(b.body.data.cfg.emailTpls.map((x: any) => x.cat)).toContain('Events & competitions');
    expect(b.body.server.emailTemplates.categories).toContain('Fees & payments');
    expect(b.body.server.emailTemplates.placeholders.receipt_no.sample).toBeTruthy();
    expect((await cfgDoc()).emailTpls).toBeUndefined();
  });
  it('saves an edited and a new template, keeping only known fields', async () => {
    const r = await save((c) => {
      c.emailTpls.find((x: any) => x.n === 'Fee receipt').subject = 'Receipt {receipt_no} for {student_name}';
      c.emailTpls.push({ id: 'ET10', cat: 'Events & competitions', n: 'Science fair', subject: '{event_name}', body: 'Dear {parent_name}, see you on {event_date}.', branch: 'KRM', active: true, html: '<script>' });
    });
    expect(r.status).toBe(200);
    const saved = (await cfgDoc()).emailTpls;
    expect(saved.find((x: any) => x.n === 'Fee receipt').subject).toBe('Receipt {receipt_no} for {student_name}');
    expect(saved.find((x: any) => x.id === 'ET10')).toEqual({ id: 'ET10', cat: 'Events & competitions', n: 'Science fair', subject: '{event_name}', body: 'Dear {parent_name}, see you on {event_date}.', branch: 'KRM', active: true });
  });
  it('rejects unknown placeholders, categories, branches and duplicate ids', async () => {
    expect((await save((c) => { c.emailTpls[0].body += ' {password}'; })).body.error).toMatch(/unknown placeholder \{password\}/);
    expect((await save((c) => { c.emailTpls[0].cat = 'Marketing'; })).body.error).toMatch(/unknown category/);
    expect((await save((c) => { c.emailTpls[0].branch = 'XYZ'; })).body.error).toMatch(/unknown branch/);
    expect((await save((c) => { c.emailTpls[1].id = c.emailTpls[0].id; })).body.error).toMatch(/duplicate id/);
    expect((await save((c) => { c.emailTpls[0].subject = ' '; })).body.error).toMatch(/subject/);
    expect((await cfgDoc()).emailTpls).toBeUndefined();
  });
  it('only configuration roles can change templates', async () => {
    const r = await save((c) => { c.emailTpls[0].subject = 'Changed'; }, USERS.priya);
    expect(r.body.error).toMatch(/cannot change configuration/);
  });
});

describe('email templates (rendering)', () => {
  it('fills placeholders and blanks missing values', () => {
    const t1 = DEFAULT_EMAIL_TEMPLATES.find((x) => x.n === 'Fee receipt')!;
    const out = renderEmailTemplate(t1, { parent_name: 'Joe', student_name: 'Tara', receipt_no: 'RC-KRM-26-0001', currency: 'AED', amount: '500.00' });
    expect(out.subject).toBe('Payment received – Tara (RC-KRM-26-0001)');
    expect(out.body).toContain('We have received AED 500.00 for Tara');
    expect(out.body).not.toMatch(/\{\w+\}/);
  });
  it('keeps the subject on one line', () => {
    expect(renderEmailTemplate({ subject: '{student_name}', body: '' }, { student_name: 'A\r\nBcc: x@y.z' }).subject).toBe('A Bcc: x@y.z');
  });
  it('prefers an active branch template over the all-branches one', () => {
    const list = [...DEFAULT_EMAIL_TEMPLATES, { ...DEFAULT_EMAIL_TEMPLATES[1], id: 'ET20', branch: 'KRM', subject: 'Karama receipt' }];
    expect(findEmailTemplate(list, 'Fee receipt', 'KRM')!.subject).toBe('Karama receipt');
    expect(findEmailTemplate(list, 'Fee receipt', 'SPC')!.id).toBe('ET2');
    expect(findEmailTemplate(list.map((x) => ({ ...x, active: false })), 'Fee receipt', 'KRM')).toBeNull();
  });
  it('validates the defaults', () => {
    expect(checkEmailTemplates(DEFAULT_EMAIL_TEMPLATES, [])).toHaveProperty('tpls');
  });
});
