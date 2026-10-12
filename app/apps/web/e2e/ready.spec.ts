import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Ready to approve (PLAN FR-15.3, FR-15.5): with the filing policy applied, To file leads with the
// filings the policy marks ready, drafted ahead; Approve ready takes them one key each. What the
// policy doesn't pre-draft waits for f or v.

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
const toFile = (page: Page) => page.getByRole('region', { name: 'Later', exact: true }).getByRole('region', { name: 'To file', exact: true });
const pos = (page: Page) => panel(page).getByTestId('batch-pos');
const approve = (page: Page) => panel(page).getByRole('button', { name: /^Approve and next/ });
const row = (page: Page, text: string) => toFile(page).locator('[data-row]').filter({ hasText: text });
const F1 = 'v2 vessel-events endpoint drops the legacy imo_str field';
const F3 = 'Meridia IQ beta stays free until GA';
const F4 = 'running Claude Code on the subscription';

async function withPolicy(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await control(page, '13:48 with the filing policy (cockpit)');
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
}

test('J88 Ready to approve leads To file; Approve ready files each ready draft with one key (FR-15.5)', async ({ page }) => {
  await withPolicy(page);
  const ready = toFile(page).locator('[data-subhead="ready"]');
  await expect(ready).toContainText('Ready to approve2');
  await expect(toFile(page).locator('[data-subhead="other"]')).toContainText('Other filings');
  // The ready rows come first, each with its rule and where it goes.
  const rows = toFile(page).locator('[data-row]');
  await expect(rows.nth(0)).toContainText(/Ready · R1/);
  await expect(rows.nth(1)).toContainText(/Ready · R1/);
  await expect(rows.nth(2)).not.toContainText('Ready ·');
  await expect(row(page, F1)).toContainText('Vault · ');

  await page.addStyleTag({ content: HIDE });
  await toFile(page).screenshot({ path: join(APP, 'screenshots/cockpit-ready-to-approve-light.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await toFile(page).screenshot({ path: join(APP, 'screenshots/cockpit-ready-to-approve-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await ready.getByRole('button', { name: 'Approve ready' }).click();
  await expect(pos(page)).toHaveText('Ready 1 of 2');
  // Only the ready filing: f1's vault note, not its Confluence entry.
  await expect(panel(page).getByRole('tab', { name: /^Vault note/, selected: true })).toBeVisible();
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });
  await page.keyboard.press('Meta+Enter');
  await expect(pos(page)).toHaveText('Ready 2 of 2');
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });
  await approve(page).click();
  const done = page.getByRole('complementary', { name: 'Filing done' });
  await expect(done.getByTestId('batch-tally')).toHaveText('2 filed');
  await page.keyboard.press('Escape');

  // f4 had one filing and is done; f1 still has its Confluence entry to file, not ready.
  await expect(row(page, F4)).toHaveCount(0, { timeout: 10_000 });
  await expect(row(page, F1)).toHaveCount(1);
  await expect(row(page, F1)).not.toContainText('Ready ·');
  await expect(toFile(page).locator('[data-subhead="ready"]')).toHaveCount(0);
});

test('J88 what the policy doesn’t pre-draft waits for f or v (FR-15.3)', async ({ page }) => {
  await withPolicy(page);
  await row(page, F3).click();
  await expect(panel(page).getByTestId('panel-pos')).toBeVisible();
  const step = panel(page).getByRole('button', { name: /^(Drafting…|Review (vault note|Confluence entry)|Draft (vault note|Confluence entry))$/ }).first();
  await expect(step).toHaveText(/^Draft (vault note|Confluence entry)$/);
  // Still nothing after a moment: no draft started ahead.
  await page.waitForTimeout(800);
  await expect(step).toHaveText(/^Draft (vault note|Confluence entry)$/);
});
