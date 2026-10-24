// One-command Cloudflare deployment (used by .github/workflows/deploy.yml; also runs from any terminal).
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/cf-deploy.mjs [--env staging] [--data masters|demo]
//
// Safe to run again: it creates the database and queues only if missing, applies only new migrations,
// sets JWT_SECRET only if the Worker has none (rotating it would sign everyone out and break two-step codes),
// and creates the administrator only when ADMIN_EMAIL + ADMIN_PASSWORD are given.
// Optional env: APP_BASE_URL (custom domain), ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const envName = arg('env', '');
const data = arg('data', 'masters');
const staging = envName === 'staging';
const DB = staging ? 'lof_crm_staging' : 'lof_crm';
const QUEUES = staging ? ['lof-crm-jobs-staging'] : ['lof-crm-jobs', 'lof-crm-jobs-dlq'];
const WORKER = staging ? 'lof-crm-staging' : 'lof-crm';
const envArgs = envName ? ['--env', envName] : [];
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) { console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID'); process.exit(1); }
if (!['masters', 'demo'].includes(data)) { console.error('--data must be masters or demo'); process.exit(1); }

const wr = (args, opts = {}) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: opts.input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], ...opts });
const step = (s) => console.log('\n▶ ' + s);
const cf = async (path) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { authorization: 'Bearer ' + TOKEN } });
  const j = await r.json();
  if (!j.success) throw new Error(path + ': ' + JSON.stringify(j.errors));
  return j.result;
};

// 1. Database
step(`Database ${DB}`);
let db = JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === DB);
if (!db) { wr(['d1', 'create', DB]); db = JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === DB); console.log('  created'); }
else console.log('  exists');
const toml = readFileSync('wrangler.toml', 'utf8');
writeFileSync('wrangler.toml', toml.replace(staging ? 'REPLACE_WITH_STAGING_D1_DATABASE_ID' : 'REPLACE_WITH_D1_DATABASE_ID', db.uuid));

// 2. Queues
step('Queues');
for (const q of QUEUES) {
  try { wr(['queues', 'create', q]); console.log('  created ' + q); }
  catch (e) { if (/already|exists|11009/i.test(String(e.stderr || e.message))) console.log('  exists ' + q); else throw e; }
}

// 3. Data: masters only (real use) or the prototype's demo data (try-out); only new migrations run
step(`Migrations (${data === 'demo' ? 'demo data' : 'masters only – no demo records, no known passwords'})`);
// A public site never uses the documented demo password: demo logins get a fresh one, printed once
const demoPw = data === 'demo' ? 'Lof-' + randomBytes(9).toString('base64url') + '7' : '';
execFileSync(process.execPath, ['scripts/build-seed.mjs', ...(data === 'masters' ? ['--masters-only'] : [])], { stdio: 'inherit', env: demoPw ? { ...process.env, DEMO_PASSWORD: demoPw } : process.env });
if (demoPw) console.log('  demo staff password (only used the first time the database is set up): ' + demoPw);
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB, '--remote', ...envArgs], { stdio: 'inherit', env: { ...process.env, CI: '1' } });

// 4. Public URL
step('Address');
let url = process.env.APP_BASE_URL;
if (!url) { const sub = await cf(`/accounts/${ACCOUNT}/workers/subdomain`); url = `https://${WORKER}.${sub.subdomain}.workers.dev`; }
console.log('  ' + url);

// 5. Frontend + deploy
step('Deploy');
execFileSync(process.execPath, ['scripts/patch-frontend.mjs'], { stdio: 'inherit' });
execFileSync('npx', ['wrangler', 'deploy', ...envArgs, '--var', `APP_BASE_URL:${url}`], { stdio: 'inherit' });

// 6. Server secret – only when missing
step('Server secret');
const secrets = JSON.parse(wr(['secret', 'list', '--format', 'json', ...envArgs]) || '[]').map((s) => s.name);
if (!secrets.includes('JWT_SECRET')) { wr(['secret', 'put', 'JWT_SECRET', ...envArgs], { input: randomBytes(48).toString('base64') }); console.log('  generated'); }
else console.log('  already set (kept)');

// 7. Administrator – only when asked
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  step('Administrator ' + process.env.ADMIN_EMAIL);
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase().replace(/'/g, "''");
  const found = JSON.parse(wr(['d1', 'execute', DB, '--remote', '--json', '--command', `SELECT staff_id FROM staff_auth WHERE email='${email}'`, ...envArgs]));
  if (found?.[0]?.results?.length) { console.log('  already exists – left unchanged (reset passwords from the CRM)'); }
  else {
  const sql = execFileSync(process.execPath, ['scripts/create-admin.mjs', '--email', process.env.ADMIN_EMAIL, '--name', process.env.ADMIN_NAME || 'System Administrator', '--must-change'], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'lof-'));
  try { writeFileSync(join(dir, 'admin.sql'), sql); wr(['d1', 'execute', DB, '--remote', '--file', join(dir, 'admin.sql'), ...envArgs]); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('  ready – change the password and set up two-step verification at first sign-in');
  }
}

// 8. Check
step('Health check');
for (let i = 0; i < 10; i++) {
  try { const r = await fetch(url + '/health'); const j = await r.json(); if (j.ok) { console.log('  ok', JSON.stringify(j)); break; } } catch {}
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`\n✔ LOF CRM is live at ${url}`);
