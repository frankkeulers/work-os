import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The bell (FR-11.3–11.6): what needs Frank's follow-up, in the top-right corner of every page.

const DRAFT_TIMEOUT = { timeout: 20_000 };
const APP = join(import.meta.dirname, '../../..');
const shot = (page: Page, name: string) => page.screenshot({ path: join(APP, `screenshots/${name}.png`), animations: 'disabled' });

async function startJourney(page: Page, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: new RegExp(`^Start ${id} `) }).click();
}

const bell = (page: Page) => page.getByTestId('bell');
const popover = (page: Page) => page.getByRole('dialog', { name: 'Follow-ups' });
const entry = (page: Page, text: string | RegExp) => popover(page).getByRole('list', { name: 'Needs you' }).getByRole('listitem').filter({ hasText: text });

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });

async function openBell(page: Page) {
  if (!(await popover(page).isVisible())) await bell(page).click();
  await expect(popover(page)).toBeVisible();
}

test('J69 draft a vault note, move on, and the bell says when it is ready (FR-11.3, FR-11.4)', async ({ page }) => {
  await startJourney(page, 'J69');
  const action = page.getByRole('region', { name: 'Action' });
  await action.getByRole('button', { name: 'Draft vault note' }).click();
  await page.getByRole('link', { name: 'Back to inbox' }).click();

  // While it drafts, the bell shows it under Working on, with its stage.
  await openBell(page);
  const working = popover(page).getByRole('region', { name: 'Working on' });
  await expect(working).toContainText('Vault note');
  await expect(working).toContainText(/of 3/);
  await shot(page, 'notifications-working-light');
  await page.keyboard.press('Escape');

  // Ready: the count turns accent again, as something arrived since the bell was opened.
  await expect(bell(page).getByTestId('bell-count')).toHaveAttribute('data-unseen', 'true', DRAFT_TIMEOUT);
  await expect(page.getByText(/Vault note draft ready ·/)).toBeVisible(); // the toast too
  await openBell(page);
  const ready = entry(page, 'Vault note draft ready').first(); // newest first; the demo data has an older one
  await expect(ready).toBeVisible();
  await expect(ready.getByRole('button', { name: 'Dismiss' })).toHaveCount(0); // a ready draft goes when it's dealt with
  await expect(bell(page).getByTestId('bell-count')).not.toHaveAttribute('data-unseen', 'true'); // seen now
  await shot(page, 'notifications-ready-light');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await shot(page, 'notifications-ready-dark');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  // Review opens it in the inbox panel, on the vault note (UX-6).
  await ready.getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/\?item=[^&]+&file=vault$/);
  await panel(page).getByRole('region', { name: 'Action' }).getByRole('button', { name: /^Approve/ }).click();
  await openBell(page);
  await expect(entry(page, 'Vault note draft ready')).toHaveCount(1); // only the demo data's older one
});

test('J70 a draft fails while away: a toast, then the bell until dismissed (FR-11.4, FR-11.5)', async ({ page }) => {
  await startJourney(page, 'J70');
  await page.getByRole('region', { name: 'Action' }).getByRole('button', { name: 'Draft vault note' }).click();
  await page.getByRole('link', { name: 'Back to inbox' }).click();
  await expect(page.getByText(/Vault note draft failed ·/)).toBeVisible(DRAFT_TIMEOUT);
  await openBell(page);
  const failed = entry(page, 'Vault note draft failed');
  await expect(failed).toContainText('did not match the expected format');
  await shot(page, 'notifications-failed-light');
  await failed.getByRole('button', { name: 'Dismiss' }).click();
  await expect(failed).toHaveCount(0);
});

test('J71 a connector to reconnect is in the bell, on every page (FR-11.4)', async ({ page }) => {
  await startJourney(page, 'J71');
  for (const path of ['/', '/settings', '/usage', '/guide']) {
    await page.goto(path);
    await openBell(page);
    const fix = entry(page, 'Outlook not connected');
    await expect(fix).toBeVisible();
    await expect(fix.getByRole('button', { name: 'Fix' })).toBeVisible();
    await expect(fix.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
    if (path === '/') await shot(page, 'notifications-fix-light');
    await page.keyboard.press('Escape');
  }
});

test('J72 nudges: a reply that left asks open, and guidance whose sources changed (FR-11.4)', async ({ page }) => {
  await startJourney(page, 'J72');
  await openBell(page);
  const reply = entry(page, 'Your reply left asks open');
  await expect(reply).toBeVisible(DRAFT_TIMEOUT);
  const guidance = entry(page, 'Guidance sources changed');
  await expect(guidance).toBeVisible();
  await shot(page, 'notifications-nudges-light');
  await guidance.getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts/);
});

test('the bell says when nothing needs you', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await page.getByRole('complementary', { name: 'Scenarios' }).getByRole('button', { name: 'Inbox zero', exact: true }).click();
  await page.getByRole('button', { name: 'Close scenarios' }).click();
  await openBell(page);
  const g = entry(page, 'Guidance sources changed');
  await g.getByRole('button', { name: 'Dismiss' }).click();
  await expect(popover(page).getByText('Nothing needs you.')).toBeVisible();
  await expect(bell(page).getByTestId('bell-count')).toHaveCount(0);
  await shot(page, 'notifications-empty-light');
});

test('J83 a notification opens its item in the inbox panel, with the list still there (UX-6)', async ({ page }) => {
  await startJourney(page, 'J83');
  const card = page.getByTestId('os-notification');
  await expect(card).toBeVisible({ timeout: 10_000 });
  const title = (await card.locator('span.font-semibold').nth(1).textContent())!;
  await card.click();
  await expect(page).toHaveURL(/\/\?item=/);
  await expect(panel(page)).toContainText(title);
  await expect(page.getByRole('region', { name: 'Inbox list' })).toBeVisible();
  await expect(page.locator('[data-row][aria-current="true"]')).toContainText(title);
  await expect(panel(page).getByText('Loading…')).toHaveCount(0);
  await shot(page, 'notifications-open-in-panel-light');
  // The panel's keys work there: Esc closes it and leaves you on the inbox.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test('J84 a toast for an item the inbox doesn’t show opens it as a full page (UX-6)', async ({ page }) => {
  await startJourney(page, 'J84'); // a Teams meeting, outside the Focus scope
  await page.getByRole('region', { name: 'Action' }).getByRole('button', { name: 'Draft vault note' }).click();
  await page.getByRole('link', { name: 'Back to inbox' }).click();
  const toast = page.getByRole('status').filter({ hasText: /Vault note draft ready ·/ });
  await toast.getByRole('button', { name: 'Review' }).click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/item\/[^?]+\?tab=vault$/);
  await expect(page.getByRole('region', { name: 'Action' }).getByRole('button', { name: /^Approve/ })).toBeVisible();
  // A macOS notification's link, opened afresh, does the same.
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  await page.goto(`/?item=${encodeURIComponent(id)}&file=vault`);
  await expect(page).toHaveURL(/\/item\/[^?]+\?tab=vault$/);
  await expect(page.getByRole('region', { name: 'Action' }).getByRole('button', { name: /^Approve/ })).toBeVisible();
});
