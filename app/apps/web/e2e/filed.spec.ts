import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Done today shows filings (specs/BACKLOG.md UX-12): what was written where today, at the top of
// the Done list, with Open note or Open page, and Reopen for an item filing closed.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

test.use({ viewport: { width: 1728, height: 1000 } });

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const later = (page: Page) => page.getByRole('region', { name: 'Later', exact: true });
const filed = (page: Page) => page.getByRole('region', { name: 'Filed today' });
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

async function startJourney(page: Page, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: new RegExp(`^Start ${id} `) }).click();
}

/** Opens a To file row, starts its filing by key and approves it with ⌘↵. */
async function fileByKey(page: Page, row: string, key: 'v' | 'f') {
  // The panel covers Later on the cockpit.
  if (await panel(page).isVisible()) await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await later(page).getByRole('region', { name: 'To file', exact: true }).locator('[data-row]').filter({ hasText: row }).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press(key);
  await expect(panel(page).locator('[data-action-bar]').getByRole('button', { name: /^Approve/ })).toBeEnabled({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+Enter');
}

test('J85 Done today lists what was filed where, with Open note, Open page and Reopen (UX-12)', async ({ page }) => {
  await startJourney(page, 'J85');
  // Out of dry-run, so the vault note is in the vault (the mock's), and Obsidian can open it.
  await page.getByRole('switch', { name: 'Dry-run' }).click();
  await page.getByRole('button', { name: 'Turn off dry-run' }).click();
  await expect(page.getByRole('switch', { name: 'Dry-run' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();

  await fileByKey(page, 'Claude Code', 'v');
  await expect(status(page, 'Filed, so marked done · #ai-adoption')).toBeVisible({ timeout: 20_000 });
  await fileByKey(page, 'imo_str', 'f');
  await expect(panel(page).getByRole('region', { name: 'Action' }).getByRole('status').filter({ hasText: /^Written to/ })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);

  await later(page).getByTestId('later-foot').getByRole('button', { name: /done today/ }).click();
  const rows = filed(page).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // Newest first: the Confluence entry, on an item that stays open for its vault note.
  const page1 = rows.nth(0);
  await expect(page1).toHaveAttribute('data-filing', 'confluence_entry');
  await expect(page1).toContainText('Confluence entry · #insights-api');
  await expect(page1).toContainText('still open');
  await expect(page1).toContainText(/^.*Written to .+, now v\d+\./);
  await expect(page1.getByRole('link', { name: 'Open page' })).toHaveAttribute('href', /\/wiki\/spaces\/.+\/pages\/\d+$/);
  await expect(page1.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
  const note = rows.nth(1);
  await expect(note).toHaveAttribute('data-filing', 'vault_note');
  await expect(note).toContainText('Vault note · #ai-adoption');
  await expect(note).not.toContainText('Logged action.executed');
  await expect(note.getByRole('link', { name: 'Open note' })).toHaveAttribute('href', /^obsidian:\/\/open\?vault=.+&file=.+/);
  await page.addStyleTag({ content: HIDE });
  await later(page).screenshot({ path: join(APP, 'screenshots/cockpit-filed-today-light.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await later(page).screenshot({ path: join(APP, 'screenshots/cockpit-filed-today-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  // Reopen puts the item back; what was written stays listed.
  await note.getByRole('button', { name: 'Reopen' }).click();
  await expect(status(page, 'Reopened · #ai-adoption')).toBeVisible();
  await expect(note).toContainText('still open');
  await expect(note.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

  // A filing's summary opens its item.
  await page1.getByRole('button').first().click();
  await expect(panel(page)).toContainText('imo_str');
});

test('below 1600 px the Done list shows the filings too (UX-12)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await startJourney(page, 'J85');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await page.getByRole('region', { name: 'Inbox list' }).locator('[data-row]').filter({ hasText: 'Claude Code' }).click();
  await page.keyboard.press('v');
  await expect(panel(page).locator('[data-action-bar]').getByRole('button', { name: /^Approve/ })).toBeEnabled({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(status(page, 'Filed, so marked done · #ai-adoption')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^\d+ done/ }).click();
  const row = filed(page).getByRole('listitem');
  await expect(row).toHaveCount(1);
  // In dry-run the note is in the sandbox, so there is no note in Obsidian to open.
  await expect(row).toContainText(/Dry-run: Created .*sandbox/);
  await expect(row.getByRole('link', { name: 'Open note' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Reopen' })).toBeVisible();
});
