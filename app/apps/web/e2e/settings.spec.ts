import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Changes saved' });

const open = async (page: Page, section: string) => {
  await page.goto(`/settings/${section}`);
  await expect(page.getByRole('heading', { name: 'Settings & rules' })).toBeVisible();
};
const sectionNav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });

test('/settings and old anchors open the right section', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/rules$/);
  await page.goto('/settings#budgets');
  await expect(page).toHaveURL(/\/settings\/budgets$/);
  await expect(page.getByRole('heading', { name: 'Budgets', level: 2 })).toBeVisible();
});

test('J31 changes save on their own; an invalid field shows inline and is held back', async ({ page }) => {
  await open(page, 'slack');
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  const interval = page.getByLabel('Poll every, work hours');
  await interval.fill('0');
  await expect(page.getByText('Must be more than 0')).toBeVisible();
  await expect(interval).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('saved-note')).toContainText('1 field not saved');

  // Another section is a click away, and a valid change there still saves while the bad field is held back.
  await expect(sectionNav(page).getByRole('link', { name: /Slack/ })).toContainText('has an unsaved field');
  await sectionNav(page).getByRole('link', { name: 'Notifications' }).click();
  await page.getByRole('switch', { name: 'macOS notifications' }).click();
  await expect(saved(page)).toBeVisible();

  await sectionNav(page).getByRole('link', { name: /Slack/ }).click();
  await expect(interval).toHaveValue('0');
  await interval.fill('15');
  await expect(page.getByText('Must be more than 0')).toHaveCount(0);
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');

  await page.reload();
  await expect(page.getByLabel('Poll every, work hours')).toHaveValue('15');
  await sectionNav(page).getByRole('link', { name: 'Notifications' }).click();
  await expect(page.getByRole('switch', { name: 'macOS notifications' })).toHaveAttribute('aria-checked', 'false');
});

test('Undo in the saved toast puts the change back', async ({ page }) => {
  await open(page, 'slack');
  await page.getByRole('button', { name: 'Remove Matt M.' }).click();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Change undone' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove Matt M.' })).toBeVisible();
});

test('J30 add a rule with a bad regex, fix it, reorder, and it is saved', async ({ page }) => {
  await open(page, 'rules');
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
  await expect(saved(page)).toBeVisible();

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
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');

  await page.reload();
  await expect(page.locator('[data-rule]').nth(4)).toHaveAttribute('data-rule', 'escalations');
  await expect(page.getByRole('switch', { name: 'Enable customer-channels' })).toHaveAttribute('aria-checked', 'true');
});

