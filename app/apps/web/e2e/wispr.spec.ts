import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

// Wispr Flow (R2.7): connect in Settings, and its meetings reach the inbox like any thread.

const itemPanel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const meetingRow = (page: Page) => page.locator('[data-row]').filter({ hasText: 'tier comparison' });
/** Clears the toasts, so a screenshot shows the page under them. */
async function dismissToasts(page: Page) {
  const close = page.getByRole('status').getByRole('button', { name: 'Dismiss' });
  while (await close.count()) await close.first().click();
}

async function connect(page: Page) {
  await page.goto('/settings/wispr');
  await expect(page.getByRole('heading', { name: 'Wispr Flow', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
}

test('Settings › Wispr Flow connects, sets its own schedule, and disconnects after asking', async ({ page }) => {
  await page.goto('/settings/wispr');
  await expect(page.getByText('Not connected')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Wispr Flow meetings' })).toBeDisabled();

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Wispr Flow meetings' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();

  // Every 3 hours in work hours, and not outside them, until Frank says otherwise.
  await expect(page.getByLabel('Wispr Flow: poll every, work hours')).toHaveValue('180');
  const offHours = page.getByRole('switch', { name: 'Wispr Flow: poll outside work hours' });
  await expect(offHours).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Wispr Flow: poll every, off hours')).toHaveCount(0);
  await offHours.click();
  await expect(page.getByLabel('Wispr Flow: poll every, off hours')).toHaveValue('180');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await offHours.click();
  await expect(page.getByLabel('Wispr Flow: poll every, off hours')).toHaveCount(0);
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved'); // a save still under way would turn the source back on

  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/settings-wispr-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/settings-wispr-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await page.getByRole('button', { name: 'Disconnect' }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect Wispr Flow?' });
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Not connected')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Wispr Flow meetings' })).toHaveAttribute('aria-checked', 'false');
});

test('a Wispr Flow meeting lands in the inbox after Connect, with its action items and no P2 tag', async ({ page }) => {
  await page.goto('/');
  await expect(meetingRow(page)).toHaveCount(0);

  await connect(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const row = meetingRow(page);
  await expect(row).toBeVisible({ timeout: 10_000 }); // the poll after Connect, then triage
  await expect(row).toHaveAttribute('data-lane', 'today');
  await expect(row.getByRole('img', { name: 'Wispr Flow' })).toBeVisible();

  await row.click();
  const panel = itemPanel(page);
  await expect(panel.getByText('Send the tier comparison to Finance · due Fri 9 Oct')).toBeVisible();
  await expect(panel.getByText('Pilots renew on the per-vessel tier.', { exact: false }).first()).toBeVisible();
  await expect(panel.getByText('P2', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'From the meeting notes' })).toBeVisible();
  // Wispr Flow's Markdown headings show as headings, without their hashes.
  await expect(panel.getByText('Next Steps', { exact: true })).toBeVisible();
  await expect(panel.getByText('### Next Steps')).toHaveCount(0);
  // The sidebar lists Wispr Flow with Slack once it's on.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Wispr/ })).toContainText('just now');
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-meeting-light.png') });
});
