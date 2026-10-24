import { test, expect, type Page } from '@playwright/test';

const PASSWORD = process.env.DEMO_PASSWORD || 'Welcome@LOF2026';

/** Sign in through the API (UI sign-in is covered in crm.spec.ts) and open the app. */
async function as(page: Page, email: string) {
  await page.context().clearCookies();
  // page.request shares the browser context's cookie jar, so this signs the page in
  const r = await page.request.post('/api/v1/auth/login', { data: { email, password: PASSWORD }, headers: { 'x-lof-csrf': '1' } });
  expect(r.ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CRM Dashboard' })).toBeVisible();
}
const go = (page: Page, p: string, params: Record<string, string> = {}) => page.evaluate(([p, params]) => (window as any).go(p, params), [p, params] as const);
const noSaveErrors = async (page: Page) => {
  await page.waitForTimeout(400); // the save starts just after the click handler finishes
  await expect(page.locator('#lofSaving')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#toasts .toast.err')).toHaveCount(0);
};

test('Reception records a counter payment and gets a server receipt number', async ({ page }) => {
  await as(page, 'layla.haddad@example.com');
  await go(page, 'payCollect');
  const row = page.locator('[data-act="payPick"]').first();
  await row.click();
  await page.locator('#payf [name=amt]').fill('10');
  await page.locator('#payf [name=method]').selectOption('Cash');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Receipt preview' })).toBeVisible();
  await noSaveErrors(page);
  await page.getByRole('button', { name: 'Close' }).first().click();
  await go(page, 'payRecords');
  await expect(page.locator('table.tbl')).toContainText(/RC-[A-Z]{3}-26-\d{4}/);
});

test('Centre Administrator registers a new student on a 40/30/30 plan; the LMS enrol call completes', async ({ page, request }) => {
  await as(page, 'hassan.ali@example.com');
  await go(page, 'wizard', { mode: 'new' });
  const stamp = Date.now().toString().slice(-6);
  const f = page.locator('#wf1');
  await f.locator('[name=first]').fill('E2E');
  await f.locator('[name=last]').fill('Learner ' + stamp);
  await f.locator('[name=dob]').fill('2015-03-03');
  await f.locator('[name=pname]').fill('E2E Guardian ' + stamp);
  await f.locator('[name=pmob]').fill('+971 50 6' + stamp);
  await f.locator('[name=pemail]').fill(`guardian.${stamp}@example.com`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#wf2 [name=prog]').selectOption('COD');
  await page.locator('#wf2 [name=term]').selectOption('PT3');
  await expect(page.locator('#main')).toContainText('Payment schedule – 40 / 30 / 30');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#wf3 [name=method]').selectOption('Cash');
  await page.getByRole('button', { name: 'Complete enrolment' }).click();
  await expect(page.locator('.sum')).toContainText('Learner ' + stamp);
  await expect(page.locator('#toasts')).toContainText('LMS enrol call succeeded', { timeout: 20_000 });
  await noSaveErrors(page);
  // the server built the schedule, and the first instalment was collected at enrolment
  const enrId = await page.evaluate(() => (0, eval)('S.enr[S.enr.length-1].id'));
  const inst = await (await page.request.get(`/api/v1/enrollments/${enrId}/instalments`)).json();
  expect(inst.term.name).toBe('40 / 30 / 30');
  expect(inst.instalments.map((i: any) => i.st)).toEqual(['Paid', 'Upcoming', 'Upcoming']);
});

test('Management approves a pending exceptional discount', async ({ page }) => {
  await as(page, 'khalid.rahman@example.com');
  await go(page, 'discountQueue');
  const approve = page.locator('[data-act="apDecide"][data-ok="1"]').first();
  test.skip(!(await approve.count()), 'No pending exceptional discount in this database');
  await approve.click();
  await page.getByRole('button', { name: 'Approve' }).last().click();
  await expect(page.locator('#toasts')).toContainText('approved');
  await noSaveErrors(page);
});

test('System Administrator saves SLA configuration', async ({ page }) => {
  await as(page, 'vikram.sethi@example.com');
  await go(page, 'config', { tab: 'sla' });
  await page.locator('[name=mins]').fill('60');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#toasts')).toContainText('SLA & follow-up rules saved');
  await noSaveErrors(page);
});

test('counsellor cannot see another branch’s leads', async ({ page }) => {
  await as(page, 'priya.nair@example.com');
  await go(page, 'leads', { preset: 'all' });
  await expect(page.locator('table.tbl')).not.toContainText('Sports City');
});

test('System Administrator issues a temporary password from Staff & user management', async ({ page, request }) => {
  await as(page, 'vikram.sethi@example.com');
  await page.evaluate(() => (0, eval)("openModal('staff',{id:'S02'})"));
  await page.getByRole('button', { name: 'Issue temporary password' }).click();
  const pw = (await page.locator('.modal p[style*="monospace"]').textContent())!.trim();
  expect(pw).toMatch(/^Lof-/);
  const r = await request.post('/api/v1/auth/login', { data: { email: 'omar.siddiqui@example.com', password: pw } });
  expect((await r.json()).stage).toBe('password_change');
});

test('Centre Administrator withdraws a student: refund suggested from the rules, LMS cancel call sent', async ({ page }) => {
  await as(page, 'hassan.ali@example.com');
  const id = await page.evaluate(() => (0, eval)("(S.enr.find(e=>e.status==='Active'&&e.branch==='KRM'&&e.paid>0)||{}).id"));
  expect(id).toBeTruthy();
  await page.evaluate((x) => (0, eval)(`openModal('withdraw',{id:'${x}'})`), id);
  await page.locator('.modal [name=reason]').fill('E2E – family relocating');
  await page.locator('.modal [name=sessions]').fill('30'); // beyond every rule → suggested 0
  await page.locator('.modal [name=amt]').fill('10');
  await expect(page.locator('#wdSug')).toContainText('exception');
  await page.locator('.modal button[type=submit]').click();
  await expect(page.locator('#toasts')).toContainText('LMS cancel call succeeded', { timeout: 20_000 });
  await noSaveErrors(page);
  await go(page, 'refunds');
  await expect(page.locator('#main')).toContainText('Exception');
  await expect(page.locator('#main')).toContainText('Awaiting Management');
});

test('System Administrator opens the new settings; counsellor sees the monthly target tile and report', async ({ page }) => {
  await as(page, 'vikram.sethi@example.com');
  for (const [tab, text] of [['targets', 'Counsellor targets'], ['payTerms', 'Payment terms'], ['refund', 'Refund calculator'], ['lms', 'Enrol call – sent once per enrolment']]) {
    await go(page, 'config', { tab });
    await expect(page.locator('#main')).toContainText(text);
  }
  await page.getByText('Sample data', { exact: true }).click();
  await expect(page.locator('#main pre').first()).toContainText('"call": "enrol"');
  await as(page, 'priya.nair@example.com');
  await expect(page.locator('.kpi', { hasText: 'My monthly target' })).toBeVisible();
  await go(page, 'reports', { rep: 'r21' });
  await expect(page.locator('#main')).toContainText('Counsellor Target vs Achievement');
  await expect(page.locator('#main')).toContainText('Priya Nair');
});

test('System Administrator checks data in Settings → Database: browse, search, open a record, export CSV', async ({ page }) => {
  await as(page, 'vikram.sethi@example.com');
  await go(page, 'config', { tab: 'database' });
  const main = page.locator('#main');
  await expect(main).toContainText('Read-only view of the live database');
  await page.locator('[data-act=dbPick][data-n=enrollments]').click();
  await expect(main.locator('table.tbl th').first()).toHaveText('id');
  await expect(main.locator('table.tbl')).toContainText('EN-26-0004');
  await page.locator('[name=q]').fill('EN-26-0004');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(main.locator('table.tbl tbody tr')).toHaveCount(1);
  await main.locator('table.tbl tbody tr').first().click();
  await expect(page.locator('.modal')).toContainText('"term": "PT3"');
  await page.locator('.modal').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.locator('[data-act=dbPick][data-n=staff]').click();
  await expect(main.locator('table.tbl')).toContainText('has_login');
  await expect(main).not.toContainText('pbkdf2');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^lof-staff-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.locator('#toasts .toast.err')).toHaveCount(0);
  // Other roles cannot open it
  await as(page, 'priya.nair@example.com');
  expect((await page.request.get('/api/v1/admin/db/tables')).status()).toBe(403);
});
