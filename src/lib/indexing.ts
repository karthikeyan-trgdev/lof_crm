// Shared by the Worker and by scripts/build-seed.mjs (Node strips the types), so keep it plain:
// no enums, no parameter properties, no imports.

/** Collection name in the CRM state object → document type stored in D1. */
export const COLLECTIONS: Record<string, string> = {
  branches: 'branch',
  programs: 'program',
  fees: 'fee',
  discounts: 'discount',
  staff: 'staff',
  leads: 'lead',
  opps: 'opp',
  students: 'student',
  enr: 'enrollment',
  pay: 'payment',
  ms: 'moodle_sync',
  refunds: 'refund',
  approvals: 'approval',
  tasks: 'task',
  calls: 'call',
  comms: 'comm',
  notifs: 'notification',
  audit: 'audit',
};
export const TYPE_TO_COLLECTION: Record<string, string> = Object.fromEntries(
  Object.entries(COLLECTIONS).map(([k, v]) => [v, k]),
);
/** Single-document settings in the CRM state object. */
export const SETTINGS_KEYS = ['cfg', 'perms', 'scope', 'fx', 'hist'];

export const normPhone = (p: unknown): string => String(p ?? '').replace(/\D/g, '').slice(-9);

export interface IndexCols {
  branch: string | null;
  status: string | null;
  owner: string | null;
  ref1: string | null;
  ref2: string | null;
  at: string | null;
}

/**
 * Derive the indexed columns for a document. `branchOf` resolves the branch of a related record
 * (lead or enrollment) for documents that do not carry a branch themselves.
 */
export function indexFor(type: string, d: any, branchOf?: (type: string, id: string) => string | null): IndexCols {
  const c: IndexCols = { branch: null, status: null, owner: null, ref1: null, ref2: null, at: null };
  const rel = (t: string, id: string | null | undefined) => (id && branchOf ? branchOf(t, id) : null);
  switch (type) {
    case 'branch': c.branch = d.id; c.status = d.status; break;
    case 'program': c.status = d.active ? 'Active' : 'Inactive'; break;
    case 'fee': c.branch = d.branch; c.ref1 = d.prog; c.status = d.active ? 'Active' : 'Inactive'; c.at = d.from; break;
    case 'discount': c.status = d.active ? 'Active' : 'Inactive'; break;
    case 'staff': c.branch = d.branch; c.status = d.status; c.ref1 = String(d.email || '').toLowerCase(); c.owner = d.role; break;
    case 'lead':
      c.branch = d.branch; c.status = d.status; c.owner = d.cslr || null;
      c.ref1 = normPhone(d.phone) || null; c.ref2 = String(d.email || '').toLowerCase() || null; c.at = d.enq; break;
    case 'opp': c.branch = d.branch; c.status = d.stage; c.owner = d.cslr || null; c.ref1 = d.lead; c.ref2 = d.stu || null; break;
    case 'student': c.branch = d.branch; c.status = d.status; c.at = d.reg; break;
    case 'enrollment': c.branch = d.branch; c.status = d.status; c.ref1 = d.stu; c.ref2 = d.opp || null; c.at = d.date; break;
    case 'payment': c.branch = d.branch; c.status = d.status; c.ref1 = d.enr; c.ref2 = d.stu; c.at = d.at; break;
    case 'moodle_sync': c.branch = rel('enrollment', d.enr); c.status = d.status; c.ref1 = d.enr; c.ref2 = d.stu; c.at = d.last; break;
    case 'refund': c.branch = rel('enrollment', d.enr); c.status = d.status; c.ref1 = d.enr; c.at = d.at; break;
    case 'approval': c.branch = d.branch; c.status = d.status; c.owner = d.by; c.ref1 = d.ref || null; c.at = d.at; break;
    case 'task': c.branch = rel('lead', d.lead); c.status = d.status; c.owner = d.cslr || null; c.ref1 = d.lead; c.at = d.due; break;
    case 'call': c.branch = rel('lead', d.lead); c.status = d.status; c.owner = d.by || null; c.ref1 = d.lead; c.at = d.at; break;
    case 'comm': c.branch = rel('lead', d.lead); c.status = d.status; c.ref1 = d.lead; c.ref2 = d.waMsgId || null; c.at = d.at; break;
    case 'notification': c.branch = d.branch || null; c.status = d.read ? 'read' : 'unread'; c.owner = d.cslr || null; c.at = d.at; break;
    case 'audit': c.ref1 = d.ref || null; c.at = d.at; break;
  }
  return c;
}

/** Human-facing ID formats, keyed by sequence name. */
export const ID_FORMAT: Record<string, (n: number) => string> = {
  lead: (n) => 'LD-26-' + n,
  opp: (n) => 'OP-26-' + String(n).padStart(4, '0'),
  enr: (n) => 'EN-26-' + String(n).padStart(4, '0'),
  pay: (n) => 'PY-26-' + String(n).padStart(4, '0'),
  student: (n) => 'LOF-26-' + String(n).padStart(6, '0'),
  ap: (n) => 'AP-26-' + String(n).padStart(4, '0'),
  rf: (n) => 'RF-26-' + String(n).padStart(4, '0'),
  pd: (n) => 'PD-' + String(n).padStart(2, '0'),
  ms: (n) => 'MS-' + String(n).padStart(3, '0'),
  task: (n) => 'T-' + n,
  call: (n) => 'CL-' + String(n).padStart(3, '0'),
  cm: (n) => 'CM' + n,
  notif: (n) => 'N' + n,
  audit: (n) => 'AU' + n,
  plink: (n) => 'PL-26-' + String(n).padStart(5, '0'),
};
/** Sequences that must stay gapless/human-readable are claimed one at a time; the rest in blocks. */
export const EXACT_SEQS = ['lead', 'opp', 'enr', 'pay', 'student', 'ap', 'rf', 'pd'];
export const BLOCK_SEQS = ['ms', 'task', 'call', 'cm', 'notif', 'audit'];
