// ERPNext / Frappe REST: push CRM receipts to Accounts as Payment Entries against a Customer
import type { Env } from '../types';
import { callApi, logMock, type Mode } from './base';

export interface ErpCtx { env: Env; cfg: any; mode: Mode; isTest?: boolean }

const headers = (env: Env) => ({ authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`, 'content-type': 'application/json', accept: 'application/json' });
const url = (env: Env, path: string) => `${String(env.ERPNEXT_URL || '').replace(/\/+$/, '')}${path}`;
const secrets = (env: Env) => [env.ERPNEXT_API_SECRET, env.ERPNEXT_API_KEY];

const DEFAULT_MODES: Record<string, string> = { Cash: 'Cash', Card: 'Credit Card', UPI: 'UPI', 'Bank transfer': 'Wire Transfer', Cheque: 'Cheque', Online: 'Wire Transfer' };

async function erp(x: ErpCtx, op: string, method: string, path: string, body?: unknown, ref?: string) {
  const r = await callApi(x.env, { integration: 'erpnext', operation: op, method, url: url(x.env, path), headers: headers(x.env), body: body ? JSON.stringify(body) : undefined, ref, secrets: secrets(x.env) }, x.isTest);
  if (!r.ok) {
    let msg = r.json?.exception || r.json?.message || '';
    try { if (r.json?._server_messages) msg = JSON.parse(JSON.parse(r.json._server_messages)[0]).message; } catch { /* keep msg */ }
    throw new Error(`ERPNext ${op}: ${msg || 'HTTP ' + r.status}`);
  }
  return r.json;
}

export async function loggedUser(x: ErpCtx) {
  if (x.mode === 'mock') {
    await logMock(x.env, 'erpnext', 'get_logged_user', {}, { message: 'crm-integration@mock' }, undefined, x.isTest);
    return 'crm-integration@mock';
  }
  return (await erp(x, 'get_logged_user', 'GET', '/api/method/frappe.auth.get_logged_user')).message;
}

export async function ensureCustomer(x: ErpCtx, c: { name: string; phone?: string; email?: string; studentId: string }, ref?: string): Promise<string> {
  const customerName = `${c.name} (${c.studentId})`;
  if (x.mode === 'mock') {
    await logMock(x.env, 'erpnext', 'customer.ensure', { customer_name: customerName }, { name: customerName }, ref, x.isTest);
    return customerName;
  }
  const q = encodeURIComponent(JSON.stringify([['customer_name', '=', customerName]]));
  const found = await erp(x, 'customer.find', 'GET', `/api/resource/Customer?filters=${q}&fields=${encodeURIComponent('["name"]')}`, undefined, ref);
  if (found.data?.length) return found.data[0].name;
  const erpCfg = x.cfg?.integ?.erp || {};
  const created = await erp(x, 'customer.create', 'POST', '/api/resource/Customer', {
    customer_name: customerName, customer_type: 'Individual', customer_group: erpCfg.customerGroup || 'Individual', territory: erpCfg.territory || 'All Territories',
    mobile_no: c.phone, email_id: c.email,
  }, ref);
  return created.data.name;
}

/** Creates the Payment Entry (draft by default so Accounts can review; set cfg.integ.erp.submit = true to post). */
export async function createPaymentEntry(x: ErpCtx, p: any, customer: string, studentName: string): Promise<{ name: string; existing?: boolean }> {
  const erpCfg = x.cfg?.integ?.erp || {};
  const paidTo = p.cur === 'INR' ? x.env.ERPNEXT_PAID_TO_INR : x.env.ERPNEXT_PAID_TO_AED;
  const body = {
    payment_type: 'Receive', company: x.env.ERPNEXT_COMPANY, posting_date: p.at.slice(0, 10), mode_of_payment: (erpCfg.modes || DEFAULT_MODES)[p.method] || p.method,
    party_type: 'Customer', party: customer, paid_amount: p.amt, received_amount: p.amt, paid_to: paidTo, target_exchange_rate: 1,
    reference_no: p.ref && p.ref !== '—' ? p.ref : p.rc, reference_date: p.at.slice(0, 10),
    remarks: `CRM ${p.id} · receipt ${p.rc} · ${studentName} · enrolment ${p.enr}`, docstatus: erpCfg.submit ? 1 : 0,
  };
  if (x.mode === 'mock') {
    const name = 'ACC-PAY-MOCK-' + p.id;
    await logMock(x.env, 'erpnext', 'payment_entry.create', body, { data: { name } }, p.id, x.isTest);
    return { name };
  }
  // Idempotency – the CRM payment id is in the remarks
  const q = encodeURIComponent(JSON.stringify([['remarks', 'like', `%CRM ${p.id} %`]]));
  const found = await erp(x, 'payment_entry.find', 'GET', `/api/resource/Payment Entry?filters=${q}&fields=${encodeURIComponent('["name"]')}`, undefined, p.id);
  if (found.data?.length) return { name: found.data[0].name, existing: true };
  const r = await erp(x, 'payment_entry.create', 'POST', '/api/resource/Payment Entry', body, p.id);
  return { name: r.data.name };
}
