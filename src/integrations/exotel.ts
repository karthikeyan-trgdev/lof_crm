// Exotel telephony: click-to-call (connect agent → customer), call status callbacks, incoming-call passthru
import type { Env } from '../types';
import { basicAuth, callApi, logMock, type Mode } from './base';

export interface ExoCtx { env: Env; mode: Mode; isTest?: boolean }

const base = (env: Env) => `https://${env.EXOTEL_SUBDOMAIN || 'api.exotel.com'}/v1/Accounts/${env.EXOTEL_SID}`;
const auth = (env: Env) => basicAuth(env.EXOTEL_API_KEY || '', env.EXOTEL_API_TOKEN || '');

/** Exotel dials the agent first (From), then bridges to the customer (To). */
export async function clickToCall(x: ExoCtx, agentNumber: string, customerNumber: string, statusCallback: string, ref?: string) {
  const form = new URLSearchParams({
    From: agentNumber, To: customerNumber, CallerId: x.env.EXOTEL_CALLER_ID || '', CallType: 'trans', Record: 'true',
    StatusCallback: statusCallback, 'StatusCallbackEvents[0]': 'terminal', StatusCallbackContentType: 'application/json',
  });
  if (x.mode === 'mock') {
    const sid = 'MOCK' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    await logMock(x.env, 'exotel', 'calls.connect', Object.fromEntries(form), { Call: { Sid: sid, Status: 'in-progress' } }, ref, x.isTest);
    return { sid, status: 'in-progress' };
  }
  const r = await callApi(x.env, {
    integration: 'exotel', operation: 'calls.connect', method: 'POST', url: `${base(x.env)}/Calls/connect.json`,
    headers: { authorization: auth(x.env), 'content-type': 'application/x-www-form-urlencoded' }, body: form, ref,
    secrets: [x.env.EXOTEL_API_TOKEN, x.env.EXOTEL_API_KEY],
  }, x.isTest);
  if (!r.ok) throw new Error(r.json?.RestException?.Message || `Exotel HTTP ${r.status}`);
  return { sid: r.json?.Call?.Sid, status: r.json?.Call?.Status };
}

export async function accountInfo(x: ExoCtx) {
  if (x.mode === 'mock') {
    const res = { Sid: 'mock', Status: 'active' };
    await logMock(x.env, 'exotel', 'account.get', {}, res, undefined, x.isTest);
    return res;
  }
  const r = await callApi(x.env, { integration: 'exotel', operation: 'account.get', url: `${base(x.env)}.json`, headers: { authorization: auth(x.env) }, secrets: [x.env.EXOTEL_API_TOKEN, x.env.EXOTEL_API_KEY] }, x.isTest);
  if (!r.ok) throw new Error(r.json?.RestException?.Message || `HTTP ${r.status}`);
  return r.json?.Account || r.json;
}

/** Normalise a status callback (JSON or form) into CRM terms. */
export function parseStatus(p: Record<string, any>) {
  const st = String(p.Status || p.status || p.CallStatus || '').toLowerCase();
  const map: Record<string, string> = { completed: 'Completed', busy: 'Busy', 'no-answer': 'Not answered', failed: 'Failed', canceled: 'Not answered', cancelled: 'Not answered' };
  const legs = p.Legs || p.legs;
  const dur = +(p.ConversationDuration ?? p.conversation_duration ?? p.Duration ?? p.duration ?? 0);
  return {
    sid: String(p.CallSid || p.call_sid || p.Sid || ''),
    status: map[st] || (st ? st[0].toUpperCase() + st.slice(1) : 'Unknown'),
    durationMin: Math.round((dur / 60) * 10) / 10,
    recordingUrl: p.RecordingUrl || p.recording_url || '',
    from: p.From || p.CallFrom || '', to: p.To || p.CallTo || '',
    answered: st === 'completed' && (dur > 0 || !legs),
  };
}
