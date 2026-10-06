import { expect, test, type Page } from '@playwright/test';

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
