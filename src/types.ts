export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  JOBS?: Queue<Job>;

  APP_ENV: string;
  APP_BASE_URL: string;
  INTEGRATION_MODE: 'auto' | 'mock' | string;
  ALLOW_IMPERSONATION: string;

  /** Server secret (≥ 32 chars): webhook test marker, MFA secret encryption. Name kept for compatibility. */
  JWT_SECRET: string;
  /** Comma-separated roles that must use an authenticator app (TOTP), e.g. "System Administrator,Management". */
  MFA_REQUIRED_ROLES?: string;
  /** Minutes of inactivity before a session ends (default 60). */
  SESSION_IDLE_MINUTES?: string;
  /** Cloudflare Turnstile secret – when set, browser website-form posts must include a valid token. */
  TURNSTILE_SECRET?: string;
  /** Optional comma-separated IPs allowed to call the Exotel webhooks. */
  EXOTEL_ALLOWED_IPS?: string;
  WEBSITE_FORM_SECRET?: string;

  META_GRAPH_VERSION?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  META_PAGE_ACCESS_TOKEN?: string;

  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_TEMPLATE_LANG?: string;

  EXOTEL_SUBDOMAIN?: string;
  EXOTEL_SID?: string;
  EXOTEL_API_KEY?: string;
  EXOTEL_API_TOKEN?: string;
  EXOTEL_CALLER_ID?: string;
  EXOTEL_WEBHOOK_TOKEN?: string;

  LMS_URL?: string;
  LMS_TOKEN?: string;

  TELR_STORE_ID?: string;
  TELR_AUTH_KEY?: string;
  TELR_TEST_MODE?: string;

  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  ERPNEXT_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
  ERPNEXT_COMPANY?: string;
  ERPNEXT_PAID_TO_AED?: string;
  ERPNEXT_PAID_TO_INR?: string;

  GCAL_CALENDAR_ID?: string;
  GCAL_SERVICE_ACCOUNT_JSON?: string;

  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export type Role =
  | 'Counsellor'
  | 'Centre Administrator'
  | 'Admissions Head'
  | 'Reception'
  | 'Management'
  | 'System Administrator';

export interface User {
  id: string;
  name: string;
  role: Role;
  branch: string;
  email: string;
  scope: string[]; // branch IDs this user may see
  isTest?: boolean;
}

export type Job =
  | { kind: 'moodle_sync'; id: string }
  | { kind: 'send_comm'; id: string }
  | { kind: 'send_student_mail'; studentId: string; index: number }
  | { kind: 'erp_payment'; id: string }
  | { kind: 'calendar_event'; taskId: string };

export interface Ctx {
  env: Env;
  /** Schedules background work (Workers waitUntil); tests run it inline. */
  waitUntil: (p: Promise<unknown>) => void;
  user?: User;
  isTest?: boolean;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
