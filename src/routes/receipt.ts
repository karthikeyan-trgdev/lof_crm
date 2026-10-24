import { money } from '../domain/core';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fdt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Printable receipt (browser "Save as PDF"). Tax-invoice wording depends on the branch's VAT/GST registration. */
export function receiptHtml(p: any, e: any, s: any, b: any, programs: any[]) {
  const prog = (programs.find((x) => x.id === e?.prog) || { name: e?.prog }).name;
  const bal = e ? Math.max(0, e.total - e.paid) : 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${esc(p.rc)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1b2633;margin:0;background:#f3f5f9}
.r{max-width:640px;margin:24px auto;background:#fff;border:1px solid #e1e6ee;border-radius:8px;padding:28px}
h1{margin:0;font-size:20px;color:#1d3557}.m{color:#5d6a7a;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td{padding:7px 0;border-bottom:1px solid #edf0f5}td:last-child{text-align:right}
.t td{font-weight:700;border-bottom:0;font-size:16px}.n{font-size:11px;color:#8793a3;margin-top:20px}
@media print{body{background:#fff}.r{border:0;margin:0}}
</style></head><body><div class="r">
<h1>Lab of Future</h1><div class="m">${esc(b?.name || p.branch)} · ${esc(b?.address || '')} · ${esc(b?.phone || '')}</div>
<h2 style="font-size:15px;margin:18px 0 0">Payment receipt <span style="font-family:monospace">${esc(p.rc)}</span></h2>
<table>
<tr><td>Date</td><td>${esc(fdt(p.at))}</td></tr>
<tr><td>Student</td><td>${esc(s ? s.first + ' ' + s.last : '')} (${esc(p.stu)})</td></tr>
<tr><td>Parent / guardian</td><td>${esc(s?.parents?.[0]?.name || '')}</td></tr>
<tr><td>Programme</td><td>${esc(prog)} · ${esc(e?.pkg || '')}</td></tr>
<tr><td>Enrolment</td><td>${esc(p.enr)}</td></tr>
<tr><td>Payment method</td><td>${esc(p.method)}${p.ref && p.ref !== '—' ? ' · ' + esc(p.ref) : ''}</td></tr>
<tr class="t"><td>Amount received</td><td>${esc(money(p.amt, p.cur))}</td></tr>
<tr><td>Balance after this payment</td><td>${esc(money(bal, p.cur))}</td></tr>
</table>
<div class="n">Payment ID ${esc(p.id)}${p.erp?.name ? ' · ERPNext ' + esc(p.erp.name) : ''}. This receipt acknowledges payment received; tax invoices are issued from ERPNext Accounts.</div>
<p class="n">To print or save as PDF, use your browser's Print command (Ctrl+P / ⌘P).</p>
</div></body></html>`;
}
