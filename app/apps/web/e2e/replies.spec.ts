import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Items close after Frank's reply (specs/cockpit/SPEC.md CK-2.5): on the cockpit at 13:48,
// Scenarios › Controls › Frank replies answers a Slack item in Needs you (or the open one),
// and a moment later the settle check settles it, holds it, or fails.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

test.use({ viewport: { width: 1728, height: 1000 } });

async function control(page: Page, name: string) {
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Backquote');
  await expect(drawer).toHaveCount(0);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const zone = (page: Page, name: 'Needs you' | 'Later') => page.getByRole('region', { name, exact: true });

async function afternoon(page: Page) {
  await page.goto('/');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await control(page, '13:48 with Outlook and the calendar on (cockpit)');
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
}

/** Frank answers a Slack item in Needs you; the row it answered, found by what the check did to it. */
async function reply(page: Page, outcome: 'Settles it' | 'Holds it (“will look later”)' | 'Check fails', mark: string) {
  await control(page, outcome);
  const hit = zone(page, 'Needs you').locator(mark).first();
  await expect(hit).toBeVisible();
  const id = (await zone(page, 'Needs you').locator(`[data-row]:has(${mark}), [data-row]${mark}`).first().getAttribute('data-row'))!;
  return (scope = zone(page, 'Needs you')) => scope.locator(`[data-row="${id}"]`);
}

test('J52: your reply settles it — "You replied" for a moment, then it leaves, and the footer counts it (CK-2.5)', async ({ page }) => {
  await afternoon(page);
  const row = await reply(page, 'Settles it', '[data-replied]');
  const id = (await row().getAttribute('data-row'))!;

  // Held in its place, struck through, for 5 s; a toast says why, with Undo.
  await expect(row()).toHaveAttribute('data-replied');
  await expect(row()).toContainText(/You replied (just now|\d+ min ago)/);
  await expect(row()).toHaveAttribute('data-lane', 'now');
  const toast = page.getByRole('status').filter({ hasText: 'Closed: you replied in Slack' });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-replied-light.png') });

  await expect(row()).toHaveCount(0, { timeout: 8000 });
  const line = page.getByTestId('replies-line');
  await expect(line).toContainText(/1 closed by your reply today · latest (just now|\d+ min ago):/);

  // Review: the closes by reply, each labelled.
  await line.getByRole('button', { name: 'Review' }).click();
  const list = zone(page, 'Later').getByRole('region', { name: 'Closed by your replies' });
  await expect(list.locator(`[data-row="${id}"]`)).toBeVisible();
  await expect(list.locator('[data-done-by="reply"]')).toHaveText(['Your reply in Slack']);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

test('J53: your reply holds it — the item stays, saying what is still yours (CK-2.3, CK-2.5)', async ({ page }) => {
  await afternoon(page);
  const row = await reply(page, 'Holds it (“will look later”)', '[data-reply-note="open"]');
  const note = row().locator('[data-reply-note="open"]');
  await expect(note).toContainText('You replied · still open: You said you’d look later');
  await expect(row()).not.toHaveAttribute('data-replied');

  // The panel says the same, and that a reply closes it by itself.
  await row().click();
  await expect(panel(page).locator('[data-reply-note="open"]')).toContainText('still open');
  await expect(panel(page).locator('[data-close-note]')).toHaveText(/^Closes (by itself when you reply in the (thread|conversation)|when your reply settles it)\. Checked 2 min after you open Slack\.$/);
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-reply-open-light.png') });
});

test('J54: Undo a close, and a failed check closes nothing (CK-2.3, CK-2.6)', async ({ page }) => {
  await afternoon(page);
  const row = await reply(page, 'Settles it', '[data-replied]');
  await page.getByRole('status').filter({ hasText: 'Closed: you replied in Slack' }).getByRole('button', { name: 'Undo' }).click();
  // Back at once, as an ordinary row.
  await expect(row()).not.toHaveAttribute('data-replied');
  await expect(row()).toHaveAttribute('data-lane', 'now');
  await expect(page.getByTestId('replies-line')).toHaveCount(0);

  // Now the check fails on the open item: nothing changes.
  await row().click();
  await expect(panel(page)).toBeVisible();
  await control(page, 'Check fails');
  await page.waitForTimeout(2000);
  await expect(row()).toHaveAttribute('data-lane', 'now');
  await expect(row().locator('[data-reply-note]')).toHaveCount(0);
});

test('your reply settles a This week item — "You replied" in This week for a moment, then it leaves (CK-2.5)', async ({ page }) => {
  await afternoon(page);
  const week = zone(page, 'Later').getByRole('region', { name: 'This week', exact: true });
  const first = week.locator('[data-row]').first();
  const id = (await first.getAttribute('data-row'))!;
  // Frank replies to the one open in the panel.
  await first.click();
  await expect(panel(page)).toBeVisible();
  await control(page, 'Settles it');
  const row = week.locator(`[data-row="${id}"]`);
  await expect(row).toHaveAttribute('data-replied');
  await expect(row).toHaveAttribute('data-lane', 'week');
  await expect(row).toContainText(/You replied (just now|\d+ min ago)/);
  await expect(page.getByRole('status').filter({ hasText: 'Closed: you replied in Slack' })).toBeVisible();
  await expect(zone(page, 'Needs you').locator(`[data-row="${id}"]`)).toHaveCount(0);
  await expect(row).toHaveCount(0, { timeout: 8000 });
});

test('with closing on reply off, a settled reply asks "Mark done?" and closes nothing (CK-2.7)', async ({ page }) => {
  await afternoon(page);
  await page.goto('/settings/rules');
  await expect(page.getByRole('heading', { name: 'When you reply', exact: true })).toBeVisible();
  const group = page.getByRole('main', { name: 'Triage rules' });
  const close = group.getByRole('switch', { name: 'Close items when your reply settles them' });
  await expect(close).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('switch', { name: 'Check replies in Slack' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('switch', { name: 'Check replies in Outlook' })).toHaveAttribute('aria-checked', 'false');
  await close.click();
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toBeVisible();
  await expect(close).toHaveAttribute('aria-checked', 'false');
  await expect(group).toContainText('The check still runs, but nothing closes');
  await page.addStyleTag({ content: `${HIDE} [role="status"] { display: none !important; }` });
  await page.screenshot({ path: join(APP, 'screenshots/settings-close-on-reply-light.png') });

  await page.goto('/');
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
  const row = await reply(page, 'Settles it', '[data-reply-note="settled"]');
  await expect(row().locator('[data-reply-note="settled"]')).toHaveText('You replied · Mark done?');
  await expect(row()).not.toHaveAttribute('data-replied');
  await expect(page.getByRole('status').filter({ hasText: 'Closed: you replied' })).toHaveCount(0);
  await expect(page.getByTestId('replies-line')).toHaveCount(0);
});

test('J52, dark: "You replied" in the dark theme', async ({ page }) => {
  await afternoon(page);
  await reply(page, 'Settles it', '[data-replied]');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-replied-dark.png') });
});
