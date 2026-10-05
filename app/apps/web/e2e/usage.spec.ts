import { expect, test } from '@playwright/test';

test('J27/J29 usage page, run eval, open the report', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Claude usage today/ }).click();
  await page.getByRole('dialog', { name: 'Claude usage today' }).getByRole('link', { name: 'Usage & health' }).click();
  await expect(page.getByRole('heading', { name: 'Usage & health', level: 1 })).toBeVisible();
  await expect(page.getByText('Cost-equivalent vs baseline')).toBeVisible();
  await expect(page.locator('[data-criterion="S6"]')).toContainText('People observations in Confluence');

  await page.getByRole('button', { name: 'Run eval' }).click();
  await expect(page.getByRole('button', { name: /Running eval/ })).toBeDisabled();
  await page.getByRole('button', { name: 'View report' }).click({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/usage\/eval\//);
  await expect(page.getByRole('heading', { name: 'Eval report' })).toBeVisible();
  await expect(page.getByText(/Compared with/)).toContainText('2 Oct 2026');
  await expect(page.getByRole('table', { name: 'Attention confusion matrix' })).toBeVisible();
});

test('J28 no baseline yet shows cost-equivalent instead of percentages', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Backquote');
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: /^Start J28 / }).click();
  await expect(page.getByText('Baseline not measured yet.')).toBeVisible();
  await expect(page.getByText('Cost-equivalent today')).toBeVisible();
  await expect(page.locator('[data-criterion="S3"]')).toContainText('Baseline not measured');
});

test('Slack source link opens source health', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Slack/ }).click();
  await expect(page).toHaveURL(/\/usage#health$/);
  await expect(page.getByTestId('slack-health')).toContainText('Healthy');
});
