import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Job } from './types';
import { HttpError } from './types';
import { auth } from './routes/auth';
import { api } from './routes/api';
import { webhooks } from './routes/webhooks';
import { admin } from './routes/admin';
import { testingRoutes } from './routes/testing';
import mail from './routes/mail';
import { cron, queueConsumer } from './jobs';

const app = new Hono<{ Bindings: Env }>();

app.use('*', secureHeaders({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: 'same-origin',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  referrerPolicy: 'strict-origin-when-cross-origin',
  xFrameOptions: 'DENY',
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
}));
app.use('/api/*', cors({ origin: (o, c) => (o && o === new URL((c.env as Env).APP_BASE_URL).origin ? o : null), allowHeaders: ['authorization', 'content-type', 'x-lof-csrf'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE'], credentials: true }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status as any);
  if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
  console.error(err);
  return c.json({ error: 'Internal error', ref: crypto.randomUUID() }, 500);
});

// Refuse to run with a missing or weak server secret
app.use('/api/*', async (c, next) => {
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) return c.json({ error: 'Server is not configured (JWT_SECRET must be at least 32 characters)' }, 500);
  c.header('cache-control', 'no-store');
  c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  await next();
});

app.get('/health', async (c) => {
  const r = await c.env.DB.prepare('SELECT COUNT(*) n FROM sequences').first<{ n: number }>().catch(() => null);
  return c.json({ ok: !!r, db: r ? 'ok' : 'unavailable', env: c.env.APP_ENV, time: new Date().toISOString() }, r ? 200 : 503);
});

app.route('/api/v1/auth', auth);
app.route('/api/v1/testing', testingRoutes(app));
app.route('/api/v1/admin', admin);
app.route('/api/v1/mail', mail);
app.route('/api/v1', api);
app.use('/webhooks/*', async (c, next) => {
  c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  await next();
});
app.route('/webhooks', webhooks);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.get('*', async (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

(globalThis as any).__lofApp = app;

export { app };
export default {
  fetch: app.fetch,
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cron(env, (p) => ctx.waitUntil(p)));
  },
  async queue(batch: MessageBatch<Job>, env: Env) {
    await queueConsumer(batch, env);
  },
} satisfies ExportedHandler<Env, Job>;
