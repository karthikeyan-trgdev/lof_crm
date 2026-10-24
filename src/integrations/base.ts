import type { Env } from '../types';

export type Mode = 'live' | 'mock';
export type IntegrationKey = 'website' | 'meta' | 'whatsapp' | 'exotel' | 'lms' | 'telr' | 'razorpay' | 'erpnext' | 'gcal' | 'email';

/** Integration → configuration toggle (cfg.integ.<key>.on) and required secrets/vars. */
export const INTEGRATIONS: Record<IntegrationKey, { label: string; cfgKey: string | null; needs: (keyof Env)[] }> = {
  website: { label: 'Website lead capture', cfgKey: 'web', needs: ['WEBSITE_FORM_SECRET'] },
  meta: { label: 'Meta Lead Ads (Facebook / Instagram)', cfgKey: 'meta', needs: ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_PAGE_ACCESS_TOKEN'] },
  whatsapp: { label: 'WhatsApp Business (Cloud API)', cfgKey: 'wa', needs: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] },
  exotel: { label: 'Telephony – Exotel', cfgKey: 'tel', needs: ['EXOTEL_SID', 'EXOTEL_API_KEY', 'EXOTEL_API_TOKEN', 'EXOTEL_CALLER_ID', 'EXOTEL_WEBHOOK_TOKEN'] },
  lms: { label: 'LMS – LOF Booking Platform', cfgKey: 'lms', needs: ['LMS_URL', 'LMS_TOKEN'] },
  telr: { label: 'Payment gateway – Telr (AED)', cfgKey: 'pay', needs: ['TELR_STORE_ID', 'TELR_AUTH_KEY'] },
  razorpay: { label: 'Payment gateway – Razorpay (INR)', cfgKey: 'pay', needs: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] },
  erpnext: { label: 'ERPNext Accounts', cfgKey: 'erp', needs: ['ERPNEXT_URL', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET', 'ERPNEXT_PAID_TO_AED', 'ERPNEXT_PAID_TO_INR'] },
  gcal: { label: 'Google Calendar', cfgKey: 'cal', needs: ['GCAL_SERVICE_ACCOUNT_JSON', 'GCAL_CALENDAR_ID'] },
  email: { label: 'E-mail (Resend)', cfgKey: null, needs: ['RESEND_API_KEY', 'EMAIL_FROM'] },
};

export function missingSecrets(env: Env, key: IntegrationKey): string[] {
  return INTEGRATIONS[key].needs.filter((n) => !String(env[n] ?? '').trim()) as string[];
}

export function enabledInConfig(cfg: any, key: IntegrationKey): boolean {
  const k = INTEGRATIONS[key].cfgKey;
  return k ? !!cfg?.integ?.[k]?.on : true;
}

/** live = enabled in Configuration + all secrets present + not forced to mock. */
export function modeFor(env: Env, cfg: any, key: IntegrationKey, isTest = false): Mode {
  if (env.INTEGRATION_MODE === 'mock') return 'mock';
  if (isTest && env.APP_ENV === 'production') return 'mock'; // Testing console records never reach live providers in production
  return enabledInConfig(cfg, key) && missingSecrets(env, key).length === 0 ? 'live' : 'mock';
}

export interface ApiCall {
  integration: IntegrationKey;
  operation: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  ref?: string;
  secrets?: (string | undefined)[];
  timeoutMs?: number;
}
export interface ApiResult {
  ok: boolean;
  status: number;
  text: string;
  json: any;
  ms: number;
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…[truncated]' : s);
export function redact(s: string, secrets: (string | undefined)[] = []): string {
  let out = String(s ?? '');
  for (const sec of secrets) if (sec && sec.length >= 4) out = out.split(sec).join('***');
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)(Bearer|Basic|token)\s+[^"',\s]+/gi, '$1$2 ***');
  out = out.replace(/(wstoken=)[^&\s"]+/gi, '$1***').replace(/(access_token=)[^&\s"]+/gi, '$1***').replace(/("authkey"\s*:\s*")[^"]+/gi, '$1***');
  return out;
}

const envSecrets = (env: Env) => Object.entries(env).filter(([k, v]) => typeof v === 'string' && v.length >= 6 && /TOKEN|SECRET|KEY|PASSWORD|AUTH/.test(k) && !/_ID$/.test(k)).map(([, v]) => v as string);

export async function writeLog(
  env: Env,
  e: { integration: string; direction: 'in' | 'out'; operation: string; mode: Mode; method?: string; url?: string; status?: number; ok: boolean; ms?: number; request?: string; response?: string; error?: string; ref?: string; isTest?: boolean },
) {
  const sec = envSecrets(env);
  e = { ...e, url: e.url && redact(e.url, sec), request: e.request && redact(e.request, sec), response: e.response && redact(e.response, sec), error: e.error && redact(e.error, sec) };
  try {
    await env.DB.prepare(
      `INSERT INTO integration_logs (integration,direction,operation,mode,method,url,status,ok,duration_ms,request,response,error,ref,is_test)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(e.integration, e.direction, e.operation, e.mode, e.method ?? null, e.url ?? null, e.status ?? null, e.ok ? 1 : 0, e.ms ?? null,
        e.request ? clip(e.request) : null, e.response ? clip(e.response) : null, e.error ?? null, e.ref ?? null, e.isTest ? 1 : 0)
      .run();
  } catch (err) {
    console.error('integration log write failed', err);
  }
}

/** Outbound HTTP call to a provider, with timeout, JSON parsing and a redacted log entry. */
export async function callApi(env: Env, c: ApiCall, isTest = false): Promise<ApiResult> {
  const t0 = Date.now();
  const method = c.method || 'GET';
  const bodyStr = c.body == null ? '' : typeof c.body === 'string' ? c.body : c.body.toString();
  const secrets = [...(c.secrets || [])];
  let status = 0, text = '', json: any = null, error: string | undefined;
  try {
    const res = await fetch(c.url, { method, headers: c.headers, body: c.body ?? undefined, signal: AbortSignal.timeout(c.timeoutMs ?? 20000) });
    status = res.status;
    text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  } catch (e: any) {
    error = e?.name === 'TimeoutError' ? `Timeout after ${(c.timeoutMs ?? 20000) / 1000}s` : String(e?.message || e);
  }
  const ok = !error && status >= 200 && status < 300;
  await writeLog(env, {
    integration: c.integration, direction: 'out', operation: c.operation, mode: 'live', method, url: redact(c.url, secrets), status, ok, ms: Date.now() - t0,
    request: redact(JSON.stringify({ headers: c.headers || {}, body: bodyStr }), secrets), response: redact(text, secrets), error, ref: c.ref, isTest,
  });
  return { ok, status, text: error ? error : text, json, ms: Date.now() - t0 };
}

/** Log a mock-mode call so the Testing Console shows exactly what would have been sent. */
export async function logMock(env: Env, integration: IntegrationKey, operation: string, request: unknown, response: unknown, ref?: string, isTest = false, ok = true) {
  await writeLog(env, { integration, direction: 'out', operation, mode: 'mock', ok, status: ok ? 200 : 500, ms: 0, request: JSON.stringify(request), response: JSON.stringify(response), ref, isTest });
}

export const basicAuth = (u: string, p: string) => 'Basic ' + btoa(`${u}:${p}`);
