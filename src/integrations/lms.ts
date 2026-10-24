// LOF Booking Platform (LMS) – the two calls from "LOF Booking Platform – what ERPNext sends us" (v3, 19 Sep 2026):
//   enrol  – once per enrolment: student, parent, branch, valid_until and one block per product (Track + exact Credit codes)
//   cancel – reference only; the LMS withdraws whatever is still unused
// One endpoint and one security token (LMS_URL, LMS_TOKEN). No payment, price or refund data is ever sent.
// The endpoint receives JSON with a "call" field. The LMS de-duplicates by "reference", so retries are safe.
import type { Env } from '../types';
import { callApi, logMock, type Mode } from './base';

export interface LmsCtx { env: Env; mode: Mode; isTest?: boolean; flags?: any }
export class LmsError extends Error {}

async function post(c: LmsCtx, call: 'enrol' | 'cancel' | 'ping', body: Record<string, unknown>, ref?: string) {
  const r = await callApi(c.env, {
    integration: 'lms', operation: call, method: 'POST', url: c.env.LMS_URL || '',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + (c.env.LMS_TOKEN || '') },
    body: JSON.stringify({ call, ...body }), ref, secrets: [c.env.LMS_TOKEN], timeoutMs: 30000,
  }, c.isTest);
  if (!r.ok) throw new LmsError(r.status ? `HTTP ${r.status} from the LMS ${call} call${r.json?.error ? ': ' + String(r.json.error).slice(0, 200) : ''}` : `${r.text} (${call})`);
  if (r.json && typeof r.json === 'object' && (r.json.ok === false || r.json.error)) throw new LmsError(`LMS refused the ${call} call: ${String(r.json.error || r.json.message || 'no reason given').slice(0, 200)}`);
  return r.json;
}

export async function enrol(c: LmsCtx, payload: Record<string, unknown>, ref?: string) {
  if (c.mode === 'mock') {
    if (c.flags?.moodleFail) {
      await logMock(c.env, 'lms', 'enrol', payload, { error: 'HTTP 503 (simulated outage)' }, ref, c.isTest, false);
      throw new LmsError('HTTP 503 Service Unavailable (simulated outage – Testing Console)');
    }
    const res = { ok: true, reference: payload.reference, applied: true };
    await logMock(c.env, 'lms', 'enrol', payload, res, ref, c.isTest);
    return res;
  }
  return post(c, 'enrol', payload, ref);
}

export async function cancel(c: LmsCtx, reference: string, ref?: string) {
  if (c.mode === 'mock') {
    if (c.flags?.moodleFail) {
      await logMock(c.env, 'lms', 'cancel', { reference }, { error: 'HTTP 503 (simulated outage)' }, ref, c.isTest, false);
      throw new LmsError('HTTP 503 Service Unavailable (simulated outage – Testing Console)');
    }
    const res = { ok: true, reference, withdrawn: true };
    await logMock(c.env, 'lms', 'cancel', { reference }, res, ref, c.isTest);
    return res;
  }
  return post(c, 'cancel', { reference }, ref);
}

/** Connection test: a ping call (the LMS answers any authorised call; "ping" changes nothing). */
export async function ping(c: LmsCtx) {
  if (c.mode === 'mock') {
    const res = { ok: true, service: 'LOF Booking Platform (mock)' };
    await logMock(c.env, 'lms', 'ping', {}, res, undefined, c.isTest);
    return res;
  }
  return post(c, 'ping', {});
}
