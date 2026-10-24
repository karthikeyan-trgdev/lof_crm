// Payment gateways: Telr hosted payment page (AED branches) and Razorpay Payment Links (INR branches)
import type { Env } from '../types';
import { basicAuth, callApi, logMock, type Mode } from './base';
import { hmacSha256Hex, safeEqual } from '../lib/crypto';

export interface PayCtx { env: Env; mode: Mode; isTest?: boolean }
export interface LinkInput {
  linkId: string; amount: number; currency: string; description: string;
  customer: { name: string; email?: string; phone?: string };
  returnUrl: string; callbackUrl: string;
}
export interface LinkResult { providerRef: string; url: string; provider: 'telr' | 'razorpay' }

export const gatewayFor = (currency: string): 'telr' | 'razorpay' => (currency === 'INR' ? 'razorpay' : 'telr');

// ---------------- Telr ----------------
const TELR_URL = 'https://secure.telr.com/gateway/order.json';

export async function telrCreate(p: PayCtx, i: LinkInput): Promise<LinkResult> {
  const [forenames, ...rest] = i.customer.name.split(' ');
  const body = {
    method: 'create', store: Number(p.env.TELR_STORE_ID), authkey: p.env.TELR_AUTH_KEY, framed: 0,
    order: { cartid: i.linkId, test: p.env.TELR_TEST_MODE === '0' ? '0' : '1', amount: i.amount.toFixed(2), currency: i.currency, description: i.description },
    return: { authorised: `${i.returnUrl}&result=authorised`, declined: `${i.returnUrl}&result=declined`, cancelled: `${i.returnUrl}&result=cancelled` },
    customer: { email: i.customer.email, phone: i.customer.phone, name: { forenames: forenames || i.customer.name, surname: rest.join(' ') || '-' } },
  };
  if (p.mode === 'mock') {
    const ref = 'MOCKTELR' + Date.now().toString(36).toUpperCase();
    await logMock(p.env, 'telr', 'order.create', { ...body, authkey: '***' }, { order: { ref, url: `${i.returnUrl}&mock=1` } }, i.linkId, p.isTest);
    return { providerRef: ref, url: `${i.returnUrl}&mock=1`, provider: 'telr' };
  }
  const r = await callApi(p.env, { integration: 'telr', operation: 'order.create', method: 'POST', url: TELR_URL, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), ref: i.linkId, secrets: [p.env.TELR_AUTH_KEY] }, p.isTest);
  if (!r.ok || r.json?.error) throw new Error(`Telr: ${r.json?.error?.message || r.status} ${r.json?.error?.note || ''}`.trim());
  return { providerRef: r.json.order.ref, url: r.json.order.url, provider: 'telr' };
}

/** Telr status codes: 3 = paid, 2 = authorised, 1 = pending, -1 expired, -2 cancelled, -3 declined. */
export async function telrCheck(p: PayCtx, ref: string, mockPaid?: { amount: number; currency: string }) {
  if (p.mode === 'mock') {
    const res = mockPaid
      ? { order: { ref, status: { code: 3, text: 'Paid' }, amount: mockPaid.amount.toFixed(2), currency: mockPaid.currency, transaction: { ref: 'MOCKTXN' + Date.now() } } }
      : { order: { ref, status: { code: 1, text: 'Pending' } } };
    await logMock(p.env, 'telr', 'order.check', { ref }, res, ref, p.isTest);
    return normaliseTelr(res);
  }
  const body = { method: 'check', store: Number(p.env.TELR_STORE_ID), authkey: p.env.TELR_AUTH_KEY, order: { ref } };
  const r = await callApi(p.env, { integration: 'telr', operation: 'order.check', method: 'POST', url: TELR_URL, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), ref, secrets: [p.env.TELR_AUTH_KEY] }, p.isTest);
  if (!r.ok || r.json?.error) throw new Error(`Telr: ${r.json?.error?.message || r.status}`);
  return normaliseTelr(r.json);
}
function normaliseTelr(j: any) {
  const code = +j?.order?.status?.code;
  return {
    paid: code === 3 || code === 2,
    final: code === 3 || code === 2 || code < 0,
    status: code === 3 || code === 2 ? 'paid' : code === -1 ? 'expired' : code === -2 ? 'cancelled' : code === -3 ? 'failed' : 'created',
    amount: Number(j?.order?.amount || 0), currency: j?.order?.currency, txnRef: j?.order?.transaction?.ref || j?.order?.ref,
  };
}

// ---------------- Razorpay ----------------
const RZP = 'https://api.razorpay.com/v1';
const rzpAuth = (env: Env) => basicAuth(env.RAZORPAY_KEY_ID || '', env.RAZORPAY_KEY_SECRET || '');

export async function razorpayCreate(p: PayCtx, i: LinkInput): Promise<LinkResult> {
  const body = {
    amount: Math.round(i.amount * 100), currency: i.currency, accept_partial: false, reference_id: i.linkId, description: i.description.slice(0, 2048),
    customer: { name: i.customer.name, email: i.customer.email, contact: i.customer.phone }, notify: { sms: true, email: !!i.customer.email },
    reminder_enable: true, callback_url: i.returnUrl, callback_method: 'get', notes: { crm_link: i.linkId },
  };
  if (p.mode === 'mock') {
    const id = 'plink_MOCK' + Date.now().toString(36);
    await logMock(p.env, 'razorpay', 'payment_links.create', body, { id, short_url: `${i.returnUrl}&mock=1`, status: 'created' }, i.linkId, p.isTest);
    return { providerRef: id, url: `${i.returnUrl}&mock=1`, provider: 'razorpay' };
  }
  const r = await callApi(p.env, { integration: 'razorpay', operation: 'payment_links.create', method: 'POST', url: `${RZP}/payment_links`, headers: { authorization: rzpAuth(p.env), 'content-type': 'application/json' }, body: JSON.stringify(body), ref: i.linkId, secrets: [p.env.RAZORPAY_KEY_SECRET] }, p.isTest);
  if (!r.ok) throw new Error(`Razorpay: ${r.json?.error?.description || r.status}`);
  return { providerRef: r.json.id, url: r.json.short_url, provider: 'razorpay' };
}

export async function razorpayFetchLink(p: PayCtx, id: string) {
  if (p.mode === 'mock') return { status: 'created', amount_paid: 0 };
  const r = await callApi(p.env, { integration: 'razorpay', operation: 'payment_links.get', url: `${RZP}/payment_links/${id}`, headers: { authorization: rzpAuth(p.env) }, ref: id, secrets: [p.env.RAZORPAY_KEY_SECRET] }, p.isTest);
  if (!r.ok) throw new Error(`Razorpay: ${r.json?.error?.description || r.status}`);
  return r.json;
}

export async function razorpayVerifyWebhook(rawBody: string, signature: string | undefined | null, secret: string | undefined) {
  if (!signature || !secret) return false;
  return safeEqual(await hmacSha256Hex(secret, rawBody), signature);
}

export async function razorpayPing(p: PayCtx) {
  if (p.mode === 'mock') {
    await logMock(p.env, 'razorpay', 'payments.list', { count: 1 }, { count: 0 }, undefined, p.isTest);
    return { ok: true, mock: true };
  }
  const r = await callApi(p.env, { integration: 'razorpay', operation: 'payments.list', url: `${RZP}/payments?count=1`, headers: { authorization: rzpAuth(p.env) }, secrets: [p.env.RAZORPAY_KEY_SECRET] }, p.isTest);
  if (!r.ok) throw new Error(r.json?.error?.description || `HTTP ${r.status}`);
  return { ok: true };
}
