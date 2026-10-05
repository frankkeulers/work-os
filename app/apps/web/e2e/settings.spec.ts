import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings & rules' })).toBeVisible();
});

test('J31 validation error shows inline, then saves once fixed', async ({ page }) => {
  const interval = page.getByLabel('Poll every, work hours');
  await interval.fill('0');
  await expect(page.getByText('Unsaved changes. Saving validates both files first.')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Must be more than 0')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 field needs fixing before saving.' })).toBeVisible();
  await expect(interval).toHaveAttribute('aria-invalid', 'true');

  await interval.fill('15');
  await expect(page.getByText('Must be more than 0')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('saved-note')).toContainText('settings.changed logged');
  await expect(page.getByText('Unsaved changes. Saving validates both files first.')).toHaveCount(0);
});

test('J30 add a rule with a bad regex, fix it, reorder and save', async ({ page }) => {
  await page.getByRole('button', { name: 'Add rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add rule' });
  await dialog.getByLabel('Rule id').fill('escalations');
  await dialog.getByLabel('Condition').selectOption('keyword');
  await dialog.getByLabel('Pattern').fill('/esc(alat/i');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog.getByText('Not a valid regular expression')).toBeVisible();
  await dialog.getByLabel('Pattern').fill('/escalat(e|ion)/i');
  await dialog.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Now' }).click();
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toHaveCount(0);

  const rows = page.locator('[data-rule]');
  await expect(rows).toHaveCount(6);
  await expect(rows.last()).toHaveAttribute('data-rule', 'escalations');

  // Keyboard reorder: move the new rule up one place.
  await page.getByRole('button', { name: 'Reorder escalations' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await expect(rows.nth(4)).toHaveAttribute('data-rule', 'escalations');

  await page.getByRole('switch', { name: 'Enable customer-channels' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('saved-note')).toContainText('rules.changed logged');
});

test('leaving with unsaved changes asks first', async ({ page }) => {
  await page.getByRole('switch', { name: 'macOS notifications' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('dialog', { name: 'Leave without saving?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('J32 turning dry-run off asks for confirmation', async ({ page }) => {
  await page.getByRole('switch', { name: 'Dry-run' }).click();
  await expect(page.getByRole('dialog', { name: 'Turn dry-run off?' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn off dry-run' }).click();
  await expect(page.getByRole('switch', { name: 'Dry-run' })).toHaveAttribute('aria-checked', 'false');
});
