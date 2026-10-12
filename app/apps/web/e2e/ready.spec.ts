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

test('J89 a suggested to-do: a adds it for review (FR-15.6)', async ({ page }) => {
  await withPolicy(page);
  const needs = page.locator('[data-row]').filter({ hasText: 'Meridia IQ beta feedback shared' });
  await needs.click();
  const chip = panel(page).getByRole('region', { name: 'Suggested to-do' });
  await expect(chip).toContainText('Add to-do: Send Meridia IQ beta feedback summary to the team');
  await expect(chip).toContainText('T2');
  await page.addStyleTag({ content: HIDE });
  await chip.screenshot({ path: join(APP, 'screenshots/panel-suggested-todo-light.png'), animations: 'disabled' });
  await page.keyboard.press('a');
  // The to-do opens for review; nothing is written until it is approved.
  await expect(panel(page).getByRole('region', { name: 'Action' })).toContainText('Send Meridia IQ beta feedback summary to the team', { timeout: 10_000 });
  await expect(chip).toHaveCount(0);
});

test('J89 dismissing the suggested to-do keeps it gone (FR-15.6)', async ({ page }) => {
  await withPolicy(page);
  await page.locator('[data-row]').filter({ hasText: 'Meridia IQ beta feedback shared' }).click();
  const chip = panel(page).getByRole('region', { name: 'Suggested to-do' });
  await chip.getByRole('button', { name: 'Dismiss the suggested to-do' }).click();
  await expect(chip).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('[data-row]').filter({ hasText: 'Meridia IQ beta feedback shared' }).click();
  await expect(panel(page).getByTestId('panel-pos')).toBeVisible();
  await expect(chip).toHaveCount(0);
});

test('J90 the Filing… menu: feedback for the policy that moves the item too, and Not for filing asks why and takes it out of To file (FR-15.7)', async ({ page }) => {
  await withPolicy(page);
  await row(page, F1).click();
  await expect(panel(page).getByTestId('panel-pos')).toBeVisible();
  const trigger = panel(page).getByRole('button', { name: 'Filing…' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Filing feedback' });
  // f1 files to both: the vault note is ready (R1), the Confluence entry isn't drafted ahead (F1).
  await expect(menu.getByRole('menuitem')).toHaveText(['Not for filing…', 'Don’t draft items like this ahead', 'Shouldn’t be ready to approve', 'Should be ready to approve']);
  await expect(menu.getByRole('group', { name: 'Vault note' }).getByRole('menuitem')).toHaveCount(2);
  await expect(menu.getByRole('group', { name: 'Confluence entry' }).getByRole('menuitem')).toHaveText(['Should be ready to approve']);
  await page.addStyleTag({ content: HIDE });
  await menu.screenshot({ path: join(APP, 'screenshots/panel-filing-feedback-light.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await menu.screenshot({ path: join(APP, 'screenshots/panel-filing-feedback-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await menu.getByRole('group', { name: 'Vault note' }).getByRole('menuitem', { name: 'Shouldn’t be ready to approve' }).click();
  await expect(page.getByText(/Marked not ready to approve · filing labels now 25/)).toBeVisible();
  // It leaves Ready to approve at once, and waits with the other filings.
  const ready = toFile(page).locator('[data-subhead="ready"]');
  await expect(row(page, F1)).not.toContainText('Ready ·');
  await expect(ready).toContainText('Ready to approve1');

  // And back in, for its Confluence entry: drafted ahead, ready with one key.
  await trigger.click();
  await page.getByRole('menu', { name: 'Filing feedback' }).getByRole('group', { name: 'Confluence entry' }).getByRole('menuitem', { name: 'Should be ready to approve' }).click();
  await expect(page.getByText(/Marked ready to approve · filing labels now 26/)).toBeVisible();
  await expect(row(page, F1)).toContainText('Ready · F1');
  await expect(ready).toContainText('Ready to approve2');

  // Not for filing asks why first, so the policy learns the reason rather than the channel.
  await trigger.click();
  await page.getByRole('menu', { name: 'Filing feedback' }).getByRole('menuitem', { name: 'Not for filing…' }).click();
  const why = page.getByRole('dialog', { name: 'Why not for filing?' });
  await expect(why.getByRole('menuitem')).toHaveText(['Not my product area', 'Not worth keeping', 'Already written up elsewhere', 'Skip, no reason']);
  await expect(why.getByRole('menuitem', { name: 'Not my product area' })).toBeFocused();
  await expect(why.getByRole('button', { name: 'Send' })).toBeDisabled();
  await why.screenshot({ path: join(APP, 'screenshots/panel-filing-why-light.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await why.screenshot({ path: join(APP, 'screenshots/panel-filing-why-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  // Esc closes it without sending; the item stays in To file.
  await page.keyboard.press('Escape');
  await expect(why).toHaveCount(0);
  await expect(row(page, F1)).toHaveCount(1);
  await trigger.click();
  await page.getByRole('menu', { name: 'Filing feedback' }).getByRole('menuitem', { name: 'Not for filing…' }).click();
  await page.getByRole('dialog', { name: 'Why not for filing?' }).getByRole('menuitem', { name: 'Not my product area' }).click();
  await expect(page.getByText(/Taken out of To file · filing labels now 27/)).toBeVisible();
  await expect(row(page, F1)).toHaveCount(0, { timeout: 10_000 });
});
