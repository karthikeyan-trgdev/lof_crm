import { test, expect, type Page } from '@playwright/test';

const PASSWORD = process.env.DEMO_PASSWORD || 'Welcome@LOF2026';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'CRM Dashboard' })).toBeVisible();
  // The session lives in an HttpOnly cookie – nothing readable by page scripts
  expect(await page.evaluate(() => document.cookie)).not.toContain('lof_session');
}

test('counsellor creates a lead and it is saved on the server', async ({ page, request }) => {
  await signIn(page, 'priya.nair@example.com');
  await page.getByRole('button', { name: 'New lead' }).first().click();
  const stamp = Date.now().toString().slice(-6);
  await page.getByLabel('Student / prospect name').fill('E2E Student ' + stamp);
  await page.getByLabel('Parent / guardian name').fill('E2E Parent');
  await page.getByLabel('Mobile number').fill('+971 50 8' + stamp);
  await page.getByLabel('Programme / course interest').selectOption('SPA');
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.locator('.sum')).toContainText('E2E Student ' + stamp);

  const login = await request.post('/api/v1/auth/login', { data: { email: 'priya.nair@example.com', password: PASSWORD } });
  const { token } = await login.json();
  const leads = async () => (await request.get('/api/v1/leads?q=' + stamp, { headers: { authorization: 'Bearer ' + token } })).json();
  await expect.poll(async () => (await leads()).items.length).toBe(1);
  const body = await leads();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ prog: 'SPA', branch: 'KRM', src: 'Manual' });

  // Close the lead again so repeated runs don't fill counsellor workload
  await page.getByRole('button', { name: 'Mark as lost' }).click();
  await page.getByLabel('Lost reason').selectOption('Other');
  await page.getByRole('button', { name: 'Mark as lost' }).last().click();
  await expect.poll(async () => (await (await request.get('/api/v1/leads?q=' + stamp, { headers: { authorization: 'Bearer ' + token } })).json()).items[0].status).toBe('Lost');
});

test('counsellor cannot open configuration', async ({ page }) => {
  await signIn(page, 'priya.nair@example.com');
  await expect(page.locator('.nav')).not.toContainText('Settings');
  await page.evaluate(() => (window as any).go('config'));
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
});

test('administrator runs the end-to-end scenario from the Testing console', async ({ page }) => {
  await signIn(page, 'vikram.sethi@example.com');
  await page.locator('.nav').getByText('Settings').click();
  await page.locator('.tabs').getByText('Testing console').click();
  await expect(page.getByRole('heading', { name: 'Integration readiness' })).toBeVisible();
  const card = page.locator('.card', { hasText: 'UAE: enquiry → enrolment → Telr payment' }).last();
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(card).toContainText('Passed', { timeout: 30_000 });
  await expect(card).toContainText('Payment pushed to ERPNext');
});

test('signing out clears the data from the page and the screen keeps working', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, 'priya.nair@example.com');
  await page.evaluate(() => (0, eval)('ACT.logout()'));
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => (0, eval)('S'))).toBeNull();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  // no leftover prototype wording once signed back in
  await signIn(page, 'vikram.sethi@example.com');
  await page.evaluate(() => (window as any).go('refunds'));
  await expect(page.locator('#app')).not.toContainText('simulated');
});
