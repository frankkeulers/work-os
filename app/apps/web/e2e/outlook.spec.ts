import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Rows that arrive while the item panel is open wait behind a "N new" pill (CK-1.2): show them. */
async function showNew(page: Page, row: Locator) {
  const pills = page.locator('[data-new-pill]');
  await expect(row.or(pills).first()).toBeVisible({ timeout: 10_000 });
  for (const p of await pills.all()) if (await p.isVisible()) await p.click();
}

const APP = join(import.meta.dirname, '../../..');

// Outlook (R2.5): connect in Settings through the claude.ai Microsoft 365 connector, and its mail
// reaches the inbox like any thread, one item per conversation.

const itemPanel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const emailRow = (page: Page, text: string) => page.locator('[data-row^="outlook:"]').filter({ hasText: text });
/** Clears the toasts, so a screenshot shows the page under them. */
async function dismissToasts(page: Page) {
  const close = page.getByRole('status').getByRole('button', { name: 'Dismiss' });
  while (await close.count()) await close.first().click();
}

async function connect(page: Page) {
  await page.goto('/settings/outlook');
  await expect(page.getByRole('heading', { name: 'Outlook', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('outlook-account')).toHaveText('Frank Keulers · frank.keulers@polestarglobal.example');
}

test('Settings › Outlook connects through the connector, sets its own schedule, and disconnects after asking', async ({ page }) => {
  await page.goto('/settings/outlook');
  await expect(page.getByText('Not connected')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toBeDisabled();

  // An entered ID claude.ai doesn't have says so, in place, and connects nothing.
  await page.getByRole('button', { name: 'Enter the connector ID instead' }).click();
  await page.getByLabel('Connector ID').fill('mcpsrv_01NotThisOne');
  await page.getByRole('button', { name: 'Connect with ID' }).click();
  await expect(page.getByText('claude.ai has no connector with that ID, or it is signed out.')).toBeVisible();
  await expect(page.getByText('Not connected')).toBeVisible();

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('outlook-account')).toHaveText('Frank Keulers · frank.keulers@polestarglobal.example');
  await expect(page.getByText('claude.ai has no connector with that ID')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('New email is read on the schedule below.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();

  // Every 30 minutes in work hours and every 2 hours outside them, until Frank says otherwise.
  await expect(page.getByLabel('Outlook: poll every, work hours')).toHaveValue('30');
  const offHours = page.getByRole('switch', { name: 'Outlook: poll outside work hours' });
  await expect(offHours).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Outlook: poll every, off hours')).toHaveValue('120');
  await offHours.click();
  await expect(page.getByLabel('Outlook: poll every, off hours')).toHaveCount(0);
  await expect(page.getByText('Email from the evening waits for the next work-hours poll.')).toBeVisible();
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await offHours.click();
  await expect(page.getByLabel('Outlook: poll every, off hours')).toHaveValue('30');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved'); // a save still under way would turn the source back on

  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/settings-outlook-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/settings-outlook-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await page.getByRole('button', { name: 'Disconnect' }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect Outlook?' });
  await expect(dialog).toContainText('The connector stays on claude.ai');
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Outlook isn’t polled, so new email doesn’t arrive.')).toBeVisible();
  // The account is kept: Connect turns Outlook back on.
  await expect(page.getByTestId('outlook-account')).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'true');
});

test('Outlook mail lands in the inbox after Connect: To and Cc, “You” on your reply, links, Reply in Outlook', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-row^="outlook:"]')).toHaveCount(0);

  await connect(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const pricing = emailRow(page, 'v2 pricing');
  await showNew(page, pricing); // the poll after Connect, then triage
  await expect(pricing).toBeVisible();
  await expect(pricing).toHaveAttribute('data-lane', 'now');
  await expect(pricing.getByRole('img', { name: 'Outlook' })).toBeVisible();

  await pricing.click();
  const panel = itemPanel(page);
  await expect(panel.getByText('P2', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(panel.getByTestId('recipients')).toHaveText('To You · Cc Customer success manager');
  await expect(panel.getByRole('link', { name: 'https://example.com/pricing/v2-draft' })).toHaveAttribute('target', '_blank');
  await expect(panel.getByText('📎 Renewal schedule.pdf')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reply in Outlook' })).toBeVisible();
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-email-light.png') });

  // Frank's reply from Sent Items shows as his; the thread needs nothing more from him.
  const footer = page.getByTestId('inbox-footer');
  await footer.getByRole('button', { name: /low priority/ }).click();
  const tiers = emailRow(page, 'tier comparison');
  await tiers.click();
  await expect(panel.getByTestId('recipients')).toHaveText(['To You · Cc Head of Sales', 'To Finance partner · Cc Head of Sales']);
  await expect(panel.getByText('You', { exact: true })).toBeVisible();
});

test('Usage & health lists Outlook under Source health once it is connected (R2.1)', async ({ page }) => {
  await page.goto('/usage');
  await expect(page.getByTestId('outlook-health')).toHaveCount(0);

  await connect(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Usage & health' }).click();
  const outlook = page.getByTestId('outlook-health');
  await expect(outlook).toContainText('Outlook');
  await expect(outlook).toContainText('Healthy');
  await expect(page.getByTestId('slack-health')).toContainText('mode search.messages'); // Slack's line is unchanged
  // The sidebar lists Outlook with Slack once it's on.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Outlook/ })).toBeVisible();
});
