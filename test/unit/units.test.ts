import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, signJwt, verifyJwt, hashPassword, verifyPassword, safeEqual } from '../../src/lib/crypto';
import { calcFee, feeFor, templateParams, msgFrom } from '../../src/domain/core';
import { buildSched, instStatus, refundCalc, termProblem, lmsEnrolPayload, lmsMissing, targetsProblem, refundProblem } from '../../src/domain/terms';
import { parseStatus } from '../../src/integrations/exotel';
import { clientIp } from '../../src/lib/ratelimit';
import { mapLead, parseLeadgenWebhook } from '../../src/integrations/meta';
import { parseWebhook, waNumber, verifyHubSignature } from '../../src/integrations/whatsapp';
import { redact, modeFor } from '../../src/integrations/base';
import { indexFor, normPhone } from '../../src/lib/indexing';
import { gatewayFor } from '../../src/integrations/payments';

describe('crypto', () => {
  it('HMAC-SHA256 matches the RFC 4231 test vector', async () => {
    expect(await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
  it('JWT round-trips and rejects tampering and expiry', async () => {
    const tok = await signJwt({ sub: 'S01' }, 'secret');
    expect((await verifyJwt(tok, 'secret'))?.sub).toBe('S01');
    expect(await verifyJwt(tok, 'other')).toBeNull();
    const [h, , s] = tok.split('.');
    expect(await verifyJwt(`${h}.${btoa('{"sub":"S12"}')}.${s}`, 'secret')).toBeNull();
    expect(await verifyJwt(await signJwt({ sub: 'x' }, 'secret', -10), 'secret')).toBeNull();
  });
  it('PBKDF2 password hashes verify only the right password', async () => {
    const h = await hashPassword('Correct horse 1', 1000);
    expect(await verifyPassword('Correct horse 1', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

describe('fees', () => {
  const fee = { amt: 2400, tax: 5, extra: { amt: 100 }, active: true, prog: 'ROB', branch: 'KRM', pkg: 'Term', from: '2026-09-01', to: '' };
  it('adds registration for new students and VAT on the net', () => {
    expect(calcFee(fee, null, true)).toEqual({ base: 2400, extra: 100, disc: 0, net: 2500, tax: 125, total: 2625 });
    expect(calcFee(fee, null, false).total).toBe(2520);
  });
  it('applies percentage and capped flat discounts to the programme fee only', () => {
    expect(calcFee(fee, { type: '%', value: 10 }, true).total).toBe(r(2160 + 100));
    expect(calcFee(fee, { type: 'flat', value: 5000 }, false).disc).toBe(2400);
  });
  it('picks only fee records effective on the date', () => {
    const fees = [{ ...fee, id: 'old', to: '2026-09-30' }, { ...fee, id: 'new', amt: 2500, from: '2026-10-01' }];
    expect(feeFor(fees, 'ROB', 'KRM', 'Term', '2026-09-15')?.id).toBe('old');
    expect(feeFor(fees, 'ROB', 'KRM', 'Term', '2026-10-12')?.id).toBe('new');
  });
});
const r = (x: number) => Math.round(x * 1.05 * 100) / 100;

describe('templates', () => {
  const l = { parent: 'Rohan', student: 'Aarav' };
  const ctx = { progName: 'Robotics', branchName: 'Al Karama', counsellor: 'Priya' };
  it('fills placeholders and extracts WhatsApp template parameters in order', () => {
    const t = 'Hi {parent_name}, {student_name} – {programme} at {branch}. {counsellor} will call.';
    expect(msgFrom(t, l, ctx)).toBe('Hi Rohan, Aarav – Robotics at Al Karama. Priya will call.');
    expect(templateParams(t, l, ctx)).toEqual(['Rohan', 'Aarav', 'Robotics', 'Al Karama', 'Priya']);
  });
});

describe('payment terms and instalments', () => {
  const t3 = { id: 'PT3', name: '40 / 30 / 30', split: [40, 30, 30], gap: 21, minFirst: 40, grace: 7, active: true };
  it('splits the total, puts rounding on the last instalment and spaces due dates', () => {
    const s = buildSched(t3, 1000.01, '2026-09-10');
    expect(s.map((x) => x.amt)).toEqual([400, 300, 300.01]);
    expect(s.map((x) => x.due)).toEqual(['2026-09-10', '2026-10-01', '2026-10-22']);
    expect(buildSched(null, 50, '2026-01-01')).toEqual([{ n: 1, due: '2026-01-01', pct: 100, amt: 50 }]);
  });
  it('applies payments to the earliest instalment and marks overdue only after the grace days', () => {
    const e = { total: 1000, paid: 600, date: '2026-09-10', status: 'Active', sched: buildSched(t3, 1000, '2026-09-10') };
    expect(instStatus(e, t3, '2026-10-08').map((i) => i.st)).toEqual(['Paid', 'Partly paid', 'Upcoming']);
    expect(instStatus(e, t3, '2026-10-09').map((i) => i.st)).toEqual(['Paid', 'Overdue (part paid)', 'Upcoming']);
    expect(instStatus({ ...e, status: 'Withdrawn' }, t3, '2026-12-31').map((i) => i.st)).toEqual(['Paid', 'Closed', 'Closed']);
  });
  it('validates term definitions', () => {
    expect(termProblem(t3)).toBe('');
    expect(termProblem({ ...t3, split: [40, 30, 20] })).toMatch(/add up to 100/);
    expect(termProblem({ ...t3, minFirst: 50 })).toMatch(/below the minimum/);
    expect(termProblem({ ...t3, gap: 0 })).toMatch(/at least 1/);
  });
});

describe('refund rules', () => {
  const R: any = { rules: [{ label: 'Cooling-off', days: 7, sessions: 2, pct: 100 }, { label: 'Early', days: 30, sessions: 6, pct: 75 }], regFee: 'retain', tax: 'refund', adminFee: { AED: 100 }, approver: 'Management' };
  const e = { fee: 2000, disc: 200, reg: 100, taxPct: 5, paid: 2000, cur: 'AED' };
  it('uses the first rule within both limits, adds tax on the share, deducts the admin fee', () => {
    const r = refundCalc(e, 20, 4, R);
    expect(r.rule?.label).toBe('Early');
    expect(r).toMatchObject({ base: 1350, tax: 67.5, reg: 0, admin: 100, suggested: 1317.5 });
  });
  it('gives 0 when no rule matches and never more than was paid', () => {
    expect(refundCalc(e, 45, 4, R).suggested).toBe(0);
    expect(refundCalc({ ...e, paid: 500 }, 1, 0, R).suggested).toBe(500);
    expect(refundCalc(e, 1, 0, { ...R, regFee: 'refund' }).reg).toBe(105);
  });
  it('rejects malformed rule sets and targets', () => {
    expect(refundProblem({ ...R, rules: [{ label: '', days: 1, sessions: 1, pct: 50 }] })).not.toBe('');
    expect(refundProblem({ ...R, tax: 'maybe' })).not.toBe('');
    expect(targetsProblem([{ m: '2026-10', c: 'S01', enr: 2.5, rev: 1, conv: 10 }], new Set(['S01']))).not.toBe('');
    expect(targetsProblem([{ m: '2026-10', c: 'S99', enr: 2, rev: 1, conv: 10 }], new Set(['S01']))).not.toBe('');
    expect(targetsProblem([{ m: '2026-10', c: 'S01', enr: 2, rev: 1000, conv: 10 }], new Set(['S01']))).toBe('');
  });
});

describe('LMS enrol call payload', () => {
  const L = { validMonths: 12, programmes: { ROB: { track: 'ROB-TRK-10021', credits: ['ROB-TRK-10021-C3', 'ROB-TRK-10021-C4'] } }, branchMap: { BLR: 'BLR01' } };
  const e = { id: 'EN-26-0123', prog: 'ROB', pkg: 'Term (24 sessions)', branch: 'BLR', date: '2026-09-19', total: 9999, paid: 9999 };
  const s = { id: 'LOF-26-000041', first: 'Aarav', last: 'Sharma', dob: '2014-07-15', fam: 'FAM-26-0019', parents: [{ name: 'Rohit Sharma', email: 'rohit@example.com', mobile: '+91 98765 11111' }] };
  it('matches the LOF booking platform sheet (v3) and carries no payment data', () => {
    const p = lmsEnrolPayload(e, s, { name: 'Robotics' }, L);
    expect(p).toEqual({
      reference: 'EN-26-0123', student_id: 'LOF-26-000041', student_first_name: 'Aarav', student_last_name: 'Sharma', student_email: 'rohit@example.com', student_phone: '+91 98765 11111', student_dob: '2014-07-15',
      parent_id: 'FAM-26-0019', parent_name: 'Rohit Sharma', parent_email: 'rohit@example.com', parent_phone: '+91 98765 11111', branch: 'BLR01', valid_until: '2027-09-18',
      products: [{ product_name: 'Robotics – Term (24 sessions)', track: 'ROB-TRK-10021', credits: ['ROB-TRK-10021-C3', 'ROB-TRK-10021-C4'] }],
    });
    expect(JSON.stringify(p)).not.toMatch(/9999|amount|price|paid|invoice/i);
    expect(lmsMissing(p)).toEqual([]);
  });
  it('lists missing required fields instead of sending an incomplete call', () => {
    const p = lmsEnrolPayload({ ...e, branch: 'HYD', prog: 'AI' }, { ...s, dob: '' }, { name: 'AI' }, L);
    expect(lmsMissing(p)).toEqual(['student_dob', 'branch', 'products[0].track', 'products[0].credits']);
  });
});

describe('Exotel', () => {
  it('normalises status callbacks', () => {
    expect(parseStatus({ CallSid: 'a', Status: 'completed', ConversationDuration: '125' })).toMatchObject({ sid: 'a', status: 'Completed', durationMin: 2.1 });
    expect(parseStatus({ CallSid: 'b', Status: 'no-answer' }).status).toBe('Not answered');
  });
});

describe('Meta Lead Ads', () => {
  it('parses leadgen webhooks and maps form fields to a lead', () => {
    const changes = parseLeadgenWebhook({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 123, form_id: 'F1' } }, { field: 'feed', value: {} }] }] });
    expect(changes).toEqual([{ leadgenId: '123', formId: 'F1', pageId: undefined, adId: undefined, createdTime: undefined }]);
    const cfg = { integ: { meta: { forms: { F1: { branch: 'SPC', prog: 'AI', camp: 'AI Coding' } } } } };
    const lead = mapLead(cfg, { id: '123', form_id: 'F1', platform: 'ig', field_data: [{ name: 'full_name', values: ['Rima'] }, { name: 'student_name', values: ['Jad'] }, { name: 'phone_number', values: ['+971501112222'] }] }, [{ id: 'SPC', name: 'Sports City', status: 'Operating' }], [{ id: 'AI', name: 'Artificial Intelligence' }]);
    expect(lead).toMatchObject({ parent: 'Rima', student: 'Jad', phone: '+971501112222', branch: 'SPC', prog: 'AI', src: 'Instagram', camp: 'AI Coding' });
  });
});

describe('WhatsApp', () => {
  it('parses statuses and inbound messages', () => {
    const ev = parseWebhook({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '9715', profile: { name: 'P' } }], statuses: [{ id: 'w1', status: 'read' }], messages: [{ id: 'm1', from: '9715', type: 'text', text: { body: 'hi' } }] } }] }] });
    expect(ev.statuses[0]).toMatchObject({ id: 'w1', status: 'read' });
    expect(ev.messages[0]).toMatchObject({ from: '9715', name: 'P', text: 'hi' });
    expect(waNumber('+971 50 555 0100')).toBe('971505550100');
  });
  it('verifies X-Hub-Signature-256', async () => {
    const sig = 'sha256=' + (await hmacSha256Hex('s', '{"a":1}'));
    expect(await verifyHubSignature('{"a":1}', sig, 's')).toBe(true);
    expect(await verifyHubSignature('{"a":2}', sig, 's')).toBe(false);
    expect(await verifyHubSignature('{"a":1}', null, 's')).toBe(false);
  });
});

