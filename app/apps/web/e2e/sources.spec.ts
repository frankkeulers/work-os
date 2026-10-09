import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Source views (specs/cockpit/SPEC.md CK-5): a sidebar source opens everything it has stored,
// newest first, whatever triage made of it, and each item opens in the Inbox's panel, filing included.

const APP = join(import.meta.dirname, '../../..');
/** The macOS-style notification card and the scenario drawer aren't part of the page. */
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const history = (page: Page) => page.locator('[data-history-group]');

async function control(page: Page, name: string) {
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Backquote');
  await expect(drawer).toHaveCount(0);
}

/** Clears the toasts, so a screenshot shows the page under them. */
async function dismissToasts(page: Page) {
  const close = page.getByRole('status').getByRole('button', { name: 'Dismiss' });
  while (await close.count()) await close.first().click();
}

async function shoot(page: Page, name: string, dark = true) {
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, `screenshots/${name}-light.png`), style: HIDE, animations: 'disabled' });
  if (!dark) return;
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, `screenshots/${name}-dark.png`), style: HIDE, animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

/** The Inbox with its panel closed. */
async function inbox(page: Page) {
  await page.goto('/');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
}

const activity = (page: Page, scope = page.locator('body')) => scope.locator('[data-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-activity') ?? ''));

test('J63: Slack’s history — every conversation, newest first, done items too; a row opens the panel and files from there (CK-5.1, 5.3, 5.7)', async ({ page }) => {
  await inbox(page);
  // Done in the Inbox: it leaves Needs you, and stays in the history, marked.
  const first = page.locator('[data-group="needs"] [data-row]').first();
  const doneId = (await first.getAttribute('data-row'))!;
  await first.locator('..').getByRole('button', { name: /^Mark done:/ }).click();
  await expect(page.locator(`[data-group="needs"] [data-row="${doneId}"]`)).toHaveCount(0);

  await nav(page).getByRole('link', { name: /^Slack/ }).click();
  await expect(page).toHaveURL(/\/source\/slack$/);
  await expect(page.getByRole('heading', { name: 'Slack', level: 1 })).toBeVisible();
  // By conversation: the one with the newest message first, and newest first inside each.
  await expect(history(page).first()).toBeVisible();
  expect(await history(page).count()).toBeGreaterThan(2);
  const heads: string[] = [];
  for (const g of await history(page).all()) {
    const times = await activity(page, g);
    expect(times).toEqual([...times].sort().reverse());
    heads.push(times[0]);
  }
  expect(heads).toEqual([...heads].sort().reverse());
  // Nothing hidden: the done item is here, with who closed it, and every row says where triage put it.
  const done = page.locator(`[data-row="${doneId}"]`);
  await expect(done).toHaveAttribute('data-status', 'done');
  await expect(done).toContainText('Done by you');
  await expect(page.locator('[data-row]').first().locator('[data-state-chips]')).not.toBeEmpty();
  await shoot(page, 'source-slack');

  // A row opens the Inbox's panel, filing included; filing from here marks the row Filed.
  const row = page.locator('[data-row]').filter({ hasText: 'imo_str' }).first();
  await row.click();
  await expect(panel(page)).toBeVisible();
  await expect(page).toHaveURL(/\/source\/slack\?item=/);
  await expect(row).toHaveAttribute('aria-current', 'true');
  await panel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  await expect(page).toHaveURL(/file=confluence/);
  const action = panel(page).getByRole('region', { name: 'Action' });
  await action.getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: write logged only', { timeout: 20_000 });
  await expect(row).toContainText('Filed · Confluence');
  await shoot(page, 'source-panel', false);

  // j and k walk the rows as they show; Esc closes the panel.
  const ids = await page.locator('[data-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')));
  const at = ids.indexOf(await row.getAttribute('data-row'));
  await page.locator('body').click({ position: { x: 300, y: 30 } }); // out of the draft editor
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await page.locator(`[data-row="${ids[at]}"]`).click();
  await page.keyboard.press('j');
  await expect(page.locator('[data-row][aria-current="true"]')).toHaveAttribute('data-row', ids[at + 1]!);
  await page.keyboard.press('k');
  await expect(page.locator('[data-row][aria-current="true"]')).toHaveAttribute('data-row', ids[at]!);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);

  // Health is a click away, from the page's header.
  await page.locator('[data-source-header]').getByRole('link', { name: 'Health ›' }).click();
  await expect(page).toHaveURL(/\/usage#health$/);
});

