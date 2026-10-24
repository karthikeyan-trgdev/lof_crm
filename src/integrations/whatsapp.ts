// WhatsApp Business Platform – Cloud API (graph.facebook.com)
import type { Env } from '../types';
import { callApi, logMock, type Mode } from './base';
import { hmacSha256Hex, safeEqual } from '../lib/crypto';

export interface WaCtx { env: Env; mode: Mode; isTest?: boolean }

const graph = (env: Env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v21.0'}`;
/** WhatsApp wants the full international number as digits only. */
export const waNumber = (p: string) => String(p || '').replace(/\D/g, '').replace(/^00/, '');

/** Validates X-Hub-Signature-256 (used by both WhatsApp and Meta Lead Ads webhooks). */
export async function verifyHubSignature(rawBody: string, header: string | undefined | null, appSecret: string | undefined) {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + (await hmacSha256Hex(appSecret, rawBody));
  return safeEqual(expected, header);
}

async function send(w: WaCtx, payload: any, ref?: string): Promise<{ id: string }> {
  if (w.mode === 'mock') {
    const id = 'wamid.MOCK' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await logMock(w.env, 'whatsapp', 'messages.send', payload, { messages: [{ id }] }, ref, w.isTest);
    return { id };
  }
  const r = await callApi(w.env, {
    integration: 'whatsapp', operation: 'messages.send', method: 'POST', url: `${graph(w.env)}/${w.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    headers: { authorization: `Bearer ${w.env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), ref,
    secrets: [w.env.WHATSAPP_ACCESS_TOKEN],
  }, w.isTest);
  if (!r.ok) {
    const e = r.json?.error;
    throw new Error(e ? `WhatsApp ${e.code}: ${e.error_data?.details || e.message}` : `WhatsApp HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  }
  return { id: r.json.messages?.[0]?.id };
}

/** Business-initiated message using an approved template (required outside the 24-hour window). */
export function sendTemplate(w: WaCtx, to: string, name: string, lang: string, params: string[], ref?: string) {
  return send(w, {
    messaging_product: 'whatsapp', to: waNumber(to), type: 'template',
    template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [] },
  }, ref);
}

/** Free-form text – only accepted by WhatsApp within 24 h of the parent's last message. */
export function sendText(w: WaCtx, to: string, body: string, ref?: string) {
  return send(w, { messaging_product: 'whatsapp', recipient_type: 'individual', to: waNumber(to), type: 'text', text: { preview_url: false, body } }, ref);
}

export async function phoneNumberInfo(w: WaCtx) {
  if (w.mode === 'mock') {
    const res = { display_phone_number: '+971 4 000 0000 (mock)', verified_name: 'Lab of Future', quality_rating: 'GREEN' };
    await logMock(w.env, 'whatsapp', 'phone_number.get', {}, res, undefined, w.isTest);
    return res;
  }
  const r = await callApi(w.env, {
    integration: 'whatsapp', operation: 'phone_number.get', url: `${graph(w.env)}/${w.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
    headers: { authorization: `Bearer ${w.env.WHATSAPP_ACCESS_TOKEN}` }, secrets: [w.env.WHATSAPP_ACCESS_TOKEN],
  }, w.isTest);
  if (!r.ok) throw new Error(r.json?.error?.message || `HTTP ${r.status}`);
  return r.json;
}

export interface WaWebhookEvents {
  statuses: { id: string; status: string; timestamp?: string; error?: string; recipient?: string }[];
  messages: { id: string; from: string; name?: string; type: string; text: string; timestamp?: string }[];
}
export function parseWebhook(body: any): WaWebhookEvents {
  const out: WaWebhookEvents = { statuses: [], messages: [] };
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const s of v.statuses || []) {
        out.statuses.push({ id: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id, error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}` : undefined });
      }
      for (const m of v.messages || []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type}]`;
        out.messages.push({ id: m.id, from: m.from, name: names[m.from], type: m.type, text, timestamp: m.timestamp });
      }
    }
  }
  return out;
}
