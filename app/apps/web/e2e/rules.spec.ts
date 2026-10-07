import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

test('a File rule for two channels picked by search, and it is saved', async ({ page }) => {
  await page.goto('/settings/rules');
  await page.getByRole('button', { name: 'Add rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add rule' });
  await dialog.getByLabel('Rule id').fill('product-signals');
  await dialog.getByLabel('Condition').selectOption('channel_in');
  await dialog.getByLabel('Named list').selectOption('');

  // Part of a name, no "#": channels starting with it come first, then ones containing it.
  const search = dialog.getByRole('combobox', { name: 'Channels' });
  await search.fill('prod');
  const options = dialog.getByRole('listbox', { name: 'Channels suggestions' }).getByRole('option');
  await expect(options.first()).toHaveText('#product-leads');
  await expect(options.filter({ hasText: '#meridia-product' })).toBeVisible();
  await search.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove #product-leads' })).toBeVisible();

  await search.fill('MERIDIA');
  await page.screenshot({ path: join(APP, 'screenshots/rules-channel-search-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/rules-channel-search-dark.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await options.filter({ hasText: '#meridia-product' }).click();
  await expect(dialog.getByRole('button', { name: 'Remove #meridia-product' })).toBeVisible();

  // Escape closes the suggestions first, and only then the dialog.
  await search.fill('gen');
  await expect(options).toHaveCount(1);
  await search.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await search.fill('');

  await dialog.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'File' }).click();
  await expect(dialog.getByText('then it goes to File for review')).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/rules-file-outcome-light.png') });
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.locator('[data-rule="product-signals"]');
  await expect(row).toContainText('channel in #product-leads, #meridia-product');
  await expect(row).toContainText('File');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await page.reload();
  await expect(page.locator('[data-rule="product-signals"]')).toContainText('File');
});
