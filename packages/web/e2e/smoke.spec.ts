import { expect, test } from '@playwright/test';
import { installFixtureApi } from './fixture-api';

test.beforeEach(async ({ page }) => {
  await installFixtureApi(page);
});

test.afterEach(async ({ page }) => {
  const size = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport);
});

test('renders the application shell', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Fixture Host' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('hosts.png'),
    fullPage: true,
  });
});

test('renders the audit page with filters and table', async ({
  page,
}, testInfo) => {
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.getByLabel('Host')).toBeVisible();
  await expect(page.getByLabel('Reason')).toBeVisible();
  await expect(page.getByText('guest.import')).toBeVisible();
  await page.getByRole('button', { name: 'View Diff' }).click();
  await expect(page.getByTestId('diff-viewer')).toContainText('before');
  await page.screenshot({
    path: testInfo.outputPath('audit.png'),
    fullPage: true,
  });
});

test('renders SSH-only host detail and connection test feedback', async ({
  page,
}, testInfo) => {
  await page.goto('/hosts/fixture-host');
  await expect(
    page.getByRole('heading', { name: 'Fixture Host' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Test Connection' }).click();
  await expect(page.getByText('Connected (12ms)')).toBeVisible();
  await expect(page.getByText('2.0 TB')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('host-detail.png'),
    fullPage: true,
  });
});

test('browses resources and preserves YAML comments and tags', async ({
  page,
}, testInfo) => {
  await page.goto('/resources');
  await expect(page.getByRole('heading', { name: 'Resources' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Example LXC' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('1 live guest has');
  await page.getByLabel('Type').selectOption('lxc');
  await expect(
    page.getByRole('heading', { name: 'Unmanaged VM' }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('resources.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: 'View guest' }).click();
  await expect(
    page.getByRole('heading', { name: 'Example LXC' }),
  ).toBeVisible();
  const yaml = page.getByLabel('Example LXC deployment YAML');
  await expect(yaml).toContainText('Fixture comment must remain visible');
  await expect(yaml).toContainText('host.index + 1');
  await page.screenshot({
    path: testInfo.outputPath('guest-detail.png'),
    fullPage: true,
  });
});

test('signs in with a recovery code and signs out', async ({
  page,
}, testInfo) => {
  await page.unroute('**://*/api/**');
  await installFixtureApi(page, 'login');
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('fixture-user');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByLabel(/2FA Code/).fill('abcdef-123456');
  await page.screenshot({
    path: testInfo.outputPath('login.png'),
    fullPage: true,
  });
  const loginRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/auth/login'),
  );
  await page.getByRole('button', { name: 'Sign In' }).click();
  expect((await loginRequest).postDataJSON()).toMatchObject({
    recoveryCode: 'abcdef-123456',
  });
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
});

test('validates first-run setup and creates the initial session', async ({
  page,
}, testInfo) => {
  await page.unroute('**://*/api/**');
  await installFixtureApi(page, 'setup');
  await page.goto('/');
  await page.getByLabel('Password (min 8 characters)').fill('fixture-password');
  await page.getByLabel('Confirm Password').fill('different-fixture-password');
  await page.getByRole('button', { name: 'Create Admin & Sign In' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('setup.png'),
    fullPage: true,
  });
  await page.getByLabel('Confirm Password').fill('fixture-password');
  await page.getByRole('button', { name: 'Create Admin & Sign In' }).click();
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
});