test('J64: Outlook mail by day, and the calendar as a week — a meeting opens its invite, or a card (CK-5.4, 5.6)', async ({ page }) => {
  await inbox(page);
  await control(page, '13:48 with Outlook and the calendar on (cockpit)');
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible({ timeout: 15_000 });

  await nav(page).getByRole('link', { name: /^Outlook/ }).click();
  await expect(page).toHaveURL(/\/source\/outlook$/);
  await expect(history(page).first().getByRole('heading')).toHaveText('Today');
  const times = await activity(page);
  expect(times.length).toBeGreaterThan(0);
  expect(times).toEqual([...times].sort().reverse());
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible();
  await shoot(page, 'source-outlook');

  // The calendar's first read brings its invite in a second poll.
  await expect(nav(page).getByRole('link', { name: /^Calendar/ })).toBeVisible({ timeout: 10_000 });
  await nav(page).getByRole('link', { name: /^Calendar/ }).click();
  await expect(page).toHaveURL(/\/source\/calendar$/);
  const week = page.locator('[data-calendar-week]');
  await expect(week).toHaveAttribute('data-calendar-week', '2026-10-05');
  await expect(week.locator('[data-week-day]')).toHaveCount(7);
  await expect(week.locator('[data-week-day][aria-current="date"]')).toHaveText('Mon 5 Oct');
  // Every meeting, cancelled and declined ones marked, not left out.
  await expect(week.locator('[data-week-event="AAMkMOCKRETRO"]')).toHaveAttribute('data-state', 'cancelled');
  await expect(week.locator('[data-week-event="AAMkMOCKDESIGN"]')).toHaveAttribute('data-state', 'declined');
  await expect(week.locator('[data-week-event="AAMkMOCKDEMO"]')).toBeVisible();
  await expect(page.getByTestId('week-now-line')).toBeVisible();
  await shoot(page, 'source-calendar');

  // A meeting with an invite opens it in the panel; one with nothing behind it, a card.
  const invite = week.locator('[data-week-event][data-linked="invite"]').first();
  await invite.click();
  await expect(panel(page)).toBeVisible();
  await expect(invite).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await week.locator('[data-week-event="AAMkMOCKONEONE"]').click();
  const card = page.locator('[data-event-card]');
  await expect(card).toContainText('1:1 with Head of Product');
  await expect(card).toContainText('Head of Product');
  await expect(card.getByRole('link', { name: 'Open in Outlook' })).toHaveAttribute('href', /AAMkMOCKONEONE/);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // Next week: nothing in the seed; this week again from the button.
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(week).toHaveAttribute('data-calendar-week', '2026-10-12');
  await expect(week.locator('[data-week-event]')).toHaveCount(0);
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(week).toHaveAttribute('data-calendar-week', '2026-10-05');
});

test('Wispr Flow’s meeting notes, newest first; a note opens with its notes and filing (CK-5.5)', async ({ page }) => {
  await page.goto('/settings/wispr');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
  await nav(page).getByRole('link', { name: /^Wispr/ }).click();
  await expect(page).toHaveURL(/\/source\/wispr$/);
  const note = page.locator('[data-row]').filter({ hasText: 'tier comparison' });
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(history(page).first().getByRole('heading')).toHaveText('This week');
  await shoot(page, 'source-wispr');
  await note.click();
  await expect(panel(page).getByRole('heading', { name: 'From the meeting notes' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: /File it|Also file/ })).toBeVisible();
});
