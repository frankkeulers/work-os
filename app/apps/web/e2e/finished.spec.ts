import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Looks finished (specs/cockpit/SPEC.md CK-2.10): 18 minutes in, the Meridia PM's update settles
// the FQ3 ask. Once the thread is quiet, triage says None, the mention-me floor keeps it in Today,
// and the finish check suggests it looks finished, in place. Done accepts; Not finished keeps it in
// Today. Both are labels for the finish eval.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

test.use({ viewport: { width: 1728, height: 1000 } });

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const row = (page: Page) => page.getByRole('region', { name: 'Needs you', exact: true }).locator('[data-row]').filter({ hasText: 'FQ3 plan for Meridia IQ' });
const WHY = 'The Meridia PM locked the FQ3 three with Matt and says nothing is needed from you.';

async function open(page: Page) {
  await page.goto('/');
  // The cockpit opens with the panel closed (UX-13), so new rows land in place.
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  // The update comes in with the poll after +18 min and is triaged once the quiet window has passed.
  const note = row(page).locator('[data-finish-note]');
  for (let i = 0; i < 6 && !(await note.count()); i++) {
    await page.getByRole('button', { name: '+10 min', exact: true }).click();
    await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/, { timeout: 15_000 });
  }
  await page.getByRole('button', { name: 'Close scenarios' }).click();
  await expect(note).toHaveText(`Looks finished · ${WHY}`);
  await row(page).click();
  const callout = panel(page).locator('[data-finish-callout]');
  await expect(callout).toContainText(WHY);
  return callout;
}

test('J62: a topic others settled says "Looks finished" in place, and Done takes it out (CK-2.10)', async ({ page }) => {
  const callout = await open(page);
  // The panel's reply line doesn't repeat it.
  await expect(panel(page).locator('[data-finish-note]')).toHaveCount(0);
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/inbox-looks-finished-light.png'), animations: 'disabled' });

  await callout.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Done · ' })).toBeVisible();
  await expect(row(page)).toHaveCount(0, { timeout: 8000 });
});

test('J62: Not finished keeps it in Today and drops the suggestion (CK-2.10)', async ({ page }) => {
  const callout = await open(page);
  await callout.getByRole('button', { name: 'Not finished' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Kept in Today · labelled set now \d+/ })).toBeVisible();
  await expect(callout).toHaveCount(0);
  await expect(row(page)).toHaveAttribute('data-lane', 'today');
  await expect(row(page).locator('[data-finish-note]')).toHaveCount(0);
});

test('J62, dark: "Looks finished" in the dark theme', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/inbox-looks-finished-dark.png'), animations: 'disabled' });
});
