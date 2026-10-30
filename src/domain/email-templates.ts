// E-mail templates (Settings → Email templates): categories, placeholders, defaults, validation and rendering.
// Stored in cfg.emailTpls; the bootstrap shows the defaults until an administrator saves a change.

export const EMAIL_TPL_CATEGORIES = ['Admissions', 'Fees & payments', 'Academic', 'Events & competitions', 'General'] as const;

/** Placeholder → description and the sample value used by the preview. */
export const EMAIL_PLACEHOLDERS: Record<string, { label: string; sample: string }> = {
  parent_name: { label: 'Parent name', sample: 'Aisha Khan' },
  student_name: { label: 'Student name', sample: 'Zayd Khan' },
  student_id: { label: 'Student ID', sample: 'LOF-26-000123' },
  programme: { label: 'Programme', sample: 'Robotics Junior' },
  branch: { label: 'Branch', sample: 'Karama' },
  counsellor: { label: 'Counsellor', sample: 'Priya Nair' },
  date: { label: "Today's date", sample: '29 Oct 2026' },
  amount: { label: 'Amount paid', sample: '1,500.00' },
  currency: { label: 'Currency', sample: 'AED' },
  receipt_no: { label: 'Receipt number', sample: 'RC-KRM-26-0042' },
  payment_date: { label: 'Payment date', sample: '29 Oct 2026' },
  payment_method: { label: 'Payment method', sample: 'Card' },
  balance_due: { label: 'Balance due', sample: '3,000.00' },
  due_date: { label: 'Due date', sample: '15 Nov 2026' },
  payment_link: { label: 'Payment link', sample: 'https://pay.labofuture.example/abc123' },
  event_name: { label: 'Event / competition name', sample: 'LOF Robotics Challenge 2026' },
  event_date: { label: 'Event date', sample: '22 Nov 2026' },
  event_venue: { label: 'Event venue', sample: 'Karama lab' },
  result: { label: 'Result / award', sample: 'Second place' },
  attendance: { label: 'Attendance', sample: '85%' },
  remarks: { label: "Teacher's remarks", sample: 'Great progress with sensors this month.' },
};

export interface EmailTemplate { id: string; cat: string; n: string; subject: string; body: string; branch: string; active: boolean }

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplate[] = [
  { id: 'ET1', cat: 'Admissions', n: 'Document request', branch: 'All', active: true, subject: 'Documents needed for {student_name}',
    body: 'Dear {parent_name},\n\nTo complete the admission of {student_name} to {programme} at Lab of Future {branch}, please send us the remaining documents.\n\nIf you have any questions, {counsellor} will be happy to help.\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET2', cat: 'Fees & payments', n: 'Fee receipt', branch: 'All', active: true, subject: 'Payment received – {student_name} ({receipt_no})',
    body: 'Dear {parent_name},\n\nThank you. We have received {currency} {amount} for {student_name} ({student_id}) on {payment_date} by {payment_method}.\n\nReceipt number: {receipt_no}\nBalance due: {currency} {balance_due}\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET3', cat: 'Fees & payments', n: 'Fee reminder', branch: 'All', active: true, subject: 'Fee reminder – {student_name}, due {due_date}',
    body: 'Dear {parent_name},\n\nThis is a friendly reminder that {currency} {balance_due} for {student_name} ({programme}) is due on {due_date}.\n\nYou can pay online here: {payment_link}\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET4', cat: 'Fees & payments', n: 'Payment overdue', branch: 'All', active: true, subject: 'Overdue payment – {student_name}',
    body: 'Dear {parent_name},\n\nOur records show that {currency} {balance_due} for {student_name} was due on {due_date} and is still outstanding.\n\nPlease pay here: {payment_link}, or contact us if you have already paid.\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET5', cat: 'Academic', n: 'Progress update', branch: 'All', active: true, subject: 'Progress update – {student_name}',
    body: 'Dear {parent_name},\n\nHere is a short update on {student_name} in {programme}.\n\nAttendance: {attendance}\nTeacher remarks: {remarks}\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET6', cat: 'Academic', n: 'Attendance alert', branch: 'All', active: true, subject: 'Attendance – {student_name}',
    body: 'Dear {parent_name},\n\n{student_name} has missed recent sessions of {programme} (attendance {attendance}). Please let us know if we can help, or if you would like to arrange a make-up class.\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET7', cat: 'Events & competitions', n: 'Competition invitation', branch: 'All', active: true, subject: '{event_name} – invitation for {student_name}',
    body: 'Dear {parent_name},\n\nWe are pleased to invite {student_name} to take part in {event_name} on {event_date} at {event_venue}.\n\nPlease reply to this e-mail to confirm participation.\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET8', cat: 'Events & competitions', n: 'Competition result', branch: 'All', active: true, subject: 'Congratulations – {student_name} at {event_name}',
    body: 'Dear {parent_name},\n\nCongratulations! {student_name} achieved {result} at {event_name} on {event_date}.\n\nWe are very proud of this achievement.\n\nKind regards,\nLab of Future {branch}' },
  { id: 'ET9', cat: 'General', n: 'Centre closure notice', branch: 'All', active: true, subject: 'Lab of Future {branch} – closed on {event_date}',
    body: 'Dear {parent_name},\n\nPlease note that Lab of Future {branch} will be closed on {event_date}. Classes for {student_name} will resume as normal afterwards.\n\nKind regards,\nLab of Future {branch}' },
];

