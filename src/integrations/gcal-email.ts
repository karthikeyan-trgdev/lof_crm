// Google Calendar (service account) and transactional e-mail (Resend)
import type { Env } from '../types';
import { callApi, logMock, type Mode } from './base';
import { signRs256 } from '../lib/crypto';

export interface SimpleCtx { env: Env; mode: Mode; isTest?: boolean }

// ---------------- Google Calendar ----------------
let cachedToken: { token: string; exp: number } | null = null;

async function googleToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const sa = JSON.parse(env.GCAL_SERVICE_ACCOUNT_JSON || '{}');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signRs256({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, sa.private_key);
  const r = await callApi(env, {
    integration: 'gcal', operation: 'oauth.token', method: 'POST', url: 'https://oauth2.googleapis.com/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), secrets: [assertion],
  });
  if (!r.ok) throw new Error(`Google OAuth: ${r.json?.error_description || r.status}`);
  cachedToken = { token: r.json.access_token, exp: Date.now() + r.json.expires_in * 1000 };
  return cachedToken.token;
}

export async function calendarInsert(g: SimpleCtx, ev: { summary: string; description: string; start: string; minutes: number; taskId: string }) {
  const body = {
    summary: ev.summary, description: ev.description,
    start: { dateTime: ev.start, timeZone: 'Asia/Dubai' }, end: { dateTime: new Date(new Date(ev.start).getTime() + ev.minutes * 60000).toISOString(), timeZone: 'Asia/Dubai' },
    extendedProperties: { private: { crmTask: ev.taskId } }, reminders: { useDefault: true },
  };
  if (g.mode === 'mock') {
    const id = 'mockevt' + ev.taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
    await logMock(g.env, 'gcal', 'events.insert', body, { id, status: 'confirmed' }, ev.taskId, g.isTest);
    return { id };
  }
  const token = await googleToken(g.env);
  const r = await callApi(g.env, {
    integration: 'gcal', operation: 'events.insert', method: 'POST', url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(g.env.GCAL_CALENDAR_ID || '')}/events`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ref: ev.taskId, secrets: [token],
  }, g.isTest);
  if (!r.ok) throw new Error(`Google Calendar: ${r.json?.error?.message || r.status}`);
  return { id: r.json.id };
}

export async function calendarPing(g: SimpleCtx) {
  if (g.mode === 'mock') {
    await logMock(g.env, 'gcal', 'calendars.get', {}, { summary: 'LOF follow-ups (mock)' }, undefined, g.isTest);
    return { summary: 'LOF follow-ups (mock)' };
  }
  const token = await googleToken(g.env);
  const r = await callApi(g.env, { integration: 'gcal', operation: 'calendars.get', url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(g.env.GCAL_CALENDAR_ID || '')}`, headers: { authorization: `Bearer ${token}` }, secrets: [token] }, g.isTest);
  if (!r.ok) throw new Error(r.json?.error?.message || `HTTP ${r.status}`);
  return { summary: r.json.summary };
}

// ---------------- E-mail (Resend) ----------------
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function sendEmail(e: SimpleCtx, m: { to: string; subject: string; text: string; ref?: string; fromName?: string; replyTo?: string; bcc?: string }) {
  const base = e.env.EMAIL_FROM || 'Lab of Future <no-reply@labofuture.example>';
  const addr = /<([^>]+)>/.exec(base)?.[1] || base;
  const body: Record<string, unknown> = {
    from: m.fromName ? `${m.fromName.replace(/[<>"\r\n]/g, '')} <${addr}>` : base, to: [m.to], subject: m.subject.replace(/[\r\n]+/g, ' '), text: m.text,
    ...(m.replyTo ? { reply_to: [m.replyTo] } : {}), ...(m.bcc ? { bcc: [m.bcc] } : {}),
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b2633">${esc(m.text).replace(/\n/g, '<br>')}<p style="color:#5d6a7a;font-size:12px;margin-top:24px">Lab of Future</p></div>`,
  };
  if (e.mode === 'mock') {
    const id = 'mock-' + crypto.randomUUID();
    await logMock(e.env, 'email', 'emails.send', body, { id }, m.ref, e.isTest);
    return { id };
  }
  const r = await callApi(e.env, { integration: 'email', operation: 'emails.send', method: 'POST', url: 'https://api.resend.com/emails', headers: { authorization: `Bearer ${e.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ref: m.ref, secrets: [e.env.RESEND_API_KEY] }, e.isTest);
  if (!r.ok) throw new Error(`E-mail: ${r.json?.message || r.status}`);
  return { id: r.json.id };
}

export async function emailPing(e: SimpleCtx) {
  if (e.mode === 'mock') {
    await logMock(e.env, 'email', 'domains.list', {}, { data: [] }, undefined, e.isTest);
    return { domains: 0 };
  }
  const r = await callApi(e.env, { integration: 'email', operation: 'domains.list', url: 'https://api.resend.com/domains', headers: { authorization: `Bearer ${e.env.RESEND_API_KEY}` }, secrets: [e.env.RESEND_API_KEY] }, e.isTest);
  if (!r.ok) throw new Error(r.json?.message || `HTTP ${r.status}`);
  return { domains: (r.json.data || []).length };
}
