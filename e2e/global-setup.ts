import { execFileSync } from 'node:child_process';

/** Local demo accounts: skip the forced first-login password change and reset sign-in rate limits. */
export default function globalSetup() {
  if (process.env.E2E_BASE_URL) return; // remote environments are prepared separately
  const run = (sql: string) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'lof_crm', '--local', '--command', sql], { stdio: 'ignore' });
  run('UPDATE staff_auth SET must_change=0, failed_count=0, locked_until=NULL');
  run('DELETE FROM rate_limits');
}