describe('integration plumbing', () => {
  it('redacts secrets and tokens from logs', () => {
    const s = redact('https://x/?wstoken=abc123&access_token=zzz {"authkey":"k1"} Authorization: Bearer tok', ['k1']);
    expect(s).not.toMatch(/abc123|zzz|k1|tok\b/);
  });
  it('goes live only when enabled and fully configured', () => {
    const env: any = { INTEGRATION_MODE: 'auto', LMS_URL: 'u', LMS_TOKEN: 't' };
    expect(modeFor(env, { integ: { lms: { on: true } } }, 'lms')).toBe('live');
    expect(modeFor(env, { integ: { lms: { on: false } } }, 'lms')).toBe('mock');
    expect(modeFor({ ...env, LMS_TOKEN: '' }, { integ: { lms: { on: true } } }, 'lms')).toBe('mock');
    expect(modeFor({ ...env, INTEGRATION_MODE: 'mock' }, { integ: { lms: { on: true } } }, 'lms')).toBe('mock');
  });
  it('routes AED to Telr and INR to Razorpay', () => {
    expect(gatewayFor('AED')).toBe('telr');
    expect(gatewayFor('INR')).toBe('razorpay');
  });
  it('indexes leads by normalised phone and child records by parent branch', () => {
    expect(normPhone('+971 50-555 0107')).toBe('505550107');
    expect(indexFor('lead', { branch: 'KRM', status: 'Open', cslr: 'S01', phone: '+971 50 555 0107', email: 'A@B.com', enq: 'x' })).toMatchObject({ branch: 'KRM', ref1: '505550107', ref2: 'a@b.com', owner: 'S01' });
    expect(indexFor('task', { lead: 'L1', status: 'Pending', due: 'd' }, () => 'SPC').branch).toBe('SPC');
  });
});

describe('clientIp', () => {
  const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
  it('uses the Cloudflare address when it is a real client', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.5');
  });
  it('behind a local reverse proxy, uses the address the proxy appended', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'cf-connecting-ip': '::1' }))).toBe('::1');
  });
});
