// Turns a backup downloaded from Settings → Database (lof-crm-backup-YYYY-MM-DD.json) into SQL for D1.
//
//   node scripts/restore-backup.mjs lof-crm-backup-2026-10-23.json > restore.sql
//   npx wrangler d1 execute lof_crm --remote --file restore.sql      # or --local
//   rm restore.sql
//
// Restore into a database that has the migrations applied but no business records yet (a new account,
// a new staging copy, or a fresh database after a loss – deploy with the default "masters" data). The SQL
// stops before writing anything if leads, enrolments, payments or other business records already exist, so a
// backup is never mixed into live data. Records keep their original version and timestamps. Logins are not in backups:
// create the administrator with scripts/create-admin.mjs and issue temporary passwords from the CRM.
import { readFileSync } from 'node:fs';
import { indexFor, SETTINGS_KEYS } from '../src/lib/indexing.ts';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/restore-backup.mjs <backup.json> > restore.sql'); process.exit(1); }
const b = JSON.parse(readFileSync(file, 'utf8'));
if (b.format !== 'lof-crm-backup/1') { console.error('Not a LOF CRM backup (format lof-crm-backup/1 expected)'); process.exit(1); }

const BUSINESS = ['lead', 'opp', 'approval', 'student', 'enrollment', 'payment', 'moodle_sync', 'refund', 'task', 'call', 'comm'];
const ORDER = ['branch', 'program', 'fee', 'discount', 'staff', 'lead', 'opp', 'approval', 'student', 'enrollment', 'payment', 'moodle_sync', 'refund', 'task', 'call', 'comm', 'notification', 'audit'];
const q = (v) => (v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
const branchIndex = {};
for (const d of b.docs) if (d.type === 'lead' || d.type === 'enrollment') branchIndex[d.type + ':' + d.id] = d.data.branch;
const branchOf = (t, id) => branchIndex[t + ':' + id] ?? null;

const docs = b.docs.slice().sort((x, y) => (ORDER.indexOf(x.type) + 1 || 99) - (ORDER.indexOf(y.type) + 1 || 99));
const out = [`-- LOF CRM restore from ${file} (exported ${b.exportedAt} by ${b.exportedBy})`,
  '-- Guard: fails with "CHECK constraint failed" when the database already holds business records',
  'DROP TABLE IF EXISTS _restore_guard;',
  'CREATE TABLE _restore_guard (existing_business_records INTEGER CHECK (existing_business_records = 0));',
  `INSERT INTO _restore_guard SELECT COUNT(*) FROM docs WHERE type IN (${BUSINESS.map(q).join(',')});`,
  'DROP TABLE _restore_guard;'];
let big = 0;
for (const d of docs) {
  const c = indexFor(d.type, d.data, branchOf);
  const verb = d.type === 'payment' || d.type === 'audit' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
  const version = Number.isInteger(d.version) && d.version > 0 ? d.version : 1;
  const stmt = `${verb} INTO docs (type,id,branch,status,owner,ref1,ref2,at,data,is_test,version,created_at,updated_at,updated_by) VALUES (${[d.type, d.id, c.branch, c.status, c.owner, c.ref1, c.ref2, c.at, JSON.stringify(d.data)].map(q).join(',')},${d.is_test ? 1 : 0},${version},${d.created_at ? q(d.created_at) : "strftime('%Y-%m-%dT%H:%M:%fZ','now')"},${d.updated_at ? q(d.updated_at) : "strftime('%Y-%m-%dT%H:%M:%fZ','now')"},${q(d.updated_by || 'restore')});`;
  if (Buffer.byteLength(stmt) > 90_000) { big++; console.error(`warning: ${d.type} ${d.id} is ${Math.round(Buffer.byteLength(stmt) / 1024)} KB – D1 rejects statements over 100 KB`); }
  out.push(stmt);
}
for (const s of b.settings) if (SETTINGS_KEYS.includes(s.key) || s.key === 'rr_last') out.push(`INSERT OR REPLACE INTO settings (key,data,updated_by) VALUES (${q(s.key)},${q(JSON.stringify(s.data))},'restore');`);
// Never move a counter backwards: a restored number must not be issued again
for (const s of b.sequences) {
  const v = Math.floor(Number(s.value));
  if (!Number.isFinite(v) || !/^[\w-]+$/.test(String(s.name))) { console.error('Invalid sequence in backup: ' + JSON.stringify(s)); process.exit(1); }
  out.push(`INSERT INTO sequences (name,value) VALUES (${q(s.name)},${v}) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value);`);
}
console.log(out.join('\n'));
if (big) console.error(`${big} record(s) may be too large for one statement – see warnings above`);
console.error(`${b.docs.length} records, ${b.settings.length} settings, ${b.sequences.length} sequences`);
