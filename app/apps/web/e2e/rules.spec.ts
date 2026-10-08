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

test('a rule can be limited to Slack or Outlook (every source in Full scope), and conditions those sources cannot check are caught', async ({ page }) => {
  await page.goto('/settings/rules');
  // MVP scope: the rules apply to Slack and Outlook, so those are the sources a rule can be limited to.
  await page.getByRole('button', { name: 'Add rule' }).click();
  const mvp = page.getByRole('dialog', { name: 'Add rule' });
  await mvp.getByRole('group', { name: 'Applies to' }).getByRole('button', { name: 'Only these' }).click();
  await expect(mvp.getByRole('button', { name: 'Slack' })).toHaveAttribute('aria-pressed', 'true');
  await expect(mvp.getByRole('button', { name: 'Outlook' })).toHaveAttribute('aria-pressed', 'false');
  await expect(mvp.getByRole('button', { name: 'Teams' })).toHaveCount(0);
  await mvp.getByLabel('Condition').selectOption('is_dm');
  await expect(mvp.getByLabel('Condition').locator('option[value="is_dm"]')).toHaveText('Is a DM (Slack only)');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-rule="vip-dm"]').getByTestId('rule-sources')).toHaveText('Slack only');
  await expect(page.locator('[data-rule="blockers"]').getByTestId('rule-sources')).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Account' }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-rule="vip-dm"]').getByTestId('rule-sources')).toHaveText('Slack and Teams only');
  await expect(page.locator('[data-rule="blockers"]').getByTestId('rule-sources')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add rule' });
  await dialog.getByLabel('Rule id').fill('outlook-escalations');
  await dialog.getByLabel('Condition').selectOption('channel_in');
  const appliesTo = dialog.getByRole('group', { name: 'Applies to' });
  await appliesTo.getByRole('button', { name: 'Only these' }).click();
  await dialog.getByRole('button', { name: 'Outlook' }).click();
  await dialog.getByRole('button', { name: 'Slack' }).click();
  await expect(dialog.getByRole('button', { name: 'Outlook' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Outlook' })).toBeDisabled(); // the last one can't be turned off
  await expect(dialog.getByText('No chosen source can check every condition.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog.getByText('None of the chosen sources supports every condition')).toBeVisible();

  await dialog.getByLabel('Condition').selectOption('keyword');
  await dialog.getByLabel('Pattern').fill('/escalat/i');
  await expect(dialog.getByText('Can match items from Outlook.')).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/rules-applies-to-light.png') });
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.locator('[data-rule="outlook-escalations"]');
  await expect(row.getByTestId('rule-sources')).toHaveText('Outlook only');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await page.reload();
  await expect(page.locator('[data-rule="outlook-escalations"]').getByTestId('rule-sources')).toHaveText('Outlook only');
  await page.screenshot({ path: join(APP, 'screenshots/rules-sources-list-light.png') });
});
