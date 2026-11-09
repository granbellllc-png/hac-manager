import { expect, test } from '@playwright/test';

test('renders the application shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
});

test('renders the audit page with filters and table', async ({ page }) => {
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.getByLabel('Host')).toBeVisible();
  await expect(page.getByLabel('Reason')).toBeVisible();
});
