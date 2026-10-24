// Live-mode adapters against stubbed provider APIs: checks the exact requests we send and how responses
// (including provider error formats) are handled.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setup, SECRETS, USERS, doc, stubFetch, type TestCtx } from '../helpers/app';

let t: TestCtx;
beforeEach(async () => {
  t = await setup({ INTEGRATION_MODE: 'auto' });
  await t.setCfg((c) => { c.integ.lms.on = true; c.integ.wa.on = true; c.integ.tel.on = true; c.integ.erp.on = true; c.integ.pay.on = true; });
});
afterEach(() => vi.unstubAllGlobals());

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

describe('LMS (LOF booking platform)', () => {
  it('sends the enrol call with the exact fields from the sheet, the bearer token and no payment data', async () => {
    const { calls } = stubFetch([[/lms\.test\/api\/booking/, () => ({ json: { ok: true, applied: true } })]]);
    const r = await t.call('POST', '/api/v1/lms/calls/MS-003/retry', { token: await t.login(USERS.admin) }); // Sara Al Hashimi – failed seed call
    expect(r.body.status).toBe('Success');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe('Bearer ' + SECRETS.LMS_TOKEN);
    const body = JSON.parse(calls[0].body);
    expect(Object.keys(body).sort()).toEqual(['branch', 'call', 'parent_email', 'parent_id', 'parent_name', 'parent_phone', 'products', 'reference', 'student_dob', 'student_email', 'student_first_name', 'student_id', 'student_last_name', 'student_phone', 'valid_until'].sort());
    expect(body).toMatchObject({ call: 'enrol', reference: 'EN-26-0003', student_id: 'LOF-26-000003', student_first_name: 'Sara', branch: 'SPC01', valid_until: '2027-10-05' });
    expect(body.products).toEqual([{ product_name: 'Artificial Intelligence – Term (24 sessions)', track: 'AI-TRK-11021', credits: ['AI-TRK-11021-C1', 'AI-TRK-11021-C2', 'AI-TRK-11021-C3', 'AI-TRK-11021-C4'] }]);
    expect(calls[0].body).not.toMatch(/amount|price|total|paid|invoice|refund/i);
    const logs = await t.sql<any>("SELECT request FROM integration_logs WHERE integration='lms'");
    expect(logs.every((l) => !String(l.request).includes(SECRETS.LMS_TOKEN))).toBe(true);
  });
  it('treats an LMS refusal as a failure and escalates after the retry limit', async () => {
    stubFetch([[/lms\.test/, () => ({ json: { ok: false, error: 'Unknown Track code' } })]]);
    const r1 = await t.call('POST', '/api/v1/lms/calls/MS-004/retry', { token: await t.login(USERS.admin) }); // already 2 attempts
    expect(r1.body.status).toBe('Retry Required');
    expect(r1.body.err).toContain('Unknown Track code');
    const n = await t.sql("SELECT id FROM docs WHERE type='notification' AND json_extract(data,'$.type')='moodle' AND json_extract(data,'$.sev')='crit'");
    expect(n.length).toBeGreaterThan(0);
  });
  it('does not send an incomplete call: missing codes wait for a person', async () => {
    const { calls } = stubFetch([[/lms\.test/, () => ({ json: { ok: true } })]]);
    await t.setCfg((c) => { c.lms.programmes.AI = { track: '', credits: [] }; });
    const r = await t.call('POST', '/api/v1/lms/calls/MS-003/retry', { token: await t.login(USERS.admin) });
    expect(r.body.status).toBe('Retry Required');
    expect(r.body.err).toMatch(/missing products\[0\]\.track, products\[0\]\.credits/);
    expect(calls).toHaveLength(0);
  });
  it('sends the cancel call with the reference only when an enrolment is withdrawn', async () => {
    const { calls } = stubFetch([[/lms\.test/, () => ({ json: { ok: true, withdrawn: true } })]]);
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const r = await t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.hassan), body: { changes: [{ coll: 'enr', id: e.id, op: 'upsert', doc: { ...e, status: 'Withdrawn' }, base: e }] } });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({ call: 'cancel', reference: 'EN-26-0002' });
    const ms = await t.sql<any>("SELECT data FROM docs WHERE type='moodle_sync' AND json_extract(data,'$.op')='cancel'");
    expect(JSON.parse(ms[0].data)).toMatchObject({ enr: 'EN-26-0002', status: 'Success' });
  });
});