const MAX_TEMPLATES = 100;
const placeholdersIn = (s: string) => [...String(s).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);

/** Validates the template list and returns it cleaned (known fields only), or a problem message. */
export function checkEmailTemplates(list: unknown, branchIds: string[]): { problem: string } | { tpls: EmailTemplate[] } {
  if (!Array.isArray(list) || list.length > MAX_TEMPLATES) return { problem: `E-mail templates are invalid (at most ${MAX_TEMPLATES})` };
  const ids = new Set<string>();
  const out: EmailTemplate[] = [];
  for (const t of list as any[]) {
    if (!t || typeof t !== 'object') return { problem: 'E-mail templates are invalid' };
    const name = String(t.n ?? '').trim();
    const where = `E-mail template "${name || t.id}"`;
    if (!/^ET\d{1,4}$/.test(String(t.id)) || ids.has(t.id)) return { problem: `${where} has a missing or duplicate id` };
    ids.add(t.id);
    if (!(EMAIL_TPL_CATEGORIES as readonly string[]).includes(t.cat)) return { problem: `${where} has an unknown category` };
    if (!name || name.length > 80) return { problem: `${where}: the name must be 1–80 characters` };
    const subject = String(t.subject ?? '').trim(), body = String(t.body ?? '');
    if (!subject || subject.length > 200) return { problem: `${where}: the subject must be 1–200 characters` };
    if (!body.trim() || body.length > 10000) return { problem: `${where}: the message must be 1–10,000 characters` };
    const bad = [...placeholdersIn(subject), ...placeholdersIn(body)].find((p) => !EMAIL_PLACEHOLDERS[p]);
    if (bad !== undefined) return { problem: `${where} uses an unknown placeholder {${bad}}` };
    const branch = String(t.branch ?? 'All');
    if (branch !== 'All' && !branchIds.includes(branch)) return { problem: `${where} has an unknown branch` };
    out.push({ id: t.id, cat: t.cat, n: name, subject, body, branch, active: t.active !== false });
  }
  return { tpls: out };
}

/** Fills the placeholders; unknown or missing values become empty text. */
export function renderEmailTemplate(t: Pick<EmailTemplate, 'subject' | 'body'>, values: Record<string, string | number | null | undefined>) {
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => (EMAIL_PLACEHOLDERS[k] ? String(values[k] ?? '') : ''));
  return { subject: fill(t.subject).replace(/[\r\n]+/g, ' '), body: fill(t.body) };
}

/** Picks the active template for a branch: a branch-specific one wins over 'All'. */
export function findEmailTemplate(list: EmailTemplate[] | undefined, name: string, branch: string) {
  const ok = (list ?? DEFAULT_EMAIL_TEMPLATES).filter((t) => t.active && t.n === name);
  return ok.find((t) => t.branch === branch) ?? ok.find((t) => t.branch === 'All') ?? null;
}
