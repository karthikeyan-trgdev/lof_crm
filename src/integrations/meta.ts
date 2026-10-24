// Meta Lead Ads – leadgen webhook + Graph API lead retrieval (Facebook & Instagram lead forms)
import type { Env } from '../types';
import { callApi, logMock, type Mode } from './base';

export interface MetaCtx { env: Env; cfg: any; mode: Mode; isTest?: boolean }

const graph = (env: Env) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v21.0'}`;

export interface LeadgenChange { leadgenId: string; formId?: string; pageId?: string; adId?: string; createdTime?: number }

export function parseLeadgenWebhook(body: any): LeadgenChange[] {
  const out: LeadgenChange[] = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'leadgen') continue;
      const v = ch.value || {};
      out.push({ leadgenId: String(v.leadgen_id), formId: v.form_id && String(v.form_id), pageId: v.page_id && String(v.page_id), adId: v.ad_id && String(v.ad_id), createdTime: v.created_time });
    }
  }
  return out;
}

export async function fetchLead(m: MetaCtx, leadgenId: string, formId?: string) {
  if (m.mode === 'mock') {
    const res = {
      id: leadgenId, created_time: new Date().toISOString(), form_id: formId || 'MOCK_FORM', platform: 'fb', campaign_name: 'Meta Lead Form – AI Coding',
      field_data: [
        { name: 'full_name', values: ['Test Parent'] }, { name: 'student_name', values: ['Test Student'] },
        { name: 'phone_number', values: ['+971505559' + String(Math.floor(Math.random() * 900) + 100)] }, { name: 'email', values: ['test.parent@example.com'] },
      ],
    };
    await logMock(m.env, 'meta', 'leadgen.get', { leadgenId }, res, leadgenId, m.isTest);
    return res;
  }
  const fields = 'created_time,field_data,ad_id,ad_name,campaign_name,form_id,platform';
  const r = await callApi(m.env, {
    integration: 'meta', operation: 'leadgen.get', url: `${graph(m.env)}/${leadgenId}?fields=${fields}&access_token=${encodeURIComponent(m.env.META_PAGE_ACCESS_TOKEN || '')}`,
    ref: leadgenId, secrets: [m.env.META_PAGE_ACCESS_TOKEN],
  }, m.isTest);
  if (!r.ok) throw new Error(r.json?.error?.message || `Graph API HTTP ${r.status}`);
  return r.json;
}

const DEFAULT_MAP: Record<string, string> = {
  full_name: 'parent', parent_name: 'parent', "parent's_name": 'parent', student_name: 'student', child_name: 'student', "child's_name": 'student',
  phone_number: 'phone', phone: 'phone', email: 'email', branch: 'branch', centre: 'branch', programme: 'prog', program: 'prog', course: 'prog', child_age: 'age', age: 'age',
};

/** Map a Graph API lead to CRM lead input. Form-level defaults come from cfg.integ.meta.forms[formId]. */
export function mapLead(cfg: any, lead: any, branches: any[], programs: any[]) {
  const fmap = { ...DEFAULT_MAP, ...(cfg?.integ?.meta?.fieldMap || {}) };
  const out: any = {};
  for (const f of lead.field_data || []) {
    const key = fmap[String(f.name).toLowerCase()];
    if (key) out[key] = (f.values || [])[0];
  }
  const form = cfg?.integ?.meta?.forms?.[lead.form_id] || {};
  const pick = (val: string | undefined, list: any[]) => {
    if (!val) return undefined;
    const v = String(val).toLowerCase();
    return (list.find((x) => x.id.toLowerCase() === v || x.name.toLowerCase() === v || x.name.toLowerCase().includes(v)) || {}).id;
  };
  const branch = pick(out.branch, branches) || form.branch || cfg?.integ?.meta?.defaultBranch || branches.find((b) => b.status === 'Operating')?.id;
  const prog = pick(out.prog, programs) || form.prog || cfg?.integ?.meta?.defaultProg || 'COD';
  return {
    student: out.student || out.parent || 'Meta lead',
    parent: out.parent || out.student || 'Unknown',
    phone: out.phone || '',
    email: out.email || '',
    age: out.age ? +out.age : undefined,
    branch, prog,
    src: lead.platform === 'ig' ? 'Instagram' : 'Facebook',
    camp: form.camp || lead.campaign_name || 'Meta Lead Form',
    cat: form.cat || 'Warm',
    // Meta lead forms include a privacy-policy consent; WhatsApp/e-mail consent follows the form's own question
    wa: form.waConsent !== false, em: form.emailConsent !== false,
    external: { metaLeadId: lead.id, formId: lead.form_id, adId: lead.ad_id },
  };
}

export async function me(m: MetaCtx) {
  if (m.mode === 'mock') {
    const res = { id: 'MOCK_PAGE', name: 'Lab of Future (mock)' };
    await logMock(m.env, 'meta', 'me.get', {}, res, undefined, m.isTest);
    return res;
  }
  const r = await callApi(m.env, { integration: 'meta', operation: 'me.get', url: `${graph(m.env)}/me?fields=id,name&access_token=${encodeURIComponent(m.env.META_PAGE_ACCESS_TOKEN || '')}`, secrets: [m.env.META_PAGE_ACCESS_TOKEN] }, m.isTest);
  if (!r.ok) throw new Error(r.json?.error?.message || `HTTP ${r.status}`);
  return r.json;
}