describe('WhatsApp Cloud API', () => {
  it('sends approved templates with body parameters when a template is mapped', async () => {
    await t.setCfg((c) => { c.comms.find((x: any) => x.id === 'T6').waTemplate = 'lof_follow_up'; });
    const { calls } = stubFetch([[/graph\.facebook\.com\/v21\.0\/1234567890\/messages/, () => ({ json: { messages: [{ id: 'wamid.LIVE1' }] } })]]);
    const tok = await t.login(USERS.priya);
    await t.call('PUT', '/api/v1/sync', { token: tok, body: { changes: [{ coll: 'comms', id: 'CM960', op: 'upsert', doc: { id: 'CM960', lead: 'LD-26-1001', ch: 'WhatsApp', tpl: 'Follow-up nudge', text: 'x', at: new Date().toISOString(), status: 'Sent (simulated)', by: 'Priya' } }] } });
    const body = JSON.parse(calls[0].body);
    expect(calls[0].headers.authorization).toBe('Bearer ' + SECRETS.WHATSAPP_ACCESS_TOKEN);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', type: 'template', template: { name: 'lof_follow_up', language: { code: 'en' } } });
    expect(body.to).toMatch(/^9715\d+$/);
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['Rohan Mehta', 'Aarav Mehta', 'Al Karama']);
    expect((await doc(t, 'comm', 'CM960'))).toMatchObject({ status: 'Sent', waMsgId: 'wamid.LIVE1' });
  });
  it('records provider errors on the message and the lead timeline', async () => {
    stubFetch([[/graph\.facebook\.com/, () => ({ status: 400, json: { error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } } } })]]);
    await t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.priya), body: { changes: [{ coll: 'comms', id: 'CM961', op: 'upsert', doc: { id: 'CM961', lead: 'LD-26-1001', ch: 'WhatsApp', tpl: 'Custom', text: 'hello', at: new Date().toISOString(), status: 'Sent (simulated)', by: 'Priya' } }] } });
    expect((await doc(t, 'comm', 'CM961')).status).toMatch(/^Failed – WhatsApp 131047: More than 24 hours/);
  });
});

describe('Exotel click-to-call', () => {
  it('rings the counsellor first, then the parent, with a status callback', async () => {
    const { calls } = stubFetch([[/api\.exotel\.com\/v1\/Accounts\/labofuture1\/Calls\/connect\.json/, () => ({ json: { Call: { Sid: 'CA1', Status: 'in-progress' } } })]]);
    const r = await t.call('POST', '/api/v1/leads/LD-26-1001/click-to-call', { token: await t.login(USERS.priya) });
    expect(r.body).toMatchObject({ ok: true, mode: 'live', callSid: 'CA1' });
    const f = form(calls[0].body);
    expect(calls[0].headers.authorization).toBe('Basic ' + btoa('exo-key:exo-token'));
    expect(f.From).toMatch(/\+971 50 555/); // Priya's mobile
    expect(f.To).toBe((await doc(t, 'lead', 'LD-26-1001')).phone);
    expect(f.CallerId).toBe(SECRETS.EXOTEL_CALLER_ID);
    expect(f.StatusCallback).toContain('/webhooks/exotel/status?token=');
  });
});

describe('ERPNext', () => {
  it('creates the customer and a draft Payment Entry for a CRM payment', async () => {
    const { calls } = stubFetch([
      [/\/api\/resource\/Customer\?filters/, () => ({ json: { data: [] } })],
      [/\/api\/resource\/Customer$/, () => ({ json: { data: { name: 'CUST-0001' } } })],
      [/\/api\/resource\/Payment%20Entry\?filters|\/api\/resource\/Payment Entry\?filters/, () => ({ json: { data: [] } })],
      [/\/api\/resource\/Payment(%20| )Entry$/, () => ({ json: { data: { name: 'ACC-PAY-2026-00001' } } })],
    ]);
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    const amt = Math.round((e.total - e.paid) * 100) / 100;
    await t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.layla), body: { changes: [{ coll: 'pay', id: 'PY-26-0009', op: 'upsert', doc: { id: 'PY-26-0009', enr: e.id, stu: e.stu, amt, method: 'Card', ref: 'POS-77', at: new Date().toISOString(), by: 'S10', branch: 'KRM' } }] } });
    const p = await doc(t, 'payment', 'PY-26-0009');
    expect(p.erp).toMatchObject({ name: 'ACC-PAY-2026-00001', mode: 'live' });
    const pe = JSON.parse(calls.find((c) => c.method === 'POST' && /Payment/.test(c.url))!.body);
    expect(pe).toMatchObject({ payment_type: 'Receive', party_type: 'Customer', party: 'CUST-0001', paid_amount: amt, mode_of_payment: 'Credit Card', paid_to: 'Bank AED - LOF', reference_no: 'POS-77', docstatus: 0 });
    expect(pe.remarks).toContain('CRM PY-26-0009');
    expect(calls[0].headers.authorization).toBe('token erp-key:erp-secret');
  });
  it('keeps the error on the payment for the scheduler to retry', async () => {
    stubFetch([[/erp\.test/, () => ({ status: 417, json: { exception: 'frappe.exceptions.ValidationError: Account is mandatory' } })]]);
    const e = await doc(t, 'enrollment', 'EN-26-0002');
    await t.call('PUT', '/api/v1/sync', { token: await t.login(USERS.layla), body: { changes: [{ coll: 'pay', id: 'PY-26-0010', op: 'upsert', doc: { id: 'PY-26-0010', enr: e.id, stu: e.stu, amt: 10, method: 'Cash', ref: '—', at: new Date().toISOString(), by: 'S10', branch: 'KRM' } }] } });
    expect((await doc(t, 'payment', 'PY-26-0010')).erp.error).toContain('Account is mandatory');
  });
});
