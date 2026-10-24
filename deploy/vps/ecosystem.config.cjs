// pm2 process for LOF CRM on a Linux VPS. The Worker runs in Cloudflare's own runtime (workerd, via wrangler) with
// D1, Queues and assets emulated locally; the database is SQLite under LOF_STATE_DIR. nginx proxies to 127.0.0.1:8787.
// See DEPLOY-VPS.md.
const path = require('node:path');

const appDir = path.resolve(__dirname, '..', '..');
const stateDir = process.env.LOF_STATE_DIR || '/var/lib/lof-crm/state';
const envFile = process.env.LOF_ENV_FILE || '/etc/lof-crm/env';
const port = process.env.LOF_PORT || '8787';

module.exports = {
  apps: [{
    name: 'lof-crm',
    cwd: appDir,
    script: path.join(appDir, 'node_modules/wrangler/bin/wrangler.js'),
    args: ['dev', '--ip', '127.0.0.1', '--port', port, '--env-file', envFile, '--persist-to', stateDir,
      '--show-interactive-dev-session=false', '--log-level', 'info'],
    interpreter: 'node',
    env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    kill_timeout: 10000,
  }],
};