test('leaving with an invalid field asks first; valid changes never do', async ({ page }) => {
  await open(page, 'storage');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await page.getByLabel('Retention days').fill('');
  await nav.getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('dialog', { name: 'Leave with unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/settings\/storage$/);

  await page.getByLabel('Retention days').fill('14');
  // Leaving straight after typing still saves: the change is flushed as the page closes.
  await nav.getByRole('link', { name: /Inbox/ }).click();
  // The inbox opens its item panel, so only the path is fixed.
  await expect(page).toHaveURL((u) => u.pathname === '/');
  await nav.getByRole('link', { name: /Settings/ }).click();
  await sectionNav(page).getByRole('link', { name: 'Storage & data' }).click();
  await expect(page.getByLabel('Retention days')).toHaveValue('14');
});

test('J32 turning dry-run off asks for confirmation, then saves', async ({ page }) => {
  await open(page, 'writing');
  await expect(sectionNav(page).getByRole('link', { name: /Write targets/ })).toContainText('Dry-run');
  await page.getByRole('switch', { name: 'Dry-run' }).click();
  await expect(page.getByRole('dialog', { name: 'Turn dry-run off?' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn off dry-run' }).click();
  await expect(page.getByRole('switch', { name: 'Dry-run' })).toHaveAttribute('aria-checked', 'false');
  await expect(saved(page)).toBeVisible();
  await expect(sectionNav(page).getByRole('link', { name: /Write targets/ })).not.toContainText('Dry-run');
});

test('J41 edit a prompt, save it, and reset it to the default; leaving with an unsaved edit asks first', async ({ page }) => {
  await open(page, 'prompts');
  await expect(page.getByRole('heading', { name: 'Prompts', level: 2 })).toBeVisible();
  const row = page.locator('[data-prompt="vault-conventions"]');
  await expect(row).toContainText('vault-conventions v2#');
  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();

  const text = page.getByLabel('Vault conventions text');
  await expect(text).toHaveValue(/^<!-- prompt: vault-conventions v2 -->/);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled(); // nothing changed yet
  await text.fill('<!-- prompt: vault-conventions v3 -->\nFile meetings under Work/Meetings.');

  // An unsaved edit holds the page.
  await sectionNav(page).getByRole('link', { name: 'Models' }).click();
  const leave = page.getByRole('dialog', { name: 'Leave with unsaved changes?' });
  await expect(leave).toContainText('Vault conventions');
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts$/);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Vault conventions saved' })).toBeVisible();
  await expect(row).toContainText('vault-conventions v3#');
  await expect(page.getByRole('main').getByText('Edited', { exact: true })).toHaveCount(1);

  // Cancel drops an edit.
  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  await page.getByLabel('Vault conventions text').fill('Throwaway');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v3#');

  // Reset asks first, then the default is back.
  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('dialog', { name: 'Reset Vault conventions?' }).getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v2#');
});

test('the Models section shows each call’s prompt version and links to Prompts', async ({ page }) => {
  await open(page, 'models');
  await page.getByRole('link', { name: /^draft-vault v2#/ }).click();
  await expect(page).toHaveURL(/\/settings\/prompts$/);
});

test('a guidance file whose source changed says so until it is marked reviewed (FR-1.7)', async ({ page }) => {
  await open(page, 'prompts');
  await expect(page.getByRole('main').getByText('Source changed')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit Confluence routing' }).click();
  await expect(page.getByTestId('prompt-sources')).toContainText('The psg-context-builder skill changed since this was written');
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Confluence routing marked reviewed' })).toBeVisible();
  await expect(page.getByTestId('prompt-sources')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('main').getByText('Source changed')).toHaveCount(0);
});

test('channel fields in Settings › Slack search the channels you’re in', async ({ page }) => {
  await open(page, 'slack');
  const search = page.getByRole('combobox', { name: 'App channels' });
  await search.fill('insig');
  const options = page.getByRole('listbox', { name: 'App channels suggestions' }).getByRole('option');
  await expect(options).toHaveText(['#insights-api']); // channels only: not the "Insights APIs roadmap review" meeting
  await page.screenshot({ path: join(APP, 'screenshots/settings-slack-channel-search-light.png') });
  await search.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove #insights-api' })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove #insights-api' })).toBeVisible();
  for (const name of ['Customer channels', 'Include channels', 'Exclude channels']) await expect(page.getByRole('combobox', { name })).toBeVisible();
});

test('VIPs are picked from a search of people', async ({ page }) => {
  await open(page, 'slack');
  const search = page.getByRole('combobox', { name: 'VIPs' });
  await search.fill('meri');
  const options = page.getByRole('listbox', { name: 'VIPs suggestions' }).getByRole('option');
  await expect(options).toHaveText(['Meridia PM']);
  await page.screenshot({ path: join(APP, 'screenshots/settings-slack-vip-search-light.png') });
  await search.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove Meridia PM' })).toBeVisible();
  // People already VIPs aren't offered again.
  await search.fill('matt');
  await expect(options).toHaveCount(0);
  await search.fill('');
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove Meridia PM' })).toBeVisible();
});

test('J42 the Confluence scope: preview the live catalogue, add a root page, exclude a subtree', async ({ page }) => {
  await open(page, 'writing');
  await expect(page.getByRole('heading', { name: 'Confluence scope' })).toBeVisible();
  await expect(page.getByLabel('Site')).toHaveValue('https://pole-star.atlassian.net');
  const roots = page.getByLabel('Root pages', { exact: true });
  await expect(roots).toContainText('Data Products (DP)');

  // The preview reads the catalogue as the next draft would: roots and below, labelled pages.
  await page.getByRole('button', { name: 'Preview catalogue' }).click();
  const list = page.getByLabel('Pages in scope');
  await expect(page.getByText(/^\d+ pages in scope$/)).toBeVisible();
  await expect(list.locator('[data-page="31000051"]')).toContainText('Shared › Data Assets & Licensing'); // by label
  await expect(list.locator('[data-page="31000001"]')).toContainText('index');
  await expect(list.locator('[data-page="31000052"]')).toHaveCount(0);
  await list.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(APP, 'screenshots/settings-confluence-scope-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/settings-confluence-scope-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  // A new root, by URL: its pages join the catalogue.
  await page.getByRole('button', { name: 'Add root page by ID or URL' }).click();
  const form = page.getByRole('form', { name: 'Add root page' });
  await form.getByLabel('Title').fill('Shared');
  await form.getByLabel('Page ID or URL').fill('https://pole-star.atlassian.net/wiki/spaces/PRD/pages/31000005/Shared');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect(roots).toContainText('31000005');
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(list.locator('[data-page="31000052"]')).toBeVisible();

  // Excluding a page takes everything below it out.
  await page.getByRole('button', { name: 'Add excluded page by ID or URL' }).click();
  const ex = page.getByRole('form', { name: 'Add excluded page' });
  await ex.getByLabel('Title').fill('Competitor Profiles');
  await ex.getByLabel('Page ID or URL').fill('31000004');
  await ex.getByRole('button', { name: 'Add' }).click();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(list.locator('[data-page="31000041"]')).toHaveCount(0);

  // Labels: a bad one is held back, a good one is saved.
  await page.getByLabel('New label').fill('Bad Label');
  await page.getByRole('button', { name: 'Add label' }).click();
  await expect(page.getByText('Labels are lower case, without spaces')).toBeVisible();
  await page.getByLabel('New label').fill('psg-shared-glossary');
  await page.getByRole('button', { name: 'Add label' }).click();
  await expect(page.getByRole('button', { name: 'Remove label psg-shared-glossary' })).toBeVisible();
  await expect(page.getByTestId('saved-note')).not.toContainText('Saving');
  await expect(page.getByTestId('saved-note')).not.toContainText('not saved');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove label psg-shared-glossary' })).toBeVisible();
  await expect(page.getByLabel('Excluded pages', { exact: true })).toContainText('Competitor Profiles');
});
